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
    address: "0x28279Df8E6656BcC1f6204dD744590b101ccE021",
    artifact: "contracts/SimpleMarket.sol/SimpleMarket.json",
    deployTx:
      "0xd08d808e2d2dcbe195fb78f20c3da39cd5715e0467dceabc889227dea6f2e1a4",
    deployBlock: 11898625,
    ctorTypes: ["address", "uint256"],
    ctorValues: ["0xf94f4f57Ac736e5f2E5104B7EaD1835cAeB224A1", "250"],
  },
  {
    name: "MultiSigOwner",
    address: "0x4944CE5fA39b453aEcEA63a1201d5d3972987EB8",
    artifact: "contracts/MultiSigOwner.sol/MultiSigOwner.json",
    deployTx:
      "0x00697c040d4a790d79817505b9affcbbd6ba4b253c800bf37d2a019f8df0e60a",
    deployBlock: 11898618,
    ctorTypes: ["address[]", "uint256"],
    ctorValues: [
      [
        "0xb630f6D1640f85F7778aBABDf76C87eF8a845E0f",
        "0x17913c094cD71b828d1F5C5f8D492f8c6CE5fb48",
        "0x1223100eCfA183300E59c95ED5b53A6DdE05f64C",
      ],
      "2",
    ],
  },
  {
    name: "MarketTimelock",
    address: "0xf94f4f57Ac736e5f2E5104B7EaD1835cAeB224A1",
    artifact: "contracts/MarketTimelock.sol/MarketTimelock.json",
    deployTx:
      "0x0f6c979ace407d264700621ef77df344cd7e436f6e2e1dfd43cd573ea4a78763",
    deployBlock: 11898622,
    ctorTypes: ["uint256", "address[]", "address[]", "address"],
    ctorValues: [
      "300",
      ["0x4944CE5fA39b453aEcEA63a1201d5d3972987EB8"],
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
