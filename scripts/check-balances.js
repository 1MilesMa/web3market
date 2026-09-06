// 只读工具：查看 .env 里各私钥对应地址的 Sepolia 余额与 nonce
// 用法：npx hardhat run scripts/check-balances.js
// 安全：只打印地址（公开信息），绝不打印私钥；不发任何交易
require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const rpc = process.env.SEPOLIA_RPC_URL;
  if (!rpc) {
    console.error("✗ .env 里缺少 SEPOLIA_RPC_URL");
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(rpc);
  const net = await provider.getNetwork();
  console.log("链 ID :", net.chainId.toString(), net.chainId === 11155111n ? "(Sepolia ✓)" : "(不是 Sepolia！)");
  console.log("--------------------------------------------------------");

  const names = ["PRIVATE_KEY", "PRIVATE_KEY_2", "PRIVATE_KEY_3"];
  for (const name of names) {
    const pk = (process.env[name] || "").trim();
    if (!pk) {
      console.log(name.padEnd(14), "未配置");
      continue;
    }
    const wallet = new ethers.Wallet(pk, provider);
    let balance = "查询失败";
    let nonce = "?";
    try {
      balance = ethers.formatEther(await provider.getBalance(wallet.address)) + " ETH";
      nonce = await provider.getTransactionCount(wallet.address);
    } catch (err) {
      balance = "RPC 错误：" + (err.shortMessage || err.message);
    }
    console.log(name.padEnd(14), wallet.address, " 余额", balance, " nonce", nonce);
  }
  console.log("--------------------------------------------------------");
  console.log("提示：nonce 为 0 且余额为 0 的账号，说明还没领过水龙头测试币。");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
