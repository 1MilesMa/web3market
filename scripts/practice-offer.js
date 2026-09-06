/**
 * ============================================================================
 * NFT 市场「买家出价 / 议价」演练脚本 —— 【本地 hardhat 网络，零成本随便跑】
 * ============================================================================
 *
 * 运行方式（在项目根目录下）：
 *   ① 本地演练（默认，零成本）：
 *      npx hardhat run scripts/practice-offer.js --network hardhat
 *      有 deployments/mynft-hardhat.json + simplemarket-hardhat.json 就直接复用；
 *      没有则现场部署一套全新合约（只有 hardhat / localhost 才允许这条回退路径）。
 *   ② 真实测试网（Sepolia，花的是真测试币）：
 *      npx hardhat run scripts/practice-offer.js --network sepolia
 *      地址从 deployments/mynft-sepolia.json 与 deployments/simplemarket-sepolia.json 读取，
 *      找不到部署产物会【直接报错退出】，绝不静默重新部署（否则脚本会在新合约上空跑一场）。
 *      也可用 NFT_ADDRESS / MARKET_ADDRESS 环境变量临时覆盖（优先级最高）。
 *
 * 需要的私钥（.env，sepolia 网络时）：
 *   PRIVATE_KEY   = 卖家 / 部署者 / NFT owner（负责铸造与授权，主账户）
 *   PRIVATE_KEY_2 = 买家 A（对 #1 出价并被接受；未配 B 时兼演买家 C）
 *   PRIVATE_KEY_3 = 买家 B（可选：缺失则自动降级，跳过买家 B 的全部场景，不报错中断）
 *   合约出价者 D 由脚本现场部署，不需要私钥。
 *
 * 与 practice-market.js 的分工：
 *   practice-market.js  = 卖家挂单 → 买家购买（"卖家定价"路径）
 *   本脚本              = 买家出价 → 卖家接受/拒绝（"买家开价"路径）
 *   两条路径最终走的是同一条分账主干 _settleSale()，手续费与版税算法完全一致。
 *
 * 角色分配（与 hardhat.config.js 的 accounts 顺序一一对应）：
 *   signers[0] = 部署者 = 卖家 = NFT 合集 owner（能铸造）（.env: PRIVATE_KEY）
 *   signers[1] = 买家 A（对 #1 出价并最终成交；未配 B 时兼演买家 C）（.env: PRIVATE_KEY_2）
 *   signers[2] = 买家 B（同时对 #1 出价，成交后自己取回）（.env: PRIVATE_KEY_3，缺失则自动降级）
 *   买家 C     = 复用买家 A（换一枚 tokenId 重演"拒绝 → 原路退回"）
 *   合约 D     = RejectingOfferBidder（拒收 ETH 的"恶意"出价者，验证防 DoS），脚本现场部署
 *
 * 演练路线：
 *   步骤 0  前置检查：网络 / 角色 / 费率与版税
 *   步骤 1  解析已部署地址（本地缺产物才现场部署）+【只读预检】：地址回读 / 余额 / 授权状态 / 版税 / 金额充足性
 *   步骤 2  铸造 #1、#2 两枚 NFT 给卖家
 *   步骤 3  卖家 setApprovalForAll 全量授权市场
 *   步骤 4  买家 A、B 同时对 #1 出价（验证并存、互不挤掉）+ A 追加出价
 *   步骤 5  打印出价总览与合约代管总额，并做【第 1 次资金守恒校验】
 *   步骤 6  卖家接受 A 的出价 → 三方分账明细 + NFT 易主核验
 *   步骤 7  验证 B 的钱没被清退（防批量退款 DoS）→ B 自行 withdrawOffer 取回
 *   步骤 8  买家 C 对 #2 出价 → 卖家 rejectOffer → 原路退回
 *   步骤 9  拒收 ETH 的合约出价者 D：退回失败 → 进待领池，交易不 revert → D 领回
 *   步骤 10 留一笔无人处理的悬空出价（B 对 #2），让守恒校验里"代管项"不为 0
 *   步骤 11 汇总 + 【最终资金守恒校验】
 *
 * ---------------------------------------------------------------------------
 * 【核心知识：出价市场和挂单市场，钱放在哪里】
 * ---------------------------------------------------------------------------
 * 挂单市场：钱在买家手里，只在成交那一瞬间过一下合约（原子交易）。
 * 出价市场：钱【先】进合约托管，一直待到成交 / 撤回 / 被拒绝。
 *
 * 于是出价市场多出一个挂单市场没有的风险 —— 退款。
 * 一个经典陷阱：成交时把其他出价者的钱"顺手"全部退回（批量退款）。
 * 只要这些出价者里有【任意一个】是拒收 ETH 的合约，这笔成交就永远成功不了
 * —— 一个无关地址，卡住了卖家处置自己资产的权利，这就是 DoS。
 *
 * 本合约的对策有两条，步骤 7 和步骤 9 会分别演示：
 *   · 成交只清被接受的那一笔，其他人的钱留在合约里，各自 withdrawOffer 取回
 *   · 拒绝出价时若退回失败，钱转入待领池（Pull Payment），绝不 revert
 *
 * 结尾的资金守恒校验是全脚本最重要的一句话：
 *   合约余额 == 代管出价 + 待领池 + 累计平台费 + 累计版税
 * 只要哪天这个等式不成立，就说明合约里出现了"没人认领也解释不了的钱"。
 * ============================================================================
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/* ============================ 可调参数 ============================ */
// 平台手续费 250 bps = 2.5%（合约硬上限 1000 bps = 10%）
const FEE_BPS = 250;
// EIP-2981 版税分子：500 / 10000 = 5%
const ROYALTY_NUMERATOR = 500;
// 铸造上限
const MAX_SUPPLY = 100;

// 出价金额：按【真测试网】量级设定（主账户余额 0.157 ETH，全套跑完本金合计约 0.0065 ETH）
const OFFER_A_FIRST = hre.ethers.parseEther("0.001"); // 买家 A 首次出价
const OFFER_A_ADD = hre.ethers.parseEther("0.0005"); // 买家 A 追加（累计 0.0015）
const OFFER_B = hre.ethers.parseEther("0.002"); // 买家 B 对同一枚出价（比 A 高，但不挤掉 A）
const OFFER_C = hre.ethers.parseEther("0.0015"); // 买家 C 对 #2 出价
const OFFER_D = hre.ethers.parseEther("0.001"); // 拒收合约 D 对 #2 出价（由部署者出资）
const OFFER_B_HANGING = hre.ethers.parseEther("0.001"); // B 最后留的悬空出价

// 预检用的 gas 安全垫：判断余额够不够时，除出价本金外还要额外留出这部分
const GAS_RESERVE = hre.ethers.parseEther("0.01");

const DEMO_URI_1 =
  "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/1.json";
const DEMO_URI_2 =
  "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/2.json";

/* ============================ 小工具 ============================ */
const line = "-".repeat(64);

function section(n, title) {
  console.log("");
  console.log(line);
  console.log(`[步骤 ${n}] ${title}`);
  console.log(line);
}
function ok(msg) {
  console.log("  [OK] " + msg);
}
function warn(msg) {
  console.log("  [注意] " + msg);
}
function info(label, value) {
  console.log(`  ${label.padEnd(18)}: ${value}`);
}
function eth(wei) {
  return hre.ethers.formatEther(wei);
}
function assert(cond, msg) {
  if (!cond) throw new Error("校验失败 → " + msg);
}

/* ====================== 已部署地址解析（写法同 practice-market.js） ====================== */
/**
 * 读取部署产物里的合约地址
 * @param {"nft"|"market"} kind
 * @param {string} networkName
 * @returns {string|null} 找不到返回 null，由调用方决定是报错还是走本地回退部署
 */
function tryReadDeployment(kind, networkName) {
  // 环境变量优先级最高，方便临时指定地址
  const envKey = kind === "nft" ? "NFT_ADDRESS" : "MARKET_ADDRESS";
  if (process.env[envKey]) return process.env[envKey];

  const file = path.join(
    __dirname,
    "..",
    "deployments",
    `${kind === "nft" ? "mynft" : "simplemarket"}-${networkName}.json`
  );
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")).address;
}

/** 部署产物的相对路径（报错与提示信息里用） */
function deploymentPath(kind, networkName) {
  return path.join(
    "deployments",
    `${kind === "nft" ? "mynft" : "simplemarket"}-${networkName}.json`
  );
}

/** 校验地址上确实有合约代码 —— 防止填错地址后一路跑到一半才炸 */
async function assertHasCode(addr, label) {
  const code = await hre.ethers.provider.getCode(addr);
  if (!code || code === "0x") {
    throw new Error(
      `${label} 地址 ${addr} 上没有任何合约代码。\n` +
        `    请确认 deployments/ 里的地址属于【当前网络 ${hre.network.name}】，` +
        "或用 NFT_ADDRESS / MARKET_ADDRESS 环境变量指定正确地址。"
    );
  }
  return code;
}

let gasTotal = 0n;

/** 发交易 → 等确认 → 打印结果，并累计 gas */
async function sendTx(txPromise) {
  const tx = await txPromise;
  info("交易哈希", tx.hash);
  const receipt = await tx.wait();
  gasTotal += receipt.gasUsed;
  info("已确认", `区块 ${receipt.blockNumber} | gas ${receipt.gasUsed.toString()}`);
  return receipt;
}

/**
 * 从交易回执里解析指定事件
 * @returns 解析后的事件对象（找不到返回 null）
 */
function parseEvent(receipt, iface, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch (_) {
      /* 不是本合约的事件，跳过 */
    }
  }
  return null;
}

/* ============================ 主流程 ============================ */
async function main() {
  const networkName = hre.network.name;
  const { chainId } = await hre.ethers.provider.getNetwork();
  const signers = await hre.ethers.getSigners();

  if (signers.length < 2) {
    throw new Error(
      `只找到 ${signers.length} 个账户。本演练至少需要 2 个：` +
        "signers[0] = 卖家/部署者（PRIVATE_KEY）、signers[1] = 买家 A（PRIVATE_KEY_2）。\n" +
        "    请检查 hardhat.config.js 的 accounts 配置与 .env 里的私钥。"
    );
  }

  // 角色映射（顺序与 hardhat.config.js 的 accounts 一致）
  //   signers[0] = PRIVATE_KEY   → 部署者 / 卖家 / NFT 合集 owner（负责铸造与授权）
  //   signers[1] = PRIVATE_KEY_2 → 买家 A（未配买家 B 时兼演买家 C）
  //   signers[2] = PRIVATE_KEY_3 → 买家 B（缺失则自动降级，跳过 B 的全部场景）
  const deployer = signers[0];
  const seller = signers[0]; // 主账户身兼卖家，与测试网私钥规划一致
  const buyerA = signers[1];
  const hasBuyerB = signers.length >= 3;
  const buyerB = hasBuyerB ? signers[2] : null;
  const buyerC = buyerA; // 复用买家 A，换一枚 tokenId 重演"拒绝 → 原路退回"
  const isLocalNetwork = networkName === "hardhat" || networkName === "localhost";

  console.log("============================================================");
  console.log(" NFT 市场「买家出价 / 议价」全流程演练");
  console.log("============================================================");

  /* ---------------- 步骤 0：前置检查 ---------------- */
  section(0, "前置检查：网络、角色与费率");

  info("网络", `${networkName} (chainId: ${chainId.toString()})`);
  info("部署者 / 卖家", `${deployer.address}（PRIVATE_KEY，兼 NFT owner、市场 owner）`);
  info("买家 A", `${buyerA.address}（PRIVATE_KEY_2）`);
  info(
    "买家 B",
    hasBuyerB
      ? `${buyerB.address}（PRIVATE_KEY_3）`
      : "未配置 PRIVATE_KEY_3 → 本轮【跳过】买家 B 的全部场景"
  );
  info("买家 C", `${buyerC.address}（复用买家 A，换一枚 tokenId 重演）`);
  info("合约出价者 D", "脚本现场部署 RejectingOfferBidder，无需私钥");
  info("平台手续费", `${FEE_BPS} bps（${(FEE_BPS / 100).toFixed(2)}%）`);
  info("NFT 版税", `${ROYALTY_NUMERATOR} / 10000（${(ROYALTY_NUMERATOR / 100).toFixed(2)}%）`);
  console.log("");
  info("版税收款人", `${deployer.address}（即部署者本人，方便最后核对版税入账）`);
  if (hasBuyerB) {
    ok("角色齐全（卖家 / 买家 A / 买家 B），完整双人出价流程可跑");
  } else {
    warn("缺少 PRIVATE_KEY_3 → 买家 B 的「多笔并存 / 自行取回 / 悬空出价」场景整段跳过");
    warn("在 .env 补上 PRIVATE_KEY_3 并给该地址转点测试币，即可解锁完整双人出价演示");
  }

  /* ---------------- 步骤 1：解析已部署地址（必要时本地回退部署） ---------------- */
  section(1, "解析已部署合约地址 + 只读预检（预检不花 gas）");

  const nftAddressFromFile = tryReadDeployment("nft", networkName);
  const marketAddressFromFile = tryReadDeployment("market", networkName);

  let nft;
  let market;
  let nftAddress;
  let marketAddress;

  // 先探一下：产物里的地址在当前这条链上到底有没有代码。
  // 本地链每次启动都是全新状态，上一次的部署产物地址必然是空地址 —— 不能硬用。
  let canReuse = false;
  if (nftAddressFromFile && marketAddressFromFile) {
    const nftCodeProbe = await hre.ethers.provider.getCode(nftAddressFromFile);
    const marketCodeProbe = await hre.ethers.provider.getCode(marketAddressFromFile);
    canReuse = nftCodeProbe !== "0x" && marketCodeProbe !== "0x";
    if (!canReuse && isLocalNetwork) {
      warn("部署产物里的地址在当前链上没有代码（本地链每次启动都会重置）→ 改为现场部署");
    }
  }

  if (canReuse) {
    // 正常路径：直接复用已部署合约（sepolia 走这条）
    nftAddress = nftAddressFromFile;
    marketAddress = marketAddressFromFile;
    info("MyNFT 地址", `${nftAddress} ← ${deploymentPath("nft", networkName)}`);
    info("市场地址   ", `${marketAddress} ← ${deploymentPath("market", networkName)}`);

    await assertHasCode(nftAddress, "MyNFT");
    await assertHasCode(marketAddress, "SimpleMarket");

    nft = await hre.ethers.getContractAt("MyNFT", nftAddress);
    market = await hre.ethers.getContractAt("SimpleMarket", marketAddress);
    ok("两个地址链上都有合约代码，ABI 挂载完成（没有重新部署）");
  } else if (isLocalNetwork) {
    // 本地回退路径：没产物 / 产物已失效，就现场部署一套，保证本地演练随时能跑
    if (!nftAddressFromFile || !marketAddressFromFile) {
      const missing = [];
      if (!nftAddressFromFile) missing.push(deploymentPath("nft", networkName));
      if (!marketAddressFromFile) missing.push(deploymentPath("market", networkName));
      warn(`未找到 ${missing.join("、")}`);
    }
    warn("当前是本地网络 → 现场部署一套全新合约供演练使用（真实网络不会走这条回退路径）");

    const MyNFT = await hre.ethers.getContractFactory("MyNFT");
    nft = await MyNFT.deploy(
      deployer.address,
      MAX_SUPPLY,
      deployer.address,
      ROYALTY_NUMERATOR
    );
    await nft.waitForDeployment();
    nftAddress = await nft.getAddress();
    info("MyNFT 已部署", nftAddress);

    const SimpleMarket = await hre.ethers.getContractFactory("SimpleMarket");
    market = await SimpleMarket.deploy(deployer.address, FEE_BPS);
    await market.waitForDeployment();
    marketAddress = await market.getAddress();
    info("市场已部署", marketAddress);
    ok("本地回退部署完成（仅 hardhat / localhost 允许）");
  } else {
    // 其余情况一律报错 —— 绝不静默重部署，否则演练会在新合约上空跑一场
    const problems = [];
    if (!nftAddressFromFile) problems.push(`没有 ${deploymentPath("nft", networkName)}`);
    if (!marketAddressFromFile)
      problems.push(`没有 ${deploymentPath("market", networkName)}`);
    if (nftAddressFromFile && !canReuse)
      problems.push(`${nftAddressFromFile} 在链上没有合约代码`);
    if (marketAddressFromFile && !canReuse)
      problems.push(`${marketAddressFromFile} 在链上没有合约代码`);
    throw new Error(
      `无法复用已部署合约：${problems.join("；")}\n` +
        `    当前网络是 ${networkName}，不允许就地重新部署 —— 新合约上没有你的 NFT，` +
        "演练会跑空，链上地址也对不上。\n" +
        "    解决办法（二选一）：\n" +
        `      · 先部署：npx hardhat run scripts/deploy-mynft.js --network ${networkName}` +
        "（市场同理 scripts/deploy-market.js）\n" +
        "      · 用环境变量直接指定地址：NFT_ADDRESS=0x... MARKET_ADDRESS=0x... npx hardhat run scripts/practice-offer.js --network " +
        networkName
    );
  }

  assert((await market.feeBps()) === BigInt(FEE_BPS), "手续费设置未生效");
  const [royaltyReceiverCheck, royaltyAmountCheck] = await nft.royaltyInfo(
    1,
    hre.ethers.parseEther("1")
  );
  info("链上回读版税", `1 ETH 成交应缴 ${eth(royaltyAmountCheck)} ETH → ${royaltyReceiverCheck}`);
  assert(
    royaltyReceiverCheck.toLowerCase() === deployer.address.toLowerCase(),
    "版税收款人不是部署者"
  );
  ok("合约就位，版税配置已生效（EIP-2981 royaltyInfo 可查）");

  /* ---------------- 步骤 1.5：只读预检（全是 view 调用，不花 gas） ---------------- */
  console.log("");
  console.log("  ── 只读预检 · 以下全部是 view 调用，不花费任何 gas ──");

  // (1) 地址与链上回读校验
  const nftCode = await assertHasCode(nftAddress, "MyNFT");
  const marketCode = await assertHasCode(marketAddress, "SimpleMarket");
  info("MyNFT 回读", `${nftAddress}（代码 ${(nftCode.length - 2) / 2} 字节）`);
  info("市场回读   ", `${marketAddress}（代码 ${(marketCode.length - 2) / 2} 字节）`);

  const nftOwnerOnChain = await nft.owner();
  const marketOwnerOnChain = await market.owner();
  info(
    "NFT owner",
    `${nftOwnerOnChain} ${
      nftOwnerOnChain.toLowerCase() === deployer.address.toLowerCase()
        ? "（= 当前部署者，可铸造）"
        : "（≠ 当前部署者，safeMint 会失败）"
    }`
  );
  info(
    "市场 owner",
    `${marketOwnerOnChain} ${
      marketOwnerOnChain.toLowerCase() === deployer.address.toLowerCase()
        ? "（= 当前部署者，可提平台费）"
        : "（≠ 当前部署者，withdrawFees 会失败）"
    }`
  );

  const totalMinted = await nft.totalMinted();
  const maxSupplyOnChain = await nft.maxSupply();
  const nextTokenId = await nft.nextTokenId();
  info("铸造进度", `已铸 ${totalMinted} / 上限 ${maxSupplyOnChain}，下一个 tokenId = ${nextTokenId}`);
  if (maxSupplyOnChain - totalMinted < 2n) {
    throw new Error(
      `铸造额度不足：上限 ${maxSupplyOnChain}，已铸 ${totalMinted}，本演练还需再铸 2 枚。`
    );
  }
  ok(`铸造额度充足，接下来会铸出 #${nextTokenId} 与 #${nextTokenId + 1n}`);

  // (2) 各参与账户余额
  console.log("");
  const balSeller = await hre.ethers.provider.getBalance(seller.address);
  const balA = await hre.ethers.provider.getBalance(buyerA.address);
  const balB = hasBuyerB ? await hre.ethers.provider.getBalance(buyerB.address) : null;
  info("卖家/部署者余额", `${eth(balSeller)} ETH`);
  info("买家 A 余额", `${eth(balA)} ETH`);
  if (hasBuyerB) info("买家 B 余额", `${eth(balB)} ETH`);

  // (3) 卖家对市场合约的授权状态
  const approvedAllBefore = await nft.isApprovedForAll(seller.address, marketAddress);
  info(
    "卖家全量授权",
    `${approvedAllBefore ? "已授权" : "未授权"} → isApprovedForAll(卖家, 市场) = ${approvedAllBefore}（步骤 3 会补做）`
  );

  // (4) 版税信息
  const [royReceiver, royAmount] = await nft.royaltyInfo(1, hre.ethers.parseEther("1"));
  const royDenominator = await nft.royaltyDenominator();
  info(
    "royaltyInfo(1 ETH)",
    `应缴 ${eth(royAmount)} ETH → 收款人 ${royReceiver}（分母 ${royDenominator}）`
  );

  // (5) 本次出价的金额合计与充足性
  console.log("");
  const needA = OFFER_A_FIRST + OFFER_A_ADD + (hasBuyerB ? 0n : OFFER_C);
  const needB = hasBuyerB ? OFFER_B + OFFER_B_HANGING : 0n;
  const needSeller = OFFER_D; // 拒收合约 D 的出价由部署者出资
  const needTotal = needA + needB + needSeller;
  info(
    "买家 A 需备",
    `${eth(needA)} ETH${hasBuyerB ? "" : `（含兼演买家 C 的 ${eth(OFFER_C)}）`}`
  );
  if (hasBuyerB) info("买家 B 需备", `${eth(needB)} ETH`);
  info("卖家需备    ", `${eth(needSeller)} ETH（给合约 D 出价）+ 铸造、授权、拒绝等 gas`);
  info("本金合计", `${eth(needTotal)} ETH（各账户另需预留约 ${eth(GAS_RESERVE)} ETH gas）`);

  const sufficiency = [
    { label: "卖家/部署者", balance: balSeller, need: needSeller },
    { label: "买家 A      ", balance: balA, need: needA },
  ];
  if (hasBuyerB) sufficiency.push({ label: "买家 B      ", balance: balB, need: needB });

  let allAffordable = true;
  for (const item of sufficiency) {
    const enough = item.balance >= item.need + GAS_RESERVE;
    if (!enough) allAffordable = false;
    info(
      `${item.label} 充足性`,
      `${enough ? "充足" : "不足"}（余额 ${eth(item.balance)} vs 需要 ${eth(
        item.need
      )} + gas 预留 ${eth(GAS_RESERVE)}）`
    );
  }
  if (!allAffordable) {
    throw new Error(
      "有账户余额不足，跑完全流程会中途 revert。请先给对应地址转测试币，" +
        "或调小脚本顶部的出价金额常量。"
    );
  }
  ok("预检通过：合约就位、余额充足 —— 从这里开始才真正花 gas");

  /* ========================================================================
   * 资金守恒校验器
   *   本轮增量：合约余额增量 == 代管出价 + 待领池 + 平台费 + 版税
   *   liveOffers / pendingAccounts / royaltyAccounts 由脚本按需登记，
   *   每一项都从链上现读，不靠脚本自己记账 —— 这样才叫校验。
   *
   *   注意是【增量】不是【总额】：sepolia 上复用的是跑过多轮的旧合约，
   *   链上本就躺着历史残留（上次的悬空出价、累计手续费等），
   *   拿总额去比必然对不上，而且那不是本轮跑出来的结果。
   * ====================================================================== */
  const liveOffers = []; // { nft, tokenId, bidder, label }
  const pendingAccounts = []; // { addr, label, baseline }
  const royaltyAccounts = []; // { addr, label, baseline }

  // 开局基线（在任何一笔交易之前快照）
  const marketBalBaseline = await hre.ethers.provider.getBalance(marketAddress);
  const feesBaseline = await market.accumulatedFees();

  async function trackPending(addr, label) {
    pendingAccounts.push({
      addr,
      label,
      baseline: await market.pendingWithdrawals(addr),
    });
  }

  async function trackRoyalty(addr, label) {
    royaltyAccounts.push({
      addr,
      label,
      baseline: await market.pendingRoyalties(addr),
    });
  }

  async function conservation(title) {
    console.log("");
    console.log("  ── 资金守恒校验 · " + title + " ──");

    // (1) 代管中的出价
    let escrow = 0n;
    for (const o of liveOffers) {
      const [amount] = await market.getOffer(o.nft, o.tokenId, o.bidder);
      if (amount > 0n) {
        escrow += amount;
        console.log(`     代管 · ${o.label.padEnd(22)}: ${eth(amount)} ETH`);
      }
    }
    // (2) 待领池（扣掉开局基线，只看本轮新增）
    let pending = 0n;
    for (const p of pendingAccounts) {
      const amount = (await market.pendingWithdrawals(p.addr)) - p.baseline;
      if (amount > 0n) {
        pending += amount;
        console.log(`     待领池 · ${p.label.padEnd(20)}: ${eth(amount)} ETH`);
      }
    }
    // (3) 平台费（扣掉开局基线）
    const fees = (await market.accumulatedFees()) - feesBaseline;
    if (fees > 0n) console.log(`     平台费  ${" ".repeat(15)}: ${eth(fees)} ETH`);
    // (4) 版税（扣掉开局基线）
    let royalties = 0n;
    for (const r of royaltyAccounts) {
      const amount = (await market.pendingRoyalties(r.addr)) - r.baseline;
      if (amount > 0n) {
        royalties += amount;
        console.log(`     版税 · ${r.label.padEnd(19)}: ${eth(amount)} ETH`);
      }
    }

    const expected = escrow + pending + fees + royalties;
    const actual =
      (await hre.ethers.provider.getBalance(marketAddress)) - marketBalBaseline;

    console.log(`     ${"-".repeat(44)}`);
    console.log(`     四项合计（应然）${" ".repeat(8)}: ${eth(expected)} ETH`);
    console.log(`     合约余额增量（实然）${" ".repeat(4)}: ${eth(actual)} ETH`);

    if (expected !== actual) {
      throw new Error(
        `资金不守恒！应然 ${expected.toString()} wei ≠ 实然 ${actual.toString()} wei`
      );
    }
    ok(`守恒通过：合约里每一分钱都能说清来路（${eth(actual)} ETH）`);
    return { escrow, pending, fees, royalties, actual };
  }

  await trackRoyalty(deployer.address, "版税收款人(部署者)");

  /* ---------------- 步骤 2：铸造两枚 NFT 给卖家 ---------------- */
  section(2, "铸造 #1、#2 两枚 NFT 给卖家");

  await sendTx(nft.connect(deployer).safeMint(seller.address, DEMO_URI_1));
  const tokenId1 = await nft.totalSupply();
  await sendTx(nft.connect(deployer).safeMint(seller.address, DEMO_URI_2));
  const tokenId2 = await nft.totalSupply();

  info("#1 tokenId", tokenId1.toString());
  info("#2 tokenId", tokenId2.toString());
  assert((await nft.ownerOf(tokenId1)) === seller.address, "#1 持有者不是卖家");
  assert((await nft.ownerOf(tokenId2)) === seller.address, "#2 持有者不是卖家");
  ok(`#${tokenId1} 与 #${tokenId2} 已铸造给卖家`);

  /* ---------------- 步骤 3：卖家授权市场 ---------------- */
  section(3, "卖家 setApprovalForAll 全量授权市场");

  await sendTx(nft.connect(seller).setApprovalForAll(marketAddress, true));
  const isApprovedAll = await nft.isApprovedForAll(seller.address, marketAddress);
  assert(isApprovedAll === true, "全量授权未生效");
  ok("市场已获得卖家名下全部 NFT 的转移权（acceptOffer 的硬性前提）");

  /* ---------------- 步骤 4：A、B 同时对 #1 出价 ---------------- */
  section(
    4,
    hasBuyerB
      ? `买家 A 与买家 B 同时对 #${tokenId1} 出价（验证多笔并存）`
      : `买家 A 对 #${tokenId1} 出价（未配买家 B，单人场景）`
  );

  info("A 出价", `${eth(OFFER_A_FIRST)} ETH`);
  await sendTx(
    market.connect(buyerA).makeOffer(nftAddress, tokenId1, { value: OFFER_A_FIRST })
  );
  liveOffers.push({
    nft: nftAddress,
    tokenId: tokenId1,
    bidder: buyerA.address,
    label: "A → #1",
  });

  let amountB = 0n;
  if (hasBuyerB) {
    info("B 出价", `${eth(OFFER_B)} ETH（比 A 高，但不会挤掉 A）`);
    await sendTx(market.connect(buyerB).makeOffer(nftAddress, tokenId1, { value: OFFER_B }));
    liveOffers.push({
      nft: nftAddress,
      tokenId: tokenId1,
      bidder: buyerB.address,
      label: "B → #1",
    });
  } else {
    warn("未配置 PRIVATE_KEY_3 → 跳过买家 B 的并存出价（A 单人流程继续跑）");
  }

  const [amountA, targetA] = await market.getOffer(nftAddress, tokenId1, buyerA.address);
  info("A 的托管额", `${eth(amountA)} ETH（出价对象 ${targetA}）`);
  assert(amountA === OFFER_A_FIRST, "A 的出价未正确记录");
  assert(targetA === seller.address, "出价对象应为当前持有者");

  if (hasBuyerB) {
    const [amtB, targetB] = await market.getOffer(nftAddress, tokenId1, buyerB.address);
    amountB = amtB;
    info("B 的托管额", `${eth(amtB)} ETH（出价对象 ${targetB}）`);
    assert(amtB === OFFER_B, "B 的出价未正确记录");
    assert(targetB === seller.address, "出价对象应为当前持有者");
    ok("两笔出价并存，互不覆盖 —— 映射按【出价人】分桶，不是按 NFT 分桶");
  } else {
    ok("买家 A 的出价已记录（想看多人并存，补上 PRIVATE_KEY_3 再跑）");
  }

  // 追加出价 = 加价（累加），而不是覆盖
  info("A 追加出价", `${eth(OFFER_A_ADD)} ETH → 累计 ${eth(OFFER_A_FIRST + OFFER_A_ADD)} ETH`);
  await sendTx(market.connect(buyerA).makeOffer(nftAddress, tokenId1, { value: OFFER_A_ADD }));
  const [amountA2] = await market.getOffer(nftAddress, tokenId1, buyerA.address);
  assert(amountA2 === OFFER_A_FIRST + OFFER_A_ADD, "追加出价应累加");
  ok("重复出价是累加（加价），想降价就先 withdrawOffer 再重新出价");

  // 反向验证：0 金额出价应被拒
  try {
    await market.connect(buyerA).makeOffer(nftAddress, tokenId1, { value: 0 });
    throw new Error("0 金额出价本应失败，却成功了");
  } catch (err) {
    if (String(err.message).includes("本应失败")) throw err;
    ok("0 金额出价被拒绝 → OfferAmountZero");
  }

  /* ---------------- 步骤 5：出价总览 + 第 1 次守恒 ---------------- */
  section(5, "出价总览与合约代管总额");

  const marketBalance = await hre.ethers.provider.getBalance(marketAddress);
  const escrowDelta = marketBalance - marketBalBaseline;
  info("A 出价", `${eth(amountA2)} ETH`);
  info("B 出价", hasBuyerB ? `${eth(amountB)} ETH` : "0 ETH（未配置 PRIVATE_KEY_3，本轮无 B）");
  info("代管合计", `${eth(amountA2 + amountB)} ETH`);
  info("合约余额增量", `${eth(escrowDelta)} ETH（开局基线 ${eth(marketBalBaseline)} ETH）`);
  assert(escrowDelta === amountA2 + amountB, "合约余额增量应恰好等于两笔出价之和");
  ok("ETH 真的躺在市场合约里托管，不在卖家、也不在任何中间人手上");

  await conservation("出价并存期");

  /* ---------------- 步骤 6：卖家接受 A 的出价 ---------------- */
  section(6, `卖家接受买家 A 的出价（成交价 ${eth(amountA2)} ETH）→ 三方分账`);

  const [qFee, qRoyalty, qReceiver, qProceeds] = await market.quoteWithRoyalty(
    nftAddress,
    tokenId1,
    amountA2
  );
  info("预估平台费", `${eth(qFee)} ETH（2.5%）`);
  info("预估版税", `${eth(qRoyalty)} ETH（5%）→ ${qReceiver}`);
  info("卖家预估实得", `${eth(qProceeds)} ETH`);

  const sellerBalBefore = await hre.ethers.provider.getBalance(seller.address);
  const feesBefore = await market.accumulatedFees();
  const royaltyBefore = await market.pendingRoyalties(deployer.address);

  const acceptReceipt = await sendTx(
    market.connect(seller).acceptOffer(nftAddress, tokenId1, buyerA.address)
  );

  const sellerBalAfter = await hre.ethers.provider.getBalance(seller.address);
  const feesAfter = await market.accumulatedFees();
  const royaltyAfter = await market.pendingRoyalties(deployer.address);
  const acceptGas = acceptReceipt.gasUsed * acceptReceipt.gasPrice;

  const sellerGain = sellerBalAfter - sellerBalBefore + acceptGas; // 补回 gas
  const feeGain = feesAfter - feesBefore;
  const royaltyGain = royaltyAfter - royaltyBefore;

  console.log("");
  info("平台费入账", `+${eth(feeGain)} ETH（留在合约，等 owner 提）`);
  info("版税入账", `+${eth(royaltyGain)} ETH（留在合约，等收款人提）`);
  info("卖家实得", `+${eth(sellerGain)} ETH（${seller.address}）`);
  info("卖家 gas 花费", `${eth(acceptGas)} ETH`);
  console.log("");

  assert(feeGain === qFee, `平台费应为 ${qFee}，实际 ${feeGain}`);
  assert(royaltyGain === qRoyalty, `版税应为 ${qRoyalty}，实际 ${royaltyGain}`);
  assert(sellerGain === qProceeds, `卖家实得应为 ${qProceeds}，实际 ${sellerGain}`);
  assert(
    feeGain + royaltyGain + sellerGain === amountA2,
    `三方分账之和应等于成交价 ${amountA2}`
  );
  ok(
    `分账精确对上：${eth(feeGain)} + ${eth(royaltyGain)} + ${eth(sellerGain)} = ${eth(
      amountA2
    )} ETH`
  );

  const eventAccepted = parseEvent(acceptReceipt, market.interface, "OfferAccepted");
  if (eventAccepted) {
    info(
      "OfferAccepted",
      `price=${eth(eventAccepted.args.price)} fee=${eth(eventAccepted.args.fee)}`
    );
  }

  const newHolder = await nft.ownerOf(tokenId1);
  info(`#${tokenId1} 持有者`, newHolder);
  assert(newHolder.toLowerCase() === buyerA.address.toLowerCase(), "成交后 NFT 应归买家 A");
  ok("NFT 已通过 safeTransferFrom 转给买家 A，钱货两清");

  const [amountAAfter] = await market.getOffer(nftAddress, tokenId1, buyerA.address);
  assert(amountAAfter === 0n, "被接受的出价应被清零");
  ok("被接受的那笔出价已清零，无法被二次成交");

  /* ---------------- 步骤 7：B 的钱没被清退，自己取回 ---------------- */
  section(
    7,
    hasBuyerB
      ? `验证买家 B 的 ${eth(OFFER_B)} ETH 未被清退 → B 自行 withdrawOffer 取回`
      : "买家 B 取回场景（跳过：未配置 PRIVATE_KEY_3）"
  );

  if (!hasBuyerB) {
    warn("未配置 PRIVATE_KEY_3 → 跳过「成交不动他人出价 / B 自行取回」这段验证");
    warn("等价逻辑在单元测试 test/SimpleMarket.test.js 里依然有覆盖");
  } else {
    const [amountBAfter, targetBAfter] = await market.getOffer(
      nftAddress,
      tokenId1,
      buyerB.address
    );
    info("B 的托管额", `${eth(amountBAfter)} ETH`);
    assert(amountBAfter === OFFER_B, "成交不该动其他人的出价");
    ok("成交【只清被接受的那一笔】—— 刻意不做批量退款，防的就是退款 DoS");

    // B 这笔出价已经"陈旧"（NFT 易主），所以它只能取回，不可能被接受
    info("出价时的对象", targetBAfter);
    info("当前持有者", newHolder);
    assert(targetBAfter.toLowerCase() !== newHolder.toLowerCase(), "B 的出价应已陈旧");
    warn("NFT 已易主 → 这笔出价无法再被接受（StaleOffer），但取回不受任何影响");

    const bBalBefore = await hre.ethers.provider.getBalance(buyerB.address);
    const bReceipt = await sendTx(market.connect(buyerB).withdrawOffer(nftAddress, tokenId1));
    const bBalAfter = await hre.ethers.provider.getBalance(buyerB.address);
    const bGas = bReceipt.gasUsed * bReceipt.gasPrice;
    const bNet = bBalAfter - bBalBefore + bGas;

    info("B 到账", `+${eth(bNet)} ETH`);
    info("B gas 花费", `${eth(bGas)} ETH`);
    assert(bNet === OFFER_B, `B 应全额取回 ${OFFER_B}，实际 ${bNet}`);
    assert(
      (await market.getOffer(nftAddress, tokenId1, buyerB.address))[0] === 0n,
      "取回后出价应清零"
    );
    ok("买家 B 全额取回，一分不少");
  }

  /* ---------------- 步骤 8：C 对 #2 出价 → 卖家拒绝 → 原路退回 ---------------- */
  section(8, `买家 C 对 #${tokenId2} 出价 → 卖家 rejectOffer → 原路退回`);

  await sendTx(market.connect(buyerC).makeOffer(nftAddress, tokenId2, { value: OFFER_C }));
  liveOffers.push({
    nft: nftAddress,
    tokenId: tokenId2,
    bidder: buyerC.address,
    label: "C → #2",
  });
  info("C 出价", `${eth(OFFER_C)} ETH`);

  const cBalBefore = await hre.ethers.provider.getBalance(buyerC.address);
  const rejectReceipt = await sendTx(
    market.connect(seller).rejectOffer(nftAddress, tokenId2, buyerC.address)
  );
  const cBalAfter = await hre.ethers.provider.getBalance(buyerC.address);
  const cNet = cBalAfter - cBalBefore; // C 不是交易发起者，无需扣 gas

  const rejectedEvent = parseEvent(rejectReceipt, market.interface, "OfferRejected");
  const refunded = rejectedEvent ? rejectedEvent.args.refunded : null;
  info("事件 refunded", String(refunded));
  info("C 到账", `+${eth(cNet)} ETH`);
  assert(refunded === true, "普通 EOA 应能正常接收退款");
  assert(cNet === OFFER_C, `C 应全额退回 ${OFFER_C}，实际 ${cNet}`);
  assert(
    (await market.pendingWithdrawals(buyerC.address)) === 0n,
    "正常退回不该进待领池"
  );
  ok("拒绝成功，钱原路退回 C，没有产生待领池记录");

  /* ---------------- 步骤 9：拒收 ETH 的合约出价者 ---------------- */
  section(9, "拒收 ETH 的合约出价者 D：退回失败 → 待领池（交易不 revert）→ D 领回");

  const MockFactory = await hre.ethers.getContractFactory("RejectingOfferBidder");
  const bidderD = await MockFactory.deploy();
  await bidderD.waitForDeployment();
  const bidderDAddr = await bidderD.getAddress();
  info("合约出价者 D", bidderDAddr);
  info("D 的拒收开关", String(await bidderD.rejectEth()));
  await trackPending(bidderDAddr, "合约 D");

  await sendTx(bidderD.makeOffer(marketAddress, nftAddress, tokenId2, { value: OFFER_D }));
  liveOffers.push({
    nft: nftAddress,
    tokenId: tokenId2,
    bidder: bidderDAddr,
    label: "D(合约) → #2",
  });
  info("D 出价", `${eth(OFFER_D)} ETH`);

  // 关键：这次 rejectOffer 必须成功（不 revert），哪怕退款失败
  const rejectDReceipt = await sendTx(
    market.connect(seller).rejectOffer(nftAddress, tokenId2, bidderDAddr)
  );
  const rejectedDEvent = parseEvent(rejectDReceipt, market.interface, "OfferRejected");
  const refundedD = rejectedDEvent ? rejectedDEvent.args.refunded : null;
  const pendingD = await market.pendingWithdrawals(bidderDAddr);

  info("事件 refunded", String(refundedD));
  info("D 的待领池", `${eth(pendingD)} ETH`);
  info("D 合约余额", `${eth(await hre.ethers.provider.getBalance(bidderDAddr))} ETH`);

  assert(refundedD === false, "D 拒收 ETH，refunded 应为 false");
  assert(pendingD === OFFER_D, `待领池应为 ${OFFER_D}，实际 ${pendingD}`);
  assert(
    (await nft.ownerOf(tokenId2)).toLowerCase() === seller.address.toLowerCase(),
    "拒绝不该动 NFT 归属"
  );
  ok("交易没有 revert —— 卖家的处置权没被一个无关合约劫持（防 DoS 成功）");
  warn("如果这里做成 revert，任何人都能用拒收合约出价，让卖家永远无法拒绝任何报价");

  // D 改过自新，自己来领
  await sendTx(bidderD.setRejectEth(false));
  ok("D 已关闭拒收开关");

  const dBalBefore = await hre.ethers.provider.getBalance(bidderDAddr);
  await sendTx(bidderD.claimPending());
  const dBalAfter = await hre.ethers.provider.getBalance(bidderDAddr);
  const dNet = dBalAfter - dBalBefore;

  info("D 到账", `+${eth(dNet)} ETH`);
  info("D 待领池余额", `${eth(await market.pendingWithdrawals(bidderDAddr))} ETH`);
  assert(dNet === OFFER_D, `D 应领回 ${OFFER_D}，实际 ${dNet}`);
  ok("D 从待领池全额领回 —— 这就是 Pull Payment：收款能力与他人操作彻底解耦");

  // 顺带看看 D 在收钱瞬间搞的那次重入探测
  info("重入 withdrawOffer", `成功？ ${await bidderD.withdrawReentrySucceeded()}`);
  info("重入 withdrawPending", `成功？ ${await bidderD.pendingReentrySucceeded()}`);
  assert((await bidderD.withdrawReentrySucceeded()) === false, "重入不应成功");
  assert((await bidderD.pendingReentrySucceeded()) === false, "重入不应成功");
  ok("D 在 receive() 里趁机重入，被 nonReentrant 挡下");

  /* ---------------- 步骤 10：留一笔悬空出价 ---------------- */
  if (hasBuyerB) {
    section(10, `留一笔无人处理的悬空出价（B 对 #${tokenId2} 出价 ${eth(OFFER_B_HANGING)} ETH）`);

    await sendTx(
      market.connect(buyerB).makeOffer(nftAddress, tokenId2, { value: OFFER_B_HANGING })
    );
    liveOffers.push({
      nft: nftAddress,
      tokenId: tokenId2,
      bidder: buyerB.address,
      label: "B → #2(悬空)",
    });
    ok("这笔钱会一直托管在合约里，直到 B 自己 withdrawOffer，或卖家接受/拒绝");
  } else {
    section(10, "悬空出价场景（跳过：未配置 PRIVATE_KEY_3）");
    warn("未配置 PRIVATE_KEY_3 → 留不下买家 B 的悬空出价，最终守恒里「代管项」会是 0");
    warn("守恒等式依然成立，只是少了一个展示维度");
  }

  /* ---------------- 步骤 11：汇总 + 最终守恒 ---------------- */
  section(11, "汇总与最终资金守恒校验");

  const finalState = await conservation("最终结算态");

  console.log("");
  info("累计 gas 消耗", gasTotal.toString());
  info(`#${tokenId1} 持有者`, await nft.ownerOf(tokenId1));
  info(`#${tokenId2} 持有者`, await nft.ownerOf(tokenId2));
  info("本轮新增平台费", `${eth(finalState.fees)} ETH（owner 可调 withdrawFees 提取）`);
  info("本轮新增版税", `${eth(finalState.royalties)} ETH（收款人可调 withdrawRoyalties 提取）`);
  info("本轮合约余额增量", `${eth(finalState.actual)} ETH`);
  if (marketBalBaseline > 0n) {
    info("合约历史余额", `${eth(marketBalBaseline)} ETH（本轮开始前的存量，非本轮产生）`);
  }
  console.log("");

  console.log("============================================================");
  console.log(" 出价功能全流程演练完成");
  console.log("============================================================");
  console.log("");
  console.log("  这次演练串起来的知识点：");
  console.log("    · 出价表按【出价人】分桶，同一枚 NFT 可以被任意多人同时出价");
  console.log("    · 重复出价是累加（加价）；要降价就先取回再重新出价");
  console.log("    · 出价的钱由合约托管，成交 / 撤回 / 拒绝三条路径都能把钱还回去");
  console.log("    · acceptOffer 与 buy 共用 _settleSale()，分账算法只有一份");
  console.log("    · 成交只清被接受的那一笔，其他人自己 withdrawOffer —— 拒绝批量退款");
  console.log("    · 退款失败不 revert，转待领池（Pull Payment），防的是 DoS");
  console.log("    · NFT 易主后旧出价自动失效（StaleOffer），但取回永远畅通");
  console.log("    · 合约余额 = 代管 + 待领池 + 平台费 + 版税，这个等式每次都要成立");
  console.log("");
  console.log("  想看攻击面的另一面，跑单元测试里的恶意合约场景：");
  console.log("    npx hardhat test test/SimpleMarket.test.js");
  console.log("");
}

main().catch((err) => {
  console.error("");
  console.error("× 演练中断：" + (err && err.message ? err.message : err));
  console.error("");
  console.error("  常见原因：");
  console.error("    · 合约尚未编译 → 先跑 npx hardhat compile");
  console.error(
    "    · 找不到部署产物 → 先在目标网络部署两个合约，或用 NFT_ADDRESS / MARKET_ADDRESS 指定"
  );
  console.error("    · 地址上没合约代码 → 部署产物写错网络，或合约已被重置（本地链重启过）");
  console.error("    · 测试币不够 → 给出价账户补币，或调小脚本顶部的出价金额常量");
  console.error("    · 只有 2 个私钥 → 买家 B 场景会自动跳过，不会中断（想跑全套请补 PRIVATE_KEY_3）");
  console.error("    · 守恒校验不通过 → 说明某一步的钱没按预期归位，按步骤日志回查");
  process.exitCode = 1;
});
