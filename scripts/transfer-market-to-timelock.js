/**
 * transfer-market-to-timelock.js —— 把 SimpleMarket 的 owner 从多签移交时间锁（Sepolia 实战）
 *
 * 跑法（PowerShell，项目根目录）：
 *   npx hardhat run scripts/transfer-market-to-timelock.js --network sepolia
 *
 * 剧本（分两次跑，中间隔着公示期）：
 *   第一次跑  多签提名时间锁 → 多签排队「时间锁接受 owner」→ 提示还需等待
 *   等待公示  这段时间里任何人都能在 Etherscan 看到 CallScheduled 事件，发现问题可由多签撤销
 *   第二次跑  公示到期 → 任何人触发执行 → owner 正式变成时间锁
 *
 * 为什么「接受 owner」也要排队？
 *   时间锁不是人，它不会自己去点 acceptOwnership。这一步必须由多签先排队，
 *   公示满后才能由任何人代它执行 —— 连"权力交接"本身都要晒在阳光下。
 *
 * 安全约定：
 *   - 三个地址都从 deployments/*.json 读，缺任一个就报错退出，绝不静默重部署
 *   - 可重入：每一步都先读链上状态，已完成的自动跳过，跑到哪一步不会被打断重来
 *   - 私钥只从本地 .env 读，不打印、不上传
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const EXPLORER = "https://sepolia.etherscan.io";
const MARKET_JSON = path.join(__dirname, "..", "deployments", "simplemarket-sepolia.json");
const MS_JSON = path.join(__dirname, "..", "deployments", "multisigowner-sepolia.json");
const TL_JSON = path.join(__dirname, "..", "deployments", "markettimelock-sepolia.json");
const ZERO = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;

// 固定 salt：保证脚本重跑时算出同一个操作 id，这是可重入的前提
const SALT = ethers.id("TRANSFER_OWNERSHIP_TO_TIMELOCK_V1");

const STATE_NAME = ["Unset", "Waiting", "Ready", "Done"];

function same(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function load(p, what) {
  if (!fs.existsSync(p)) {
    console.error(`✗ 找不到 ${what}（${p}）。请先跑对应的部署脚本，本脚本不会替你重部署。`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
async function send(label, promiseFn, quietConfirmations = false) {
  const tx = await promiseFn();
  const receipt = await tx.wait(1);
  console.log(`  ✓ ${label}`);
  console.log(`    ${EXPLORER}/tx/${receipt.hash}   (区块 ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  if (!quietConfirmations) return receipt;
  return receipt;
}

/** 多签三步走：submit → confirm → execute，返回提案 id */
async function multisigRun(ms, w1, w2, to, data, label) {
  const txId = Number(await ms.getTransactionCount());
  console.log(`\n  多签提案 #${txId}：${label}`);
  await send("账号 1 提交（提交即投第一票）", () => ms.connect(w1).submit(to, 0, data), true);
  let t = await ms.getTransaction(txId);
  console.log(`    票数 ${t.confirmations}/2`);
  await send("账号 2 补第二票", () => ms.connect(w2).confirm(txId), true);
  t = await ms.getTransaction(txId);
  console.log(`    票数 ${t.confirmations}/2`);
  await send("账号 1 触发执行", () => ms.connect(w1).execute(txId), true);
  t = await ms.getTransaction(txId);
  console.log(`    票数 ${t.confirmations}/2，已执行 ${t.executed}`);
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

  const marketAddr = load(MARKET_JSON, "市场部署产物").address;
  const msAddr = load(MS_JSON, "多签部署产物").address;
  const tlInfo = load(TL_JSON, "时间锁部署产物");
  const tlAddr = tlInfo.address;

  const market = await ethers.getContractAt("SimpleMarket", marketAddr, w1);
  const ms = await ethers.getContractAt("MultiSigOwner", msAddr, w1);
  const timelock = await ethers.getContractAt("MarketTimelock", tlAddr, w1);

  const minDelay = Number(await timelock.getMinDelay());

  console.log("=".repeat(68));
  console.log("市场 owner 移交时间锁 —— Sepolia 实战（可重入）");
  console.log("=".repeat(68));
  console.log("  市场   :", marketAddr);
  console.log("  多签   :", msAddr);
  console.log("  时间锁 :", tlAddr);
  console.log("  公示期 :", minDelay, "秒");
  console.log("  账号 1 :", w1.address);
  console.log("  账号 2 :", w2.address);
  console.log("  账号 3 :", w3.address);

  // ---------------------------------------------------------------- 前置校验
  const owner = await market.owner();
  console.log("\n当前 owner :", owner);

  if (same(owner, tlAddr)) {
    console.log("\n[已完成] 市场 owner 已经是时间锁，无需再次移交。");
    console.log("  治理链路：成员提交 → 2 票通过 → 排队公示", minDelay, "秒 → 任何人执行");
    console.log(`\n${EXPLORER}/address/${marketAddr}\n`);
    return;
  }
  if (!same(owner, msAddr)) {
    console.error(`✗ 市场 owner 是 ${owner}，既不是多签也不是时间锁。请先跑 transfer-market-to-multisig.js。`);
    process.exit(1);
  }
  // 确认时间锁确实把提案权给了这个多签
  const hasProposer = await timelock.hasRole(await timelock.PROPOSER_ROLE(), msAddr);
  if (!hasProposer) {
    console.error("✗ 该多签不是时间锁的 proposer，移交后治理会锁死。请检查时间锁部署参数。");
    process.exit(1);
  }

  // ------------------------------------------------- 第 1 步：多签提名时间锁
  console.log("\n[第 1 步] 多签提名时间锁接任 owner");
  const pending = await market.pendingOwner();
  if (same(pending, tlAddr)) {
    console.log("  [复用] pendingOwner 已经是时间锁，跳过提名。");
  } else {
    await multisigRun(
      ms,
      w1,
      w2,
      marketAddr,
      market.interface.encodeFunctionData("transferOwnership", [tlAddr]),
      "transferOwnership(时间锁)"
    );
  }
  console.log("  pendingOwner =", await market.pendingOwner());
  console.log("  owner        =", await market.owner(), "（仍是多签 —— 交接期无权力真空）");

  // ------------------------------------------- 第 2 步：多签排队「接受 owner」
  const acceptData = market.interface.encodeFunctionData("acceptOwnership", []);
  const opId = await timelock.hashOperation(marketAddr, 0, acceptData, ZERO_BYTES32, SALT);
  const state = Number(await timelock.getOperationState(opId));
  console.log("\n[第 2 步] 多签排队「时间锁接受 owner」");
  console.log("  操作 id :", opId);
  console.log("  当前状态:", STATE_NAME[state]);

  if (state === 0) {
    // Unset —— 还没排队
    await multisigRun(
      ms,
      w1,
      w2,
      tlAddr,
      timelock.interface.encodeFunctionData("schedule", [
        marketAddr,
        0,
        acceptData,
        ZERO_BYTES32,
        SALT,
        minDelay,
      ]),
      "schedule(acceptOwnership)"
    );
  } else {
    console.log("  [复用] 该操作已排队，跳过。");
  }

  const state2 = Number(await timelock.getOperationState(opId));
  const readyAt = Number(await timelock.getTimestamp(opId));
  const nowBlock = await provider.getBlock("latest");
  const now = nowBlock.timestamp;

  console.log("\n[第 3 步] 等待公示结束");
  console.log("  操作状态:", STATE_NAME[state2]);
  if (state2 === 1) {
    const left = readyAt - now;
    console.log(`  距离可执行还剩 ${left} 秒（约 ${(left / 60).toFixed(1)} 分钟）`);
    console.log(`  预定可执行时间：${new Date(readyAt * 1000).toLocaleString("zh-CN")}`);
    console.log("\n  ⏳ 还在公示期，现在执行会被拒绝。");
    console.log("  等时间到了，再跑一次本脚本即可完成易主：");
    console.log("     npx hardhat run scripts/transfer-market-to-timelock.js --network sepolia");
    console.log(`\n${EXPLORER}/address/${tlAddr}\n`);
    return;
  }
  if (state2 === 3) {
    const finalOwner = await market.owner();
    if (same(finalOwner, tlAddr)) {
      console.log("  易主已完成。");
    } else {
      console.error(`✗ 操作显示已完成但 owner 是 ${finalOwner}，请到 Etherscan 核对。`);
      process.exit(1);
    }
    return;
  }

  // state2 === 2，Ready —— 可以执行了
  console.log("  ✓ 公示已结束，操作可执行");
  console.log("\n[第 4 步] 触发执行（任何人都能点，这里用账号 1 代劳）");
  await send("execute(acceptOwnership)", () =>
    timelock.connect(w1).execute(marketAddr, 0, acceptData, ZERO_BYTES32, SALT)
  );

  // ---------------------------------------------------------------- 收尾验证
  const newOwner = await market.owner();
  console.log("\n[验证]");
  console.log("  市场 owner   :", newOwner);
  const ok = same(newOwner, tlAddr);
  console.log("  是否已易主   :", ok ? "是 ✓" : "否 ✗");
  if (!ok) {
    console.error("✗ 移交未生效，请到 Etherscan 核对交易。");
    process.exit(1);
  }

  console.log("\n  账号 1 想绕过多签和时间锁，直接把费率改成 999 bps（约 10%）……");
  try {
    await market.connect(w1).setFeeBps(999);
    console.log("  ✗ 竟然改成了 —— 这是严重问题，请立刻检查");
  } catch (err) {
    const msg = (err.shortMessage || err.message || String(err)).split("\n")[0];
    console.log("  [被拒]", msg);
    console.log("  结论：单人再也动不了任何参数 —— 必须 2 票通过 + 公示满点。");
  }

  console.log("\n最终状态");
  console.log("  市场 owner :", await market.owner());
  console.log("  市场费率   :", await market.feeBps(), "bps");
  console.log("  时间锁延迟 :", minDelay, "秒");
  console.log("  多签提案数 :", await ms.getTransactionCount());
  console.log("\n  治理链路：成员提交 → 2 票通过 → 排队公示", minDelay, "秒 → 任何人执行");
  console.log(`\n${EXPLORER}/address/${marketAddr}`);
  console.log(`${EXPLORER}/address/${tlAddr}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n移交失败：", err.shortMessage || err.message || err);
    process.exit(1);
  });
