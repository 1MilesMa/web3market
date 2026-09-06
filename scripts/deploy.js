const hre = require("hardhat");

async function main() {
  const networkName = hre.network.name;
  console.log("当前网络:", networkName);

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) {
    throw new Error("未找到部署账户，请检查 .env 中的 PRIVATE_KEY");
  }
  console.log("部署账户:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("部署前余额:", hre.ethers.formatEther(balance), "ETH");

  if (networkName === "sepolia" && balance === 0n) {
    console.error("\n余额为 0，无法部署。请先领取 Sepolia 测试币后再运行。");
    process.exit(1);
  }

  const initialMessage =
    process.env.INITIAL_MESSAGE || "Hello Web3 —— 我的第一个智能合约";
  console.log("初始留言:", initialMessage);

  const Factory = await hre.ethers.getContractFactory("HelloWeb3");
  const contract = await Factory.deploy(initialMessage);
  const tx = contract.deploymentTransaction();

  console.log("\n部署交易已发送，等待区块确认...");
  console.log("交易哈希 :", tx.hash);

  await contract.waitForDeployment();
  const mined = await hre.ethers.provider.getTransactionReceipt(tx.hash);

  const address = await contract.getAddress();
  const gasCost = mined.gasUsed * mined.gasPrice;
  const balanceAfter = await hre.ethers.provider.getBalance(deployer.address);

  console.log("\n合约部署成功！");
  console.log("合约地址   :", address);
  console.log("交易哈希   :", tx.hash);
  console.log("区块高度   :", mined.blockNumber);
  console.log("Gas 用量   :", mined.gasUsed.toString(), "gas");
  console.log(
    "Gas 单价   :",
    hre.ethers.formatUnits(mined.gasPrice, "gwei"),
    "gwei"
  );
  console.log("部署总成本 :", hre.ethers.formatEther(gasCost), "ETH");
  console.log("部署后余额 :", hre.ethers.formatEther(balanceAfter), "ETH");
  console.log("最新留言   :", await contract.getMessage());
  console.log("历史条数   :", (await contract.historyLength()).toString());

  if (networkName === "sepolia") {
    console.log("\n区块浏览器: https://sepolia.etherscan.io/address/" + address);
    console.log("交易详情  : https://sepolia.etherscan.io/tx/" + tx.hash);
  }

  // 部署结果落盘，供后续验证脚本读取（避免手工复制地址出错）
  const fs = require("fs");
  const path = require("path");
  const outFile = path.join(__dirname, "..", "deployment-sepolia.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        network: "sepolia",
        chainId: 11155111,
        contract: "HelloWeb3",
        address,
        txHash: tx.hash,
        blockNumber: mined.blockNumber,
        gasUsed: mined.gasUsed.toString(),
        gasPriceWei: mined.gasPrice.toString(),
        deployCostEth: hre.ethers.formatEther(gasCost),
        deployer: deployer.address,
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
