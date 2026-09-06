/**
 * ============================================================================
 * MyNFT（ERC721）部署脚本 —— 【请你自己执行，Agent 不会替你跑】
 * ============================================================================
 *
 * 用法（在项目根目录 web3-contract-project 下执行）：
 *
 *   1) 部署到本地 Hardhat 内置链（一次性内存链，进程结束即消失，用于验证脚本能跑通）
 *      npx hardhat run scripts/deploy-mynft.js --network hardhat
 *
 *   2) 部署到本地常驻节点（先另开一个终端跑 npx hardhat node）
 *      npx hardhat run scripts/deploy-mynft.js --network localhost
 *
 *   3) 部署到 Sepolia 测试网（需要 .env 里配好 PRIVATE_KEY 与 SEPOLIA_RPC_URL，且账户有测试币）
 *      npx hardhat run scripts/deploy-mynft.js --network sepolia
 *
 * 可选环境变量：
 *   INITIAL_OWNER  合约 owner，默认取部署账户
 *   MAX_SUPPLY     铸造上限，默认 10000
 *   ROYALTY_RECEIVER      版税接收者地址，默认取部署账户（也就是你自己）
 *   ROYALTY_FEE_NUMERATOR 版税分子，分母固定 10000，默认 500（= 5%）
 *                         想部署"无版税"版本就设成 0 并把 RECEIVER 设成零地址
 *                         更常见的做法：先部署无版税，链上验证后再用 setDefaultRoyalty 补设
 *
 * 部署成功后，合约地址会写入 deployments/mynft-<网络名>.json，
 * 后续 scripts/verify-mynft.js 会自动读取它，你不用手动复制粘贴地址。
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

/** 根据 chainId 返回区块浏览器基础地址（用于打印可点击的链接） */
function explorerBaseUrl(chainId) {
  const map = {
    1: "https://etherscan.io",
    11155111: "https://sepolia.etherscan.io",
    137: "https://polygonscan.com",
    31337: null, // 本地链没有浏览器
  };
  return map[Number(chainId)] || null;
}

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await hre.ethers.provider.getNetwork();
  const [deployer] = await hre.ethers.getSigners();

  console.log("============================================================");
  console.log(" MyNFT 部署");
  console.log("============================================================");
  console.log("网络          :", networkName, "(chainId:", chainId.toString() + ")");
  console.log("部署账户      :", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("账户余额      :", hre.ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    console.error("");
    console.error("[X] 余额为 0，无法发送部署交易。");
    if (chainId === 11155111n) {
      console.error("    Sepolia 测试币请前往水龙头领取：");
      console.error("    https://sepoliafaucet.com/  或  https://www.alchemy.com/faucets/ethereum-sepolia");
    } else {
      console.error("    本地网络请先启动节点：npx hardhat node");
    }
    process.exit(1);
  }

  // owner 与铸造上限：允许用环境变量覆盖，默认 owner = 部署账户
  const initialOwner = process.env.INITIAL_OWNER || deployer.address;
  const maxSupply = process.env.MAX_SUPPLY || "10000";

  // 版税参数（EIP-2981）：分母固定 10000，500 = 5%
  const royaltyReceiver = process.env.ROYALTY_RECEIVER || deployer.address;
  const royaltyFeeNumerator = process.env.ROYALTY_FEE_NUMERATOR || "500";

  console.log("合约 owner    :", initialOwner);
  console.log("铸造上限      :", maxSupply);
  console.log("版税接收者    :", royaltyReceiver);
  console.log(
    "版税率        :",
    royaltyFeeNumerator,
    "/ 10000 =",
    (Number(royaltyFeeNumerator) / 100).toFixed(2) + "%"
  );
  console.log("------------------------------------------------------------");

  // 简单的格式校验，避免手抖写错地址白跑一趟
  if (!hre.ethers.isAddress(royaltyReceiver)) {
    throw new Error(`ROYALTY_RECEIVER 不是合法地址：${royaltyReceiver}`);
  }
  const numerator = Number(royaltyFeeNumerator);
  if (!Number.isInteger(numerator) || numerator < 0 || numerator > 10000) {
    throw new Error(`ROYALTY_FEE_NUMERATOR 必须是 0 ~ 10000 之间的整数：${royaltyFeeNumerator}`);
  }

  // 1. 拿到合约工厂（需要 artifacts 已生成，即先跑过 npx hardhat compile）
  const MyNFT = await hre.ethers.getContractFactory("MyNFT");

  // 2. 发起部署交易
  console.log("正在发送部署交易，等待矿工确认...");
  const nft = await MyNFT.deploy(
    initialOwner,
    maxSupply,
    royaltyReceiver,
    royaltyFeeNumerator
  );
  const deployTx = nft.deploymentTransaction();
  console.log("交易哈希      :", deployTx.hash);

  // 3. 等待上链
  await nft.waitForDeployment();
  const address = await nft.getAddress();
  const receipt = await deployTx.wait();

  console.log("[OK] 部署成功！");
  console.log("合约地址      :", address);
  console.log("所在区块      :", receipt.blockNumber);
  console.log("消耗 gas      :", receipt.gasUsed.toString());
  console.log("gas 价格      :", hre.ethers.formatUnits(deployTx.gasPrice || 0n, "gwei"), "gwei");

  const base = explorerBaseUrl(chainId);
  if (base) {
    console.log("浏览器查看    :", `${base}/address/${address}`);
    console.log("交易详情      :", `${base}/tx/${deployTx.hash}`);
  }

  // 4. 把地址落盘，供后续验证脚本读取
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const outFile = path.join(deploymentsDir, `mynft-${networkName}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        network: networkName,
        chainId: Number(chainId),
        contract: "MyNFT",
        address,
        deployer: deployer.address,
        initialOwner,
        maxSupply,
        // 版税（EIP-2981）：receiver + 分子，分母固定 10000
        royaltyReceiver,
        royaltyFeeNumerator: Number(royaltyFeeNumerator),
        royaltyDenominator: 10000,
        royaltyPercent: (Number(royaltyFeeNumerator) / 100).toFixed(2) + "%",
        txHash: deployTx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("地址已保存到  :", path.relative(process.cwd(), outFile));

  // 5. 回读链上状态，确认合约真的活了（不要只看脚本没报错就以为成功）
  console.log("------------------------------------------------------------");
  console.log("链上回读校验：");
  console.log("  name()          :", await nft.name());
  console.log("  symbol()        :", await nft.symbol());
  console.log("  owner()         :", await nft.owner());
  console.log("  maxSupply()     :", (await nft.maxSupply()).toString());
  console.log("  totalSupply()   :", (await nft.totalSupply()).toString());
  console.log("  nextTokenId()   :", (await nft.nextTokenId()).toString());

  // 版税（EIP-2981）回读：用 1 ETH 的假想成交价试算，同时确认接口自报家门
  const salePrice = hre.ethers.parseEther("1");
  const [rReceiver, rAmount] = await nft.royaltyInfo(1, salePrice);
  console.log("  supportsInterface(0x2a55205a) :", await nft.supportsInterface("0x2a55205a"));
  console.log("  royaltyInfo(#1, 1 ETH) 接收者 :", rReceiver);
  console.log("  royaltyInfo(#1, 1 ETH) 金额   :", hre.ethers.formatEther(rAmount), "ETH");
  console.log("  royaltyDenominator()   :", (await nft.royaltyDenominator()).toString());

  console.log("============================================================");
  console.log("下一步：铸造并做链上验证");
  console.log(`  npx hardhat run scripts/verify-mynft.js --network ${networkName}`);
  console.log("============================================================");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("");
    console.error("[X] 部署失败：", err.message || err);
    process.exit(1);
  });
