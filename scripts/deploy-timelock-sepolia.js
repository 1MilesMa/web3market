/**
 * deploy-timelock-sepolia.js —— 把时间锁部署到 Sepolia
 *
 * 跑法（PowerShell，项目根目录）：
 *   $env:TIMELOCK_DELAY_SECONDS = 3600
 *   npx hardhat run scripts/deploy-timelock-sepolia.js --network sepolia
 *
 * 角色约定（写死在部署参数里，部署后无法偷偷改）：
 *   proposers = [多签地址]        → 唯一有权排队的人，同时自动获得 canceller 权限
 *   executors = [address(0)]      → 开放执行：公示期走完后任何人都能触发，不怕最后一公里没人点
 *   admin     = address(0)        → 不留管理员后门，改延迟也必须走时间锁自己排一次队
 *
 * 安全约定：
 *   - 多签地址只读 deployments/multisigowner-sepolia.json，缺文件就报错退出
 *   - 部署后回读链上角色与延迟做二次校验，任一不符立即报错
 *   - 私钥只从本地 .env 读，不打印、不上传
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const EXPLORER = "https://sepolia.etherscan.io";
const MS_JSON = path.join(__dirname, "..", "deployments", "multisigowner-sepolia.json");
const OUT_JSON = path.join(__dirname, "..", "deployments", "markettimelock-sepolia.json");
const ZERO = ethers.ZeroAddress;

const DELAY = Number(process.env.TIMELOCK_DELAY_SECONDS || 3600);

function humanDelay(sec) {
  if (sec >= 86400) return `${(sec / 86400).toFixed(2)} 天`;
  if (sec >= 3600) return `${(sec / 3600).toFixed(2)} 小时`;
  if (sec >= 60) return `${(sec / 60).toFixed(1)} 分钟`;
  return `${sec} 秒`;
}

async function main() {
  const pk = (process.env.PRIVATE_KEY || "").trim();
  if (!pk) {
    console.error("✗ .env 里缺少 PRIVATE_KEY");
    process.exit(1);
  }

  const provider = ethers.provider;
  const net = await provider.getNetwork();
  if (net.chainId !== 11155111n) {
    console.error("✗ 当前不是 Sepolia 网络，请在命令末尾加 --network sepolia");
    process.exit(1);
  }
  const wallet = new ethers.Wallet(pk, provider);

  if (!fs.existsSync(MS_JSON)) {
    console.error(`✗ 找不到多签部署产物（${MS_JSON}）。请先部署多签，本脚本不会替你重部署。`);
    process.exit(1);
  }
  const msInfo = JSON.parse(fs.readFileSync(MS_JSON, "utf8"));
  const msAddr = msInfo.address;

  console.log("=".repeat(68));
  console.log("部署 MarketTimelock —— Sepolia");
  console.log("=".repeat(68));
  console.log("  minDelay  :", DELAY, `秒 (${humanDelay(DELAY)})`);
  console.log("  proposers :", msAddr, "（多签；自动同时获得 canceller）");
  console.log("  executors :", ZERO, "（address(0) = 开放给所有人执行）");
  console.log("  admin     :", ZERO, "（零地址 = 不留管理员后门）");
  console.log("  部署账号  :", wallet.address);

  const bal = await provider.getBalance(wallet.address);
  console.log("  账号余额  :", ethers.formatEther(bal), "ETH");
  if (bal < ethers.parseEther("0.005")) {
    console.error("✗ 余额偏低，先去水龙头领点测试币再部署。");
    process.exit(1);
  }

  console.log("\n开始部署……");
  const Factory = await ethers.getContractFactory("MarketTimelock", wallet);
  const timelock = await Factory.deploy(DELAY, [msAddr], [ZERO], ZERO);
  const deployTx = timelock.deploymentTransaction();
  await timelock.waitForDeployment();
  const addr = await timelock.getAddress();
  const receipt = await deployTx.wait(1);

  console.log("\n✓ 部署完成");
  console.log("  时间锁地址 :", addr);
  console.log("  txHash     :", receipt.hash);
  console.log("  区块       :", receipt.blockNumber, " gas:", receipt.gasUsed.toString());
  console.log(`  ${EXPLORER}/tx/${receipt.hash}`);

  // ------------------------------------------------------------ 回读校验
  console.log("\n回读链上状态做二次校验");
  const checks = [];
  const minDelay = Number(await timelock.getMinDelay());
  checks.push(["最小延迟 = 设定值", minDelay === DELAY, `${minDelay}`]);

  const proposerRole = await timelock.PROPOSER_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  const adminRole = await timelock.DEFAULT_ADMIN_ROLE();

  const hasProposer = await timelock.hasRole(proposerRole, msAddr);
  checks.push(["多签拥有 PROPOSER_ROLE", hasProposer, `${hasProposer}`]);
  const hasCanceller = await timelock.hasRole(cancellerRole, msAddr);
  checks.push(["多签拥有 CANCELLER_ROLE", hasCanceller, `${hasCanceller}`]);
  const openExecutor = await timelock.hasRole(executorRole, ZERO);
  checks.push(["执行权限对公众开放", openExecutor, `${openExecutor}`]);
  const noAdmin = !(await timelock.hasRole(adminRole, wallet.address));
  checks.push(["部署者未留管理员后门", noAdmin, `${noAdmin}`]);

  let allOk = true;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${name} — ${detail}`);
    if (!ok) allOk = false;
  }
  if (!allOk) {
    console.error("\n✗ 链上状态与预期不符，请勿继续移交，先排查。");
    process.exit(1);
  }

  // ------------------------------------------------------------ 落盘
  const out = {
    contract: "MarketTimelock",
    address: addr,
    network: "sepolia",
    chainId: "11155111",
    minDelay: DELAY,
    proposers: [msAddr],
    executors: [ZERO],
    admin: ZERO,
    deployer: wallet.address,
    deployedAt: new Date().toISOString(),
    blockNumber: receipt.blockNumber,
    txHash: receipt.hash,
    note: "角色：多签可提案可撤销，执行对公众开放，无管理员后门",
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), "utf8");
  console.log("\n✓ 部署信息已写入", OUT_JSON);

  console.log("\n下一步");
  console.log("  npx hardhat run scripts/transfer-market-to-timelock.js --network sepolia");
  console.log("  该脚本会先把 owner 排队公示，等时间到再跑一次即可完成易主。");
  console.log(`\n${EXPLORER}/address/${addr}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n部署失败：", err.shortMessage || err.message || err);
    process.exit(1);
  });
