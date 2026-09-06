const hre = require("hardhat");

async function main() {
  console.log("=== Hardhat 本地网络演示（无需测试币）===\n");

  const [owner, alice] = await hre.ethers.getSigners();
  console.log("账户1(部署者):", owner.address);
  console.log("账户2        :", alice.address, "\n");

  const Factory = await hre.ethers.getContractFactory("HelloWeb3");
  const c = await Factory.deploy("第一条留言：开始学习 Solidity");
  await c.waitForDeployment();

  console.log("合约已部署到本地区块链:", await c.getAddress());
  console.log("当前留言 :", await c.getMessage());
  console.log("历史条数 :", (await c.historyLength()).toString(), "\n");

  // 用另一个账户更新留言，验证 msg.sender 与事件
  const tx = await c.connect(alice).setMessage("第二条留言：来自另一个账户");
  const receipt = await tx.wait();
  console.log("账户2 更新留言成功，gas 消耗:", receipt.gasUsed.toString());
  console.log("当前留言 :", await c.getMessage());
  console.log("更新次数 :", (await c.updateCount()).toString());
  console.log("历史条数 :", (await c.historyLength()).toString(), "\n");

  const e = await c.getEntry(1);
  console.log("第 2 条记录详情:");
  console.log("  内容 :", e.content);
  console.log("  作者 :", e.author);
  console.log(
    "  时间 :",
    new Date(Number(e.timestamp) * 1000).toLocaleString("zh-CN")
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
