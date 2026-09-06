/**
 * deploy-multisig-sepolia.js —— 在 Sepolia 测试网部署 MultiSigOwner（2/3 多签）
 *
 * 跑法（PowerShell，项目根目录）：
 *   npx hardhat run scripts/deploy-multisig-sepolia.js --network sepolia
 *
 * 三位成员来自 .env：PRIVATE_KEY / PRIVATE_KEY_2 / PRIVATE_KEY_3
 * 阈值固定 2：三个人里任意两人点头，才能动多签控制的东西。
 *
 * 安全约定：
 *   - 私钥只从本地 .env 读取，不打印、不上传
 *   - 已部署过就复用（产物存在且链上有代码），绝不重复部署作废旧地址
 *   - 这一步只部署，不碰市场 owner —— 移交是下一个脚本的事
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const EXPLORER = "https://sepolia.etherscan.io";
const OUT = path.join(__dirname, "..", "deployments", "multisigowner-sepolia.json");

async function main() {
  const keys = ["PRIVATE_KEY", "PRIVATE_KEY_2", "PRIVATE_KEY_3"].map((k) =>
    (process.env[k] || "").trim()
  );
  if (keys.some((k) => !k)) {
    console.error("✗ .env 里 PRIVATE_KEY / PRIVATE_KEY_2 / PRIVATE_KEY_3 必须三个都配好");
    process.exit(1);
  }

  const provider = ethers.provider;
  const net = await provider.getNetwork();
  if (net.chainId !== 11155111n) {
    console.error("✗ 当前不是 Sepolia 网络，请在命令末尾加 --network sepolia");
    process.exit(1);
  }

  const wallets = keys.map((pk) => new ethers.Wallet(pk, provider));
  const owners = wallets.map((w) => w.address);
  const THRESHOLD = 2;

  console.log("Sepolia 多签部署 —— 3 人共管，2 票放行");
  console.log("=".repeat(66));
  for (let i = 0; i < wallets.length; i++) {
    const bal = ethers.formatEther(await provider.getBalance(wallets[i].address));
    console.log(`  成员 ${i + 1}：${owners[i]}   余额 ${bal} ETH`);
  }
  const fd = await provider.getFeeData();
  const gp = fd.gasPrice || fd.maxFeePerGas || 0n;
  console.log(`  当前 gas 价：${ethers.formatUnits(gp, "gwei")} gwei`);

  // 已部署过 → 复用，不重复部署
  if (fs.existsSync(OUT)) {
    const old = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (old.address && (await provider.getCode(old.address)) !== "0x") {
      console.log(`\n[复用] 已部署过：${old.address}`);
      console.log(`       不重复部署 —— 免得作废旧地址、还得改一堆文档`);
      console.log(`       Etherscan: ${EXPLORER}/address/${old.address}`);
      return;
    }
  }

  console.log("\n部署中……（Sepolia 出块约 12 秒，请稍候）");
  const factory = await ethers.getContractFactory("MultiSigOwner", wallets[0]);
  const ms = await factory.deploy(owners, THRESHOLD);
  const tx = ms.deploymentTransaction();
  console.log("  部署交易 txHash:", tx.hash);
  console.log(`  ${EXPLORER}/tx/${tx.hash}`);

  await ms.waitForDeployment();
  const addr = await ms.getAddress();
  const receipt = await tx.wait(1);

  console.log("\n✓ 部署成功");
  console.log("  多签地址 :", addr);
  console.log("  区块高度 :", receipt.blockNumber);
  console.log("  gas 花费 :", ethers.formatEther(receipt.gasUsed * (receipt.gasPrice || 0n)), "ETH");
  console.log(`  合约链接 : ${EXPLORER}/address/${addr}`);

  // 回读链上状态校验，不看本地变量
  const onchain = await ethers.getContractAt("MultiSigOwner", addr, wallets[0]);
  const threshold = await onchain.threshold();
  const members = await onchain.getOwners();
  const flags = await Promise.all(owners.map((o) => onchain.isOwner(o)));
  const allOk = flags.every(Boolean) && Number(threshold) === THRESHOLD && members.length === 3;
  console.log(
    `  链上校验 ：成员 ${members.length} 人，阈值 ${threshold}，三个地址均为成员 → ${allOk ? "一致 ✓" : "不一致 ✗"}`
  );
  if (!allOk) {
    console.error("✗ 链上状态与预期不符，请人工核对后再继续");
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        contract: "MultiSigOwner",
        address: addr,
        network: "sepolia",
        chainId: "11155111",
        owners,
        threshold: THRESHOLD,
        deployer: wallets[0].address,
        deployedAt: new Date().toISOString(),
        blockNumber: receipt.blockNumber,
        txHash: tx.hash,
        note: "部署后已回读链上 threshold / getOwners / isOwner 校验",
      },
      null,
      2
    ),
    "utf8"
  );

  console.log("\n地址已保存：deployments/multisigowner-sepolia.json");
  console.log("下一步：确认无误后，跑 scripts/transfer-market-to-multisig.js 移交市场 owner。\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n部署失败：", err.shortMessage || err.message || err);
    process.exit(1);
  });
