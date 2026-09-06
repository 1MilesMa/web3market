/**
 * transfer-market-to-multisig.js —— 把 SimpleMarket 的 owner 移交给多签（Sepolia 实战）
 *
 * 跑法（PowerShell，项目根目录）：
 *   npx hardhat run scripts/transfer-market-to-multisig.js --network sepolia
 *
 * 剧本（两步走，缺一不可）：
 *   第 1 步  现任 owner（账号 1）提名多签 → transferOwnership，此时 owner 不变
 *   第 2 步  多签内部提案 acceptOwnership → 两人投票 → 执行，owner 才真正易主
 *   第 3 步  验证：账号 1 再想直接改费率，会被拒
 *
 * 安全约定：
 *   - 市场地址只读 deployments/simplemarket-sepolia.json，缺文件就报错退出，绝不静默重部署
 *   - 可重入：owner 已是多签就跳过；pendingOwner 已是多签就跳过提名
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
  console.log(`    txHash ${receipt.hash}`);
  console.log(`    ${EXPLORER}/tx/${receipt.hash}   (区块 ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  return receipt;
}

async function main() {
  const keys = ["PRIVATE_KEY", "PRIVATE_KEY_2", "PRIVATE_KEY_3"].map((k) =>
    (process.env[k] || "").trim()
  );
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

  const marketInfo = load(MARKET_JSON, "市场部署产物");
  const msInfo = load(MS_JSON, "多签部署产物");
  const marketAddr = marketInfo.address;
  const msAddr = msInfo.address;

  const market = await ethers.getContractAt("SimpleMarket", marketAddr, w1);
  const ms = await ethers.getContractAt("MultiSigOwner", msAddr, w1);

  console.log("市场 owner 移交多签 —— Sepolia 实战");
  console.log("=".repeat(66));
  console.log("  市场       :", marketAddr);
  console.log("  多签       :", msAddr);
  console.log("  现任 owner :", await market.owner());
  console.log("  账号 1     :", w1.address);
  console.log("  账号 2     :", w2.address);
  console.log("  账号 3     :", w3.address);

  const owner = await market.owner();
  if (!same(owner, w1.address)) {
    console.error(`✗ 市场 owner 是 ${owner}，不是账号 1，无法发起移交。`);
    process.exit(1);
  }
  if (same(owner, msAddr)) {
    console.log("\n[跳过] 市场 owner 已经是多签，无需再次移交。");
    return;
  }
  // 多签自身配置校验，防止移交给一个配置异常的地址
  const threshold = Number(await ms.threshold());
  const isMember1 = await ms.isOwner(w1.address);
  if (threshold !== 2 || !isMember1) {
    console.error(`✗ 多签配置异常（阈值 ${threshold}，账号1 是成员：${isMember1}），中止移交。`);
    process.exit(1);
  }

  // ---------------------------------------------------------------- 第 1 步
  console.log("\n第 1 步：账号 1 提名多签接任（transferOwnership）");
  const pending = await market.pendingOwner();
  if (same(pending, msAddr)) {
    console.log("  [复用] pendingOwner 已经是多签，跳过提名。");
  } else {
    await send(w1, "提名已上链", () => market.transferOwnership(msAddr));
  }
  console.log("  pendingOwner =", await market.pendingOwner());
  console.log("  owner        =", await market.owner(), "（还是账号 1 —— 两步走的关键）");

  // ---------------------------------------------------------------- 第 2 步
  console.log("\n第 2 步：多签内部投票，通过后才 acceptOwnership");
  const acceptData = market.interface.encodeFunctionData("acceptOwnership");
  const before = Number(await ms.getTransactionCount());
  console.log("  当前提案总数：", before);

  await send(w1, `账号 1 提交提案 #${before}（提交即投第一票）`, () =>
    ms.connect(w1).submit(marketAddr, 0, acceptData)
  );
  let t = await ms.getTransaction(before);
  console.log(`    票数 ${t.confirmations}/2，已执行 ${t.executed}`);

  await send(w2, `账号 2 补上第二票`, () => ms.connect(w2).confirm(before));
  t = await ms.getTransaction(before);
  console.log(`    票数 ${t.confirmations}/2，已执行 ${t.executed}`);

  await send(w1, `账号 1 触发执行`, () => ms.connect(w1).execute(before));
  t = await ms.getTransaction(before);
  console.log(`    票数 ${t.confirmations}/2，已执行 ${t.executed}`);

  // ---------------------------------------------------------------- 第 3 步
  console.log("\n第 3 步：验证结果");
  const newOwner = await market.owner();
  console.log("  市场 owner   :", newOwner);
  console.log("  是否为多签   :", same(newOwner, msAddr) ? "是，接管成功 ✓" : "否，接管失败 ✗");
  if (!same(newOwner, msAddr)) {
    console.error("✗ 接管未生效，请到 Etherscan 核对交易。");
    process.exit(1);
  }

  console.log("\n  账号 1 想绕过多签，直接把费率改成 999 bps（约 10%）……");
  try {
    await market.connect(w1).setFeeBps(999);
    console.log("  ✗ 竟然改成了 —— 这是严重问题，请立刻检查");
  } catch (err) {
    const msg = (err.shortMessage || err.message || String(err)).split("\n")[0];
    console.log("  [被拒]", msg);
    console.log("  结论：老账号彻底失去特权 —— 以后改费率必须两个人点头。");
  }

  console.log("\n最终状态");
  console.log("  市场 owner :", await market.owner());
  console.log("  市场费率   :", await market.feeBps(), "bps");
  console.log("  多签阈值   :", await ms.threshold());
  console.log("  多签提案数 :", await ms.getTransactionCount());
  console.log(`\n${EXPLORER}/address/${marketAddr}`);
  console.log(`${EXPLORER}/address/${msAddr}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n移交失败：", err.shortMessage || err.message || err);
    process.exit(1);
  });
