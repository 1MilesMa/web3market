// 自动生成 —— 来源：deployments/*-sepolia.json（勿手改，重新部署后重跑 gen-frontend-config.js）
// 生成时间：2026/9/6 17:51:39
window.APP_CONFIG = {
  "chainId": 11155111,
  "chainName": "Sepolia",
  "rpcUrl": "https://sepolia.gateway.tenderly.co",
  "explorer": "https://sepolia.etherscan.io",
  "contracts": {
    "MyNFT": {
      "address": "0x9EFe00123a6A22d903D63E195B7E87Bf3622412e",
      "label": "MyNFT（ERC721 + 版税）",
      "deployedAtBlock": 11631013
    },
    "SimpleMarket": {
      "address": "0x71450D767f2b83722b88164316d7308DB20A39c8",
      "label": "SimpleMarket（市场）",
      "deployedAtBlock": 11631015
    },
    "MultiSigOwner": {
      "address": "0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317",
      "label": "MultiSigOwner（多签治理，3 owner / 阈值 2）",
      "deployedAtBlock": 11637734
    },
    "MarketTimelock": {
      "address": "0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119",
      "label": "MarketTimelock（时间锁，延迟 300 秒，当前市场 owner）",
      "deployedAtBlock": 11638781
    }
  },
  "eip712": {
    "name": "SimpleMarket",
    "version": "1"
  }
};
