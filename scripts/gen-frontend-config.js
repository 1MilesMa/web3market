/**
 * 重新部署后，把新地址同步进前端 config.js。
 *
 * 用法： node scripts/gen-frontend-config.js
 *
 * 作用：读取 deployments/mynft-sepolia.json 与 deployments/simplemarket-sepolia.json，
 *      生成 frontend/config.js。每次重新部署合约后跑一次即可。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEP = path.join(ROOT, "deployments");
const OUT = path.join(ROOT, "frontend", "config.js");

// 部署记录可能不完整：缺失的合约自动跳过，不阻断前端配置生成
function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const nft = readJsonIfExists(path.join(DEP, "mynft-sepolia.json"));
const mkt = readJsonIfExists(path.join(DEP, "simplemarket-sepolia.json"));
const msig = readJsonIfExists(path.join(DEP, "multisigowner-sepolia.json"));
const lock = readJsonIfExists(path.join(DEP, "markettimelock-sepolia.json"));

const cfg = {
  chainId: 11155111,
  chainName: "Sepolia",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  explorer: "https://sepolia.etherscan.io",
  explorerAlt: "https://sepolia.otterscan.io",
  contracts: {
    MyNFT: {
      address: nft.address,
      label: "MyNFT（ERC721 + 版税）",
      deployedAtBlock: nft.blockNumber || null
    },
    SimpleMarket: {
      address: mkt.address,
      label: "SimpleMarket（市场）",
      deployedAtBlock: mkt.blockNumber || null
    },
    ...(msig
      ? {
          MultiSigOwner: {
            address: msig.address,
            label: "MultiSigOwner（多签治理，3 owner / 阈值 2）",
            deployedAtBlock: msig.blockNumber || null
          }
        }
      : {}),
    ...(lock
      ? {
          MarketTimelock: {
            address: lock.address,
            label: "MarketTimelock（时间锁，延迟 300 秒，当前市场 owner）",
            deployedAtBlock: lock.blockNumber || null
          }
        }
      : {})
  },
  eip712: { name: "SimpleMarket", version: "1" }
};

const banner =
  "// 自动生成 —— 来源：deployments/*-sepolia.json（勿手改，重新部署后重跑 gen-frontend-config.js）\n" +
  "// 生成时间：" + new Date().toLocaleString("zh-CN") + "\n";

fs.writeFileSync(OUT, banner + "window.APP_CONFIG = " + JSON.stringify(cfg, null, 2) + ";\n", "utf8");

console.log("");
console.log("  前端配置已同步");
console.log("  ------------------------------------------");
Object.keys(cfg.contracts).forEach((name) => {
  const c = cfg.contracts[name];
  console.log("  " + name.padEnd(14) + ":", c.address, "(block " + c.deployedAtBlock + ")");
});
console.log("  写入        :", path.relative(ROOT, OUT));
console.log("");
console.log("  下一步建议跑一次签名算法校验： node scripts/verify-eip712-frontend.js");
console.log("");
