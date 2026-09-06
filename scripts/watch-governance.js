// 治理事件监听 / 复盘脚本
//
// 用途：把「多签 + 时间锁」这条治理链上发生过的事，按时间线打印出来
//   - 谁提了案、谁确认了、谁撤了票、什么时候执行的
//   - 时间锁什么时候排队（公示开始）、什么时候真正生效、有没有被撤销
//   - 提案里的 calldata 翻译成人话（例如 setFeeBps(300)）
//
// 用法：
//   npx hardhat run scripts/watch-governance.js --network sepolia
//   FROM_BLOCK=11637734 npx hardhat run scripts/watch-governance.js --network sepolia   // 指定起始区块
//   WATCH=1 npx hardhat run scripts/watch-governance.js --network sepolia               // 打完历史后继续盯新事件
//
// 说明：只读脚本，不发任何交易、不花 gas。

const fs = require("fs");
const path = require("path");

function loadDeployment(name) {
  const p = path.join(__dirname, "..", "deployments", name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// 把一段 calldata 翻译成「函数(参数)」，认不出来就原样截断显示
function describeCall(marketIface, timelockIface, data) {
  if (!data || data === "0x") return "（纯转账，无调用数据）";
  for (const iface of [marketIface, timelockIface]) {
    try {
      const fn = iface.getFunction(data.slice(0, 10));
      if (!fn) continue;
      const args = iface.decodeFunctionData(fn, data);
      return `${fn.name}(${args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ")})`;
    } catch (_) {
      /* 不是这个接口的函数，换下一个 */
    }
  }
  return `未知调用 ${data.slice(0, 10)}…`;
}

async function main() {
  const { ethers, artifacts } = require("hardhat");

  const multisigDep = loadDeployment("multisigowner-sepolia.json");
  const timelockDep = loadDeployment("markettimelock-sepolia.json");
  const marketDep = loadDeployment("simplemarket-sepolia.json");

  const MULTISIG = process.env.MULTISIG || (multisigDep && multisigDep.address);
  const TIMELOCK = process.env.TIMELOCK || (timelockDep && timelockDep.address);
  const MARKET = process.env.MARKET || (marketDep && marketDep.address);

  if (!MULTISIG || !TIMELOCK || !MARKET) {
    throw new Error("缺少合约地址：请确认 deployments/ 下三个 sepolia 部署记录存在");
  }

  const provider = ethers.provider;
  const marketArt = await artifacts.readArtifact("SimpleMarket");
  const multisigArt = await artifacts.readArtifact("MultiSigOwner");
  const timelockArt = await artifacts.readArtifact("MarketTimelock");

  const iMarket = new ethers.Interface(marketArt.abi);
  const iMulti = new ethers.Interface(multisigArt.abi);
  const iTime = new ethers.Interface(timelockArt.abi);

  const ms = new ethers.Contract(MULTISIG, multisigArt.abi, provider);
  const tl = new ethers.Contract(TIMELOCK, timelockArt.abi, provider);
  const mk = new ethers.Contract(MARKET, marketArt.abi, provider);

  console.log("=".repeat(72));
  console.log("治理链上复盘");
  console.log("=".repeat(72));
  console.log(`多签   MultiSigOwner : ${MULTISIG}`);
  console.log(`时间锁 MarketTimelock: ${TIMELOCK}`);
  console.log(`市场   SimpleMarket  : ${MARKET}`);
  console.log("");

  // ---------- 当前状态 ----------
  const [owners, threshold, txCount, minDelay, ownerNow, feeBps] = await Promise.all([
    ms.getOwners().catch(() => []),
    ms.threshold().catch(() => null),
    ms.getTransactionCount ? ms.getTransactionCount().catch(() => null) : null,
    tl.getMinDelay().catch(() => null),
    mk.owner().catch(() => null),
    mk.feeBps().catch(() => null),
  ]);

  console.log("【当前状态】");
  console.log(`  市场 owner        : ${ownerNow}`);
  console.log(`    └ 是时间锁？    : ${ownerNow && ownerNow.toLowerCase() === TIMELOCK.toLowerCase() ? "是 ✅" : "否 ⚠️"}`);
  console.log(`  市场 feeBps       : ${feeBps !== null ? feeBps.toString() : "读取失败"}（250 = 2.5%）`);
  console.log(`  多签阈值          : ${threshold !== null ? threshold.toString() : "读取失败"} / ${owners.length} 人`);
  owners.forEach((o, i) => console.log(`    owner[${i}]       : ${o}`));
  if (txCount !== null) console.log(`  多签提案总数      : ${txCount.toString()}`);
  console.log(`  时间锁公示延迟    : ${minDelay !== null ? minDelay.toString() + " 秒" : "读取失败"}`);
  console.log("");

  // ---------- 历史事件扫描 ----------
  const latest = await provider.getBlockNumber();
  const defaultFrom = Math.min(
    multisigDep ? Number(multisigDep.blockNumber) : latest,
    timelockDep ? Number(timelockDep.blockNumber) : latest
  );
  const fromBlock = Number(process.env.FROM_BLOCK || defaultFrom);
  const CHUNK = Number(process.env.CHUNK || 5000);

  console.log(`【历史治理事件】扫描区块 ${fromBlock} → ${latest}（每批 ${CHUNK} 块）`);
  console.log("");

  const events = [];
  for (let start = fromBlock; start <= latest; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latest);
    const logs = await provider.getLogs({
      address: [MULTISIG, TIMELOCK],
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) events.push(log);
    process.stdout.write(`  已扫描至区块 ${end}\r`);
  }
  console.log("  " + " ".repeat(30) + "\r");

  // 区块时间戳缓存
  const tsCache = new Map();
  async function tsOf(blockNumber) {
    if (!tsCache.has(blockNumber)) {
      const b = await provider.getBlock(blockNumber);
      tsCache.set(blockNumber, b ? b.timestamp : 0);
    }
    return tsCache.get(blockNumber);
  }

  const rows = [];
  for (const log of events) {
    const isMulti = log.address.toLowerCase() === MULTISIG.toLowerCase();
    const iface = isMulti ? iMulti : iTime;
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch (_) {
      continue;
    }
    if (!parsed) continue;

    const ts = await tsOf(log.blockNumber);
    const time = new Date(Number(ts) * 1000).toLocaleString("zh-CN", { hour12: false });
    const a = parsed.args;
    let who = "";
    let what = "";

    switch (parsed.name) {
      case "Submitted":
        who = a.proposer;
        what = `提案 #${a.txId} → 目标 ${a.to}：${describeCall(iMarket, iTime, a.data)}`;
        break;
      case "Confirmed":
        who = a.owner;
        what = `确认提案 #${a.txId}（当前 ${a.confirmations} 票）`;
        break;
      case "Revoked":
        who = a.owner;
        what = `撤销对提案 #${a.txId} 的确认（剩 ${a.confirmations} 票）`;
        break;
      case "Executed":
        who = `${a.to}`;
        what = `执行提案 #${a.txId} → ${a.success ? "成功 ✅" : "失败 ❌"}`;
        break;
      case "ThresholdChanged":
        what = `阈值变更 ${a.oldThreshold} → ${a.newThreshold}`;
        break;
      case "OwnerAdded":
        what = `新增多签成员 ${a.owner}`;
        break;
      case "OwnerRemoved":
        what = `移除多签成员 ${a.owner}`;
        break;
      case "CallScheduled":
        what = `⏳ 排队公示：${a.target} 的 ${describeCall(iMarket, iTime, a.data)}，延迟 ${a.delay} 秒，id ${a.id.slice(0, 12)}…`;
        break;
      case "CallExecuted":
        what = `✅ 公示到期执行：${a.target} 的 ${describeCall(iMarket, iTime, a.data)}，id ${a.id.slice(0, 12)}…`;
        break;
      case "CallCanceled":
        what = `🚫 撤销排队提案 id ${a.id.slice(0, 12)}…`;
        break;
      case "MinDelayChange":
        what = `公示延迟变更 ${a.oldDuration} → ${a.newDuration} 秒`;
        break;
      default:
        what = parsed.name;
    }

    rows.push({
      block: log.blockNumber,
      time,
      src: isMulti ? "多签" : "时间锁",
      name: parsed.name,
      who,
      what,
      tx: log.transactionHash,
    });
  }

  rows.sort((x, y) => x.block - y.block);

  if (rows.length === 0) {
    console.log("  该区间内没有治理事件。");
  } else {
    for (const r of rows) {
      console.log(`[${r.time}] 区块 ${r.block}｜${r.src}｜${r.name}`);
      console.log(`    ${r.what}`);
      if (r.who) console.log(`    发起人: ${r.who}`);
      console.log(`    tx: ${r.tx}`);
      console.log("");
    }
    console.log(`共 ${rows.length} 条治理事件。`);
  }

  // ---------- 持续监听 ----------
  if (process.env.WATCH === "1") {
    console.log("");
    console.log("【实时监听】已开启，新事件会即时打印（Ctrl+C 退出）");
    const seen = new Set(rows.map((r) => r.tx + r.name));

    const handle = async (log, isMulti) => {
      const iface = isMulti ? iMulti : iTime;
      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch (_) {
        return;
      }
      if (!parsed) return;
      const key = log.transactionHash + parsed.name;
      if (seen.has(key)) return;
      seen.add(key);

      const ts = await tsOf(log.blockNumber);
      console.log(
        `[${new Date(Number(ts) * 1000).toLocaleString("zh-CN", { hour12: false })}] ${isMulti ? "多签" : "时间锁"} ${
          parsed.name
        } | tx ${log.transactionHash}`
      );
      if (parsed.name === "Submitted") {
        console.log(`    提案 #${parsed.args.txId}：${describeCall(iMarket, iTime, parsed.args.data)}`);
      }
      if (parsed.name === "CallScheduled") {
        console.log(`    ⏳ 进入公示，${parsed.args.delay} 秒后可执行`);
      }
    };

    provider.on({ address: MULTISIG }, (log) => handle(log, true));
    provider.on({ address: TIMELOCK }, (log) => handle(log, false));

    await new Promise(() => {}); // 常驻
  }

  console.log("");
  console.log("提示：WATCH=1 可持续监听新提案（例如 WATCH=1 npx hardhat run scripts/watch-governance.js --network sepolia）");
}

main().catch((e) => {
  console.error("脚本出错：", e.message);
  process.exit(1);
});
