// Sepolia RPC 节点健康检查
//
// 用途：默认 RPC 卡住/抽风时，快速挑一个能用的备用节点
//   - 逐个测连通性、延迟、区块高度、chainId（必须是 11155111）
//   - 顺便测一次 eth_getLogs，避免遇到「能连但查不了历史日志」的假活节点
//
// 用法（不需要 hardhat，node 直接跑）：
//   node scripts/check-rpc.js
//   RPC_LIST="https://a,https://b" node scripts/check-rpc.js

const { ethers } = require("ethers");

const DEFAULT_LIST = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://1rpc.io/sepolia",
  "https://rpc.sepolia.org",
  "https://sepolia.drpc.org",
  "https://eth-sepolia.public.blastapi.io",
];

const list = process.env.RPC_LIST ? process.env.RPC_LIST.split(",").map((s) => s.trim()) : DEFAULT_LIST;
const withTimeout = (pr, ms) => Promise.race([pr, new Promise((_, rj) => setTimeout(() => rj(new Error("超时")), ms))]);

async function checkOne(url) {
  const r = { url, ok: false, ms: 0, block: null, chainId: null, logs: null, err: "" };
  const t0 = Date.now();
  try {
    const p = new ethers.JsonRpcProvider(url);
    const [n, net] = await withTimeout(Promise.all([p.getBlockNumber(), p.getNetwork()]), 8000);
    r.block = n;
    r.chainId = Number(net.chainId);
    r.ms = Date.now() - t0;
    // 再探一次历史日志查询能力（很多公共节点对大范围 getLogs 有限制）
    try {
      const logs = await withTimeout(
        p.getLogs({ fromBlock: Math.max(0, n - 2000), toBlock: n, address: "0x71450D767f2b83722b88164316d7308DB20A39c8" }),
        8000
      );
      r.logsOk = true;
      r.logs = `getLogs 正常（近 2000 块 ${logs.length} 条）`;
    } catch (e) {
      r.logsOk = false;
      r.logs = `getLogs 受限：${e.shortMessage || e.message}`.slice(0, 60);
    }
    r.ok = r.chainId === 11155111;
    if (!r.ok) r.err = `chainId 不是 11155111（拿到 ${r.chainId}）`;
  } catch (e) {
    r.ms = Date.now() - t0;
    r.err = (e.shortMessage || e.message || String(e)).slice(0, 70);
  }
  return r;
}

(async () => {
  console.log("=".repeat(72));
  console.log("Sepolia RPC 节点体检");
  console.log("=".repeat(72));

  const results = [];
  for (const url of list) {
    const r = await checkOne(url);
    results.push(r);
    const tag = r.ok ? "✅ 可用" : "❌ 不可用";
    console.log(`${tag}  ${url}`);
    if (r.ok) {
      console.log(`        延迟 ${r.ms}ms｜区块 ${r.block}｜chainId ${r.chainId}`);
      console.log(`        ${r.logs}`);
    } else {
      console.log(`        ${r.err || "连接失败"}`);
    }
  }

  // 排序：能不能查历史日志，比快几十毫秒重要得多
  const good = results
    .filter((r) => r.ok)
    .sort((a, b) => (b.logsOk ? 1 : 0) - (a.logsOk ? 1 : 0) || a.ms - b.ms);
  console.log("");
  if (good.length === 0) {
    console.log("⚠️ 所有候选节点都不可用：检查本机网络，或自备 Alchemy / Infura 的免费 Key。");
  } else {
    console.log(`可用节点 ${good.length} 个，推荐 ${good[0].url}（${good[0].ms}ms${good[0].logsOk ? "，日志可查" : "，但日志查询受限"}）`);
    console.log("");
    console.log("切换方法：把下面这行写进项目根目录的 .env，再重跑命令即可");
    console.log(`  SEPOLIA_RPC_URL=${good[0].url}`);
    if (good.length > 1) {
      console.log("");
      console.log("备用（主节点抽风时替换用）：");
      good.slice(1).forEach((g) => console.log(`  SEPOLIA_RPC_URL=${g.url}   （${g.ms}ms）`));
    }
  }
  process.exit(0);
})();
