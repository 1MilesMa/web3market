// 生成 Etherscan「Standard JSON Input」离线验证包
//
// 用途：本机到 Etherscan 全域名超时时，把标准 JSON 输入文件导出，
//      之后在任何能访问 Etherscan 的设备上手动上传即可完成源码验证，
//      不需要 API Key（只需登录 Etherscan 账号）。
//
// 产出（verify-bundle/ 目录）：
//   <合约名>-standard-input.json   → 上传给 Etherscan 的标准 JSON 输入
//   <合约名>-constructor-args.txt  → 构造参数的 ABI 编码（网页上要填）
//   UPLOAD-GUIDE.md                → 上传步骤说明
//
// 用法：npx hardhat run scripts/gen-verify-bundle.js

const fs = require("fs");
const path = require("path");
const { AbiCoder } = require("ethers");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "verify-bundle");
const BUILD_INFO_DIR = path.join(ROOT, "artifacts", "build-info");

// 四个合约的构造参数，全部来自 deployments/*.json 与 contracts/*.sol 双重核对
const TARGETS = [
  {
    name: "MyNFT",
    address: "0x9EFe00123a6A22d903D63E195B7E87Bf3622412e",
    source: "contracts/MyNFT.sol",
    contract: "MyNFT",
    ctorTypes: ["address", "uint256", "address", "uint96"],
    ctorValues: [
      "0xe3C2B262B0AbC952ff0a56868cf2B7A4E6AafCd8", // initialOwner
      "10000", // maxSupply
      "0xe3C2B262B0AbC952ff0a56868cf2B7A4E6AafCd8", // royaltyReceiver
      "500", // royaltyFeeNumerator（分母 10000 → 5%）
    ],
  },
  {
    name: "SimpleMarket",
    address: "0x71450D767f2b83722b88164316d7308DB20A39c8",
    source: "contracts/SimpleMarket.sol",
    contract: "SimpleMarket",
    ctorTypes: ["address", "uint256"],
    ctorValues: [
      "0xe3C2B262B0AbC952ff0a56868cf2B7A4E6AafCd8", // initialOwner
      "250", // feeBps（2.5%）
    ],
  },
  {
    name: "MultiSigOwner",
    address: "0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317",
    source: "contracts/MultiSigOwner.sol",
    contract: "MultiSigOwner",
    ctorTypes: ["address[]", "uint256"],
    ctorValues: [
      [
        "0xe3C2B262B0AbC952ff0a56868cf2B7A4E6AafCd8",
        "0xb9a429a3b101015DdeE57569360b73c36E646a32",
        "0x38e1969A889bF4912919D4b93cdF3c06dC6cd72a",
      ], // owners_（顺序必须与链上 getOwners() 一致）
      "2", // threshold_
    ],
  },
  {
    name: "MarketTimelock",
    address: "0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119",
    source: "contracts/MarketTimelock.sol",
    contract: "MarketTimelock",
    ctorTypes: ["uint256", "address[]", "address[]", "address"],
    ctorValues: [
      "300", // minDelay（秒）
      ["0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317"], // proposers（仅多签可提案）
      ["0x0000000000000000000000000000000000000000"], // executors（0 地址＝开放执行）
      "0x0000000000000000000000000000000000000000", // admin（0 地址＝无管理员）
    ],
  },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const buildInfoFiles = fs
    .readdirSync(BUILD_INFO_DIR)
    .filter((f) => f.endsWith(".json"));

  const coder = AbiCoder.defaultAbiCoder();
  const summary = [];

  for (const t of TARGETS) {
    // 找到包含该合约的编译产物（build-info 里存的就是 solc 的标准 JSON 输入）
    let bi = null;
    for (const f of buildInfoFiles) {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(BUILD_INFO_DIR, f), "utf8")
      );
      const contracts = parsed?.output?.contracts ?? {};
      if (contracts[t.source]?.[t.contract]) {
        bi = parsed;
        break;
      }
    }
    if (bi === null) {
      console.log(
        `  [跳过] ${t.name}：没找到编译产物，先跑 npx hardhat compile`
      );
      summary.push({ ...t, ok: false });
      continue;
    }

    // 标准 JSON 输入 = 源码 + 编译设置，Etherscan 用它复现编译结果
    const inputPath = path.join(OUT_DIR, `${t.name}-standard-input.json`);
    fs.writeFileSync(inputPath, JSON.stringify(bi.input, null, 2));

    // 构造参数的 ABI 编码（上传页面上要填这一串）
    const encoded = coder.encode(t.ctorTypes, t.ctorValues);
    const argsPath = path.join(OUT_DIR, `${t.name}-constructor-args.txt`);
    fs.writeFileSync(argsPath, encoded);

    console.log(
      `  [生成] ${t.name}  input=${(fs.statSync(inputPath).size / 1024).toFixed(
        1
      )}KB  args=${encoded.slice(0, 20)}...`
    );
    summary.push({ ...t, ok: true, encoded, solcVersion: bi.solcLongVersion });
  }

  // 生成上传说明
  const guide = [
    "# Etherscan 源码验证包 —— 上传说明",
    "",
    "本机网络到 Etherscan 全域名超时，因此改用「离线生成 + 手动上传」的方式完成源码验证。",
    "下面的文件已经全部备好，你只需要在一个**能打开 etherscan.io** 的设备上按步骤点。",
    "",
    "## 需要什么",
    "",
    "- 一个能访问 etherscan.io 的网络环境（家里 WiFi 和手机流量都试过不行的话，换其他网络）",
    "- 一个已登录的 Etherscan 账号（免费注册，不需要 API Key）",
    "",
    "## 每个合约要传两个东西",
    "",
    "| 合约 | 地址 | 标准 JSON 文件 | 构造参数文件 |",
    "| --- | --- | --- | --- |",
    ...summary
      .filter((s) => s.ok)
      .map(
        (s) =>
          `| ${s.name} | \`${s.address}\` | ${s.name}-standard-input.json | ${s.name}-constructor-args.txt |`
      ),
    "",
    "## 上传步骤（每个合约重复一次）",
    "",
    "1. 打开 `https://sepolia.etherscan.io/address/<合约地址>`（把地址换成上表里的）",
    "2. 点页面上的 **Contract** 标签页",
    "3. 如果显示 **Verify and Publish** 链接，点它；已验证过就不用管了",
    "4. 填写验证信息：",
    "   - **Compiler Type**：选 `Solidity (Standard JSON Input)`",
    "   - **Compiler Version**：`v0.8.28+commit.7893614a`",
    "   - 点 **Continue**",
    "5. 上传标准 JSON 文件：",
    "   - 点 **Browse** / 选择文件，选中对应的 `<合约名>-standard-input.json`",
    "   - 如果页面让你确认文件，直接确认",
    "6. 填构造参数：",
    "   - 找到 **Constructor Arguments (ABI-encoded)** 那一栏",
    "   - 打开对应的 `<合约名>-constructor-args.txt`，全选复制，粘贴进去",
    "   - （也可以展开下面的 **Constructor Arguments** 逐个填，但直接贴编码串更不容易错）",
    "7. 勾选同意条款，点 **Verify and Publish**",
    "8. 等十几秒，页面显示绿色对勾 / `Successfully verified` 就成了",
    "",
    "## 怎么算成功",
    "",
    "合约页面的 **Contract** 标签出现绿色对勾，且能直接看到源码和 `Read Contract` / `Write Contract` 按钮。",
    "",
    "## 常见问题",
    "",
    "- **报构造参数不匹配**：99% 是构造参数填错或顺序不对，用本目录里的 txt 原样复制即可",
    "- **报编译结果不一致**：确认 Compiler Version 选的是 0.8.28，且 JSON 文件是本目录生成的（别用旧副本）",
    "- **已经验证过了**：页面会直接显示源码，跳过即可",
    "",
    "---",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
  ].join("\n");

  fs.writeFileSync(path.join(OUT_DIR, "UPLOAD-GUIDE.md"), guide);
  console.log("");
  console.log(`验证包已生成到：${OUT_DIR}`);
  const okCount = summary.filter((s) => s.ok).length;
  console.log(`  成功 ${okCount} / ${TARGETS.length} 个合约`);
  if (okCount < TARGETS.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("脚本异常:", e);
  process.exitCode = 1;
});
