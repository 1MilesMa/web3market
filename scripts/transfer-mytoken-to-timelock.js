/**
 * transfer-mytoken-to-timelock.js —— 把 MyToken 的 owner 交给时间锁（Sepolia）
 *
 * 为什么要做：MyToken 是 ERC20，owner 手里握着 onlyOwner 的 mint / burn。
 *   只要它还是部署者 EOA，一把私钥就能无限增发，练习合约也会被当成"项目方还能印钱"。
 *   交给时间锁后，增发要走「多签 2 票 → 排队 → 执行」，与 SimpleMarket / MyNFT 对齐。
 *
 * 与 MyNFT 的区别：MyNFT 是 Ownable2Step（提名 + 接受两步），MyToken 是 Ownable，
 *   transferOwnership 一笔到位，不需要 pendingOwner / acceptOwnership。
 *
 * 用法（项目根目录，PowerShell）：
 *   npx hardhat run scripts/transfer-mytoken-to-timelock.js --network sepolia          # 演练
 *   $env:EXECUTE='1'; npx hardhat run scripts/transfer-mytoken-to-timelock.js --network sepolia
 *
 * 安全约定：
 *   - 默认演练，不发交易
 *   - 地址全部从部署产物读，缺文件就退出，绝不重部署
 *   - 可重入：owner 已是时间锁则直接跳过
 *   - 私钥只读本地 .env，不打印
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const EXPLORER = "https://sepolia.etherscan.io";
const TOKEN_JSON = path.join(__dirname, "..", "deployment-mytoken-sepolia.json");
const MS_JSON = path.join(__dirname, "..", "deployments", "multisigowner-sepolia.json");
const TL_JSON = path.join(__dirname, "..", "deployments", "markettimelock-sepolia.json");

function load(p, what) {
  if (!fs.existsSync(p)) {
    console.error(`✗ 找不到${what}（${p}）。请先跑对应部署脚本，本脚本不会替你重部署。`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const EXECUTE = process.env.EXECUTE === "1";

async function main() {
  const keys = ["PRIVATE_KEY", "PRIVATE_KEY_2", "PRIVATE_KEY_3"].map((k) => (process.env[k] || "").trim());
  if (keys.some((k) => !k)) {
    console.error("✗ .env 里 PRIVATE_KEY / PRIVATE_KEY_2 / PRIVATE_KEY_3 必须三个都配好（本脚本至少要用到部署者那一把）");
    process.exit(1);
  }
  const provider = ethers.provider;
  const net = await provider.getNetwork();
  if (net.chainId !== 11155111n) {
    console.error("✗ 当前不是 Sepolia 网络，请在命令末尾加 --network sepolia");
    process.exit(1);
  }
  const wallets = keys.map((pk) => new ethers.Wallet(pk, provider));

  const tokenAddr = load(TOKEN_JSON, "MyToken 部署产物").address;
  const msAddr = load(MS_JSON, "多签部署产物").address;
  const tlAddr = load(TL_JSON, "时间锁部署产物").address;

  const token = await ethers.getContractAt("MyToken", tokenAddr, wallets[0]);
  const ms = await ethers.getContractAt("MultiSigOwner", msAddr, wallets[0]);
  const timelock = await ethers.getContractAt("MarketTimelock", tlAddr, wallets[0]);

  console.log("=".repeat(68));
  console.log(`MyToken owner 移交时间锁 —— Sepolia（${EXECUTE ? "真实执行" : "演练模式，不发交易"}）`);
  console.log("=".repeat(68));
  console.log("  MyToken :", tokenAddr);
  console.log("  多签    :", msAddr);
  console.log("  时间锁  :", tlAddr);
  console.log("  总供应量:", ethers.formatUnits(await token.totalSupply(), 18), "MTK");

  const owner = await token.owner();
  console.log("\n当前 owner :", owner);

  if (same(owner, tlAddr)) {
    console.log("\n[已完成] MyToken owner 已经是时间锁，无需再次移交。");
    console.log(`\n${EXPLORER}/address/${tokenAddr}\n`);
    return;
  }

  // 移交后治理不能锁死：多签必须是时间锁的 proposer
  const hasProposer = await timelock.hasRole(await timelock.PROPOSER_ROLE(), msAddr);
  if (!hasProposer) {
    console.error("✗ 该多签不是时间锁的 proposer，移交后 MyToken 的治理会锁死（谁都动不了 mint/burn）。");
    process.exit(1);
  }
  console.log("  多签是时间锁 proposer：是（移交后治理可运转）");

  const who = wallets.find((w) => same(owner, w.address));
  if (!who) {
    console.error(`✗ MyToken owner 是 ${owner}，不是本脚本持有的任何一把私钥，无法发起移交。`);
    process.exit(1);
  }
  console.log(`\n当前 owner 是本地 EOA ${owner}（钱包 ${wallets.indexOf(who) + 1}），由它本人发起 transferOwnership`);

  const bal = await provider.getBalance(who.address);
  console.log("  该 EOA 余额:", ethers.formatEther(bal), "ETH");
  if (bal === 0n) {
    console.error("✗ 余额为 0，付不了 gas。");
    process.exit(1);
  }

  if (!EXECUTE) {
    console.log("\n[演练] 将发送：transferOwnership(时间锁)");
    console.log("  所有权一次性转移（Ownable 不是两步交接），执行后 owner 立即变成时间锁。");
    console.log("  若要真上链，重跑时加上 $env:EXECUTE='1'");
    return;
  }

  const tx = await token.connect(who).transferOwnership(tlAddr);
  const r = await tx.wait(1);
  console.log("\n  ✅ transferOwnership 已上链");
  console.log(`    ${EXPLORER}/tx/${r.hash}   (区块 ${r.blockNumber}, gas ${r.gasUsed})`);
  console.log("\n  MyToken owner 现在是：", await token.owner());
  console.log(`  链上查看：${EXPLORER}/address/${tokenAddr}`);
  console.log("");
}

main().catch((e) => {
  console.error("✗ 出错：", e.message);
  process.exit(1);
});
