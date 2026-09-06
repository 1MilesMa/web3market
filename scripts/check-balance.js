// 查询 Sepolia 测试网连通性与部署账户余额（部署前的最后一道检查）
const hre = require("hardhat");

async function main() {
  const networkName = hre.network.name;
  const [signer] = await hre.ethers.getSigners();
  if (!signer) {
    throw new Error("未找到部署账户，请检查 .env 中的 PRIVATE_KEY");
  }

  const network = await hre.ethers.provider.getNetwork();
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  const balance = await hre.ethers.provider.getBalance(signer.address);

  console.log("网络名称     :", networkName);
  console.log("chainId      :", network.chainId.toString());
  console.log("最新区块高度 :", blockNumber);
  console.log("部署账户     :", signer.address);
  console.log("账户余额     :", hre.ethers.formatEther(balance), "ETH");

  const gasPrice = await hre.ethers.provider.getFeeData();
  console.log(
    "当前 gasPrice:",
    gasPrice.gasPrice ? hre.ethers.formatUnits(gasPrice.gasPrice, "gwei") : "N/A",
    "gwei"
  );

  if (balance === 0n) {
    console.error("\n余额为 0，无法部署。请先领取 Sepolia 测试币。");
    process.exit(1);
  }
  console.log("\nRPC 连通正常，余额充足，可以部署。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
