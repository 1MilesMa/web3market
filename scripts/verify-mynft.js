/**
 * ============================================================================
 * MyNFT 链上验证脚本 —— 【请你自己执行，Agent 不会替你跑】
 * ============================================================================
 *
 * 作用：对已部署的 MyNFT 做一次完整的"真钱（测试网）实操"：
 *   步骤 1  读取合约基本信息
 *   步骤 2  铸造一枚 NFT（写交易）
 *   步骤 3  回读校验 ownerOf / balanceOf / tokenURI / totalSupply
 *   步骤 4  把这枚 NFT 转给另一个账户（写交易）
 *   步骤 5  再次回读，确认归属真的变了
 *   步骤 6  用 Enumerable 列出该账户持有的 NFT
 *
 * 用法：
 *   npx hardhat run scripts/verify-mynft.js --network localhost
 *   npx hardhat run scripts/verify-mynft.js --network sepolia
 *
 * 合约地址来源（优先级从高到低）：
 *   1. 环境变量 NFT_ADDRESS=0x...
 *   2. deployments/mynft-<网络名>.json（由 deploy-mynft.js 自动生成）
 *
 * 可选环境变量：
 *   NFT_ADDRESS   合约地址
 *   MINT_TO       铸造给谁，默认取部署账户
 *   MINT_URI      metadata 链接，默认用一个公开的示例 IPFS 地址
 * ============================================================================
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const DEFAULT_URI =
  process.env.MINT_URI ||
  "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/1.json";

function explorerBaseUrl(chainId) {
  const map = {
    1: "https://etherscan.io",
    11155111: "https://sepolia.etherscan.io",
    137: "https://polygonscan.com",
    31337: null,
  };
  return map[Number(chainId)] || null;
}

/** 从环境变量或 deployments 目录里解析合约地址 */
function resolveAddress(networkName) {
  if (process.env.NFT_ADDRESS) return process.env.NFT_ADDRESS;

  const file = path.join(__dirname, "..", "deployments", `mynft-${networkName}.json`);
  if (!fs.existsSync(file)) {
    console.error("[X] 找不到合约地址。请先运行部署脚本，或设置环境变量 NFT_ADDRESS=0x...");
    console.error(`    期望的部署产物文件：${path.relative(process.cwd(), file)}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return data.address;
}

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await hre.ethers.provider.getNetwork();
  const signers = await hre.ethers.getSigners();
  const owner = signers[0];
  const buddy = signers[1] || null; // 第二个账户：PRIVATE_KEY_2（用于演示转账）
  const base = explorerBaseUrl(chainId);

  const address = resolveAddress(networkName);
  const nft = await hre.ethers.getContractAt("MyNFT", address);

  const link = (hash) => (base ? `${base}/tx/${hash}` : hash);

  console.log("============================================================");
  console.log(" MyNFT 链上验证");
  console.log("============================================================");
  console.log("网络        :", networkName, "(chainId:", chainId.toString() + ")");
  console.log("合约地址    :", address);
  console.log("操作账户    :", owner.address);
  if (buddy) console.log("第二账户    :", buddy.address);
  console.log("------------------------------------------------------------");

  // ---------- 步骤 1：读取合约基本信息 ----------
  console.log("[步骤 1] 读取合约基本信息（view 调用，不花 gas）");
  const name = await nft.name();
  const symbol = await nft.symbol();
  const contractOwner = await nft.owner();
  const totalSupplyBefore = await nft.totalSupply();
  const nextId = await nft.nextTokenId();

  console.log("  name()        :", name);
  console.log("  symbol()      :", symbol);
  console.log("  owner()       :", contractOwner);
  console.log("  totalSupply() :", totalSupplyBefore.toString());
  console.log("  nextTokenId() :", nextId.toString());

  if (contractOwner.toLowerCase() !== owner.address.toLowerCase()) {
    console.error("");
    console.error("[X] 当前账户不是合约 owner，无法铸造。");
    console.error(`    合约 owner 是 ${contractOwner}，你用的是 ${owner.address}`);
    process.exit(1);
  }

  const mintTo = process.env.MINT_TO || owner.address;
  const uri = DEFAULT_URI;

  // ---------- 步骤 2：铸造 ----------
  console.log("------------------------------------------------------------");
  console.log("[步骤 2] 铸造一枚 NFT（写交易，要花 gas）");
  console.log("  接收者      :", mintTo);
  console.log("  tokenURI    :", uri);

  const mintTx = await nft.safeMint(mintTo, uri);
  console.log("  交易已发送  :", mintTx.hash);
  if (base) console.log("  浏览器查看  :", link(mintTx.hash));

  const mintReceipt = await mintTx.wait();
  console.log("  [OK] 已确认 : 区块", mintReceipt.blockNumber, "| gas", mintReceipt.gasUsed.toString());

  const tokenId = await nft.nextTokenId();
  const mintedId = tokenId - 1n; // 刚铸造的那枚，就是自增前的值

  // ---------- 步骤 3：回读校验 ----------
  console.log("------------------------------------------------------------");
  console.log("[步骤 3] 回读校验（铸造结果必须与链上一致）");
  const ownerOfToken = await nft.ownerOf(mintedId);
  const balanceOfTo = await nft.balanceOf(mintTo);
  const tokenURI = await nft.tokenURI(mintedId);
  const totalSupplyAfter = await nft.totalSupply();

  console.log("  tokenId         :", mintedId.toString());
  console.log("  ownerOf(id)     :", ownerOfToken);
  console.log("  balanceOf(接收者):", balanceOfTo.toString());
  console.log("  tokenURI(id)    :", tokenURI);
  console.log("  totalSupply()   :", totalSupplyAfter.toString());

  const checks = [
    ["ownerOf 等于接收者", ownerOfToken.toLowerCase() === mintTo.toLowerCase()],
    ["balanceOf 至少为 1", balanceOfTo >= 1n],
    ["tokenURI 与铸造时一致", tokenURI === uri],
    ["totalSupply 比铸造前 +1", totalSupplyAfter === totalSupplyBefore + 1n],
  ];
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "[OK]" : "[X]"} ${label}`);
    if (!ok) allOk = false;
  }
  if (!allOk) {
    console.error("[X] 铸造校验未通过，请检查交易是否真的被确认。");
    process.exit(1);
  }

  // ---------- 步骤 4：转账 ----------
  if (buddy) {
    console.log("------------------------------------------------------------");
    console.log("[步骤 4] 把这枚 NFT 转给第二账户");
    console.log("  from:", mintTo, "-> to:", buddy.address);

    const beforeBalFrom = await nft.balanceOf(mintTo);
    const beforeBalTo = await nft.balanceOf(buddy.address);

    const transferTx = await nft.transferFrom(mintTo, buddy.address, mintedId);
    console.log("  交易已发送  :", transferTx.hash);
    if (base) console.log("  浏览器查看  :", link(transferTx.hash));
    const transferReceipt = await transferTx.wait();
    console.log(
      "  [OK] 已确认 : 区块",
      transferReceipt.blockNumber,
      "| gas",
      transferReceipt.gasUsed.toString()
    );

    // ---------- 步骤 5：再次回读 ----------
    console.log("------------------------------------------------------------");
    console.log("[步骤 5] 再次回读，确认归属真的变更");
    const newOwner = await nft.ownerOf(mintedId);
    const afterBalFrom = await nft.balanceOf(mintTo);
    const afterBalTo = await nft.balanceOf(buddy.address);

    console.log("  ownerOf(id)  :", newOwner);
    console.log(`  原持有者余额 : ${beforeBalFrom.toString()} -> ${afterBalFrom.toString()}`);
    console.log(`  新持有者余额 : ${beforeBalTo.toString()} -> ${afterBalTo.toString()}`);

    const transferOk =
      newOwner.toLowerCase() === buddy.address.toLowerCase() &&
      afterBalFrom === beforeBalFrom - 1n &&
      afterBalTo === beforeBalTo + 1n;
    console.log(`  ${transferOk ? "[OK]" : "[X]"} 转账结果一致`);
    if (!transferOk) {
      console.error("[X] 转账校验未通过。");
      process.exit(1);
    }

    // ---------- 步骤 6：枚举 ----------
    console.log("------------------------------------------------------------");
    console.log("[步骤 6] 用 ERC721Enumerable 列出第二账户持有的 NFT");
    const count = await nft.balanceOf(buddy.address);
    console.log("  持有数量:", count.toString());
    for (let i = 0; i < Number(count); i++) {
      const id = await nft.tokenOfOwnerByIndex(buddy.address, i);
      const u = await nft.tokenURI(id);
      console.log(`  #${i} tokenId=${id.toString()}  tokenURI=${u}`);
    }
  } else {
    console.log("------------------------------------------------------------");
    console.log("[提示] 未配置第二账户（PRIVATE_KEY_2），跳过转账与枚举步骤。");
    console.log("       想演示转账，请在 .env 里补一行 PRIVATE_KEY_2=xxx（记得也要有测试币）。");
  }

  console.log("============================================================");
  console.log(" 全部验证通过！你的 NFT 已经真实存在于", networkName, "链上。");
  if (base) console.log(" 合约地址:", `${base}/address/${address}`);
  console.log("============================================================");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("");
    console.error("[X] 验证失败：", err.message || err);
    process.exit(1);
  });
