/**
 * ============================================================================
 * 链上流水账：拉取 MyNFT 的全部 Transfer / Approval 事件，还原每枚 NFT 的一生
 * ============================================================================
 *
 * 运行方式（在项目根目录下）：
 *   npx hardhat run scripts/nft-history.js --network sepolia
 *
 * ---------------------------------------------------------------------------
 * 为什么要学这个：链上只存「状态」，不存「历史」
 * ---------------------------------------------------------------------------
 * 你可以随时问合约：tokenId 3 现在归谁？（ownerOf）
 * 但合约**不提供**：tokenId 3 都经过过谁的手？
 *
 * 原因：区块链只保存当前状态树，历史事件写在「日志（Log / Event）」里，
 * 日志不进状态树、合约自己读不到，只有链下的程序能扫描。
 * 所以「历史」这个维度的信息，必须靠事件来重建 —— 这就是本脚本在做的事。
 *
 * 现实中所有这些功能，底层都是读事件：
 *   · OpenSea 的成交记录、价格走势
 *   · 钱包里「我的 NFT」列表（扫 Transfer 事件聚合出你持有过什么）
 *   · The Graph / Alchemy NFT API 这类索引服务（本质是把事件写进数据库）
 *   · 你自己项目的前端活动流
 *
 * ---------------------------------------------------------------------------
 * 三个要认识的事件（ERC721 标准规定）
 * ---------------------------------------------------------------------------
 *   Transfer(from, to, tokenId)
 *      转移或铸造或销毁都会 emit。
 *      特殊约定：from == 0x0 表示【铸造】；to == 0x0 表示【销毁】。
 *      这三个动作共用同一个事件，靠零地址区分 —— 这是 ERC721 的硬性约定。
 *
 *   Approval(owner, approved, tokenId)
 *      单枚授权（或被撤销，撤销时 approved == 0x0）
 *
 *   ApprovalForAll(owner, operator, approved)
 *      全量授权开关（approved 为 true/false）
 *
 * ---------------------------------------------------------------------------
 * 一个实战坑：公共 RPC 对单次查询的区块跨度有限制
 * ---------------------------------------------------------------------------
 * 直接 queryFilter(0, latest) 在公共节点上大概率报错
 * （常见的限制是单次最多 2,000 / 10,000 个区块）。
 * 本脚本用「分段 + 失败自动减半重试」的方式处理，这是生产环境的标准做法。
 *
 * 另外：indexed 参数（本例中 from / to / tokenId 都是 indexed）会被写进
 * topic，可以在节点侧做过滤；非 indexed 参数只能拉回来在代码里筛。
 * 这也是设计事件时要权衡的点：最多只能有 3 个 indexed 参数。
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const line = "-".repeat(72);
const ZERO = "0x0000000000000000000000000000000000000000";

/** 地址缩写：0x1234...abcd，便于在终端里对齐阅读 */
function short(addr) {
  if (!addr) return String(addr);
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

/** 带序号的事件标题 */
function section(n, title) {
  console.log("");
  console.log(line);
  console.log(`[${n}] ${title}`);
  console.log(line);
}

/**
 * 分段拉取事件日志，遇到 RPC 的区块跨度限制时自动减半重试。
 *
 * @param contract  已连接的合约实例
 * @param filter    ethers 的事件过滤器，如 contract.filters.Transfer()
 * @param fromBlock 起始区块
 * @param toBlock   结束区块
 * @param span      单次查询的区块跨度，失败就减半
 */
async function fetchLogsChunked(contract, filter, fromBlock, toBlock, span = 2000) {
  const all = [];
  let cursor = fromBlock;
  let currentSpan = span;
  let shrunk = 0;

  while (cursor <= toBlock) {
    const end = Math.min(cursor + currentSpan - 1, toBlock);
    try {
      const part = await contract.queryFilter(filter, cursor, end);
      all.push(...part);
      cursor = end + 1; // 只有成功后才前进，保证不重不漏
    } catch (err) {
      const msg = String((err && err.shortMessage) || err.message || err);
      // 命中区块跨度限制 → 缩小跨度后重试同一段
      if (msg.includes("block range") || msg.includes("too many") || msg.includes("limit")) {
        shrunk++;
        if (currentSpan <= 10) {
          throw new Error(`区块跨度已缩小到 ${currentSpan} 仍然失败：${msg}`);
        }
        currentSpan = Math.floor(currentSpan / 2);
        continue;
      }
      throw err;
    }
  }
  return { logs: all, finalSpan: currentSpan, shrunk };
}

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await hre.ethers.provider.getNetwork();
  const [owner] = await hre.ethers.getSigners();

  const address = process.env.NFT_ADDRESS || readAddress(networkName);
  const nft = await hre.ethers.getContractAt("MyNFT", address);

  const latest = await hre.ethers.provider.getBlockNumber();
  const deployInfo = readDeployInfo(networkName);
  // 从部署区块开始扫，能少拉几十万区块；读不到就退化成从 0 开始
  const fromBlock = deployInfo && deployInfo.blockNumber ? Number(deployInfo.blockNumber) : 0;

  console.log("============================================================");
  console.log(" MyNFT 链上流水账（从事件还原历史）");
  console.log("============================================================");
  console.log("  网络        :", `${networkName} (chainId: ${chainId.toString()})`);
  console.log("  合约地址    :", address);
  console.log("  你的主账户  :", owner.address);
  console.log("  扫描区间    :", `区块 ${fromBlock} -> ${latest}（共 ${latest - fromBlock + 1} 个区块）`);

  /* ---------------- 1. 拉 Transfer 事件 ---------------- */
  section(1, "拉取 Transfer 事件（分段 + 自动重试）");
  const t = await fetchLogsChunked(nft, nft.filters.Transfer(), fromBlock, latest);
  console.log(`  共拉到 ${t.logs.length} 条 Transfer`);
  if (t.shrunk > 0) {
    console.log(`  （RPC 限制触发 ${t.shrunk} 次，最终单次跨度收敛到 ${t.finalSpan} 个区块）`);
  } else {
    console.log(`  （单次跨度 ${t.finalSpan} 个区块，未触发 RPC 限制）`);
  }

  // 按区块号、再按日志序号排序，还原真实先后顺序
  const transfers = t.logs
    .map((log) => ({
      tokenId: log.args[2].toString(),
      from: log.args[0],
      to: log.args[1],
      block: log.blockNumber,
      logIndex: log.index,
      txHash: log.transactionHash,
    }))
    .sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block - b.block));

  /* ---------------- 2. 时间线视图 ---------------- */
  section(2, "时间线：按发生顺序看每一笔流转");
  if (transfers.length === 0) {
    console.log("  没有任何 Transfer 记录。");
  } else {
    console.log("  序号 | 类型      | tokenId | from          -> to            | 区块");
    console.log("  " + "-".repeat(68));
    transfers.forEach((e, i) => {
      const kind = e.from === ZERO ? "Mint 铸造" : e.to === ZERO ? "Burn 销毁" : "Transfer  ";
      const from = e.from === ZERO ? "0x0(铸造)" : short(e.from);
      const to = e.to === ZERO ? "0x0(销毁)" : short(e.to);
      console.log(
        `  ${String(i + 1).padStart(4)} | ${kind} | ${e.tokenId.padStart(7)} | ${from} -> ${to} | ${e.block}`
      );
    });
    console.log("");
    console.log("  提示：from 是零地址 = 铸造，to 是零地址 = 销毁。");
    console.log("        这是 ERC721 的约定 —— 铸造/转移/销毁共用同一个 Transfer 事件。");
  }

  /* ---------------- 3. 按 tokenId 分组的一生 ---------------- */
  section(3, "每枚 NFT 的完整一生（按 tokenId 分组）");
  const byToken = {};
  for (const e of transfers) {
    (byToken[e.tokenId] = byToken[e.tokenId] || []).push(e);
  }
  const tokenIds = Object.keys(byToken).sort((a, b) => Number(a) - Number(b));

  if (tokenIds.length === 0) {
    console.log("  暂无 NFT。");
  }

  for (const tid of tokenIds) {
    const history = byToken[tid];
    const last = history[history.length - 1];
    const alive = last.to !== ZERO;

    console.log("");
    console.log(`  ── tokenId ${tid} ${alive ? "" : "（已销毁）"} ─────────────────`);
    history.forEach((e, i) => {
      const kind = e.from === ZERO ? "铸造" : e.to === ZERO ? "销毁" : "转移";
      console.log(
        `    ${i + 1}. ${kind}  ${e.from === ZERO ? "0x0" : short(e.from)} -> ${
          e.to === ZERO ? "0x0" : short(e.to)
        }   [区块 ${e.block}]`
      );
      console.log(`       tx ${e.txHash}`);
    });
    if (alive) {
      // 用当前链上状态交叉验证，确保历史重建和现实一致
      const nowOwner = await nft.ownerOf(tid);
      const match = nowOwner.toLowerCase() === last.to.toLowerCase();
      console.log(`    当前持有者: ${nowOwner}`);
      console.log(`    与事件最后一条${match ? "一致 ✓" : "不一致 ✗（请检查是否有漏拉的事件）"}`);
    }
  }

  /* ---------------- 4. 授权事件 ---------------- */
  section(4, "授权事件（Approval / ApprovalForAll）");
  const a = await fetchLogsChunked(nft, nft.filters.Approval(), fromBlock, latest);
  const afa = await fetchLogsChunked(nft, nft.filters.ApprovalForAll(), fromBlock, latest);

  const approvals = a.logs
    .map((log) => ({
      owner: log.args[0],
      approved: log.args[1],
      tokenId: log.args[2].toString(),
      block: log.blockNumber,
      logIndex: log.index,
    }))
    .sort((x, y) => (x.block === y.block ? x.logIndex - y.logIndex : x.block - y.block));

  const forAlls = afa.logs
    .map((log) => ({
      owner: log.args[0],
      operator: log.args[1],
      approved: log.args[2],
      block: log.blockNumber,
      logIndex: log.index,
    }))
    .sort((x, y) => (x.block === y.block ? x.logIndex - y.logIndex : x.block - y.block));

  console.log(`  Approval（单枚）共 ${approvals.length} 条：`);
  if (approvals.length === 0) {
    console.log("    （无）");
  } else {
    approvals.forEach((e) => {
      const action = e.approved === ZERO ? "撤销授权" : "授予授权";
      console.log(
        `    tokenId ${e.tokenId.padStart(3)} | ${short(e.owner)} ${action} -> ${
          e.approved === ZERO ? "0x0" : short(e.approved)
        } | 区块 ${e.block}`
      );
    });
  }

  console.log("");
  console.log(`  ApprovalForAll（全量）共 ${forAlls.length} 条：`);
  if (forAlls.length === 0) {
    console.log("    （无）");
  } else {
    forAlls.forEach((e) => {
      console.log(
        `    ${short(e.owner)} -> ${short(e.operator)} | ${
          e.approved ? "开启全量授权" : "撤销全量授权"
        } | 区块 ${e.block}`
      );
    });
    console.log("");
    console.log("  注意看：全量授权的「开启」和「撤销」是成对出现的两条独立事件，");
    console.log("          链上不会替你自动关闭 —— 不主动撤销，权限就一直挂着。");
  }

  /* ---------------- 5. 当前状态汇总（状态 vs 历史，对照看） ---------------- */
  section(5, "当前状态（状态查询 vs 事件重建，交叉验证）");
  const supply = await nft.totalSupply();
  const ownerBal = await nft.balanceOf(owner.address);
  console.log("  totalSupply          :", supply.toString());
  console.log("  主账户持有数量        :", ownerBal.toString());
  console.log("  主账户持有的 tokenId  :", (await listTokens(nft, owner.address, ownerBal)).join(", "));
  console.log("  nextTokenId（下一枚） :", (await nft.nextTokenId()).toString());

  const mintCount = transfers.filter((e) => e.from === ZERO).length;
  const burnCount = transfers.filter((e) => e.to === ZERO).length;
  console.log("");
  console.log("  从事件统计：累计铸造", mintCount, "次，累计销毁", burnCount, "次");
  console.log("  校验：totalSupply 应等于 铸造数 - 销毁数 =", mintCount - burnCount);
  console.log(
    Number(supply) === mintCount - burnCount
      ? "  [OK] 事件重建与链上状态完全吻合 —— 说明日志一条都没漏拉"
      : "  [!] 两者不一致，可能有事件没拉全（检查起始区块是否正确）"
  );

  console.log("");
  console.log("============================================================");
  console.log(" 读完了，记住三件事");
  console.log("============================================================");
  console.log("  1. 链上只有【状态】，没有【历史】；历史靠事件重建。");
  console.log("     所以写合约时该 emit 的事件一定要 emit —— 少发一个事件，");
  console.log("     这个功能在链下就永远查不回来了（除非重新部署）。");
  console.log("  2. 铸造 / 转移 / 销毁共用 Transfer 事件，靠零地址区分。");
  console.log("  3. 公共 RPC 有区块跨度限制，生产代码必须分段拉取 + 失败重试。");
  console.log("============================================================");
}

/** 读取 deployments/mynft-<网络>.json 里的地址 */
function readAddress(networkName) {
  const file = path.join(__dirname, "..", "deployments", `mynft-${networkName}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `找不到部署产物 ${path.relative(process.cwd(), file)}，请先部署合约或设置 NFT_ADDRESS=0x...`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")).address;
}

/** 读取完整部署信息（含部署区块，用来缩小扫描范围） */
function readDeployInfo(networkName) {
  const file = path.join(__dirname, "..", "deployments", `mynft-${networkName}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

/** 列出某地址持有的全部 tokenId */
async function listTokens(nft, addr, bal) {
  const ids = [];
  for (let i = 0; i < bal; i++) {
    ids.push((await nft.tokenOfOwnerByIndex(addr, i)).toString());
  }
  return ids;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("");
    console.error(line);
    console.error(" [X] 拉取失败：", err.shortMessage || err.message || err);
    console.error(line);
    console.error(" 提示：");
    console.error("  · 若提示区块跨度相关错误，脚本本应自动缩小跨度重试；");
    console.error("    仍失败的话可能是 RPC 节点对历史日志有更严格的限制。");
    console.error("  · 也可以设置环境变量 NFT_ADDRESS 手动指定合约地址。");
    process.exit(1);
  });
