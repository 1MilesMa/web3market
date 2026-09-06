/**
 * ============================================================================
 * NFT 市场全流程演练脚本 —— 【请你自己在终端执行，本脚本未被运行过】
 * ============================================================================
 *
 * 运行方式（在项目根目录下）：
 *   npx hardhat run scripts/practice-market.js --network sepolia
 *   （想先在本地练手：npx hardhat run scripts/practice-market.js --network localhost）
 *
 * 前置条件：
 *   1. 已部署 MyNFT 合集（deployments/mynft-<网络>.json 存在，或用 NFT_ADDRESS 指定）
 *   2. 已部署 SimpleMarket（deployments/simplemarket-<网络>.json，或用 MARKET_ADDRESS 指定）
 *   3. .env 里配了两个账户：PRIVATE_KEY（主账户）、PRIVATE_KEY_2（第二账户）
 *
 * 角色分配：
 *   主账户  = NFT 合约 owner（能铸造） + 市场 owner（能提现） + 本次的【买家】
 *   第二账户 = 【卖家】，持有 NFT 并挂单出售
 *
 * 演练路线（每一步都对应一个真实的市场动作或一个真实的坑）：
 *   步骤 0  前置检查：读两个合约地址、给卖家补 gas 费
 *   步骤 1  给卖家铸造一枚 NFT
 *   步骤 2  卖家对市场做单枚 approve（复习上一轮练的授权）
 *   步骤 3  卖家挂单，并验证：挂单不转移 NFT（授权式而非托管式）
 *   步骤 4  反向验证：重复挂单 / 未授权挂单 / 非持有者挂单 都会被拒
 *   步骤 5  反向验证：付款不足会被拒（捕获 InsufficientPayment）
 *   步骤 6  买家购买（故意多付，验证退款）→ 核对钱货两清
 *   步骤 7  验证成交后授权被自动清空
 *   步骤 8  撤单路径：挂单 → 撤单 → 验证不能再买 → 验证撤单不会自动撤销授权
 *   步骤 9  全量授权路径：setApprovalForAll → 挂单 → 购买 → 主动撤销授权
 *   步骤 10 市场 owner 提取累计手续费
 *   步骤 11 汇总：gas 消耗、最终持仓、链上状态
 *
 * ---------------------------------------------------------------------------
 * 【核心知识：一次成交到底发生了什么】
 * ---------------------------------------------------------------------------
 * 一笔 buy() 内部其实是一次原子操作，顺序严格如下：
 *
 *   1. 检查（Checks）
 *      挂单是否有效 / 钱是否够 / 当前持有者是否还是挂单时的卖家
 *   2. 改状态（Effects）
 *      先把挂单置为失效、先把手续费累加
 *   3. 外部调用（Interactions）
 *      a. safeTransferFrom(卖家 → 买家, tokenId)   把 NFT 交给买家
 *      b. call{value: 货款} → 卖家                 把钱给卖家
 *      c. call{value: 多付的部分} → 买家            把零钱退回去
 *
 * 为什么要先改状态再转账？因为第 3 步的转账会把执行权交给别人的代码
 * （如果收款方是合约，它的 receive / onERC721Received 会被回调）。
 * 若此时挂单还有效，对方就能在回调里再次调用 buy()，把同一枚 NFT 反复买、
 * 反复套走 ETH —— 这就是著名的【重入攻击】。
 * 先置失效 + nonReentrant 互斥锁，两道防线一起上，才挡得住。
 *
 * 另一个重点是【原子性】：上面任何一步失败（比如卖家代码拒绝收 ETH），
 * 整笔交易全部回滚 —— 不会出现「NFT 给了买家但卖家没拿到钱」。
 * 本脚本步骤 6 会让你看到每一步的余额变化都是精确对上的。
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

/* ============================ 可调参数 ============================ */
// 卖家（第二账户）gas 费阈值：低于这个值就从主账户转过去
const MIN_BALANCE = hre.ethers.parseEther("0.005");
const GAS_TOPUP = hre.ethers.parseEther("0.01");

// 挂单价格：默认 0.001 ETH（测试网上的小额，够看清手续费计算即可）
const PRICE = process.env.LIST_PRICE
  ? hre.ethers.parseEther(process.env.LIST_PRICE)
  : hre.ethers.parseEther("0.001");

// 步骤 6 故意多付的金额，用来验证退款逻辑
const OVERPAY = hre.ethers.parseEther("0.0005");

const DEMO_URI =
  process.env.MINT_URI ||
  "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/1.json";

const ZERO_ADDRESS = hre.ethers.ZeroAddress;

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
function assert(cond, msg) {
  if (!cond) throw new Error("校验失败 → " + msg);
}

/** 读取部署产物里的合约地址（允许用环境变量覆盖） */
function readDeployment(kind, networkName) {
  const envKey = kind === "nft" ? "NFT_ADDRESS" : "MARKET_ADDRESS";
  if (process.env[envKey]) return process.env[envKey];

  const file = path.join(
    __dirname,
    "..",
    "deployments",
    `${kind === "nft" ? "mynft" : "simplemarket"}-${networkName}.json`
  );
  if (!fs.existsSync(file)) {
    throw new Error(
      `找不到部署产物 ${path.relative(process.cwd(), file)}。\n` +
        `    请先部署合约：npx hardhat run scripts/deploy-${kind === "nft" ? "" : "market"}.js --network ${networkName}\n` +
        `    或设置环境变量 ${envKey}=0x...`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")).address;
}

/**
 * 解码链上 revert：合约用的是自定义错误（custom error），
 * 公共 RPC 常常只回一句 execution reverted，看不到具体原因。
 * 这里从异常对象的各个可能位置取出 data，用合约 ABI 反解成可读的错误名与参数。
 */
function decodeRevert(err, ifaces) {
  const list = Array.isArray(ifaces) ? ifaces : [ifaces];
  const candidates = [
    err && err.data,
    err && err.info && err.info.error && err.data,
    err && err.info && err.info.error && err.info.error.data,
    err && err.error && err.error.data,
    err && err.error && err.error.error && err.error.error.data,
  ].filter(Boolean);

  for (const data of candidates) {
    if (typeof data === "string" && data.startsWith("0x")) {
      for (const iface of list) {
        try {
          const parsed = iface.parseError(data);
          if (parsed) {
            return {
              name: parsed.name,
              args: parsed.args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))),
            };
          }
        } catch (_) {
          /* 这个 iface 解不出来，换下一个 */
        }
      }
    }
  }
  const msg = String((err && err.message) || err);

  // 情况 A：错误信息里直接带了 custom error 文本
  //   例：reverted with custom error 'InsufficientPayment(500000000000000, 1000000000000000)'
  const ce = msg.match(/custom error '([A-Za-z0-9_]+)\(([^)]*)\)'/);
  if (ce) {
    const args = ce[2].trim() ? ce[2].split(",").map((s) => s.trim()) : [];
    return { name: ce[1], args };
  }

  // 情况 B：老式 require 字符串
  const m = msg.match(/reason="([^"]+)"/) || msg.match(/reverted with reason string '([^']+)'/);
  if (m) return { name: m[1], args: [] };

  // 情况 C：只有光秃秃的错误名，没有 data 可解
  const bare = msg.match(/reverted with custom error '([A-Za-z0-9_]+)'/);
  if (bare) return { name: bare[1], args: [] };

  return null;
}

let gasTotal = 0n;

/** 发交易 → 等确认 → 打印结果，并累计 gas */
async function sendTx(txPromise) {
  const tx = await txPromise;
  info("交易哈希", tx.hash);
  console.log("    等待区块确认...");
  const receipt = await tx.wait();
  gasTotal += receipt.gasUsed;
  info("已确认", `区块 ${receipt.blockNumber} | gas ${receipt.gasUsed.toString()}`);
  return receipt;
}

/** 期望某笔交易失败，并打印解码后的错误名 */
async function expectRevert(label, txPromise, ifaces) {
  try {
    const tx = await txPromise;
    // 有些环境下要等 wait 才会抛，这里主动等一下
    const r = await tx.wait();
    gasTotal += r.gasUsed;
    throw new Error(`${label}：本应失败，却成功了`);
  } catch (err) {
    const decoded = decodeRevert(err, ifaces);
    if (decoded) {
      const args = decoded.args.length ? `(${decoded.args.join(", ")})` : "";
      ok(`${label}：按预期被拒绝 → ${decoded.name}${args}`);
      return decoded;
    }
    // 没解出来但确实是失败了，也算通过，如实打印原文
    const raw = String((err && err.shortMessage) || err.message || err);
    if (/revert|reverted|失败|本应失败/.test(raw)) {
      warn(`${label}：交易失败（未能解码具体错误）→ ${raw.slice(0, 160)}`);
      return null;
    }
    throw err;
  }
}

/* ============================ 主流程 ============================ */
async function main() {
  const networkName = hre.network.name;
  const { chainId } = await hre.ethers.provider.getNetwork();
  const signers = await hre.ethers.getSigners();

  if (signers.length < 2) {
    throw new Error(
      "只找到 1 个账户。市场演练需要买卖双方两个账户，请在 .env 里配置 PRIVATE_KEY 与 PRIVATE_KEY_2。"
    );
  }
  const buyer = signers[0]; // 主账户：NFT owner + 市场 owner + 本次买家
  const seller = signers[1]; // 第二账户：卖家

  const nftAddress = readDeployment("nft", networkName);
  const marketAddress = readDeployment("market", networkName);

  const nft = await hre.ethers.getContractAt("MyNFT", nftAddress);
  const market = await hre.ethers.getContractAt("SimpleMarket", marketAddress);

  // 两个合约的 ABI 都带上，revert 可能来自任一方
  const ifaces = [nft.interface, market.interface];

  console.log("============================================================");
  console.log(" NFT 市场全流程演练（挂单 / 购买 / 撤单 / 提现）");
  console.log("============================================================");
  info("网络", `${networkName} (chainId: ${chainId.toString()})`);
  info("NFT 合约", nftAddress);
  info("市场合约", marketAddress);
  info("买家(主账户)", buyer.address);
  info("卖家(第二账户)", seller.address);

  /* ---------------- 步骤 0：前置检查 ---------------- */
  section(0, "前置检查：合约状态与卖家 gas 费");

  const nftOwner = await nft.owner();
  const marketOwner = await market.owner();
  const feeBps = await market.feeBps();
  info("NFT 合约 owner", nftOwner);
  info("市场 owner", marketOwner);
  info("平台手续费", `${feeBps.toString()} bps（${(Number(feeBps) / 100).toFixed(2)}%）`);

  assert(
    nftOwner.toLowerCase() === buyer.address.toLowerCase(),
    `主账户 ${buyer.address} 不是 NFT 合约 owner（${nftOwner}），无法铸造 NFT。`
  );
  assert(
    marketOwner.toLowerCase() === buyer.address.toLowerCase(),
    `主账户 ${buyer.address} 不是市场 owner（${marketOwner}），最后无法演示提现手续费。\n` +
      "    可以用 MARKET_ADDRESS 指向你自己部署、且 owner 是主账户的市场合约。"
  );
  ok("两个合约的 owner 都是主账户");

  const sellerBalance = await hre.ethers.provider.getBalance(seller.address);
  info("卖家余额", `${hre.ethers.formatEther(sellerBalance)} ETH`);
  if (sellerBalance < MIN_BALANCE) {
    console.log("    卖家 gas 费不足，从主账户转入...");
    await sendTx(
      buyer.sendTransaction({ to: seller.address, value: GAS_TOPUP })
    );
    ok(`已转入 ${hre.ethers.formatEther(GAS_TOPUP)} ETH`);
  } else {
    ok("卖家 gas 费充足");
  }

  const buyerBalance = await hre.ethers.provider.getBalance(buyer.address);
  info("买家余额", `${hre.ethers.formatEther(buyerBalance)} ETH`);

  /* ---------------- 步骤 1：给卖家铸造一枚 NFT ---------------- */
  section(1, "给卖家铸造一枚 NFT（卖家手上得先有货）");

  const beforeSupply = await nft.totalSupply();
  info("当前 totalSupply", beforeSupply.toString());

  await sendTx(nft.connect(buyer).safeMint(seller.address, DEMO_URI));

  const afterSupply = await nft.totalSupply();
  const newTokenId = afterSupply; // 本合约 ID 从 1 递增，且未销毁时等于 totalSupply
  info("铸造后 totalSupply", afterSupply.toString());
  info("新 tokenId", newTokenId.toString());
  assert(
    (await nft.ownerOf(newTokenId)).toLowerCase() === seller.address.toLowerCase(),
    `#${newTokenId} 的持有者不是卖家`
  );
  ok(`#${newTokenId} 已铸造给卖家`);

  /* ---------------- 步骤 2：卖家授权市场 ---------------- */
  section(2, "卖家对市场做单枚 approve（复习上一轮练的授权）");

  info("授权前 getApproved", await nft.getApproved(newTokenId));
  await sendTx(nft.connect(seller).approve(marketAddress, newTokenId));

  const approved = await nft.getApproved(newTokenId);
  info("授权后 getApproved", approved);
  assert(
    approved.toLowerCase() === marketAddress.toLowerCase(),
    `授权未生效，getApproved 应为 ${marketAddress}`
  );
  ok("市场已获得这枚 NFT 的转移权");

  /* ---------------- 步骤 3：挂单，并验证 NFT 没被转移 ---------------- */
  section(3, `卖家挂单：#${newTokenId} 售价 ${hre.ethers.formatEther(PRICE)} ETH`);

  info("挂单价", `${hre.ethers.formatEther(PRICE)} ETH`);
  // 注意：这里必须用 quoteWithRoyalty。
  // 合约里那个只算平台费的 quote(price) 已在本次重构中彻底删除——
  // 它漏算版税，与链上 _settleSale 的真实分账算法脱节；
  // quoteWithRoyalty() 与 _settleSale 共用 _splitProceeds，
  // 所以"前端看到的预估"和"链上实际扣款"永远一致。
  const [fee, royalty, royaltyReceiver, proceeds] = await market.quoteWithRoyalty(
    nftAddress,
    newTokenId,
    PRICE
  );
  info("预计平台费", `${hre.ethers.formatEther(fee)} ETH`);
  info("预计创作者版税", `${hre.ethers.formatEther(royalty)} ETH`);
  info("版税收款方", royaltyReceiver);
  info("卖家预计实得", `${hre.ethers.formatEther(proceeds)} ETH`);

  await sendTx(market.connect(seller).list(nftAddress, newTokenId, PRICE));

  const [listSeller, listPrice, listActive] = await market.getListing(nftAddress, newTokenId);
  info("挂单卖家", listSeller);
  info("挂单价格", `${hre.ethers.formatEther(listPrice)} ETH`);
  info("是否有效", String(listActive));
  assert(listActive === true, "挂单后 active 应为 true");
  assert(listPrice === PRICE, "挂单价格与设置的不一致");

  // 关键认知点：授权式市场挂单时不转移资产
  const holder = await nft.ownerOf(newTokenId);
  const marketHolding = await nft.balanceOf(marketAddress);
  info("NFT 当前持有者", holder);
  info("市场合约持有数", marketHolding.toString());
  assert(
    holder.toLowerCase() === seller.address.toLowerCase(),
    "挂单不该转移 NFT，持有者仍应是卖家"
  );
  ok("挂单成功，且 NFT 仍在卖家手上（授权式，不是托管式）");

  /* ---------------- 步骤 4：三种非法挂单都应被拒 ---------------- */
  section(4, "反向验证：非法挂单会被合约拒绝");

  // 4.1 重复挂单
  await expectRevert(
    "重复挂同一枚 NFT",
    market.connect(seller).list(nftAddress, newTokenId, PRICE),
    ifaces
  );

  // 4.2 未授权就挂单：先铸一枚新的给卖家（但不授权）
  await sendTx(nft.connect(buyer).safeMint(seller.address, DEMO_URI));
  const unapprovedId = await nft.totalSupply();
  info("新铸 tokenId", `${unapprovedId.toString()}（不授权，用于测试）`);
  await expectRevert(
    "未授权就挂单",
    market.connect(seller).list(nftAddress, unapprovedId, PRICE),
    ifaces
  );

  // 4.3 非持有者挂单
  await expectRevert(
    "非持有者挂别人的 NFT",
    market.connect(buyer).list(nftAddress, newTokenId, PRICE),
    ifaces
  );

  /* ---------------- 步骤 5：付款不足应被拒 ---------------- */
  section(5, "反向验证：付款不足会被拒绝");

  const shortPay = PRICE / 2n;
  info("尝试支付", `${hre.ethers.formatEther(shortPay)} ETH（挂单价的一半）`);
  await expectRevert(
    "付款不足",
    market.connect(buyer).buy(nftAddress, newTokenId, { value: shortPay }),
    ifaces
  );

  /* ---------------- 步骤 6：正常购买（故意多付，验证退款） ---------------- */
  section(6, `买家购买 #${newTokenId}（故意多付，验证退款）`);

  const sent = PRICE + OVERPAY;
  info("实际发送", `${hre.ethers.formatEther(sent)} ETH`);
  info("挂单价", `${hre.ethers.formatEther(PRICE)} ETH`);
  info("预期退回", `${hre.ethers.formatEther(OVERPAY)} ETH`);

  const sellerBalBefore = await hre.ethers.provider.getBalance(seller.address);
  const buyerBalBefore = await hre.ethers.provider.getBalance(buyer.address);
  const marketBalBefore = await hre.ethers.provider.getBalance(marketAddress);

  const receipt = await sendTx(
    market.connect(buyer).buy(nftAddress, newTokenId, { value: sent })
  );

  const sellerBalAfter = await hre.ethers.provider.getBalance(seller.address);
  const buyerBalAfter = await hre.ethers.provider.getBalance(buyer.address);
  const marketBalAfter = await hre.ethers.provider.getBalance(marketAddress);

  // 卖家的净收益（卖家不是交易发起者，不含 gas 干扰，最干净）
  const sellerGain = sellerBalAfter - sellerBalBefore;
  // 买家的净支出需要扣掉 gas，用收据算
  const gasCost = receipt.gasUsed * receipt.gasPrice;
  const buyerNetSpend = buyerBalBefore - buyerBalAfter - gasCost;
  // 平台费和版税都先滞留在合约里（Pull Payment），所以市场余额增加的是两者之和
  const marketGain = marketBalAfter - marketBalBefore;

  console.log("");
  info("卖家余额变化", `+${hre.ethers.formatEther(sellerGain)} ETH`);
  info("买家净支出", `-${hre.ethers.formatEther(buyerNetSpend)} ETH（已扣除 gas）`);
  info("市场合约留存", `+${hre.ethers.formatEther(marketGain)} ETH（平台费 + 版税，均走 Pull Payment）`);
  info("买家 gas 花费", `${hre.ethers.formatEther(gasCost)} ETH`);
  console.log("");

  assert(sellerGain === proceeds, `卖家实得应为 ${proceeds}，实际 ${sellerGain}`);
  assert(buyerNetSpend === PRICE, `买家净支出应恰为挂单价 ${PRICE}，实际 ${buyerNetSpend}`);
  assert(
    marketGain === fee + royalty,
    `市场应留下 平台费+版税 = ${fee + royalty}，实际 ${marketGain}`
  );
  ok("卖家收到扣费后货款，买家多付的部分已全额退回，市场只留平台费+版税");

  const finalHolder = await nft.ownerOf(newTokenId);
  info("NFT 当前持有者", finalHolder);
  assert(
    finalHolder.toLowerCase() === buyer.address.toLowerCase(),
    "成交后 NFT 应归买家"
  );
  ok("NFT 已转到买家手上，钱货两清");

  const [, , activeAfterSale] = await market.getListing(nftAddress, newTokenId);
  assert(activeAfterSale === false, "成交后挂单应失效");
  ok("挂单已失效，同一枚无法被二次购买");

  /* ---------------- 步骤 7：成交后授权被清空 ---------------- */
  section(7, "验证成交后授权被自动清空（OZ v5 行为）");

  const approvedAfterSale = await nft.getApproved(newTokenId);
  info("成交后 getApproved", approvedAfterSale);
  assert(
    approvedAfterSale === ZERO_ADDRESS,
    `成交后授权应被清空，实际为 ${approvedAfterSale}`
  );
  ok("转移即清授权 —— 这正是上一轮亲手验证过的规则");

  /* ---------------- 步骤 8：撤单路径 ---------------- */
  section(8, "撤单路径：挂单 → 撤单 → 无法再购买");

  // 用步骤 4.2 铸出的那枚（还没授权），先授权再挂单
  await sendTx(nft.connect(seller).approve(marketAddress, unapprovedId));
  await sendTx(market.connect(seller).list(nftAddress, unapprovedId, PRICE));
  ok(`#${unapprovedId} 已挂单`);

  await sendTx(market.connect(seller).cancel(nftAddress, unapprovedId));
  const [, , activeAfterCancel] = await market.getListing(nftAddress, unapprovedId);
  assert(activeAfterCancel === false, "撤单后 active 应为 false");
  ok("撤单成功");

  await expectRevert(
    "撤单后再购买",
    market.connect(buyer).buy(nftAddress, unapprovedId, { value: PRICE }),
    ifaces
  );

  // 重要的安全提醒点：撤单不会自动撤销授权
  const stillApproved = await nft.getApproved(unapprovedId);
  info("撤单后 getApproved", stillApproved);
  if (stillApproved.toLowerCase() === marketAddress.toLowerCase()) {
    warn("撤单【不会】自动撤销授权 —— 市场对这枚 NFT 的权限仍然开着");
    await sendTx(nft.connect(seller).approve(ZERO_ADDRESS, unapprovedId));
    ok("已手动撤销授权（approve 零地址）");
  }

  /* ---------------- 步骤 9：全量授权路径 ---------------- */
  section(9, "全量授权路径：setApprovalForAll → 挂单 → 购买 → 撤销");

  await sendTx(nft.connect(buyer).safeMint(seller.address, DEMO_URI));
  const thirdId = await nft.totalSupply();
  info("新铸 tokenId", thirdId.toString());

  await sendTx(nft.connect(seller).setApprovalForAll(marketAddress, true));
  const isApprovedAll = await nft.isApprovedForAll(seller.address, marketAddress);
  assert(isApprovedAll === true, "全量授权未生效");
  ok("卖家已开启全量授权（此时市场能转走卖家名下任意一枚）");

  // 全量授权下无需再单独 approve，直接挂单
  await sendTx(market.connect(seller).list(nftAddress, thirdId, PRICE));
  ok(`#${thirdId} 在全量授权下直接挂单成功`);

  await sendTx(market.connect(buyer).buy(nftAddress, thirdId, { value: PRICE }));
  assert(
    (await nft.ownerOf(thirdId)).toLowerCase() === buyer.address.toLowerCase(),
    "购买后 NFT 应归买家"
  );
  ok("成交完成");

  // 全量授权不会因转移而失效，必须主动撤销
  const stillAll = await nft.isApprovedForAll(seller.address, marketAddress);
  info("成交后全量授权状态", String(stillAll));
  if (stillAll) {
    warn("全量授权【不会】因为 NFT 被卖掉而失效 —— 这就是它最危险的地方");
    await sendTx(nft.connect(seller).setApprovalForAll(marketAddress, false));
    ok("已主动撤销全量授权");
  }

  /* ---------------- 步骤 10：owner 提现手续费 ---------------- */
  section(10, "市场 owner 提取累计手续费");

  const accumulated = await market.accumulatedFees();
  info("累计手续费", `${hre.ethers.formatEther(accumulated)} ETH`);

  if (accumulated === 0n) {
    warn("累计手续费为 0，跳过提现（withdrawFees 会 revert NothingToWithdraw）");
  } else {
    const ownerBalBefore = await hre.ethers.provider.getBalance(buyer.address);
    const r = await sendTx(market.connect(buyer).withdrawFees(buyer.address));
    const ownerBalAfter = await hre.ethers.provider.getBalance(buyer.address);
    const gas = r.gasUsed * r.gasPrice;
    const net = ownerBalAfter - ownerBalBefore + gas; // 补回 gas 才是真实到账

    info("提现到账", `${hre.ethers.formatEther(net)} ETH`);
    assert(net === accumulated, `提现金额应等于累计手续费 ${accumulated}，实际 ${net}`);
    assert((await market.accumulatedFees()) === 0n, "提现后累计手续费应归零");
    ok("手续费已提取，市场合约不再滞留资金");
  }

  /* ---------------- 步骤 11：版税收款方提现（EIP-2981 的另一半） ---------------- */
  section(11, "版税收款方提取累计版税（Pull Payment 的另一半）");

  const royAccumulated = await market.pendingRoyalties(royaltyReceiver);
  info("待领版税", `${hre.ethers.formatEther(royAccumulated)} ETH`);

  if (royAccumulated === 0n) {
    warn("待领版税为 0，跳过提现（withdrawRoyalties 会 revert NothingToWithdraw）");
  } else if (royaltyReceiver.toLowerCase() !== buyer.address.toLowerCase()) {
    warn(`版税收款方 ${royaltyReceiver} 不是本演练的买家账户，跳过提现演示`);
    warn("真实场景里创作者自己调用 withdrawRoyalties() 就能领走属于自己的那一份");
  } else {
    // withdrawRoyalties 没有 onlyOwner，也没有 to 参数：
    // 谁被 NFT 指定为版税收款方，谁就能且只能提走自己的那份
    const royBalBefore = await hre.ethers.provider.getBalance(royaltyReceiver);
    const r2 = await sendTx(market.connect(buyer).withdrawRoyalties());
    const royBalAfter = await hre.ethers.provider.getBalance(royaltyReceiver);
    const royGas = r2.gasUsed * r2.gasPrice;
    const royNet = royBalAfter - royBalBefore + royGas; // 补回 gas 才是真实到账

    info("版税到账", `${hre.ethers.formatEther(royNet)} ETH`);
    assert(royNet === royAccumulated, `版税到账应等于待领 ${royAccumulated}，实际 ${royNet}`);
    assert(
      (await market.pendingRoyalties(royaltyReceiver)) === 0n,
      "提现后待领版税应归零"
    );
    ok("创作者版税已提取，且这笔钱不经过 owner，收款方自己就能领");
  }

  /* ---------------- 步骤 12：汇总 ---------------- */
  section(12, "演练汇总");

  const sellerNfts = await nft.balanceOf(seller.address);
  const buyerNfts = await nft.balanceOf(buyer.address);
  const totalSupply = await nft.totalSupply();

  console.log("");
  info("累计 gas 消耗", gasTotal.toString());
  info("卖家持有 NFT", sellerNfts.toString());
  info("买家持有 NFT", buyerNfts.toString());
  info("NFT 总供给", totalSupply.toString());
  info("市场累计手续费", `${hre.ethers.formatEther(await market.accumulatedFees())} ETH`);
  info("市场合约余额", `${hre.ethers.formatEther(await hre.ethers.provider.getBalance(marketAddress))} ETH`);
  console.log("");

  console.log("============================================================");
  console.log(" 全流程演练完成");
  console.log("============================================================");
  console.log("");
  console.log("  这次演练串起来的知识点：");
  console.log("    · 授权式市场：挂单不转移资产，成交瞬间才动 NFT");
  console.log("    · approve 单枚 vs setApprovalForAll 全量：后者不会自动失效，必须主动撤销");
  console.log("    · 成交后授权自动清空（单枚），但全量授权不受影响");
  console.log("    · 撤单不会撤销授权 —— 链上权限要自己收回");
  console.log("    · 买卖 + 退款在同一笔交易里原子完成，多付的钱一分不少退回");
  console.log("    · 平台手续费按基点计算，走 Pull Payment 由 owner 主动提取");
  console.log("");
  console.log("  想看防线的另一面，跑单元测试里的攻击场景：");
  console.log("    npx hardhat test test/SimpleMarket.test.js");
  console.log("");
  if (networkName === "sepolia") {
    console.log("  本次涉及的交易可在区块浏览器核对：");
    console.log(`    https://sepolia.etherscan.io/address/${marketAddress}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error("");
  console.error("× 演练中断：" + (err && err.message ? err.message : err));
  console.error("");
  console.error("  常见原因：");
  console.error("    · 还没部署 MyNFT 或 SimpleMarket → 先跑对应的 deploy 脚本");
  console.error("    · .env 里缺少 PRIVATE_KEY_2 → 演练需要买卖双方两个账户");
  console.error("    · 账户 Sepolia 测试币不足 → 去水龙头领一些再跑");
  process.exitCode = 1;
});
