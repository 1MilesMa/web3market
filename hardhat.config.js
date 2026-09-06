require("@nomicfoundation/hardhat-ethers");
// 源码验证插件：把合约源码提交给 Etherscan 做公开验证（npx hardhat verify）
// 需要 .env 里配置 ETHERSCAN_API_KEY
require("@nomicfoundation/hardhat-verify");
// 测试插件：hardhat-chai-matchers 提供 to.be.revertedWith /
// revertedWithCustomError / changeTokenBalance 等合约专用断言
require("@nomicfoundation/hardhat-chai-matchers");
// 本地链操控助手：loadFixture / mine / time 等
require("@nomicfoundation/hardhat-network-helpers");
// 显式引入：hardhat 的插件自动发现偶尔会漏，显式 require 保证 gas 报告生效
require("hardhat-gas-reporter");
require("solidity-coverage");
require("dotenv").config({ quiet: true });

// Sepolia 测试网 RPC 节点（已在当前网络环境下实测连通，可按需替换为备用节点）
const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

// 部署账户私钥，来自 .env（绝不要把真实资产钱包的私钥放进这里）
// 支持多个账户：
//   PRIVATE_KEY   → 主账户（owner / 部署者 / 卖家）
//   PRIVATE_KEY_2 → 买家 A
//   PRIVATE_KEY_3 → 买家 B（可选；不配的话 practice-offer.js 会自动跳过买家 B 的场景）
// filter 掉空值：只配 1 个或 2 个私钥时完全向后兼容，不会把 undefined 塞进 accounts
const accounts = [
  process.env.PRIVATE_KEY,
  process.env.PRIVATE_KEY_2,
  process.env.PRIVATE_KEY_3,
].filter((k) => !!k && k.trim() !== "");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // solc 0.8.28 默认按 Cancun 生成字节码，而 Hardhat 默认 EVM 版本是 paris，
      // 二者不一致会报 "mcopy instruction is only available for Cancun-compatible VMs"。
      // 显式声明 cancun 即可（Sepolia 与主网均已支持 Cancun）
      evmVersion: "cancun",
    },
  },
  networks: {
    // Hardhat 内置本地链：零配置、零成本，用于单元验证与快速调试
    hardhat: {},

    // Sepolia 以太坊官方测试网
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: accounts,
      timeout: 180000,
    },
  },
  // Etherscan 源码验证配置
  // 验证通过后，区块浏览器上会显示绿色对勾，任何人都能直接阅读源码、
  // 并在浏览器里调用合约的读方法 —— 这是"你说你做过"变成"别人自己能验证"的关键一步
  // API Key 在 https://etherscan.io/myapikey 免费注册即得
  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY || "",
    },
  },

  // Sourcify：去中心化的合约源码验证服务（备用验证通道）
  // 与 Etherscan 的区别：不需要 API Key、源码存 IPFS、任何兼容浏览器都能读取
  // 本机到 Etherscan 全域名超时，Sourcify 可达，因此作为主力验证通道
  sourcify: {
    // 插件默认关闭，必须显式打开
    enabled: true,
    // API 端点用插件默认即可（https://sourcify.dev/server），已实测 HTTP 200
    // 验证成功后浏览器查看地址：https://sourcify.dev/#/lookup/<合约地址>
  },

  paths: {
    sources: "./contracts",
    scripts: "./scripts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  // Mocha 配置：合约测试涉及部署与多笔交易，默认 20s 超时偏紧
  mocha: {
    timeout: 120000,
  },

  // Gas 消耗报告（hardhat-gas-reporter）：跑测试时输出每个方法的 gas 用量
  // offline: true 表示不去联网拉币价，避免测试环境无外网时卡住
  gasReporter: {
    enabled: true,
    currency: "USD",
    offline: true,
    outputFile: process.env.GAS_REPORT_FILE || undefined,
  },
};
