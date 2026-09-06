// SPDX-License-Identifier: MIT
/**
 * demo-full-flow.js —— 一条命令跑通「业务 + 治理」完整闭环（本地 hardhat 内存链，零 gas）
 *
 * 跑法（项目根目录，PowerShell）：
 *   npx hardhat run scripts/demo-full-flow.js
 * 注意：不要加 --network，默认就是 hardhat 内存链；每次跑都是全新链，不会碰 Sepolia 上的真实合约。
 *
 * 剧本（七个阶段，每阶段打印关键状态变化）：
 *   阶段 0  认识演员：部署者/卖家、买家、多签三成员、创作者（版税收款方）、无关路人
 *   阶段 1  部署 MyNFT → 铸造 NFT #1 → 读出版税配置
 *   阶段 2  部署 SimpleMarket（费率 250 bps）→ 卖家授权 → 挂单
 *   阶段 3  买家按标价买入 → 打印三方分账（平台费 / 创作者版税 / 卖家实得）
 *   阶段 4  加演：出价成交（makeOffer → acceptOffer），验证与挂单共用同一套分账
 *   阶段 5  治理第一层：市场 owner 由 deployer 移交给 2/3 多签（提案 → 2 票 → 执行）
 *   阶段 6  治理第二层：多签把 owner 移交给时间锁（多签排队 → 公示 300 秒 → 任何人执行）
 *   阶段 7  治理实战：改费率 250 → 300 bps 走完整时间锁；再改回 250，零残留收尾
 *
 * 设计原则（与项目其它脚本一致）：
 *   - 每一步都读链上真实状态后打印，不打印推测值
 *   - 断言失败会累计并在结尾汇总，退出码非 0，方便一眼看出没跑通
 */
const hre = require("hardhat");
const { ethers, network } = hre;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const ZERO = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;
const PRICE = ethers.parseEther("1"); // 挂单价 1 ETH
const OFFER_PRICE = ethers.parseEther("1.2"); // 出价 1.2 ETH
const FEE_BPS = 250; // 初始平台费率 2.5%
const NEW_FEE_BPS = 300; // 治理后要改成的 3%
const MAX_SUPPLY = 10000;
const ROYALTY_NUMERATOR = 500; // EIP-2981：分母 10000 → 5%
const MIN_DELAY = 300; // 时间锁公示期 300 秒（与 Sepolia 部署一致）
const STATE_NAME = ["Unset", "Waiting", "Ready", "Done"];

// ---------------------------------------------------------------------------
// 打印与断言工具
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function line(ch = "-") {
  console.log(ch.repeat(78));
}
function title(text) {
  console.log("");
  line("=");
  console.log(text);
  line("=");
}
function step(text) {
  console.log(`\n  ▶ ${text}`);
}
function info(label, value) {
  console.log(`      ${label.padEnd(30, " ")} ${value}`);
}
function changed(label, before, after) {
  console.log(`      ${label.padEnd(30, " ")} ${before}  →  ${after}`);
}
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`      ✓ ${name}${detail ? " — " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`      ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}
const eth = (v) => `${ethers.formatEther(v)} ETH`;
const short = (a) => `${String(a).slice(0, 10)}…${String(a).slice(-6)}`;

async function balanceOf(addr) {
  return ethers.provider.getBalance(addr);
}

/** 快进链上时间（本地链专用，真实网络请用真等） */
async function fastForward(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

/** 断言某笔交易被拒绝，并打印被拒原因（取首行，避免刷屏） */
async function expectReverted(promiseFactory, label) {
  try {
    const tx = await promiseFactory();
    if (tx && tx.wait) await tx.wait();
    check(label, false, "本该被拒绝却成功了");
    return false;
  } catch (err) {
    const msg = (err.shortMessage || err.message || String(err)).split("\n")[0];
    check(label, true, `已拒绝（${msg.slice(0, 70)}）`);
    return true;
  }
}

/**
 * 多签三步走：成员 A 提交（提交即投第一票）→ 成员 B 补第二票 → 任何人触发执行
 * 返回提案编号 txId
 */
async function multisigRun(ms, submitter, confirmer, executor, to, data, label) {
  const txId = Number(await ms.getTransactionCount());
  step(`多签提案 #${txId}：${label}`);
  await (await ms.connect(submitter).submit(to, 0, data)).wait();
  let t = await ms.getTransaction(txId);
  info("提交后票数", `${t.confirmations} / ${await ms.threshold()}（提交即投第一票）`);
  await (await ms.connect(confirmer).confirm(txId)).wait();
  t = await ms.getTransaction(txId);
  info("第二票后票数", `${t.confirmations} / ${await ms.threshold()}`);
  await (await ms.connect(executor).execute(txId)).wait();
  t = await ms.getTransaction(txId);
  info("执行后", `票数 ${t.confirmations}，executed=${t.executed}`);
  return txId;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const [deployer, buyer, ms1, ms2, ms3, creator, outsider] = await ethers.getSigners();

  title("NFT 市场 · 业务与治理完整闭环演示（本地 hardhat 内存链）");
  const net = await ethers.provider.getNetwork();
  info("网络", `${network.name}（chainId ${net.chainId}）`);
  info("时间锁公示期", `${MIN_DELAY} 秒`);
  console.log("");
  console.log("  【演员表】");
  console.log(`      部署者 / 初始 owner / 卖家 : ${deployer.address}`);
  console.log(`      买家                       : ${buyer.address}`);
  console.log(`      多签成员 1 / 2 / 3         : ${ms1.address} / ${ms2.address} / ${ms3.address}`);
  console.log(`      创作者（版税收款方）        : ${creator.address}`);
  console.log(`      路人甲（验证开放执行）      : ${outsider.address}`);

  // =========================================================================
  title("阶段 1  部署 MyNFT 并铸造第一枚 NFT");
  // =========================================================================
  const MyNFT = await ethers.getContractFactory("MyNFT");
  const nft = await MyNFT.deploy(deployer.address, MAX_SUPPLY, creator.address, ROYALTY_NUMERATOR);
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  step("部署 MyNFT");
  info("合约地址", nftAddr);
  info("名称 / 代号", `${await nft.name()} / ${await nft.symbol()}`);
  info("最大供应量", await nft.maxSupply());
  info("owner", await nft.owner());

  step("铸造 NFT（safeMint 给卖家）");
  const mintTx = await nft.connect(deployer).safeMint(deployer.address, "ipfs://demo/nft-1.json");
  const mintReceipt = await mintTx.wait();
  const tokenId = Number(await nft.totalMinted());
  changed("tokenId", "（铸造前）totalMinted=0", `totalMinted=${tokenId}`);
  info("持有者", await nft.ownerOf(tokenId));
  info("metadata", await nft.tokenURI(tokenId));
  info("本次铸造 gas", mintReceipt.gasUsed);

  const royaltyInfo = await nft.royaltyInfo(tokenId, PRICE);
  info("版税（EIP-2981）", `收款方 ${royaltyInfo[0]}，1 ETH 成交应收 ${eth(royaltyInfo[1])}`);
  check("NFT 已铸造给卖家", (await nft.ownerOf(tokenId)) === deployer.address);
  check("版税收款方是创作者账号", royaltyInfo[0] === creator.address);

  // =========================================================================
  title("阶段 2  部署 SimpleMarket → 授权 → 挂单");
  // =========================================================================
  const Market = await ethers.getContractFactory("SimpleMarket");
  const market = await Market.deploy(deployer.address, FEE_BPS);
  await market.waitForDeployment();
  const marketAddr = await market.getAddress();
  step("部署 SimpleMarket");
  info("合约地址", marketAddr);
  info("owner", await market.owner());
  changed("平台费率", "（部署参数）", `${await market.feeBps()} bps = 2.5%`);
  info("费率硬上限", `${await market.MAX_FEE_BPS()} bps = 10%（合约常量，owner 也改不动）`);

  step("卖家把 NFT #1 授权给市场（approve）");
  await (await nft.connect(deployer).approve(marketAddr, tokenId)).wait();
  info("授权后 getApproved", await nft.getApproved(tokenId));
  check("市场已拿到授权", (await nft.getApproved(tokenId)) === marketAddr);

  step(`卖家挂单，标价 ${eth(PRICE)}`);
  await (await market.connect(deployer).list(nftAddr, tokenId, PRICE)).wait();
  let listing = await market.getListing(nftAddr, tokenId);
  changed("挂单状态", "active=false", `active=${listing.active}`);
  info("挂单卖家 / 价格", `${listing.seller} / ${eth(listing.price)}`);
  check("挂单已生效", listing.active && listing.price === PRICE);

  // 未授权不能挂别人的单
  await expectReverted(
    () => market.connect(outsider).list(nftAddr, tokenId, PRICE),
    "路人甲对不属于自己的 NFT 挂单被拒"
  );

  // =========================================================================
  title("阶段 3  买家按标价买入（挂单成交）");
  // =========================================================================
  step(`买家支付 ${eth(PRICE)} 调用 buy()`);
  const buyerBefore = await balanceOf(buyer.address);
  const creatorBefore = await balanceOf(creator.address);
  const marketBefore = await balanceOf(marketAddr);

  await (await market.connect(buyer).buy(nftAddr, tokenId, { value: PRICE })).wait();

  const feeAfter = await market.accumulatedFees();
  const royaltyAfter = await market.pendingRoyalties(creator.address);
  const expectedFee = (PRICE * BigInt(FEE_BPS)) / 10000n;
  const expectedRoyalty = (PRICE * BigInt(ROYALTY_NUMERATOR)) / 10000n;
  const expectedSeller = PRICE - expectedFee - expectedRoyalty;

  changed("NFT #1 持有者", "卖家 deployer", `${await nft.ownerOf(tokenId)}`);
  changed("市场合约余额", eth(marketBefore), eth(await balanceOf(marketAddr)));
  info("平台费（待 owner 提取）", `${eth(feeAfter)}  → accumulatedFees 累计待提`);
  info("创作者版税（待自提）", `${eth(royaltyAfter)}  → pendingRoyalties[creator]`);
  info("卖家实得（已实时到账）", eth(expectedSeller));
  info("买家支出", eth(buyerBefore - (await balanceOf(buyer.address))));

  check("NFT 已转到买家名下", (await nft.ownerOf(tokenId)) === buyer.address);
  check("挂单已失效", !(await market.getListing(nftAddr, tokenId))[2]);
  check("平台费 = 2.5%", feeAfter === expectedFee, `${eth(feeAfter)}`);
  check("创作者版税 = 5%", royaltyAfter === expectedRoyalty, `${eth(royaltyAfter)}`);
  check("分账守恒：费 + 版税 + 卖家 = 成交价", feeAfter + royaltyAfter + expectedSeller === PRICE);
  check("版税收款方余额此刻未变（Pull Payment，需自提）", (await balanceOf(creator.address)) === creatorBefore);

  step("创作者调用 withdrawRoyalties() 提走版税");
  const wdTx = await market.connect(creator).withdrawRoyalties();
  const wdReceipt = await wdTx.wait();
  // 提现这笔交易是创作者自己发的，余额增量 = 版税 - 自己付的 gas
  const wdGas = wdReceipt.gasUsed * wdReceipt.gasPrice;
  changed("创作者余额", eth(creatorBefore), eth(await balanceOf(creator.address)));
  info("本次提现 gas", wdGas);
  check(
    "版税已到账（扣掉自付 gas 后与应收一致）",
    (await balanceOf(creator.address)) - creatorBefore + wdGas === expectedRoyalty,
    `应收 ${eth(expectedRoyalty)}`
  );

  // =========================================================================
  title("阶段 4  加演：出价成交（买家定价、持有者接受）");
  // =========================================================================
  step(`多签成员 1 对 NFT #1 出价 ${eth(OFFER_PRICE)}（ETH 真的托管进合约）`);
  await (await market.connect(ms1).makeOffer(nftAddr, tokenId, { value: OFFER_PRICE })).wait();
  let offer = await market.getOffer(nftAddr, tokenId, ms1.address);
  info("托管中的出价", eth(offer.amount));
  info("出价时记录的持有者", offer.targetOwner);
  check("出价 ETH 已进合约托管", offer.amount === OFFER_PRICE);
  check("市场合约余额同步增加", (await balanceOf(marketAddr)) - marketBefore >= PRICE);

  step("持有者（买家）授权市场后 acceptOffer 成交");
  await (await nft.connect(buyer).approve(marketAddr, tokenId)).wait();
  const sellerBeforeAccept = await balanceOf(buyer.address);
  await (await market.connect(buyer).acceptOffer(nftAddr, tokenId, ms1.address)).wait();
  changed("NFT #1 持有者", "买家 buyer", `${await nft.ownerOf(tokenId)}`);
  changed("卖家实得（买家收钱）", eth(sellerBeforeAccept), eth(await balanceOf(buyer.address)));
  info("累计平台费", eth(await market.accumulatedFees()));
  info("累计版税（待提）", eth(await market.pendingRoyalties(creator.address)));
  check("出价已清零", (await market.getOffer(nftAddr, tokenId, ms1.address))[0] === 0n);
  check("NFT 已转给出价人", (await nft.ownerOf(tokenId)) === ms1.address);
  check("两笔成交共用同一套分账（平台费 = 2.5% × 2）", (await market.accumulatedFees()) === expectedFee + (OFFER_PRICE * BigInt(FEE_BPS)) / 10000n);

  // =========================================================================
  title("阶段 5  治理第一层：市场 owner 移交给 2/3 多签");
  // =========================================================================
  const MultiSig = await ethers.getContractFactory("MultiSigOwner");
  const multisig = await MultiSig.deploy([ms1.address, ms2.address, ms3.address], 2);
  await multisig.waitForDeployment();
  const msAddr = await multisig.getAddress();
  step("部署 MultiSigOwner（3 成员 / 阈值 2）");
  info("多签地址", msAddr);
  info("阈值", await multisig.threshold());

  step("现任 owner 提名多签接任（Ownable2Step：提名 ≠ 生效）");
  await (await market.connect(deployer).transferOwnership(msAddr)).wait();
  info("pendingOwner", await market.pendingOwner());
  info("owner（仍是 deployer）", await market.owner());
  check("提名期间权力未真空", (await market.owner()) === deployer.address);

  const acceptData = market.interface.encodeFunctionData("acceptOwnership", []);
  await multisigRun(
    multisig,
    ms1,
    ms2,
    ms3,
    marketAddr,
    acceptData,
    "acceptOwnership() —— 多签接受市场 owner"
  );
  changed("市场 owner", "deployer", `${await market.owner()}`);
  check("多签已成为市场 owner", (await market.owner()) === msAddr);

  await expectReverted(
    () => market.connect(deployer).setFeeBps(999),
    "老 owner 单人想直接改费率被拒"
  );

  // =========================================================================
  title("阶段 6  治理第二层：多签把 owner 移交给时间锁（排队 → 公示 → 执行）");
  // =========================================================================
  const Timelock = await ethers.getContractFactory("MarketTimelock");
  const timelock = await Timelock.deploy(MIN_DELAY, [msAddr], [ZERO], ZERO);
  await timelock.waitForDeployment();
  const tlAddr = await timelock.getAddress();
  step("部署 MarketTimelock（minDelay 300 秒）");
  info("时间锁地址", tlAddr);
  info("最小公示延迟", `${await timelock.getMinDelay()} 秒`);
  check("多签拥有 PROPOSER_ROLE", await timelock.hasRole(await timelock.PROPOSER_ROLE(), msAddr));
  check("多签同时拥有 CANCELLER_ROLE（可反悔）", await timelock.hasRole(await timelock.CANCELLER_ROLE(), msAddr));
  check("执行权对所有人开放（address(0) 持 EXECUTOR_ROLE）", await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ZERO));
  check("未留管理员后门", !(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)));

  step("多签提名时间锁接任 owner");
  await multisigRun(
    multisig,
    ms1,
    ms2,
    ms3,
    marketAddr,
    market.interface.encodeFunctionData("transferOwnership", [tlAddr]),
    "transferOwnership(时间锁)"
  );
  info("pendingOwner", await market.pendingOwner());
  info("owner（仍是多签）", await market.owner());

  step("多签再排一次队：让时间锁自己去 acceptOwnership");
  const SALT_ACCEPT = ethers.id("DEMO_ACCEPT_OWNERSHIP_V1");
  const scheduleAccept = timelock.interface.encodeFunctionData("schedule", [
    marketAddr,
    0,
    acceptData,
    ZERO_BYTES32,
    SALT_ACCEPT,
    MIN_DELAY,
  ]);
  await multisigRun(multisig, ms1, ms2, ms3, tlAddr, scheduleAccept, "schedule(acceptOwnership)");

  const idAccept = await timelock.hashOperation(marketAddr, 0, acceptData, ZERO_BYTES32, SALT_ACCEPT);
  const readyAt = Number(await timelock.getTimestamp(idAccept));
  const nowTs = (await ethers.provider.getBlock("latest")).timestamp;
  info("操作 id", idAccept);
  changed("操作状态", "Unset", `${STATE_NAME[Number(await timelock.getOperationState(idAccept))]}`);
  info("距离可执行", `${readyAt - nowTs} 秒`);

  await expectReverted(
    () => timelock.connect(outsider).execute(marketAddr, 0, acceptData, ZERO_BYTES32, SALT_ACCEPT),
    "公示期未满就抢跑执行被拒"
  );

  step(`快进 ${MIN_DELAY + 1} 秒，模拟真实世界等公示期走完`);
  await fastForward(MIN_DELAY + 1);
  changed("操作状态", "Waiting", `${STATE_NAME[Number(await timelock.getOperationState(idAccept))]}`);

  step("由完全无关的路人甲触发执行（验证开放执行权）");
  await (await timelock.connect(outsider).execute(marketAddr, 0, acceptData, ZERO_BYTES32, SALT_ACCEPT)).wait();
  changed("市场 owner", "多签", `${await market.owner()}`);
  changed("操作状态", "Ready", `${STATE_NAME[Number(await timelock.getOperationState(idAccept))]}`);
  check("时间锁已成为市场 owner", (await market.owner()) === tlAddr);

  // =========================================================================
  title(`阶段 7  治理实战：改费率 ${FEE_BPS} → ${NEW_FEE_BPS} bps`);
  // =========================================================================
  const setFeeData = market.interface.encodeFunctionData("setFeeBps", [NEW_FEE_BPS]);
  const SALT_FEE = ethers.id("DEMO_SET_FEE_V1");
  const scheduleFee = timelock.interface.encodeFunctionData("schedule", [
    marketAddr,
    0,
    setFeeData,
    ZERO_BYTES32,
    SALT_FEE,
    MIN_DELAY,
  ]);
  await multisigRun(multisig, ms1, ms2, ms3, tlAddr, scheduleFee, `schedule(setFeeBps(${NEW_FEE_BPS}))`);
  const idFee = await timelock.hashOperation(marketAddr, 0, setFeeData, ZERO_BYTES32, SALT_FEE);

  await expectReverted(
    () => timelock.connect(outsider).schedule(marketAddr, 0, setFeeData, ZERO_BYTES32, ethers.id("EVIL"), MIN_DELAY),
    "路人甲想自己排队改费率被拒（只有多签是 proposer）"
  );
  await expectReverted(
    async () => {
      const txId = Number(await multisig.getTransactionCount());
      await (await multisig.connect(ms3).submit(tlAddr, 0, scheduleFee)).wait();
      await (await multisig.connect(ms3).execute(txId)).wait(); // 只有 1 票
    },
    "单个成员 1 票就想执行被拒（阈值 2）"
  );
  check("公示期内费率保持原值", (await market.feeBps()) === BigInt(FEE_BPS), `${await market.feeBps()} bps`);
  check("操作处于 Waiting", Number(await timelock.getOperationState(idFee)) === 1);

  step(`快进 ${MIN_DELAY + 1} 秒，公示期满`);
  await fastForward(MIN_DELAY + 1);
  changed("操作状态", "Waiting", `${STATE_NAME[Number(await timelock.getOperationState(idFee))]}`);
  await (await timelock.connect(outsider).execute(marketAddr, 0, setFeeData, ZERO_BYTES32, SALT_FEE)).wait();
  changed("市场费率", `${FEE_BPS} bps`, `${await market.feeBps()} bps`);
  check("费率已生效", (await market.feeBps()) === BigInt(NEW_FEE_BPS));

  step(`收尾：再走一遍时间锁把费率还原成 ${FEE_BPS} bps（零残留）`);
  const restoreData = market.interface.encodeFunctionData("setFeeBps", [FEE_BPS]);
  const SALT_RESTORE = ethers.id("DEMO_RESTORE_FEE_V1");
  const scheduleRestore = timelock.interface.encodeFunctionData("schedule", [
    marketAddr,
    0,
    restoreData,
    ZERO_BYTES32,
    SALT_RESTORE,
    MIN_DELAY,
  ]);
  await multisigRun(multisig, ms2, ms3, ms1, tlAddr, scheduleRestore, `schedule(setFeeBps(${FEE_BPS}))`);
  await fastForward(MIN_DELAY + 1);
  await (await timelock.connect(outsider).execute(marketAddr, 0, restoreData, ZERO_BYTES32, SALT_RESTORE)).wait();
  changed("市场费率", `${NEW_FEE_BPS} bps`, `${await market.feeBps()} bps`);
  check("费率已还原", (await market.feeBps()) === BigInt(FEE_BPS));

  // =========================================================================
  title("演示结果");
  // =========================================================================
  console.log(`  断言：${passed} 项通过 / ${failed} 项失败`);
  if (failed > 0) console.log("  失败项：" + failures.join(" | "));
  console.log("");
  console.log("  最终链上状态");
  info("MyNFT", `${nftAddr}（已铸造 ${await nft.totalMinted()} 枚 / 上限 ${await nft.maxSupply()}）`);
  info("SimpleMarket", `${marketAddr}（费率 ${await market.feeBps()} bps，owner = 时间锁）`);
  info("MultiSigOwner", `${msAddr}（阈值 ${await multisig.threshold()}，累计提案 ${await multisig.getTransactionCount()} 条）`);
  info("MarketTimelock", `${tlAddr}（公示 ${await timelock.getMinDelay()} 秒）`);
  info("市场内滞留资金", `平台费 ${eth(await market.accumulatedFees())} + 创作者版税 ${eth(await market.pendingRoyalties(creator.address))}`);
  console.log("");
  console.log("  治理链路：成员提交 → 2 票通过 → 时间锁排队公示 300 秒 → 任何人执行 → 变更生效");
  console.log("  业务链路：铸造 → 授权 → 挂单 → 买入成交（三方分账）→ 出价 → 接受出价成交");
  line("=");

  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("演示异常终止：", e);
  process.exitCode = 1;
});
