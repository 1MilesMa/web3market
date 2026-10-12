// MultiSigOwner 构造参数（给 hardhat verify 用）
// 数组类型的构造参数无法在命令行直接传，必须用 --constructor-args 指向本文件
//
// 用法：
//   npx hardhat verify --network sepolia 0x4944CE5fA39b453aEcEA63a1201d5d3972987EB8 \
//     --constructor-args scripts/verify-args/multisig-args.js
//
// 对应合约构造函数：constructor(address[] memory owners_, uint256 threshold_)
module.exports = [
  // owners_：三个多签成员，必须与链上 getOwners() 完全一致（顺序也要一致）
  [
    "0xb630f6D1640f85F7778aBABDf76C87eF8a845E0f",
    "0x17913c094cD71b828d1F5C5f8D492f8c6CE5fb48",
    "0x1223100eCfA183300E59c95ED5b53A6DdE05f64C",
  ],
  // threshold_：2 / 3，两人同意才能执行
  2,
];
