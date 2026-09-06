// MarketTimelock 构造参数（给 hardhat verify 用）
// 数组类型的构造参数无法在命令行直接传，必须用 --constructor-args 指向本文件
//
// 用法：
//   npx hardhat verify --network sepolia 0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119 \
//     --constructor-args scripts/verify-args/timelock-args.js
//
// 对应合约构造函数：
//   constructor(uint256 minDelay, address[] proposers, address[] executors, address admin)
module.exports = [
  // minDelay：提案通过后必须等待的秒数（学习用 5 分钟；主网通常是 2 天）
  300,
  // proposers：只有多签能提交提案
  ["0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317"],
  // executors：address(0) 表示开放执行权，任何人都能在延迟到期后触发
  ["0x0000000000000000000000000000000000000000"],
  // admin：address(0) 表示没有管理员，连改延迟都只能走时间锁自己
  "0x0000000000000000000000000000000000000000",
];
