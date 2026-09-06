// 部署 MyToken（ERC20）到 Sepolia 测试网
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const signers = await hre.ethers.getSigners();
  console.log("当前网络 :", hre.network.name);
  console.log("部署账户 :", deployer.address);
  console.log("账户数量 :", signers.length);
  if (signers.length > 1) {
    console.log("第二账户 :", signers[1].address);
  }

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("部署前余额:", hre.ethers.formatEther(balance), "ETH");
  if (balance === 0n) {
    throw new Error("余额为 0，无法部署");
  }

  // 初始发行量：100 万枚（单位为「整币」，合约内部会按 18 位小数放大）
  const INITIAL_SUPPLY = 1_000_000;

  const Factory = await hre.ethers.getContractFactory("MyToken");
  const contract = await Factory.deploy(deployer.address, INITIAL_SUPPLY);
  const tx = contract.deploymentTransaction();

  console.log("\n部署交易已发送，等待确认...");
  console.log("交易哈希 :", tx.hash);

  await contract.waitForDeployment();
  const mined = await hre.ethers.provider.getTransactionReceipt(tx.hash);
  const address = await contract.getAddress();
  const cost = mined.gasUsed * mined.gasPrice;

  console.log("\nERC20 部署成功！");
  console.log("合约地址   :", address);
  console.log("交易哈希   :", tx.hash);
  console.log("区块高度   :", mined.blockNumber);
  console.log("Gas 用量   :", mined.gasUsed.toString(), "gas");
  console.log("Gas 单价   :", hre.ethers.formatUnits(mined.gasPrice, "gwei"), "gwei");
  console.log("部署成本   :", hre.ethers.formatEther(cost), "ETH");
  console.log("name       :", await contract.name());
  console.log("symbol     :", await contract.symbol());
  console.log("decimals   :", (await contract.decimals()).toString());
  console.log("totalSupply:", hre.ethers.formatUnits(await contract.totalSupply(), 18), "MTK");
  console.log("owner      :", await contract.owner());

  const outFile = path.join(__dirname, "..", "deployment-mytoken-sepolia.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        network: "sepolia",
        chainId: 11155111,
        contract: "MyToken",
        address,
        txHash: tx.hash,
        blockNumber: mined.blockNumber,
        gasUsed: mined.gasUsed.toString(),
        gasPriceWei: mined.gasPrice.toString(),
        deployCostEth: hre.ethers.formatEther(cost),
        initialSupply: INITIAL_SUPPLY,
        owner: deployer.address,
        openzeppelin: require("@openzeppelin/contracts/package.json").version,
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("\n部署信息已写入:", outFile);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
