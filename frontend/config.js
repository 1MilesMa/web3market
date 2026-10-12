// 自动生成 —— 来源：deployments/*-sepolia.json（勿手改，重新部署后重跑 gen-frontend-config.js）
// 生成时间：2026/10/12 19:39:55
window.APP_CONFIG = {
  "chainId": 11155111,
  "chainName": "Sepolia",
  "rpcUrl": "https://sepolia.gateway.tenderly.co",
  "explorer": "https://sepolia.etherscan.io",
  // explorerAlt 是备用浏览器；本机网络打不开 etherscan（踩坑日志 P-36），页内「查交易」则完全不依赖浏览器
  "explorerAlt": "https://sepolia.otterscan.io",
  "contracts": {
    "MyNFT": {
      "address": "0x9EFe00123a6A22d903D63E195B7E87Bf3622412e",
      "label": "MyNFT（ERC721 + 版税）",
      "deployedAtBlock": 11631013
    },
    "SimpleMarket": {
      "address": "0x28279Df8E6656BcC1f6204dD744590b101ccE021",
      "label": "SimpleMarket（市场）",
      "deployedAtBlock": 11898625
    },
    "MultiSigOwner": {
      "address": "0x4944CE5fA39b453aEcEA63a1201d5d3972987EB8",
      "label": "MultiSigOwner（多签治理，3 owner / 阈值 2）",
      "deployedAtBlock": 11898618
    },
    "MarketTimelock": {
      "address": "0xf94f4f57Ac736e5f2E5104B7EaD1835cAeB224A1",
      "label": "MarketTimelock（时间锁，延迟 300 秒，当前市场 owner）",
      "deployedAtBlock": 11898622
    }
  },
  "eip712": {
    "name": "SimpleMarket",
    "version": "1"
  }
};
