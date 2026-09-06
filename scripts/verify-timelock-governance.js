/**
 * verify-timelock-governance.js —— 时间锁接管后的治理实战（Sepolia）
 *
 * 跑法（PowerShell，项目根目录）：
 *   npx hardhat run scripts/verify-timelock-governance.js --network sepolia
 *
 * 剧本（一次跑完，中途自动等待公示，不用人盯）：
 *   1. 校验 owner 已经是时间锁
 *   2. 多签排队「把费率改成 300 bps」
 *   3. 公示期内抢跑 —— 应当被拒（证明时间锁真的挡得住）
 *   4. 公示到期 → 任何人执行 → 费率真正生效
 *   5. 再排队把费率还原成原值 → 到期执行 → 零残留
 *
 * 安全约定：
 *   - 地址全部从 deployments/*.json 读，缺文件报错退出
 *   - 可重入：每步先读链上状态，已完成的跳过
 *   - 会自己 sleep 等到公示结束，跑起来后去泡杯茶即可
 *   - 私钥只从本地 .env 读，不打印、不上传
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const EXPLORER = "https://sepolia.etherscan.io";
const MARKET_JSON = path.join(__dirname, "..", "deployments", "simplemarket-sepolia.json");
const MS_JSON = path.join(__dirname, "..", "deployments", "multisigowner-sepolia.json");
const TL_JSON = path.join(__dirname, "..", "deployments", "markettimelock-sepolia.json");
const ZERO_BYTES32 = ethers.ZeroHash;

const SALT_CHANGE = ethers.id("GOV_CHANGE_FEE_V1");
const SALT_RESTORE = ethers.id("GOV_RESTORE_FEE_V1");

const STATE_NAME = ["Unset", "Waiting", "Ready", "Done"];
const NEW_FEE = 300;

function same(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function load(p, what) {
  if (!fs.existsSync(p)) {
    console.error(`✗ 找不到 ${what}（${p}）。请先跑对应的部署脚本。`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(label, promiseFn) {
  const tx = await promiseFn();
  const receipt = await tx.wait(1);
  console.log(`  ✓ ${label}`);
  console.log(`    ${EXPLORER}/tx/${receipt.hash}   (区块 ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  return receipt;
}

/** 多签三步走：submit → confirm → execute */
async function multisigRun(ms, w1, w2, to, data, label) {
  const txId = Number(await ms.getTransactionCount());
  console.log(`\n  多签提案 #${txId}：${label}`);
  await send("账号 1 提交（提交即投第一票）", () => ms.connect(w1).submit(to, 0, data));
  await send("账号 2 补第二票", () => ms.connect(w2).confirm(txId));
  await send("账号 1 触发执行", () => ms.connect(w1).execute(txId));
  return txId;
}

/** 等到操作可执行，期间打印剩余时间 */
async function waitUntilReady(timelock, provider, opId, tag) {
  const readyAt = Number(await timelock.getTimestamp(opId));
  for (;;) {
    const state = Number(await timelock.getOperationState(opId));
    if (state === 2) return true;
    if (state === 3) return false;
    const blk = await provider.getBlock("latest");
    const left = readyAt - blk.timestamp;
    if (left <= 0) {
      await sleep(5000);
      continue;
    }
    console.log(`  ⏳ ${tag}：还需等待 ${left} 秒（${new Date(readyAt * 1000).toLocaleTimeString("zh-CN")} 可执行）`);
    await sleep(Math.min(Math.max(left, 1), 30) * 1000);
  }
}

/** 走完一个完整的时间锁治理动作：排队 → 抢跑被拒 → 等待 → 执行 */
async function runGovernanceAction(ctx, target, data, salt, label, verify) {
  const { timelock, ms, w1, w2, provider } = ctx;
  const opId = await timelock.hashOperation(target, 0, data, ZERO_BYTES32, salt);
  let state = Number(await timelock.getOperationState(opId));

  console.log(`\n  操作 id : ${opId}`);
  console.log(`  当前状态: ${STATE_NAME[state]}`);

  if (state === 0) {
    await multisigRun(
      ms,
      w1,
      w2,
      await timelock.getAddress(),
      timelock.interface.encodeFunctionData("schedule", [
        target,
        0,
        data,
        ZERO_BYTES32,
        salt,
        Number(await timelock.getMinDelay()),
      ]),
      `schedule(${label})`
    );
    state = Number(await timelock.getOperationState(opId));
  } else {
    console.log("  [复用] 该操作已排队，跳过排队步骤。");
  }

  // 公示期内抢跑，应当被拒
  if (state === 1) {
    console.log("\n  抢跑测试：公示还没结束就执行（应当被拒）");
    try {
      await timelock.connect(w1).execute(target, 0, data, ZERO_BYTES32, salt);
      console.log("  ✗ 竟然执行成功了 —— 时间锁没生效，请立刻检查");
      process.exit(1);
    } catch (err) {
      const msg = (err.shortMessage || err.message || String(err)).split("\n")[0];
      console.log(`  [被拒] ${msg}`);
      console.log("  ✓ 公示期防护生效");
    }
  }

  // 等待到期
  if (state === 1) {
    console.log("\n  等待公示结束（脚本自动等待，不用管）……");
    await waitUntilReady(timelock, provider, opId, label);
  }

  state = Number(await timelock.getOperationState(opId));
  if (state === 3) {
    console.log("  [复用] 该操作已执行，跳过。");
  } else if (state === 2) {
    console.log("\n  执行（任何人都能点，这里用账号 1 代劳）");
    await send(`execute(${label})`, () =>
      timelock.connect(w1).execute(target, 0, data, ZERO_BYTES32, salt)
    );
  } else {
    console.error(`✗ 操作状态异常（${STATE_NAME[state]}），中止。`);
    process.exit(1);
  }

  await verify();
}

async function main() {
  const keys = ["PRIVATE_KEY", "PRIVATE_KEY_2", "PRIVATE_KEY_3"].map((k) => (process.env[k] || "").trim());
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
  const [w1, w2, w3] = keys.map((pk) => new ethers.Wallet(pk, provider));

  const marketAddr = load(MARKET_JSON, "市场部署产物").address;
  const msAddr = load(MS_JSON, "多签部署产物").address;
  const tlAddr = load(TL_JSON, "时间锁部署产物").address;

  const market = await ethers.getContractAt("SimpleMarket", marketAddr, w1);
  const ms = await ethers.getContractAt("MultiSigOwner", msAddr, w1);
  const timelock = await ethers.getContractAt("MarketTimelock", tlAddr, w1);

  const owner = await market.owner();
  const minDelay = Number(await timelock.getMinDelay());
  const origFee = Number(await market.feeBps());

  console.log("=".repeat(68));
  console.log("时间锁治理实战 —— Sepolia");
  console.log("=".repeat(68));
  console.log("  市场   :", marketAddr, " 当前费率", origFee, "bps");
  console.log("  多签   :", msAddr);
  console.log("  时间锁 :", tlAddr, " 公示", minDelay, "秒");
  console.log("  owner  :", owner);

  if (!same(owner, tlAddr)) {
    console.error("✗ 市场 owner 还不是时间锁，请先跑 transfer-market-to-timelock.js 完成易主。");
    process.exit(1);
  }
  console.log("  ✓ owner 已是时间锁，治理链路就绪\n");

  const ctx = { timelock, ms, w1, w2, w3, provider };

  // ------------------------------------------------ 动作一：改费率为 300
  console.log("=".repeat(68));
  console.log(`[动作一] 把费率从 ${origFee} 改成 ${NEW_FEE} bps`);
  console.log("=".repeat(68));
  const changeData = market.interface.encodeFunctionData("setFeeBps", [NEW_FEE]);
  await runGovernanceAction(ctx, marketAddr, changeData, SALT_CHANGE, `setFeeBps(${NEW_FEE})`, async () => {
    const fee = Number(await market.feeBps());
    const ok = fee === NEW_FEE;
    console.log(`\n  校验：费率 = ${fee} bps → ${ok ? "已生效 ✓" : "未生效 ✗"}`);
    if (!ok) process.exit(1);
  });

  // ------------------------------------------------ 动作二：还原费率
  console.log("\n" + "=".repeat(68));
  console.log(`[动作二] 把费率还原成 ${origFee} bps`);
  console.log("=".repeat(68));
  const restoreData = market.interface.encodeFunctionData("setFeeBps", [origFee]);
  await runGovernanceAction(ctx, marketAddr, restoreData, SALT_RESTORE, `setFeeBps(${origFee})`, async () => {
    const fee = Number(await market.feeBps());
    const ok = fee === origFee;
    console.log(`\n  校验：费率 = ${fee} bps → ${ok ? "已还原，零残留 ✓" : "未还原 ✗"}`);
    if (!ok) process.exit(1);
  });

  // ------------------------------------------------ 越权测试
  console.log("\n" + "=".repeat(68));
  console.log("[越权测试] 非多签成员想直接排队（应当被拒）");
  console.log("=".repeat(68));
  const outsider = w3;
  const evilSalt = ethers.id("EVIL_OUTSIDER_V1");
  const evilData = market.interface.encodeFunctionData("setFeeBps", [999]);
  try {
    await timelock
      .connect(outsider)
      .schedule(marketAddr, 0, evilData, ZERO_BYTES32, evilSalt, minDelay);
    console.log("  ✗ 外部账号竟然排队成功了 —— 权限配置有问题，请立刻检查");
    process.exit(1);
  } catch (err) {
    const msg = (err.shortMessage || err.message || String(err)).split("\n")[0];
    console.log(`  [被拒] ${msg}`);
    console.log("  ✓ 只有多签能发起排队，外部账号（即便是有钱有币的账号 3）也动不了");
  }

  // ------------------------------------------------ 总结
  console.log("\n" + "=".repeat(68));
  console.log("治理实战总结");
  console.log("=".repeat(68));
  console.log("  ✓ 多签提议 → 2 票通过 → 排队公示", minDelay, "秒 → 任何人执行 → 变更生效");
  console.log("  ✓ 公示期内抢跑：被拒");
  console.log("  ✓ 非多签成员排队：被拒");
  console.log("  ✓ 变更 + 还原全流程：零残留");
  console.log("\n  最终状态");
  console.log("    市场 owner :", await market.owner());
  console.log("    市场费率   :", await market.feeBps(), "bps");
  console.log("    多签提案数 :", await ms.getTransactionCount());
  console.log(`\n${EXPLORER}/address/${tlAddr}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n治理验证失败：", err.shortMessage || err.message || err);
    process.exit(1);
  });
