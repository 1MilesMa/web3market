/**
 * 给测试账户转测试币（内部划转，绕过水龙头）
 *
 * 用法：
 *   npx hardhat run scripts/fund-account.js --network sepolia
 *   可用环境变量覆盖：
 *     TARGET  = 收款地址（默认买家 B）
 *     AMOUNT  = 转账数量，单位 ETH（默认 0.02）
 *
 * 用的是 hardhat.config.js 里配置的第一个账户（PRIVATE_KEY，即部署者主账户）。
 * 只用于测试网内部划转，别拿去碰任何有真实资产的钱包。
 */

const hre = require("hardhat");

async function main() {
  const [sender] = await hre.ethers.getSigners();
  const target = process.env.TARGET || "0x38e1969A889bF4912919D4b93cdF3c06dC6cd72a";
  const amount = process.env.AMOUNT || "0.02";

  const value = hre.ethers.parseEther(amount);
  const bal = await hre.ethers.provider.getBalance(sender.address);

  console.log("网络        :", hre.network.name);
  console.log("付款方      :", sender.address);
  console.log("收款方      :", target);
  console.log("付款方余额  :", hre.ethers.formatEther(bal), "ETH");
  console.log("转账金额    :", amount, "ETH");

  if (bal < value) {
    throw new Error(`余额不足：仅有 ${hre.ethers.formatEther(bal)} ETH，需要 ${amount} ETH`);
  }

  const before = await hre.ethers.provider.getBalance(target);
  const tx = await sender.sendTransaction({ to: target, value });
  console.log("交易哈希    :", tx.hash);

  const receipt = await tx.wait();
  const after = await hre.ethers.provider.getBalance(target);

  console.log("已确认      : 区块", receipt.blockNumber, "| gas", receipt.gasUsed.toString());
  console.log("收款方余额  :", hre.ethers.formatEther(before), "->", hre.ethers.formatEther(after), "ETH");
  console.log("[OK] 到账", amount, "ETH");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("[FAIL]", e.message);
  process.exit(1);
});
