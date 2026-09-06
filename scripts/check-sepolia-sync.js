/**
 * ============================================================================
 * 链上字节码一致性自检（本地编译产物 vs Sepolia 链上代码）
 * ============================================================================
 *
 * 运行方式（在项目根目录）：
 *   npx hardhat run scripts/check-sepolia-sync.js --network sepolia
 *
 * 【这个脚本为什么存在】
 *   之前踩过一次坑：本地把合约加固完、测试全绿，
 *   但链上跑的还是加固前的旧字节码，导致"本地测过的行为"和"链上真实行为"对不上。
 *   人工去 Etherscan 比对太麻烦，所以把这个检查固化成一条命令。
 *
 * 【怎么比】
 *   Solidity 编译产物末尾会附加一段 CBOR 编码的 metadata（含 IPFS 哈希、solc 版本），
 *   只要源码或编译环境动过一丁点，这段就会变，所以不能直接比全串。
 *   这里把 metadata 尾部剥掉，只比对真正的代码段 —— 代码段一致才是真的同一份合约。
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

// Solidity metadata 的 CBOR 头：a2 64 "ipfs" 58 22 ...
const METADATA_MARKER = "a264697066735822";

function stripMetadata(bytecode) {
  if (!bytecode) return "";
  const hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const idx = hex.lastIndexOf(METADATA_MARKER);
  return idx === -1 ? hex : hex.slice(0, idx);
}

/**
 * 取 solc 输出的 immutable 占位区间。
 *
 * 为什么要这一步：
 *   本地 deployedBytecode 里，immutable 变量的位置是**全零占位符**；
 *   真正的值（比如 MyNFT 的 maxSupply=10000、EIP712 的 name/version）
 *   是在部署交易里才被填进链上代码的。
 *   所以直接比全串必然"不一致"—— 那不是链上旧了，是值本来就该不同。
 *
 *   hardhat 的 artifact 顶层没带这个信息，要去 .dbg.json 指向的 build-info 里翻。
 */
function loadImmutableRefs(artifactPath) {
  const dbgPath = artifactPath.replace(/\.json$/, ".dbg.json");
  if (!fs.existsSync(dbgPath)) return null;
  try {
    const dbg = JSON.parse(fs.readFileSync(dbgPath, "utf8"));
    const buildInfoPath = path.resolve(path.dirname(dbgPath), dbg.buildInfo);
    const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const entry =
      buildInfo.output.contracts[artifact.sourceName]?.[artifact.contractName];
    return entry?.evm?.deployedBytecode?.immutableReferences || null;
  } catch (e) {
    return null;
  }
}

/**
 * 把 immutable 区间整体抹零 —— 链上填的是真值，本地是占位零，
 * 两边都抹平后才能真正比较"代码逻辑有没有变"。
 */
function maskImmutables(hex, refs) {
  if (!refs) return { hex, masked: 0 };
  const buf = Buffer.from(hex, "hex");
  let masked = 0;
  for (const key of Object.keys(refs)) {
    for (const { start, length } of refs[key]) {
      buf.fill(0, start, start + length);
      masked += length;
    }
  }
  return { hex: buf.toString("hex"), masked };
}

async function checkOne(label, artifactPath, address) {
  console.log(`\n---- ${label} ----`);
  console.log("  地址:", address);

  const onchain = await hre.ethers.provider.getCode(address);
  if (!onchain || onchain === "0x") {
    console.log("  [FAIL] 链上没有代码：地址不存在，或合约已被销毁");
    return false;
  }

  if (!fs.existsSync(artifactPath)) {
    console.log("  [FAIL] 本地没有编译产物，请先 npx hardhat compile：", artifactPath);
    return false;
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const local = artifact.deployedBytecode;

  const refs = loadImmutableRefs(artifactPath);
  const mA = maskImmutables(stripMetadata(onchain), refs);
  const mB = maskImmutables(stripMetadata(local), refs);
  const a = mA.hex;
  const b = mB.hex;

  console.log("  链上代码段长度:", a.length / 2, "字节");
  console.log("  本地代码段长度:", b.length / 2, "字节");
  console.log(
    "  metadata 尾部  :",
    (onchain.length - 2 - a.length) / 2,
    "vs",
    (local.length - 2 - b.length) / 2,
    "字节（这段必然不同，不参与比较）"
  );
  if (mA.masked > 0) {
    console.log(
      "  immutable 占位 :",
      mA.masked,
      "字节已抹平（链上是部署时填入的真值，本地是全零占位，属正常差异）"
    );
  }

  if (a === b) {
    console.log("  [OK] 代码段完全一致 —— 链上就是本地这份最新编译产物");
    return true;
  }

  console.log("  [FAIL] 代码段不一致 —— 链上是旧版，需要重新部署！");
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  console.log("  首个差异位置  : 第", Math.floor(i / 2), "字节处");
  return false;
}

async function main() {
  const { chainId } = await hre.ethers.provider.getNetwork();
  console.log("============================================================");
  console.log(" 链上字节码同步自检");
  console.log("============================================================");
  console.log("  网络: " + hre.network.name + " (chainId: " + chainId + ")");

  const dir = path.join(__dirname, "..", "deployments");
  const artDir = path.join(__dirname, "..", "artifacts", "contracts");

  const targets = [
    {
      label: "MyNFT",
      file: "mynft-sepolia.json",
      artifact: path.join(artDir, "MyNFT.sol", "MyNFT.json"),
    },
    {
      label: "SimpleMarket",
      file: "simplemarket-sepolia.json",
      artifact: path.join(artDir, "SimpleMarket.sol", "SimpleMarket.json"),
    },
  ];

  let allOk = true;
  for (const t of targets) {
    const p = path.join(dir, t.file);
    if (!fs.existsSync(p)) {
      console.log(`\n[SKIP] 缺少部署记录 ${t.file}`);
      allOk = false;
      continue;
    }
    const info = JSON.parse(fs.readFileSync(p, "utf8"));
    const ok = await checkOne(t.label, t.artifact, info.address);
    allOk = allOk && ok;
  }

  console.log("\n============================================================");
  console.log(
    allOk
      ? " 结论：链上与本地完全同步，链上跑的就是你刚测过的那版"
      : " 结论：存在不同步，请重新部署后再跑演练"
  );
  console.log("============================================================");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
