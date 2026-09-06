// MultiSigOwner 构造参数（给 hardhat verify 用）
// 数组类型的构造参数无法在命令行直接传，必须用 --constructor-args 指向本文件
//
// 用法：
//   npx hardhat verify --network sepolia 0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317 \
//     --constructor-args scripts/verify-args/multisig-args.js
//
// 对应合约构造函数：constructor(address[] memory owners_, uint256 threshold_)
module.exports = [
  // owners_：三个多签成员，必须与链上 getOwners() 完全一致（顺序也要一致）
  [
    "0xe3C2B262B0AbC952ff0a56868cf2B7A4E6AafCd8",
    "0xb9a429a3b101015DdeE57569360b73c36E646a32",
    "0x38e1969A889bF4912919D4b93cdF3c06dC6cd72a",
  ],
  // threshold_：2 / 3，两人同意才能执行
  2,
];
