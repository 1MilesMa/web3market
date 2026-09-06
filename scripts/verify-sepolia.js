// Sepolia 链上验证：读取合约状态 + 一次写入往返，确认交互正常
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const infoPath = path.join(__dirname, "..", "deployment-sepolia.json");
  if (!fs.existsSync(infoPath)) {
    throw new Error("未找到 deployment-sepolia.json，请先执行部署脚本");
  }
  const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  console.log("合约地址:", info.address);

  const [signer] = await hre.ethers.getSigners();
  const contract = await hre.ethers.getContractAt(
    "HelloWeb3",
    info.address,
    signer
  );

  console.log("\n===== 1. 读取链上状态（view 调用，不消耗 gas）=====");
  const owner = await contract.owner();
  const updateCount = await contract.updateCount();
  const historyLength = await contract.historyLength();
  const message = await contract.getMessage();
  const entry0 = await contract.getEntry(0);

  console.log("owner         :", owner);
  console.log("updateCount   :", updateCount.toString());
  console.log("historyLength :", historyLength.toString());
  console.log("getMessage()  :", message);
  console.log("getEntry(0)   :");
  console.log("   content    :", entry0.content);
  console.log("   author     :", entry0.author);
  console.log("   timestamp  :", new Date(Number(entry0.timestamp) * 1000).toISOString());

  console.log("\n===== 2. 写入往返验证（发送交易，消耗 gas）=====");
  const newMessage = "Sepolia 写入验证 @" + new Date().toISOString();
  console.log("准备写入:", newMessage);
  const balanceBefore = await hre.ethers.provider.getBalance(signer.address);

  const tx = await contract.setMessage(newMessage);
  console.log("写交易哈希:", tx.hash);
  const receipt = await tx.wait();

  const gasCost = receipt.gasUsed * receipt.gasPrice;
  const balanceAfter = await hre.ethers.provider.getBalance(signer.address);
  console.log("区块高度   :", receipt.blockNumber);
  console.log("Gas 用量   :", receipt.gasUsed.toString(), "gas");
  console.log("写入成本   :", hre.ethers.formatEther(gasCost), "ETH");
  console.log("余额变化   :", hre.ethers.formatEther(balanceBefore), "->", hre.ethers.formatEther(balanceAfter), "ETH");

  console.log("\n===== 3. 回读校验 =====");
  const after = await contract.getMessage();
  const afterCount = await contract.updateCount();
  const afterLen = await contract.historyLength();
  console.log("getMessage()  :", after);
  console.log("updateCount   :", afterCount.toString());
  console.log("historyLength :", afterLen.toString());

  const okRead = after === newMessage;
  const okCount = afterCount.toString() === (updateCount + 1n).toString();
  const okLen = afterLen.toString() === (historyLength + 1n).toString();
  const okOwner = owner.toLowerCase() === signer.address.toLowerCase();

  console.log("\n===== 验证结论 =====");
  console.log("读取一致   :", okRead ? "PASS" : "FAIL");
  console.log("计数递增   :", okCount ? "PASS" : "FAIL");
  console.log("历史条数   :", okLen ? "PASS" : "FAIL");
  console.log("owner 正确 :", okOwner ? "PASS" : "FAIL");
  console.log(
    "总体       :",
    okRead && okCount && okLen && okOwner ? "全部通过" : "存在失败项"
  );

  const outFile = path.join(__dirname, "..", "verification-sepolia.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        contract: info.address,
        txHash: info.txHash,
        writeTxHash: tx.hash,
        owner,
        messageAfterWrite: after,
        updateCount: afterCount.toString(),
        historyLength: afterLen.toString(),
        checks: {
          readMatch: okRead,
          countIncremented: okCount,
          historyIncremented: okLen,
          ownerCorrect: okOwner,
        },
        verifiedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("\n验证结果已写入:", outFile);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
