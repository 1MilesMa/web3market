// 资金滞留监控脚本
//
// 用途：盯住 SimpleMarket 里「该领还没领」的钱，避免资金在合约里睡大觉
//   1) 平台费：owner（时间锁）可提取的 accumulatedFees
//   2) 待领退款：出价被拒/退回失败后进 pendingWithdrawals 的钱（买家自己领）
//   3) 待领版税：成交时分给创作者、存在 pendingRoyalties 里的钱（创作者自己领）
//
// 用法：
//   npx hardhat run scripts/monitor-funds.js --network sepolia
//   FROM_BLOCK=11631015 npx hardhat run scripts/monitor-funds.js --network sepolia
//
// 说明：只读脚本，不发交易、不花 gas。

const fs = require("fs");
const path = require("path");

function loadDeployment(name) {
  const p = path.join(__dirname, "..", "deployments", name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const { ethers, artifacts } = require("hardhat");

  const marketDep = loadDeployment("simplemarket-sepolia.json");
  const timelockDep = loadDeployment("markettimelock-sepolia.json");
  const MARKET = process.env.MARKET || (marketDep && marketDep.address);
  if (!MARKET) throw new Error("缺少 SimpleMarket 地址：deployments/simplemarket-sepolia.json 不存在");

  const provider = ethers.provider;
  const marketArt = await artifacts.readArtifact("SimpleMarket");
  const iMarket = new ethers.Interface(marketArt.abi);
  const mk = new ethers.Contract(MARKET, marketArt.abi, provider);

  console.log("=".repeat(72));
  console.log("SimpleMarket 资金滞留监控");
  console.log("=".repeat(72));
  console.log(`市场合约: ${MARKET}`);
  console.log(`现任 owner: ${await mk.owner()}${timelockDep ? "（时间锁 " + timelockDep.address + "）" : ""}`);
  console.log("");

  // ---------- 1. 合约自身状态 ----------
  const balance = await provider.getBalance(MARKET);
  let accumulatedFees = null;
  try {
    accumulatedFees = await mk.accumulatedFees();
  } catch (_) {
    /* 变量不是 public，跳过 */
  }

  console.log("【合约资金总览】");
  console.log(`  合约 ETH 余额      : ${ethers.formatEther(balance)} ETH`);
  if (accumulatedFees !== null) {
    console.log(`  平台费可提取       : ${ethers.formatEther(accumulatedFees)} ETH（owner 调 withdrawFees 领取）`);
  }
  console.log("");

  // ---------- 2. 扫事件，收集所有相关地址 ----------
  const latest = await provider.getBlockNumber();
  const fromBlock = Number(process.env.FROM_BLOCK || (marketDep && marketDep.blockNumber) || latest - 50000);
  const CHUNK = Number(process.env.CHUNK || 5000);

  const WATCH_TOPICS = [
    "RefundPending",
    "PendingWithdrawn",
    "RoyaltyPaid",
    "RoyaltyWithdrawn",
    "OfferMade",
    "OfferWithdrawn",
    "OfferAccepted",
    "OfferRejected",
    "Sold",
    "FeesWithdrawn",
  ];
  const topic0List = WATCH_TOPICS.map((n) => {
    const ev = iMarket.getEvent(n);
    return ev ? { name: n, topic: iMarket.getEvent(n).topicHash } : null;
  }).filter(Boolean);

  console.log(`【扫描链上事件】区块 ${fromBlock} → ${latest}`);
  const allLogs = [];
  for (let start = fromBlock; start <= latest; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latest);
    // 注意：这里故意不用 topics 过滤。公共 RPC 对 topics 数组的 OR 查询支持不一致
    // （实测同一区间带 topics 与不带 topics 返回的条数不同，会漏事件），
    // 因此拉该地址的全部日志、再在本地按事件名筛选，最稳。
    const logs = await provider.getLogs({
      address: MARKET,
      fromBlock: start,
      toBlock: end,
    });
    allLogs.push(...logs);
    process.stdout.write(`  已扫描至区块 ${end}\r`);
  }
  console.log("  " + " ".repeat(30) + "\r");

  // 收集事件中出现过的所有地址（凡是 address 类型的参数都算）
  const addrSet = new Set();
  const refundEvents = [];
  // 在途出价的唯一键：nft + tokenId + 出价人
  const offerKeys = new Set();
  for (const log of allLogs) {
    let parsed;
    try {
      parsed = iMarket.parseLog(log);
    } catch (_) {
      continue;
    }
    if (!parsed) continue;
    for (const v of parsed.args) {
      if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && v !== ethers.ZeroAddress) {
        addrSet.add(v);
      }
    }
    if (parsed.name === "RefundPending") {
      refundEvents.push({ account: parsed.args.account, amount: parsed.args.amount, block: log.blockNumber });
    }
    // 出价类事件都带 (nftContract, tokenId, bidder)
    if (["OfferMade", "OfferWithdrawn", "OfferAccepted", "OfferRejected"].includes(parsed.name)) {
      const nft = parsed.args.nftContract;
      const tokenId = parsed.args.tokenId;
      const bidder = parsed.args.bidder;
      if (nft && tokenId !== undefined && bidder) {
        offerKeys.add(`${nft}|${tokenId.toString()}|${bidder}`);
      }
    }
  }

  // ---------- 3. 逐个地址查待领金额 ----------
  console.log("");
  console.log("【待领明细】（大于 0 才列）");
  let sumPending = 0n;
  let sumRoyalty = 0n;
  let any = false;

  for (const addr of addrSet) {
    let pw = 0n;
    let pr = 0n;
    try {
      pw = await mk.pendingWithdrawals(addr);
    } catch (_) {}
    try {
      pr = await mk.pendingRoyalties(addr);
    } catch (_) {}
    if (pw > 0n || pr > 0n) {
      any = true;
      console.log(`  ${addr}`);
      if (pw > 0n) console.log(`      待领退款 : ${ethers.formatEther(pw)} ETH  → 该地址调 withdrawPendingFunds()`);
      if (pr > 0n) console.log(`      待领版税 : ${ethers.formatEther(pr)} ETH  → 该地址调 withdrawRoyalties()`);
      sumPending += pw;
      sumRoyalty += pr;
    }
  }
  if (!any) console.log("  无（没有待领资金）");

  // ---------- 3b. 在途出价：钱锁在合约里，等成交或撤回 ----------
  console.log("");
  console.log("【在途出价】（买家已出价、尚未成交或撤回，ETH 暂时锁在合约里）");
  let sumOffers = 0n;
  let anyOffer = false;
  for (const key of offerKeys) {
    const [nft, tokenId, bidder] = key.split("|");
    let amount = 0n;
    try {
      const o = await mk.getOffer(nft, tokenId, bidder);
      amount = o.amount !== undefined ? o.amount : o[0];
    } catch (_) {}
    if (amount > 0n) {
      anyOffer = true;
      console.log(`  NFT ${nft} #${tokenId} ← 出价人 ${bidder}`);
      console.log(`      锁定 : ${ethers.formatEther(amount)} ETH`);
      sumOffers += amount;
    }
  }
  if (!anyOffer) console.log("  无（没有在途出价）");

  console.log("");
  console.log("【对账】");
  const fees = accumulatedFees !== null ? accumulatedFees : 0n;
  const accounted = fees + sumPending + sumRoyalty + sumOffers;
  console.log(
    `  平台费 ${ethers.formatEther(fees)} + 待领退款 ${ethers.formatEther(sumPending)} + 待领版税 ${ethers.formatEther(
      sumRoyalty
    )} + 在途出价 ${ethers.formatEther(sumOffers)}`
  );
  console.log(`  = 已记账合计 ${ethers.formatEther(accounted)} ETH`);
  console.log(`  合约实际余额 ${ethers.formatEther(balance)} ETH`);
  if (balance > accounted) {
    console.log(`  ⚠️ 差额 +${ethers.formatEther(balance - accounted)} ETH：合约里还有不属于以上三项的钱`);
    console.log(`     （可能是直接转入、或扫描起始区块之前产生的待领），可调大 FROM_BLOCK 范围复查`);
  } else if (balance < accounted) {
    console.log(`  ⚠️ 差额 -${ethers.formatEther(accounted - balance)} ETH：账目不平，需人工核查（不应出现）`);
  } else {
    console.log(`  ✅ 账目一致：合约里的每一分钱都能对上来源`);
  }

  if (refundEvents.length) {
    console.log("");
    console.log(`【退款待领事件】共 ${refundEvents.length} 笔（记入待领池的历史）`);
    for (const r of refundEvents.slice(-10)) {
      console.log(`  区块 ${r.block}：${r.account} 待领 ${ethers.formatEther(r.amount)} ETH`);
    }
  }

  console.log("");
  console.log("下一步：");
  console.log("  · 平台费要提取 → 多签发起提案：withdrawFees(收款地址)，走 5 分钟公示后执行");
  console.log("  · 买家/创作者的待领 → 只能由对应地址自己领，owner 无权代领（这就是 Pull Payment 的意义）");
}

main().catch((e) => {
  console.error("脚本出错：", e.message);
  process.exit(1);
});
