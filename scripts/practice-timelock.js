// SPDX-License-Identifier: MIT
/**
 * 本地时间锁治理全流程演练（零 gas，hardhat 本地链）
 *
 * 验证目标：把"多签"和"时间锁"两层治理拼接起来，证明：
 *   1. 市场 owner 能从多签平滑移交给时间锁，中间不出现权力真空
 *   2. 之后每一次参数修改都必须"多签投票 → 排队公示 → 到期执行"三步
 *   3. 公示期内任何人看得到、但谁都改不动（未到期执行被拒）
 *   4. 到期后任何人都能触发执行（开放执行人，不怕最后一公里没人点）
 *   5. 老账号、外部账号、单人投票全部被挡住
 *
 * 用法：npx hardhat run scripts/practice-timelock.js --network hardhat
 */
const hre = require("hardhat");
const { ethers, network } = hre;

// ---------------------------------------------------------------------------
// 参数与断言工具
// ---------------------------------------------------------------------------
const DELAY = 3600; // 时间锁公示期：1 小时（本地链可快进，上链可按需调整）
const ORIGINAL_FEE = 250; // 原始费率 2.5%
const NEW_FEE = 300; // 治理要改成的费率 3%
const ZERO = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${name}${detail ? " — " + detail : ""}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}

/** 快进链上时间 */
async function fastForward(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

/** 断言某笔交易会被拒绝，且错误信息命中关键词 */
async function expectReverted(promiseFactory, label, keywords = []) {
  try {
    const tx = await promiseFactory();
    if (tx && tx.wait) await tx.wait();
    check(label, false, "本应被拒绝，却成功执行了");
    return false;
  } catch (err) {
    const msg = err.shortMessage || err.message || String(err);
    const hit = keywords.length === 0 || keywords.some((k) => msg.includes(k));
    check(label, hit, hit ? `已拒绝 (${keywords[0] || msg.slice(0, 60)})` : `报错不匹配: ${msg.slice(0, 120)}`);
    return hit;
  }
}

/** 多签三步走：submit → confirm → execute，返回 txId */
async function multisigRun(ms, submitter, confirmer, to, data, label) {
  const before = await ms.getTransactionCount();
  const tx = await ms.connect(submitter).submit(to, 0, data);
  await tx.wait();
  const txId = before; // submit 内部自增，新提案 id = 提交前的总数
  const cTx = await ms.connect(confirmer).confirm(txId);
  await cTx.wait();
  const eTx = await ms.connect(confirmer).execute(txId);
  await eTx.wait();
  return txId;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const [deployer, alice, bob, carol, outsider] = await ethers.getSigners();
  console.log("=".repeat(72));
  console.log("时间锁治理全流程演练（本地链 · 零 gas）");
  console.log("=".repeat(72));
  console.log(`部署者(原 owner): ${deployer.address}`);
  console.log(`多签成员: alice=${alice.address} / bob=${bob.address} / carol=${carol.address}`);
  console.log(`外部账号(无关人员): ${outsider.address}`);
  console.log(`公示延迟 DELAY = ${DELAY} 秒`);
  console.log("");

  // =========================================================================
  console.log("[阶段 0] 部署三件套");
  // =========================================================================
  const Market = await ethers.getContractFactory("SimpleMarket");
  const market = await Market.deploy(deployer.address, ORIGINAL_FEE);
  await market.waitForDeployment();
  const marketAddr = await market.getAddress();
  console.log(`  SimpleMarket      : ${marketAddr}`);

  const MultiSig = await ethers.getContractFactory("MultiSigOwner");
  const multisig = await MultiSig.deploy([alice.address, bob.address, carol.address], 2);
  await multisig.waitForDeployment();
  const msAddr = await multisig.getAddress();
  console.log(`  MultiSigOwner     : ${msAddr}`);

  const Timelock = await ethers.getContractFactory("MarketTimelock");
  const timelock = await Timelock.deploy(DELAY, [msAddr], [ZERO], ZERO);
  await timelock.waitForDeployment();
  const tlAddr = await timelock.getAddress();
  console.log(`  MarketTimelock    : ${tlAddr}`);

  check("市场初始费率正确", (await market.feeBps()) === BigInt(ORIGINAL_FEE), `feeBps=${await market.feeBps()}`);
  check("多签阈值为 2", (await multisig.threshold()) === 2n);
  check("时间锁最小延迟 = DELAY", (await timelock.getMinDelay()) === BigInt(DELAY));
  check("多签拥有 PROPOSER_ROLE", await timelock.hasRole(await timelock.PROPOSER_ROLE(), msAddr));
  check("多签同时拥有 CANCELLER_ROLE", await timelock.hasRole(await timelock.CANCELLER_ROLE(), msAddr));
  check(
    "执行权限对所有人开放 (address(0) 持有 EXECUTOR_ROLE)",
    await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ZERO)
  );
  check(
    "未留管理员后门 (deployer 无 ADMIN_ROLE)",
    !(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address))
  );
  console.log("");

  // =========================================================================
  console.log("[阶段 1] 多签先接管市场（owner: deployer → 多签）");
  // =========================================================================
  await (await market.connect(deployer).transferOwnership(msAddr)).wait();
  check("提名后 pendingOwner = 多签", (await market.pendingOwner()) === msAddr);
  check("提名期间老 owner 仍是 deployer", (await market.owner()) === deployer.address);

  const acceptData = market.interface.encodeFunctionData("acceptOwnership", []);
  await multisigRun(multisig, alice, bob, marketAddr, acceptData, "接管市场");
  check("多签已成为市场 owner", (await market.owner()) === msAddr, `owner=${await market.owner()}`);
  await expectReverted(
    () => market.connect(deployer).setFeeBps(999),
    "老账号 deployer 已不能直接改费率",
    ["OwnableUnauthorizedAccount"]
  );
  console.log("");

  // =========================================================================
  console.log("[阶段 2] 多签把 owner 移交给时间锁（提名 + 时间锁自己接受）");
  // =========================================================================
  const nominateTl = market.interface.encodeFunctionData("transferOwnership", [tlAddr]);
  await multisigRun(multisig, alice, bob, marketAddr, nominateTl, "提名时间锁");
  check("pendingOwner 已指向时间锁", (await market.pendingOwner()) === tlAddr);
  check("移交公示期间 owner 仍是多签（权力未真空）", (await market.owner()) === msAddr);

  // 时间锁自己也要"接受"，这一步同样要走多签排队 + 公示
  const saltAccept = ethers.id("ACCEPT_OWNERSHIP_V1");
  const scheduleAccept = timelock.interface.encodeFunctionData("schedule", [
    marketAddr,
    0,
    acceptData,
    ZERO_BYTES32,
    saltAccept,
    DELAY,
  ]);
  await multisigRun(multisig, alice, bob, tlAddr, scheduleAccept, "时间锁接受 owner");
  const idAccept = await timelock.hashOperation(marketAddr, 0, acceptData, ZERO_BYTES32, saltAccept);
  const stAccept = await timelock.getOperationState(idAccept);
  check("操作已进入 Waiting 状态", stAccept === 1n, `state=${stAccept} (0=Unset 1=Waiting 2=Ready 3=Done)`);

  console.log("  -- 未到期就执行，应当被拒 --");
  await expectReverted(
    () => timelock.connect(outsider).execute(marketAddr, 0, acceptData, ZERO_BYTES32, saltAccept),
    "公示期内执行被拒",
    ["TimelockUnexpectedOperationState", "OperationState", "revert"]
  );

  console.log(`  -- 快进 ${DELAY + 1} 秒 --`);
  await fastForward(DELAY + 1);
  const stReady = await timelock.getOperationState(idAccept);
  check("到期后操作变为 Ready", stReady === 2n, `state=${stReady}`);

  console.log("  -- 由完全无关的外部账号触发执行（验证开放执行人）--");
  await (await timelock.connect(outsider).execute(marketAddr, 0, acceptData, ZERO_BYTES32, saltAccept)).wait();
  check("时间锁正式成为市场 owner", (await market.owner()) === tlAddr, `owner=${await market.owner()}`);
  const stDone = await timelock.getOperationState(idAccept);
  check("操作状态变为 Done", stDone === 3n, `state=${stDone}`);
  console.log("");

  // =========================================================================
  console.log(`[阶段 3] 治理实战：改费率 ${ORIGINAL_FEE} → ${NEW_FEE} bps`);
  // =========================================================================
  const setFeeData = market.interface.encodeFunctionData("setFeeBps", [NEW_FEE]);
  const saltFee = ethers.id("SET_FEE_V1");
  const scheduleFee = timelock.interface.encodeFunctionData("schedule", [
    marketAddr,
    0,
    setFeeData,
    ZERO_BYTES32,
    saltFee,
    DELAY,
  ]);
  await multisigRun(multisig, alice, bob, tlAddr, scheduleFee, "改费率");
  const idFee = await timelock.hashOperation(marketAddr, 0, setFeeData, ZERO_BYTES32, saltFee);

  // 单人投票不能执行
  await expectReverted(
    async () => {
      const before = await multisig.getTransactionCount();
      await (await multisig.connect(carol).submit(tlAddr, 0, scheduleFee)).wait();
      await (await multisig.connect(carol).execute(before)).wait(); // 只有 1 票
    },
    "单人(1票)执行排队提案被拒",
    ["BelowThreshold"]
  );

  // 非 proposer 直接排队
  await expectReverted(
    () => timelock.connect(outsider).schedule(marketAddr, 0, setFeeData, ZERO_BYTES32, ethers.id("EVIL"), DELAY),
    "无关人员直接调 schedule 被拒",
    ["AccessControlUnauthorizedAccount", "AccessControl", "missing role"]
  );
  await expectReverted(
    () => timelock.connect(alice).schedule(marketAddr, 0, setFeeData, ZERO_BYTES32, ethers.id("EVIL2"), DELAY),
    "多签单个成员(非合约)直接 schedule 被拒",
    ["AccessControlUnauthorizedAccount", "AccessControl", "missing role"]
  );

  check(
    "公示期内费率保持原值",
    (await market.feeBps()) === BigInt(ORIGINAL_FEE),
    `feeBps=${await market.feeBps()}`
  );

  console.log(`  -- 快进 ${DELAY + 1} 秒 --`);
  await fastForward(DELAY + 1);
  await (await timelock.connect(carol).execute(marketAddr, 0, setFeeData, ZERO_BYTES32, saltFee)).wait();
  check("到期执行后费率已生效", (await market.feeBps()) === BigInt(NEW_FEE), `feeBps=${await market.feeBps()}`);

  let dupRejected = false;
  try {
    await timelock.connect(outsider).execute(marketAddr, 0, setFeeData, ZERO_BYTES32, saltFee);
  } catch (e) {
    dupRejected = true;
  }
  check("重复执行同一操作被拒", dupRejected);

  // 暂停/恢复也走同一条链路
  console.log("");
  console.log("[阶段 3b] 紧急暂停同样走时间锁");
  const pauseData = market.interface.encodeFunctionData("pause", []);
  const saltPause = ethers.id("PAUSE_V1");
  const schedulePause = timelock.interface.encodeFunctionData("schedule", [
    marketAddr,
    0,
    pauseData,
    ZERO_BYTES32,
    saltPause,
    DELAY,
  ]);
  await multisigRun(multisig, bob, carol, tlAddr, schedulePause, "暂停市场");
  await fastForward(DELAY + 1);
  await (await timelock.connect(outsider).execute(marketAddr, 0, pauseData, ZERO_BYTES32, saltPause)).wait();
  check("市场已暂停", await market.paused(), `paused=${await market.paused()}`);
  console.log("");

  // =========================================================================
  console.log("[阶段 4] 撤销演示：公示期内发现问题，多签可以反悔");
  // =========================================================================
  const evilData = market.interface.encodeFunctionData("setFeeBps", [999]);
  const saltEvil = ethers.id("EVIL_FEE");
  const scheduleEvil = timelock.interface.encodeFunctionData("schedule", [
    marketAddr,
    0,
    evilData,
    ZERO_BYTES32,
    saltEvil,
    DELAY,
  ]);
  await multisigRun(multisig, alice, bob, tlAddr, scheduleEvil, "恶意改费率(演示)");
  const idEvil = await timelock.hashOperation(marketAddr, 0, evilData, ZERO_BYTES32, saltEvil);
  check("恶意操作已排队", await timelock.isOperationPending(idEvil));

  const cancelData = timelock.interface.encodeFunctionData("cancel", [idEvil]);
  await multisigRun(multisig, alice, bob, tlAddr, cancelData, "撤销恶意操作");
  check("恶意操作已被撤销", !(await timelock.isOperationPending(idEvil)));
  await fastForward(DELAY + 1);
  await expectReverted(
    () => timelock.connect(outsider).execute(marketAddr, 0, evilData, ZERO_BYTES32, saltEvil),
    "被撤销的操作即使到期也无法执行",
    ["TimelockUnexpectedOperationState", "OperationState", "revert"]
  );
  console.log("");

  // =========================================================================
  console.log("[阶段 5] 收尾：全部改回原值，零残留");
  // =========================================================================
  const restoreData = market.interface.encodeFunctionData("setFeeBps", [ORIGINAL_FEE]);
  const saltRestore = ethers.id("RESTORE_FEE");
  const scheduleRestore = timelock.interface.encodeFunctionData("schedule", [
    marketAddr,
    0,
    restoreData,
    ZERO_BYTES32,
    saltRestore,
    DELAY,
  ]);
  await multisigRun(multisig, alice, bob, tlAddr, scheduleRestore, "恢复费率");
  await fastForward(DELAY + 1);
  await (await timelock.connect(outsider).execute(marketAddr, 0, restoreData, ZERO_BYTES32, saltRestore)).wait();

  const unpauseData = market.interface.encodeFunctionData("unpause", []);
  const saltUnpause = ethers.id("UNPAUSE_V1");
  const scheduleUnpause = timelock.interface.encodeFunctionData("schedule", [
    marketAddr,
    0,
    unpauseData,
    ZERO_BYTES32,
    saltUnpause,
    DELAY,
  ]);
  await multisigRun(multisig, alice, bob, tlAddr, scheduleUnpause, "恢复市场");
  await fastForward(DELAY + 1);
  await (await timelock.connect(outsider).execute(marketAddr, 0, unpauseData, ZERO_BYTES32, saltUnpause)).wait();

  check("费率已还原", (await market.feeBps()) === BigInt(ORIGINAL_FEE), `feeBps=${await market.feeBps()}`);
  check("市场已解除暂停", !(await market.paused()), `paused=${await market.paused()}`);
  check("owner 稳定在时间锁", (await market.owner()) === tlAddr);
  console.log("");

  // =========================================================================
  console.log("=".repeat(72));
  console.log(`演练结果：${passed} 项通过 / ${failed} 项失败`);
  if (failed > 0) {
    console.log("失败项：" + failures.join(" | "));
  } else {
    console.log("全部通过 —— 多签 + 时间锁双层治理链路完整可用");
  }
  console.log("=".repeat(72));
  console.log(`市场地址   : ${marketAddr}`);
  console.log(`多签地址   : ${msAddr}`);
  console.log(`时间锁地址 : ${tlAddr}`);
  console.log(`治理链路   : 成员提交 → 2票通过 → 排队公示 ${DELAY}s → 任何人执行`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("演练异常终止：", e);
  process.exitCode = 1;
});
