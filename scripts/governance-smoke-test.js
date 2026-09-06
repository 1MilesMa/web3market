/**
 * governance-smoke-test.js —— 治理链路冒烟测试（Sepolia）
 *
 * 为什么要做：MyNFT / MyToken 的 owner 现在都在时间锁手里。
 *   万一多签与时间锁的联动有没测到的边角，这两个合约就等于被锁死——
 *   谁都动不了 mint / pause，那"移交治理"反而变成了"永久冻结"。
 *   这一步用治理真的去驱动它们一次，把"应该能"变成"确实能"。
 *
 * 验证三件事（一次排队、一次公示、一次执行，全部走 2/2 多签）：
 *   1. MyToken.mint(部署者, 1 MTK)   —— ERC20 增发权确由治理驱动
 *   2. MyNFT.pause()                —— NFT 暂停权确由治理驱动
 *   3. MyNFT.unpause()              —— 一定能还原（放在最后执行）
 *
 * 为什么选 pause/unpause 而不是 setPublicMintEnabled：
 *   pause 只挡铸造（safeMint / publicMint / adminMintWithTokenId），
 *   不挡转账与授权，市场交易不受影响；而"打开公开铸造"会在链上真的铸出 NFT。
 *   成对开关 + 最后还原，跑完状态与跑之前完全一致。
 *
 * 用法（项目根目录，PowerShell）：
 *   npx hardhat run scripts/governance-smoke-test.js --network sepolia          # 演练
 *   $env:EXECUTE='1'; npx hardhat run scripts/governance-smoke-test.js --network sepolia
 *
 * 安全约定：同其它治理脚本——默认演练、EXECUTE=1 才发交易、按操作 id 可重入。
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const EXPLORER = "https://sepolia.etherscan.io";
const TOKEN_JSON = path.join(__dirname, "..", "deployment-mytoken-sepolia.json");
const NFT_JSON = path.join(__dirname, "..", "deployments", "mynft-sepolia.json");
const MS_JSON = path.join(__dirname, "..", "deployments", "multisigowner-sepolia.json");
const TL_JSON = path.join(__dirname, "..", "deployments", "markettimelock-sepolia.json");
const ZERO = ethers.ZeroHash;
const STATE = ["Unset", "Waiting", "Ready", "Done"];
const EXECUTE = process.env.EXECUTE === "1";

function load(p, what) {
  if (!fs.existsSync(p)) {
    console.error(`✗ 找不到${what}（${p}）`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** 多签三步走：submit（含第 1 票）→ confirm（第 2 票）→ execute */
async function multisigRun(ms, w1, w2, to, data, label) {
  const txId = Number(await ms.getTransactionCount());
  console.log(`\n  多签提案 #${txId}：${label}`);
  const send = async (sub, fn) => {
    if (!EXECUTE) {
      console.log(`    [演练] ${sub}`);
      return;
    }
    const r = await (await fn()).wait(1);
    console.log(`    ✅ ${sub}  ${EXPLORER}/tx/${r.hash} (区块 ${r.blockNumber}, gas ${r.gasUsed})`);
  };
  await send("账号 1 提交（含第 1 票）", () => ms.connect(w1).submit(to, 0, data));
  await send("账号 2 补第 2 票", () => ms.connect(w2).confirm(txId));
  await send("账号 1 触发执行", () => ms.connect(w1).execute(txId));
  if (EXECUTE) {
    const t = await ms.getTransaction(txId);
    console.log(`    状态：${t.confirmations}/2 票，已执行=${t.executed}`);
  }
  return txId;
}

async function main() {
  const keys = ["PRIVATE_KEY", "PRIVATE_KEY_2", "PRIVATE_KEY_3"].map((k) => (process.env[k] || "").trim());
  if (keys.some((k) => !k)) {
    console.error("✗ .env 里三个私钥必须配齐");
    process.exit(1);
  }
  const provider = ethers.provider;
  if ((await provider.getNetwork()).chainId !== 11155111n) {
    console.error("✗ 不是 Sepolia，命令末尾加 --network sepolia");
    process.exit(1);
  }
  const [w1, w2, w3] = keys.map((pk) => new ethers.Wallet(pk, provider));

  const tokenAddr = load(TOKEN_JSON, "MyToken 产物").address;
  const nftAddr = load(NFT_JSON, "MyNFT 产物").address;
  const msAddr = load(MS_JSON, "多签产物").address;
  const tlAddr = load(TL_JSON, "时间锁产物").address;

  const token = await ethers.getContractAt("MyToken", tokenAddr, w1);
  const nft = await ethers.getContractAt("MyNFT", nftAddr, w1);
  const ms = await ethers.getContractAt("MultiSigOwner", msAddr, w1);
  const timelock = await ethers.getContractAt("MarketTimelock", tlAddr, w1);
  const minDelay = Number(await timelock.getMinDelay());

  console.log("=".repeat(70));
  console.log(`治理链路冒烟测试 —— Sepolia（${EXECUTE ? "真实执行" : "演练模式，不发交易"}）`);
  console.log("=".repeat(70));
  console.log("  MyToken :", tokenAddr);
  console.log("  MyNFT   :", nftAddr);
  console.log("  多签    :", msAddr);
  console.log("  时间锁  :", tlAddr, "（公示", minDelay, "秒）");

  // ---------- 前置校验：owner 必须已经是时间锁，否则这次测试没有意义 ----------
  const tkOwner = await token.owner();
  const nftOwner = await nft.owner();
  console.log("\n[前置] 链上 owner 现状");
  console.log("  MyToken.owner() :", tkOwner, same(tkOwner, tlAddr) ? "= 时间锁 ✓" : "✗ 不是时间锁");
  console.log("  MyNFT.owner()   :", nftOwner, same(nftOwner, tlAddr) ? "= 时间锁 ✓" : "✗ 不是时间锁");
  if (!same(tkOwner, tlAddr) || !same(nftOwner, tlAddr)) {
    console.error("✗ 有合约的 owner 还不是时间锁，先跑对应的移交脚本。");
    process.exit(1);
  }
  if (!(await timelock.hasRole(await timelock.PROPOSER_ROLE(), msAddr))) {
    console.error("✗ 多签不是时间锁 proposer，无法排队。");
    process.exit(1);
  }

  const before = {
    bal: await token.balanceOf(w1.address),
    paused: await nft.paused(),
  };
  console.log("\n[基线] 测试前状态");
  console.log("  部署者 MTK 余额 :", ethers.formatUnits(before.bal, 18));
  console.log("  MyNFT.paused()  :", before.paused);

  // ---------- 三个待验证操作 ----------
  const mintData = token.interface.encodeFunctionData("mint", [w1.address, ethers.parseUnits("1", 18)]);
  const ops = [
    { key: "mint", label: "MyToken.mint(部署者, 1 MTK)", target: tokenAddr, data: mintData, salt: ethers.id("GOV_SMOKE_MINT_V1"), order: 1 },
    { key: "pause", label: "MyNFT.pause()", target: nftAddr, data: nft.interface.encodeFunctionData("pause", []), salt: ethers.id("GOV_SMOKE_PAUSE_V1"), order: 2 },
    { key: "unpause", label: "MyNFT.unpause()（还原，最后执行）", target: nftAddr, data: nft.interface.encodeFunctionData("unpause", []), salt: ethers.id("GOV_SMOKE_UNPAUSE_V1"), order: 3 },
  ];

  for (const op of ops) {
    op.id = await timelock.hashOperation(op.target, 0, op.data, ZERO, op.salt);
    op.state = Number(await timelock.getOperationState(op.id));
  }

  console.log("\n[计划] 三组操作，各走一次 2/2 多签排队");
  for (const op of ops) {
    console.log(`  ${op.order}. ${op.label}`);
    console.log(`     操作 id ${op.id.slice(0, 18)}…  当前状态 ${STATE[op.state]}`);
  }

  // ---------- 演练：估 gas 后退出 ----------
  if (!EXECUTE) {
    console.log("\n[演练] gas 估算（按当前未排队状态估算，实际以链上为准）");
    let total = 0n;
    for (const op of ops) {
      if (op.state !== 0) {
        console.log(`  ${op.label}：已排队，跳过估算`);
        continue;
      }
      const sd = timelock.interface.encodeFunctionData("schedule", [op.target, 0, op.data, ZERO, op.salt, minDelay]);
      try {
        const g1 = await ms.connect(w1).submit.estimateGas(tlAddr, 0, sd);
        const g2 = await ms.connect(w2).confirm.estimateGas(await ms.getTransactionCount());
        const g3 = await ms.connect(w1).execute.estimateGas(await ms.getTransactionCount());
        const sub = g1 + g2 + g3;
        total += sub;
        console.log(`  ${op.label}\n     排队（提交 ${g1} + 第2票 ${g2} + 执行 ${g3}）= ${sub}`);
      } catch (e) {
        console.log(`  ${op.label}：估算失败（${e.message.split("\n")[0].slice(0, 80)}）`);
      }
    }
    console.log(`  排队合计约 ${total} gas`);
    console.log("  执行阶段（公示到期后）3 笔 execute，参考历史实测约 48,000 gas/笔");
    console.log("\n  全部交易均由多签账号 1 付 gas，部署者余额:", ethers.formatEther(await provider.getBalance(w1.address)), "ETH");
    console.log("  要真上链，重跑时加 $env:EXECUTE='1'");
    return;
  }

  // ---------- 第 1 步：排队 ----------
  console.log("\n[第 1 步] 多签排队三组操作");
  for (const op of ops.sort((a, b) => a.order - b.order)) {
    if (op.state === 0) {
      const sd = timelock.interface.encodeFunctionData("schedule", [op.target, 0, op.data, ZERO, op.salt, minDelay]);
      await multisigRun(ms, w1, w2, tlAddr, sd, `schedule(${op.label})`);
      op.state = Number(await timelock.getOperationState(op.id));
    } else {
      console.log(`\n  [复用] ${op.label} 状态 ${STATE[op.state]}，跳过排队`);
    }
  }

  // ---------- 第 2 步：等公示 ----------
  const now = (await provider.getBlock("latest")).timestamp;
  let earliest = Infinity;
  for (const op of ops) {
    op.state = Number(await timelock.getOperationState(op.id));
    if (op.state === 1) earliest = Math.min(earliest, Number(await timelock.getTimestamp(op.id)));
  }
  console.log("\n[第 2 步] 公示期");
  if (earliest !== Infinity) {
    const left = earliest - now;
    console.log(`  距可执行还剩 ${left} 秒（约 ${(left / 60).toFixed(1)} 分钟），到期时间 ${new Date(earliest * 1000).toLocaleString("zh-CN")}`);
    console.log("  ⏳ 到期后重跑本脚本即可完成执行。");
    return;
  }

  // ---------- 第 3 步：执行（mint → pause → unpause，保证最后还原） ----------
  console.log("\n[第 3 步] 公示已到期，执行三组操作");
  for (const op of ops.sort((a, b) => a.order - b.order)) {
    if (op.state === 2) {
      const r = await (await timelock.connect(w1).execute(op.target, 0, op.data, ZERO, op.salt)).wait(1);
      console.log(`  ✅ ${op.label}  ${EXPLORER}/tx/${r.hash} (区块 ${r.blockNumber}, gas ${r.gasUsed})`);
    } else if (op.state === 3) {
      console.log(`  [跳过] ${op.label} 已执行过`);
    } else {
      console.log(`  ⚠ ${op.label} 状态 ${STATE[op.state]}，本次不执行`);
    }
  }

  // ---------- 验收 ----------
  const after = {
    bal: await token.balanceOf(w1.address),
    paused: await nft.paused(),
  };
  console.log("\n" + "=".repeat(70));
  console.log("验收结果");
  console.log("=".repeat(70));
  console.log(`  MyToken 余额 : ${ethers.formatUnits(before.bal, 18)} → ${ethers.formatUnits(after.bal, 18)} MTK  ${after.bal === before.bal + ethers.parseUnits("1", 18) ? "✅ 恰好 +1" : "✗ 未增加"}`);
  console.log(`  MyNFT.paused : ${before.paused} → ${after.paused}  ${after.paused === before.paused ? "✅ 已还原" : "✗ 未还原"}`);
  console.log(`  MyToken.owner: ${await token.owner()} ${same(await token.owner(), tlAddr) ? "✅ 仍为时间锁" : "✗"}`);
  console.log(`  MyNFT.owner  : ${await nft.owner()} ${same(await nft.owner(), tlAddr) ? "✅ 仍为时间锁" : "✗"}`);
  const ok = after.bal === before.bal + ethers.parseUnits("1", 18) && after.paused === before.paused;
  console.log(`\n  结论：治理对 MyToken / MyNFT 的 onlyOwner 权限${ok ? "✅ 确实可用，不是单向锁" : "✗ 未通过，需要排查"}`);
  console.log("");
}

main().catch((e) => {
  console.error("✗ 出错：", e.message);
  process.exit(1);
});
