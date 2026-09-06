/**
 * transfer-mynft-to-timelock.js —— 把 MyNFT 的 owner 交给时间锁（Sepolia）
 *
 * 为什么要做：MyNFT 现在是部署者 EOA 当 owner，能一个人
 *   · safeMint 无限增发
 *   · setDefaultRoyalty 改版税
 *   · pause/unpause 一键停掉整个 NFT
 *   交给时间锁后，这些动作全部要「多签 2 票 → 排队公示 5 分钟 → 执行」。
 *
 * 用法（项目根目录，PowerShell）：
 *   npx hardhat run scripts/transfer-mynft-to-timelock.js --network sepolia            # 演练，只读+打印计划
 *   $env:EXECUTE='1'; npx hardhat run scripts/transfer-mynft-to-timelock.js --network sepolia   # 真正上链
 *
 * 分两步跑（中间隔着公示期）：
 *   第一次    EOA 提名时间锁 或 多签提名 → 多签排队「时间锁接受 owner」→ 提示还要等
 *   等待公示  这 5 分钟里任何人都能在 Etherscan 看到 CallScheduled，发现问题可由多签撤销
 *   第二次    公示到期 → 脚本自动执行 → owner 正式变成时间锁
 *
 * 安全约定：
 *   - 默认演练（EXECUTE 未设）不发任何交易，只查状态、打印将要做什么
 *   - 三个地址都从 deployments/*.json 读，缺一个就报错退出，绝不静默重部署
 *   - 可重入：每一步先读链上状态，已完成的自动跳过
 *   - 私钥只从本地 .env 读，不打印、不上传
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const EXPLORER = "https://sepolia.etherscan.io";
const MYNFT_JSON = path.join(__dirname, "..", "deployments", "mynft-sepolia.json");
const MS_JSON = path.join(__dirname, "..", "deployments", "multisigowner-sepolia.json");
const TL_JSON = path.join(__dirname, "..", "deployments", "markettimelock-sepolia.json");
const ZERO_BYTES32 = ethers.ZeroHash;
// 固定 salt，保证脚本重跑时算出同一个操作 id，这是可重入的前提
const SALT = ethers.id("MYNFT_ACCEPT_OWNERSHIP_BY_TIMELOCK_V1");
const STATE_NAME = ["Unset", "Waiting", "Ready", "Done"];
const EXECUTE = process.env.EXECUTE === "1";

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function load(p, what) {
  if (!fs.existsSync(p)) {
    console.error(`✗ 找不到${what}（${p}）。请先跑对应部署脚本，本脚本不会替你重部署。`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function send(label, fn) {
  if (!EXECUTE) {
    console.log(`  [演练] 将发送：${label}`);
    return null;
  }
  const tx = await fn();
  const r = await tx.wait(1);
  console.log(`  ✅ ${label}`);
  console.log(`    ${EXPLORER}/tx/${r.hash}   (区块 ${r.blockNumber}, gas ${r.gasUsed})`);
  return r;
}

/** 多签三步走：submit → confirm → execute */
async function multisigRun(ms, w1, w2, to, data, label) {
  const txId = Number(await ms.getTransactionCount());
  console.log(`\n  多签提案 #${txId}：${label}`);
  await send("账号 1 提交（提交即投第一票）", () => ms.connect(w1).submit(to, 0, data));
  if (!EXECUTE) return txId;
  let t = await ms.getTransaction(txId);
  console.log(`    票数 ${t.confirmations}/2`);
  await send("账号 2 补第二票", () => ms.connect(w2).confirm(txId));
  t = await ms.getTransaction(txId);
  console.log(`    票数 ${t.confirmations}/2`);
  await send("账号 1 触发执行", () => ms.connect(w1).execute(txId));
  t = await ms.getTransaction(txId);
  console.log(`    已执行 ${t.executed}`);
  return txId;
}

async function main() {
  const keys = ["PRIVATE_KEY", "PRIVATE_KEY_2", "PRIVATE_KEY_3"].map((k) => (process.env[k] || "").trim());
  if (keys.some((k) => !k)) {
    console.error("✗ .env 里 PRIVATE_KEY / PRIVATE_KEY_2 / PRIVATE_KEY_3 必须三个都配好");
    process.exit(1);
  }
  const provider = ethers.provider;
  const net = await provider.getNetwork();
  if (net.chainId !== 11155111n) {
    console.error("✗ 当前不是 Sepolia 网络，请在命令末尾加 --network sepolia");
    process.exit(1);
  }
  const [w1, w2, w3] = keys.map((pk) => new ethers.Wallet(pk, provider));

  const nftAddr = load(MYNFT_JSON, "MyNFT 部署产物").address;
  const msAddr = load(MS_JSON, "多签部署产物").address;
  const tlAddr = load(TL_JSON, "时间锁部署产物").address;

  const nft = await ethers.getContractAt("MyNFT", nftAddr, w1);
  const ms = await ethers.getContractAt("MultiSigOwner", msAddr, w1);
  const timelock = await ethers.getContractAt("MarketTimelock", tlAddr, w1);
  const minDelay = Number(await timelock.getMinDelay());

  console.log("=".repeat(68));
  console.log(`MyNFT owner 移交时间锁 —— Sepolia（${EXECUTE ? "真实执行" : "演练模式，不发交易"}）`);
  console.log("=".repeat(68));
  console.log("  MyNFT  :", nftAddr);
  console.log("  多签   :", msAddr);
  console.log("  时间锁 :", tlAddr);
  console.log("  公示期 :", minDelay, "秒");

  const owner = await nft.owner();
  console.log("\n当前 owner :", owner);

  if (same(owner, tlAddr)) {
    console.log("\n[已完成] MyNFT owner 已经是时间锁，无需再次移交。");
    console.log(`\n${EXPLORER}/address/${nftAddr}\n`);
    return;
  }

  // 时间锁必须能当 proposer，否则移交后治理锁死
  const hasProposer = await timelock.hasRole(await timelock.PROPOSER_ROLE(), msAddr);
  if (!hasProposer) {
    console.error("✗ 该多签不是时间锁的 proposer，移交后治理会锁死。");
    process.exit(1);
  }

  // ---------------- 第 1 步：把时间锁提名为 pendingOwner ----------------
  console.log("\n[第 1 步] 提名时间锁接任 owner");
  const pending = await nft.pendingOwner();
  if (same(pending, tlAddr)) {
    console.log("  [复用] pendingOwner 已经是时间锁，跳过提名。");
  } else if (same(owner, msAddr)) {
    // owner 是多签 → 走多签三步
    await multisigRun(ms, w1, w2, nftAddr, nft.interface.encodeFunctionData("transferOwnership", [tlAddr]), "transferOwnership(时间锁)");
  } else if ([w1.address, w2.address, w3.address].some((a) => same(owner, a))) {
    // owner 是某个本地私钥对应的 EOA → 只有它能发起 transferOwnership
    const who = [w1, w2, w3].find((w) => same(owner, w.address));
    console.log(`  当前 owner 是 EOA ${owner}，由它本人发起 transferOwnership`);
    await send("EOA 提名时间锁", () => nft.connect(who).transferOwnership(tlAddr));
  } else {
    console.error(`✗ MyNFT owner 是 ${owner}，既不是多签也不是本脚本持有的 EOA，无法发起移交。`);
    process.exit(1);
  }

  if (EXECUTE) {
    console.log("  pendingOwner =", await nft.pendingOwner());
    console.log("  owner        =", await nft.owner(), "（交接期没有权力真空）");
  }

  // ------------- 第 2 步：多签排队「时间锁接受 owner」 -------------
  const acceptData = nft.interface.encodeFunctionData("acceptOwnership", []);
  const opId = await timelock.hashOperation(nftAddr, 0, acceptData, ZERO_BYTES32, SALT);
  const state = Number(await timelock.getOperationState(opId));
  console.log("\n[第 2 步] 多签排队「时间锁接受 owner」");
  console.log("  操作 id :", opId);
  console.log("  当前状态:", STATE_NAME[state]);

  if (state === 0) {
    await multisigRun(
      ms,
      w1,
      w2,
      tlAddr,
      timelock.interface.encodeFunctionData("schedule", [nftAddr, 0, acceptData, ZERO_BYTES32, SALT, minDelay]),
      "schedule(acceptOwnership)"
    );
  } else {
    console.log("  [复用] 该操作已排队，跳过。");
  }

  const state2 = Number(await timelock.getOperationState(opId));
  const readyAt = Number(await timelock.getTimestamp(opId));
  const now = (await provider.getBlock("latest")).timestamp;

  console.log("\n[第 3 步] 等待公示结束");
  console.log("  操作状态:", STATE_NAME[state2]);
  if (state2 === 1) {
    const left = readyAt - now;
    console.log(`  距离可执行还剩 ${left} 秒（约 ${(left / 60).toFixed(1)} 分钟）`);
    console.log(`  预定可执行时间：${new Date(readyAt * 1000).toLocaleString("zh-CN")}`);
    console.log("\n  ⏳ 还在公示期，现在执行会被拒绝。到点后重跑本脚本即可完成交接。");
    return;
  }
  if (state2 === 3) {
    console.log("\n[已完成] 该操作已执行过。");
    console.log("  MyNFT owner =", await nft.owner());
    return;
  }

  // ------------- 第 4 步：公示到期，任何人可触发执行 -------------
  console.log("\n[第 4 步] 公示已到期，执行交接");
  await send("execute(acceptOwnership)", () =>
    timelock.connect(w1).execute(nftAddr, 0, acceptData, ZERO_BYTES32, SALT)
  );
  if (EXECUTE) {
    console.log("\n  MyNFT owner 现在是：", await nft.owner());
    console.log(`  链上查看：${EXPLORER}/address/${nftAddr}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("✗ 出错：", e.message);
  process.exit(1);
});
