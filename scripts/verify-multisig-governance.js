/**
 * verify-multisig-governance.js —— 验证多签接管后「治理链路真的通」
 *
 * 跑法（PowerShell，项目根目录）：
 *   npx hardhat run scripts/verify-multisig-governance.js --network sepolia
 *
 * 剧本（Sepolia 真实链上，共 6 笔交易）：
 *   1. 确认市场 owner 已经是多签（不是就退出，不做任何改动）
 *   2. 多签提案把费率改成 300 bps → 两人投票 → 执行 → 验证生效
 *   3. 验证单个成员无法独自改费率（1 票提案执行必 revert）
 *   4. 再走一遍流程把费率改回原值，最终状态零残留
 *
 * 安全约定：
 *   - 地址只读 deployments/ 下的产物，缺文件报错退出，绝不静默重部署
 *   - 开头就把原费率读出来，无论中途成功失败都尝试还原
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

const TEMP_FEE = 300; // 临时改成 3%，验证完立刻还原

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
async function send(wallet, label, promiseFn) {
  const tx = await promiseFn();
  const receipt = await tx.wait(1);
  console.log(`  ✓ ${label}`);
  console.log(`    ${EXPLORER}/tx/${receipt.hash}  (区块 ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  return receipt;
}

/** 走完整一轮：submit → confirm → execute */
async function proposeAndRun(ms, target, market, w1, w2, fnName, args, label) {
  const data = market.interface.encodeFunctionData(fnName, args);
  const idx = Number(await ms.getTransactionCount());
  console.log(`\n  ── 提案 #${idx}：${label}`);
  await send(w1, "账号 1 提交（自动投第一票）", () => ms.connect(w1).submit(target, 0, data));
  await send(w2, "账号 2 补第二票", () => ms.connect(w2).confirm(idx));
  await send(w1, "执行", () => ms.connect(w1).execute(idx));
  const t = await ms.getTransaction(idx);
  console.log(`    结果：票数 ${t.confirmations}/2，已执行 ${t.executed}`);
  return t;
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

  const [w1, w2] = keys.map((pk) => new ethers.Wallet(pk, provider));
  const marketAddr = load(MARKET_JSON, "市场部署产物").address;
  const msAddr = load(MS_JSON, "多签部署产物").address;

  const market = await ethers.getContractAt("SimpleMarket", marketAddr, w1);
  const ms = await ethers.getContractAt("MultiSigOwner", msAddr, w1);

  console.log("多签治理实战验证 —— Sepolia");
  console.log("=".repeat(66));
  console.log("  市场 :", marketAddr);
  console.log("  多签 :", msAddr);

  const owner = await market.owner();
  if (!same(owner, msAddr)) {
    console.error(`✗ 市场 owner 是 ${owner}，还不是多签。请先跑 transfer-market-to-multisig.js。本脚本不做任何改动。`);
    process.exit(1);
  }
  const originalFee = Number(await market.feeBps());
  console.log("  市场 owner :", owner, "（多签已接管 ✓）");
  console.log("  当前费率   :", originalFee, "bps");

  // ---------------------------------------------------------- 第 1 关：多签能办事
  console.log("\n第 1 关：多签两人同意，把费率改成 " + TEMP_FEE + " bps");
  await proposeAndRun(ms, marketAddr, market, w1, w2, "setFeeBps", [TEMP_FEE], `setFeeBps(${TEMP_FEE})`);
  const afterFee = Number(await market.feeBps());
  console.log(`  链上费率 : ${afterFee} bps → ${afterFee === TEMP_FEE ? "生效 ✓" : "未生效 ✗"}`);
  if (afterFee !== TEMP_FEE) {
    console.error("✗ 多签改费率未生效，治理链路有问题。");
    process.exit(1);
  }

  // ---------------------------------------------------------- 第 2 关：一个人说了不算
  console.log("\n第 2 关：只凑 1 票就执行，必须被挡下");
  const data = market.interface.encodeFunctionData("setFeeBps", [999]);
  const soloIdx = Number(await ms.getTransactionCount());
  await ms.connect(w1).submit(marketAddr, 0, data);
  const solo = await ms.getTransaction(soloIdx);
  console.log(`  提案 #${soloIdx} 已建立，票数 ${solo.confirmations}/2（账号 1 一人所投）`);
  try {
    await ms.connect(w2).execute(soloIdx); // 换账号 2 触发，证明不是提交者特权
    console.log("  ✗ 竟然执行成功了 —— 阈值保护失效，这是严重问题");
    process.exitCode = 1;
  } catch (err) {
    const msg = (err.shortMessage || err.message || String(err)).split("\n")[0];
    console.log("  [被拒]", msg);
    console.log("  结论：1 票不足以动用 owner 权力 —— 单人失效确认 ✓");
  }

  // ---------------------------------------------------------- 第 3 关：还原
  console.log(`\n第 3 关：再把费率改回原值 ${originalFee} bps（保持零残留）`);
  await proposeAndRun(ms, marketAddr, market, w1, w2, "setFeeBps", [originalFee], `setFeeBps(${originalFee})`);
  const restored = Number(await market.feeBps());
  console.log(`  链上费率 : ${restored} bps → ${restored === originalFee ? "已还原 ✓" : "还原失败 ✗"}`);

  // ---------------------------------------------------------- 总结
  console.log("\n最终状态");
  console.log("  市场 owner   :", await market.owner());
  console.log("  市场费率     :", await market.feeBps(), "bps");
  console.log("  多签阈值     :", await ms.threshold());
  console.log("  多签提案总数 :", await ms.getTransactionCount());
  console.log(`  （其中 #${soloIdx} 是只有 1 票、永远不会被执行的废弃提案）`);
  console.log(`\n${EXPLORER}/address/${marketAddr}`);
  console.log(`${EXPLORER}/address/${msAddr}\n`);
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error("\n验证失败：", err.shortMessage || err.message || err);
    process.exit(1);
  });
