/**
 * restore-fee-multisig.js —— 收尾：验证「1 票不能办事」并把费率还原到 250 bps
 *
 * 跑法（PowerShell，项目根目录）：
 *   npx hardhat run scripts/restore-fee-multisig.js --network sepolia
 *
 * 为什么要单独一个脚本：
 *   verify-multisig-governance.js 的第 1 关（改成 300 bps）已成功上链，
 *   但终端输出被截断、进程中断，费率停在 300。本脚本从当前状态接力：
 *     第 2 关 找一个只有 1 票的提案，换账号执行 → 必须被阈值挡下
 *     第 3 关 走完整流程把费率改回 250 bps，验证生效
 *   幂等：费率已经是 250 时跳过第 3 关；没有 1 票提案就现场建一个。
 *
 * 安全约定：地址只读 deployments/ 产物，缺文件报错退出，绝不静默重部署。
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const EXPLORER = "https://sepolia.etherscan.io";
const MARKET_JSON = path.join(__dirname, "..", "deployments", "simplemarket-sepolia.json");
const MS_JSON = path.join(__dirname, "..", "deployments", "multisigowner-sepolia.json");

const RESTORE_FEE = 250; // 市场原始费率 2.5%

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
async function logTx(label, promiseFn) {
  const tx = await promiseFn();
  const r = await tx.wait(1);
  console.log(`  ✓ ${label}`);
  console.log(`    ${EXPLORER}/tx/${r.hash}  (区块 ${r.blockNumber}, gas ${r.gasUsed})`);
  return r;
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

  console.log("多签治理实战验证（收尾）—— Sepolia");
  console.log("=".repeat(66));
  console.log("  市场 :", marketAddr);
  console.log("  多签 :", msAddr);

  const owner = await market.owner();
  if (!same(owner, msAddr)) {
    console.error(`✗ 市场 owner 是 ${owner}，不是多签。本脚本不做任何改动。`);
    process.exit(1);
  }
  const curFee = Number(await market.feeBps());
  console.log("  市场 owner :", owner, "（多签已接管 ✓）");
  console.log("  当前费率   :", curFee, "bps");

  // ---------------------------------------------------------- 第 2 关：1 票不能办事
  console.log("\n第 2 关：只凑 1 票就执行，必须被挡下");
  const count0 = Number(await ms.getTransactionCount());
  let soloIdx = -1;
  for (let i = count0 - 1; i >= 0; i--) {
    const t = await ms.getTransaction(i);
    if (!t.executed && Number(t.confirmations) === 1) {
      soloIdx = i;
      break;
    }
  }
  if (soloIdx >= 0) {
    const t = await ms.getTransaction(soloIdx);
    console.log(`  复用现有 1 票提案 #${soloIdx}（票数 ${t.confirmations}/2，目标：改费率 999）`);
  } else {
    const data = market.interface.encodeFunctionData("setFeeBps", [999]);
    await logTx("账号 1 建立新提案（自动投第一票）", () => ms.connect(w1).submit(marketAddr, 0, data));
    soloIdx = Number(await ms.getTransactionCount()) - 1;
    console.log(`  新建 1 票提案 #${soloIdx}（目标：改费率 999，仅账号 1 一票）`);
  }
  try {
    await ms.connect(w2).execute(soloIdx); // 故意换账号 2 触发：证明不是提交者的特权在起作用
    console.log("  ✗ 竟然执行成功了 —— 阈值保护失效，这是严重问题");
    process.exitCode = 1;
  } catch (err) {
    const msg = (err.shortMessage || err.message || String(err)).split("\n")[0];
    console.log("  [被拒]", msg);
    console.log("  结论：1 票不足以动用 owner 权力，单人无法擅自改费率 ✓");
  }

  // ---------------------------------------------------------- 第 3 关：还原费率
  console.log(`\n第 3 关：走完整流程把费率改回 ${RESTORE_FEE} bps`);
  if (curFee === RESTORE_FEE) {
    console.log("  [跳过] 费率已经是 " + RESTORE_FEE + "，无需改动。");
  } else {
    const data = market.interface.encodeFunctionData("setFeeBps", [RESTORE_FEE]);
    const idx = Number(await ms.getTransactionCount());
    console.log(`\n  ── 提案 #${idx}：setFeeBps(${RESTORE_FEE})`);
    await logTx("账号 1 提交（自动投第一票）", () => ms.connect(w1).submit(marketAddr, 0, data));
    await logTx("账号 2 补第二票", () => ms.connect(w2).confirm(idx));
    await logTx("账号 1 执行", () => ms.connect(w1).execute(idx));
    const t = await ms.getTransaction(idx);
    console.log(`    结果：票数 ${t.confirmations}/2，已执行 ${t.executed}`);
    const after = Number(await market.feeBps());
    console.log(`  链上费率 : ${after} bps → ${after === RESTORE_FEE ? "已还原 ✓" : "还原失败 ✗"}`);
    if (after !== RESTORE_FEE) process.exitCode = 1;
  }

  // ---------------------------------------------------------- 总结
  console.log("\n最终状态");
  console.log("  市场 owner   :", await market.owner());
  console.log("  市场费率     :", await market.feeBps(), "bps");
  console.log("  多签阈值     :", await ms.threshold());
  console.log("  多签提案总数 :", await ms.getTransactionCount());
  console.log(`\n${EXPLORER}/address/${marketAddr}`);
  console.log(`${EXPLORER}/address/${msAddr}\n`);
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error("\n收尾验证失败：", err.shortMessage || err.message || err);
    process.exit(1);
  });
