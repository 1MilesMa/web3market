// 校验本地算出的构造参数编码，与链上部署交易里的真实参数是否一致
//
// 原理：部署交易的 calldata = 创建字节码 + ABI 编码的构造参数。
//       用本地编译出的创建字节码长度去切 calldata，剩下的就是链上真实参数，
//       再和本地编码的结果逐字节比对。一致才说明验证包里的构造参数是对的。
//
// 用法：npx hardhat run scripts/check-ctor-args.js --network sepolia

require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, AbiCoder } = require("ethers");

const ROOT = path.join(__dirname, "..");

// deployTx 留空时，脚本会自动到部署区块里找创建该合约的交易
const TARGETS = [
  {
    name: "MyNFT",
    address: "0x9EFe00123a6A22d903D63E195B7E87Bf3622412e",
    artifact: "contracts/MyNFT.sol/MyNFT.json",
    deployTx:
      "0x1890ac43500391cdc17d435680d493dc73fa06adb1bd51a943b89adf108a03db",
    deployBlock: 11631013,
    ctorTypes: ["address", "uint256", "address", "uint96"],
    ctorValues: [
      "0xe3C2B262B0AbC952ff0a56868cf2B7A4E6AafCd8",
      "10000",
      "0xe3C2B262B0AbC952ff0a56868cf2B7A4E6AafCd8",
      "500",
    ],
  },
  {
    name: "SimpleMarket",
    address: "0x71450D767f2b83722b88164316d7308DB20A39c8",
    artifact: "contracts/SimpleMarket.sol/SimpleMarket.json",
    deployTx: null, // 部署记录里没存 txHash，自动按区块找
    deployBlock: 11631015,
    ctorTypes: ["address", "uint256"],
    ctorValues: ["0xe3C2B262B0AbC952ff0a56868cf2B7A4E6AafCd8", "250"],
  },
  {
    name: "MultiSigOwner",
    address: "0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317",
    artifact: "contracts/MultiSigOwner.sol/MultiSigOwner.json",
    deployTx:
      "0xe7e5475ffa7c04be377b2c930a0ffff760c8adf3d4dcae4d49f1d94fd8efc04a",
    deployBlock: 11637734,
    ctorTypes: ["address[]", "uint256"],
    ctorValues: [
      [
        "0xe3C2B262B0AbC952ff0a56868cf2B7A4E6AafCd8",
        "0xb9a429a3b101015DdeE57569360b73c36E646a32",
        "0x38e1969A889bF4912919D4b93cdF3c06dC6cd72a",
      ],
      "2",
    ],
  },
  {
    name: "MarketTimelock",
    address: "0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119",
    artifact: "contracts/MarketTimelock.sol/MarketTimelock.json",
    deployTx:
      "0x53a96d38b98230bd6026ecaf2f8364b093de00a2be99e486c5d1f65f01882c7f",
    deployBlock: 11638781,
    ctorTypes: ["uint256", "address[]", "address[]", "address"],
    ctorValues: [
      "300",
      ["0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317"],
      ["0x0000000000000000000000000000000000000000"],
      "0x0000000000000000000000000000000000000000",
    ],
  },
];

async function findDeployTx(provider, address, blockNumber) {
  const block = await provider.getBlock(blockNumber, true);
  if (block === null) return null;
  for (const txHash of block.transactions) {
    const tx = await provider.getTransaction(txHash);
    if (tx === null || tx.to !== null) continue; // 只看创建合约的交易
    const receipt = await provider.getTransactionReceipt(txHash);
    if (
      receipt &&
      receipt.contractAddress &&
      receipt.contractAddress.toLowerCase() === address.toLowerCase()
    ) {
      return txHash;
    }
  }
  return null;
}

async function main() {
  const rpc = process.env.SEPOLIA_RPC_URL;
  if (!rpc) throw new Error(".env 里没有 SEPOLIA_RPC_URL");
  const provider = new JsonRpcProvider(rpc);
  const coder = AbiCoder.defaultAbiCoder();

  console.log("=== 构造参数校验：本地编码 vs 链上部署交易 ===");
  console.log("");

  let allOk = true;

  for (const t of TARGETS) {
    const artifactPath = path.join(ROOT, "artifacts", t.artifact);
    if (!fs.existsSync(artifactPath)) {
      console.log(`  [跳过] ${t.name}：缺编译产物，先跑 npx hardhat compile`);
      allOk = false;
      continue;
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const creationCode = artifact.bytecode; // 0x 开头

    let txHash = t.deployTx;
    if (!txHash) {
      txHash = await findDeployTx(provider, t.address, t.deployBlock);
      if (txHash) console.log(`  ${t.name}: 自动定位到部署交易 ${txHash}`);
    }
    if (!txHash) {
      console.log(`  [失败] ${t.name}：找不到部署交易`);
      allOk = false;
      continue;
    }

    const tx = await provider.getTransaction(txHash);
    const calldata = tx.data;

    // calldata = 创建字节码 + 构造参数编码，按字节码长度切开
    const onChainArgs = "0x" + calldata.slice(creationCode.length);
    const localArgs = coder.encode(t.ctorTypes, t.ctorValues);

    const same = onChainArgs.toLowerCase() === localArgs.toLowerCase();
    console.log(`  ${t.name}:`);
    console.log(`    链上参数: ${onChainArgs.slice(0, 66)}${onChainArgs.length > 66 ? "..." : ""}`);
    console.log(`    本地参数: ${localArgs.slice(0, 66)}${localArgs.length > 66 ? "..." : ""}`);
    console.log(`    比对结果: ${same ? "一致 ✓" : "不一致 ✗"}`);
    if (!same) {
      console.log(`    链上完整: ${onChainArgs}`);
      console.log(`    本地完整: ${localArgs}`);
      allOk = false;
    }
    console.log("");
  }

  console.log("=== 结论 ===");
  console.log(
    allOk
      ? "  四个合约的构造参数全部与链上一致，验证包可以直接上传"
      : "  存在不一致，先把上面的差异解决再上传，否则 Etherscan 会报构造参数不匹配"
  );
  if (!allOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error("脚本异常:", e.message);
  process.exitCode = 1;
});
