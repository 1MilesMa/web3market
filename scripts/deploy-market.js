/**
 * ============================================================================
 * 部署 SimpleMarket（NFT 市场合约）
 * ============================================================================
 *
 * 运行方式（在项目根目录）：
 *   本地网络：npx hardhat run scripts/deploy-market.js
 *   Sepolia ：npx hardhat run scripts/deploy-market.js --network sepolia
 *
 * 【这一步请你亲手执行】
 *   部署是唯一会真实消耗测试币、写进链上历史的操作，
 *   所以它留给你自己敲命令、自己看输出。脚本本身只负责把流程做对。
 *
 * 可调环境变量：
 *   FEE_BPS=250        平台手续费（基点），10000 = 100%，上限 1000（10%），默认 250（2.5%）
 *   MARKET_OWNER=0x... 市场 owner（可提现手续费、可调费率），默认取部署者地址
 *
 * 部署完成后会把地址写入 deployments/simplemarket-<网络名>.json，
 * 供 practice-market.js 演练脚本读取。
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const line = "-".repeat(60);

function info(label, value) {
  console.log(`  ${label}: ${value}`);
}
function ok(msg) {
  console.log("  [OK] " + msg);
}

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await hre.ethers.provider.getNetwork();
  const [deployer] = await hre.ethers.getSigners();

  // 费率：默认 250 bps（2.5%），允许用环境变量覆盖
  const feeBps = process.env.FEE_BPS ? Number(process.env.FEE_BPS) : 250;
  // owner：默认部署者，允许指定其他地址（比如多签钱包）
  const marketOwner = process.env.MARKET_OWNER || deployer.address;

  console.log("============================================================");
  console.log(" 部署 SimpleMarket（NFT 市场）");
  console.log("============================================================");
  info("网络", `${networkName} (chainId: ${chainId.toString()})`);
  info("部署者", deployer.address);
  info("市场 owner", marketOwner);
  info("平台手续费", `${feeBps} bps（${(feeBps / 100).toFixed(2)}%）`);

  // 部署前先看看余额够不够（本地网络余额很大，Sepolia 上要留意）
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  info("部署者余额", `${hre.ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error(
      "部署者余额为 0，无法支付部署 gas。\n" +
        "    Sepolia 测试币可去 https://sepoliafaucet.com 或 https://www.alchemy.com/faucets/ethereum-sepolia 领取"
    );
  }

  console.log("");
  console.log(line);
  console.log(" 编译产物检查与部署中...");
  console.log(line);

  const SimpleMarket = await hre.ethers.getContractFactory("SimpleMarket");
  const market = await SimpleMarket.deploy(marketOwner, feeBps);

  // ethers v6：部署后地址在 .target / getAddress()；等待上链需 waitForDeployment()
  const address = await market.getAddress();
  info("合约地址（已生成）", address);
  console.log("  等待部署交易上链...");

  const deployTx = market.deploymentTransaction();
  if (deployTx) {
    info("部署交易哈希", deployTx.hash);
    const receipt = await deployTx.wait();
    info("已确认", `区块 ${receipt.blockNumber} | gas ${receipt.gasUsed.toString()}`);
  }
  await market.waitForDeployment();
  ok("合约已部署");

  /* ---------------- 上链后回读校验（写操作之后必须做读验证） ---------------- */
  console.log("");
  console.log(line);
  console.log(" 上链后回读校验");
  console.log(line);

  const onChainOwner = await market.owner();
  const onChainFeeBps = await market.feeBps();
  const maxFeeBps = await market.MAX_FEE_BPS();

  info("owner()", onChainOwner);
  info("feeBps()", onChainFeeBps.toString());
  info("MAX_FEE_BPS()", maxFeeBps.toString());
  info("accumulatedFees()", (await market.accumulatedFees()).toString());

  if (onChainOwner.toLowerCase() !== marketOwner.toLowerCase()) {
    throw new Error(`owner 回读不一致：期望 ${marketOwner}，实际 ${onChainOwner}`);
  }
  if (onChainFeeBps !== BigInt(feeBps)) {
    throw new Error(`feeBps 回读不一致：期望 ${feeBps}，实际 ${onChainFeeBps}`);
  }
  ok("链上状态与部署参数一致");

  /* ---------------- 写入部署产物 ---------------- */
  const dir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const outFile = path.join(dir, `simplemarket-${networkName}.json`);
  const record = {
    contract: "SimpleMarket",
    address,
    network: networkName,
    chainId: chainId.toString(),
    owner: marketOwner,
    deployer: deployer.address,
    feeBps,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  info("部署产物", path.relative(process.cwd(), outFile));

  /* ---------------- 下一步指引 ---------------- */
  console.log("");
  console.log("============================================================");
  console.log(" 部署完成");
  console.log("============================================================");
  console.log(`  SimpleMarket 地址：${address}`);
  console.log("");
  console.log("  下一步：跑市场全流程演练");
  console.log(`    npx hardhat run scripts/practice-market.js --network ${networkName}`);
  console.log("");
  console.log("  演练会覆盖：授权 → 挂单 → 购买 → 撤单 → 多付退款 → 提现手续费");
  console.log("  如果还没部署 NFT 合集，演练会提示你先部署 MyNFT。");
  console.log("");
  if (networkName === "sepolia") {
    console.log("  区块浏览器：https://sepolia.etherscan.io/address/" + address);
  }
  console.log("");
}

main().catch((err) => {
  console.error("");
  console.error("× 部署失败：" + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
