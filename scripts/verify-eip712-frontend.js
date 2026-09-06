/**
 * 验证：前端 app.js 里的 EIP-712 算法，与链上 SimpleMarket.hashListingIntent()
 * 算出来的摘要逐字节一致。
 *
 * 为什么需要它：签名挂单是"线下签、线上验"，只要前端的 domain / types 顺序
 * 和合约有半点偏差，买家拿到的签名就会验签失败。用它把这条链路钉死。
 *
 * 用法： node scripts/verify-eip712-frontend.js
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");

// 读取前端 config.js（内容是 window.APP_CONFIG = {...}）
const sandbox = { window: {} };
new Function("window", fs.readFileSync(path.join(ROOT, "frontend/config.js"), "utf8"))(sandbox.window);
const CFG = sandbox.window.APP_CONFIG;

const mktAbi = JSON.parse(fs.readFileSync(path.join(ROOT, "frontend/abi/SimpleMarket.json"), "utf8"));

// 必须与 frontend/app.js 中的 TYPES 完全一致
const TYPES = {
  ListingIntent: [
    { name: "nftContract", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" }
  ]
};
const DOMAIN = {
  name: CFG.eip712.name,
  version: CFG.eip712.version,
  chainId: CFG.chainId,
  verifyingContract: CFG.contracts.SimpleMarket.address
};

(async () => {
  const rpc = process.env.SEPOLIA_RPC_URL || CFG.rpcUrl;
  const provider = new ethers.JsonRpcProvider(rpc, CFG.chainId, { staticNetwork: true });
  const market = new ethers.Contract(CFG.contracts.SimpleMarket.address, mktAbi, provider);

  const intent = {
    nftContract: CFG.contracts.MyNFT.address,
    tokenId: 7n,
    price: ethers.parseEther("0.001"),
    deadline: 1999999999n,
    nonce: 3n
  };

  // 1) 链上算一遍
  const onchain = await market.hashListingIntent(intent);

  // 2) 本地用和前端完全相同的算法算一遍
  const local = ethers.TypedDataEncoder.hash(DOMAIN, TYPES, {
    nftContract: intent.nftContract,
    tokenId: intent.tokenId.toString(),
    price: intent.price.toString(),
    deadline: intent.deadline.toString(),
    nonce: intent.nonce.toString()
  });

  console.log("");
  console.log("  EIP-712 摘要一致性校验");
  console.log("  ------------------------------------------");
  console.log("  domain  :", JSON.stringify(DOMAIN));
  console.log("  typeHash:", ethers.id(
    "ListingIntent(address nftContract,uint256 tokenId,uint256 price,uint256 deadline,uint256 nonce)"));
  console.log("  链上    :", onchain);
  console.log("  前端算法:", local);
  console.log("");

  if (onchain === local) {
    console.log("  一致 ✓  前端生成的签名可以被链上正确验签");
    console.log("");
    process.exit(0);
  } else {
    console.log("  不一致 ✗  前端签名会验签失败，请检查 domain / TYPES 字段顺序");
    console.log("");
    process.exit(1);
  }
})().catch((e) => {
  console.error("校验脚本执行失败：", e.message);
  process.exit(2);
});
