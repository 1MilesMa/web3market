// 用 Sourcify 批量验证已部署合约的源码
//
// 为什么不用命令行 `npx hardhat verify:sourcify`：
//   verify:sourcify 是内部 subtask，CLI 直接调用会报 HH312，必须用 hre.run 从脚本调
//
// 为什么选 Sourcify 而不是 Etherscan：
//   本机到 Etherscan 全域名（网页/API/sepolia 子站）实测超时不可达；
//   Sourcify（https://sourcify.dev/server）实测 HTTP 200 可达，
//   且不需要注册账号与 API Key，源码存 IPFS，公开可查
//
// 用法：npx hardhat run scripts/verify-sourcify.js --network sepolia

const TARGETS = [
  {
    name: "MyNFT",
    address: "0x9EFe00123a6A22d903D63E195B7E87Bf3622412e",
    contract: "contracts/MyNFT.sol:MyNFT",
  },
  {
    name: "SimpleMarket",
    address: "0x71450D767f2b83722b88164316d7308DB20A39c8",
    contract: "contracts/SimpleMarket.sol:SimpleMarket",
  },
  {
    name: "MultiSigOwner",
    address: "0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317",
    contract: "contracts/MultiSigOwner.sol:MultiSigOwner",
  },
  {
    name: "MarketTimelock",
    address: "0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119",
    contract: "contracts/MarketTimelock.sol:MarketTimelock",
  },
];

async function main() {
  const hre = require("hardhat");

  console.log("=== Sourcify 源码验证 ===");
  console.log("网络:", hre.network.name, "| chainId:", hre.network.config.chainId);
  console.log("API 端点:", hre.config.sourcify.apiUrl);
  console.log("");

  const results = [];

  for (const t of TARGETS) {
    console.log(`--- ${t.name} (${t.address}) ---`);
    try {
      await hre.run("verify:sourcify", {
        address: t.address,
        contract: t.contract,
      });
      console.log(`  结果: 验证成功`);
      results.push({ name: t.name, ok: true, note: "" });
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e)).trim();
      // Sourcify 对"已经验证过"的合约会提示，不算失败
      const already = /already verified|Already Verified/i.test(msg);
      console.log(`  结果: ${already ? "此前已验证过（无需重复）" : "失败"}`);
      if (!already) {
        console.log(`  原因: ${msg.split("\n")[0]}`);
      }
      results.push({ name: t.name, ok: already, note: msg.split("\n")[0] });
    }
    console.log("");
  }

  console.log("=== 汇总 ===");
  for (const r of results) {
    console.log(`  ${r.ok ? "[已验证]" : "[未验证]"} ${r.name}`);
  }
  console.log("");
  console.log("查看地址（把地址替换进去即可）：");
  console.log("  https://sourcify.dev/#/lookup/<合约地址>");
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log("");
    console.log("未通过的合约：", failed.map((f) => f.name).join("、"));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("脚本异常:", e);
  process.exitCode = 1;
});
