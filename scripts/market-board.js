/**
 * ============================================================================
 * 市场行情板：把 SimpleMarket 的事件重放成「当前在售 / 成交历史 / 报价」
 * ============================================================================
 *
 * 运行方式（项目根目录）：
 *   npx hardhat run scripts/market-board.js --network sepolia
 *
 * ---------------------------------------------------------------------------
 * 为什么需要这个脚本：getListing 只能「点对点」查
 * ---------------------------------------------------------------------------
 * 合约提供了 getListing(nft, tokenId)，但你必须先知道 tokenId 才能问。
 * 想回答「这个市场现在一共挂着几件、都多少钱」——合约本身答不了，
 * 因为 _listings 是 private mapping，Solidity 不提供枚举 mapping 的能力。
 *
 * 于是链下只有两条路：
 *   路线 A：遍历 tokenId，逐个 getListing（本脚本的交叉验证部分）
 *           —— 简单，但要知道 NFT 总量，且 NFT 多了请求数线性增长
 *   路线 B：扫 Listed / PriceUpdated / Canceled / Sold 事件，在本地重放出现状
 *           —— 这才是 OpenSea、Blur 的真实做法（它们背后是 The Graph / 自建索引器）
 *
 * 本脚本两条都跑，并用 B 的结果去校验 A —— 两条独立路径得出同一个答案，
 * 才能证明事件一条没漏拉、重放逻辑没写错。这是链下索引的标准自检方式。
 *
 * ---------------------------------------------------------------------------
 * 事件怎么变成「状态」：一个小型状态机
 * ---------------------------------------------------------------------------
 *   Listed(nft, tokenId, seller, price)     → 建一条挂单
 *   PriceUpdated(nft, tokenId, old, new)    → 改价
 *   Canceled(nft, tokenId, seller)          → 删除挂单（下架）
 *   Sold(nft, tokenId, seller, buyer, price, fee) → 删除挂单 + 记一笔成交
 *   OfferAccepted(nft, tokenId, seller, bidder, price, fee) → 同上（报价成交）
 *
 * 排序必须按 (blockNumber, logIndex)：同一区块里先挂后卖、和先卖后挂，
 * 重放结果天差地别。logIndex 就是日志在区块内的顺序号，不能省。
 *
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const line = "-".repeat(78);

function short(addr) {
  // 不是地址的（比如 NFT 已销毁时的占位文字）原样返回，别按地址去截断
  if (!addr || !String(addr).startsWith("0x")) return String(addr);
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function section(n, title) {
  console.log("");
  console.log(line);
  console.log(`[${n}] ${title}`);
  console.log(line);
}

/** wei → ETH。保留 8 位小数：手续费对账里 0.0001375 这种数，
 *  只留 6 位会四舍五入成 0.000138，看起来跟分项之和对不上 */
function eth(wei) {
  return Number(hre.ethers.formatEther(wei)).toFixed(8);
}

/**
 * 分段拉取事件日志，公共 RPC 限制单次区块跨度时自动减半重试。
 * 与 nft-history.js 里的实现同源。
 */
async function fetchLogsChunked(contract, filter, fromBlock, toBlock, span = 2000) {
  const all = [];
  let cursor = fromBlock;
  let currentSpan = span;

  while (cursor <= toBlock) {
    const end = Math.min(cursor + currentSpan - 1, toBlock);
    try {
      const part = await contract.queryFilter(filter, cursor, end);
      all.push(...part);
      cursor = end + 1;
    } catch (err) {
      const msg = String((err && err.shortMessage) || err.message || err);
      if (
        msg.includes("block range") ||
        msg.includes("too many") ||
        msg.includes("limit") ||
        msg.includes("502") ||
        msg.includes("timeout")
      ) {
        if (currentSpan <= 10) {
          throw new Error(`区块跨度已缩到 ${currentSpan} 仍失败：${msg}`);
        }
        currentSpan = Math.floor(currentSpan / 2);
        continue;
      }
      throw err;
    }
  }
  return all;
}

/** 事件统一排序：先按区块，同区块按日志序号 */
function byChainOrder(a, b) {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
  return a.index - b.index;
}

/**
 * 按「显示宽度」补空格：中文等全角字符在终端占 2 列，
 * 直接用 padEnd 会按字符数算，导致中文行对不齐。
 */
function padDisp(s, width) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[　-〿一-鿿＀-￯]/.test(ch) ? 2 : 1;
  }
  return String(s) + " ".repeat(Math.max(0, width - w));
}

/** 挂单的唯一键：同一市场可以服务多个 NFT 合集，所以键里必须带合约地址 */
function keyOf(nftAddr, tokenId) {
  return `${String(nftAddr).toLowerCase()}:${tokenId.toString()}`;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

async function main() {
  const { ethers } = hre;
  const networkName = hre.network.name;
  const [me] = await ethers.getSigners();
  const base = path.join(__dirname, "..", "deployments");

  const marketInfo = readJson(path.join(base, `simplemarket-${networkName}.json`));
  const nftInfo = readJson(path.join(base, `mynft-${networkName}.json`));
  if (!marketInfo || !nftInfo) {
    throw new Error(
      `缺少部署产物（需要 simplemarket-${networkName}.json 与 mynft-${networkName}.json）`
    );
  }

  const market = await ethers.getContractAt("SimpleMarket", marketInfo.address);
  const nft = await ethers.getContractAt("MyNFT", nftInfo.address);

  const latest = await ethers.provider.getBlockNumber();
  const fromBlock = marketInfo.blockNumber || marketInfo.block || 0;

  /* ---------------- 1. 市场基本盘 ---------------- */
  section(1, "市场基本盘");
  const feeBps = await market.feeBps();
  const accFees = await market.accumulatedFees();
  console.log("  Market 合约 :", marketInfo.address);
  console.log("  NFT 合约    :", nftInfo.address);
  console.log("  部署区块    :", fromBlock, " | 当前区块:", latest);
  console.log("  手续费      :", feeBps.toString(), "bps =", Number(feeBps) / 100, "%");
  // 注意 accumulatedFees 是【还没被 owner 提走】的余额，不是历史累计；
  // 历史累计要再加上 FeesWithdrawn 事件，见第 4 节的对账
  console.log("  待提取手续费:", eth(accFees), "ETH");
  console.log("  当前账户    :", me.address);

  /* ---------------- 2. 拉取全部事件 ---------------- */
  section(2, "扫描事件日志（从部署区块至今）");
  const evListed = await fetchLogsChunked(market, market.filters.Listed(), fromBlock, latest);
  const evPrice = await fetchLogsChunked(market, market.filters.PriceUpdated(), fromBlock, latest);
  const evCancel = await fetchLogsChunked(market, market.filters.Canceled(), fromBlock, latest);
  const evSold = await fetchLogsChunked(market, market.filters.Sold(), fromBlock, latest);
  const evOfferAccepted = await fetchLogsChunked(
    market,
    market.filters.OfferAccepted(),
    fromBlock,
    latest
  );
  const evOfferMade = await fetchLogsChunked(market, market.filters.OfferMade(), fromBlock, latest);
  const evRoyalty = await fetchLogsChunked(market, market.filters.RoyaltyPaid(), fromBlock, latest);
  const evFeeWd = await fetchLogsChunked(market, market.filters.FeesWithdrawn(), fromBlock, latest);

  console.log(`  Listed        ${evListed.length} 条`);
  console.log(`  PriceUpdated  ${evPrice.length} 条`);
  console.log(`  Canceled      ${evCancel.length} 条`);
  console.log(`  Sold          ${evSold.length} 条`);
  console.log(`  OfferAccepted ${evOfferAccepted.length} 条`);
  console.log(`  OfferMade     ${evOfferMade.length} 条`);
  console.log(`  RoyaltyPaid   ${evRoyalty.length} 条`);
  console.log(`  FeesWithdrawn ${evFeeWd.length} 条`);

  /* ---------------- 3. 重放出现状 ---------------- */
  // 把六类事件压成一条按链上顺序排列的流，再逐条改状态
  const stream = [];
  // 注意：不要对 ethers 的 EventLog 用展开运算符 {...e} ——
  // ethers v6 的 Log 字段大多是不可枚举的 own property，展开会静默丢掉
  // blockNumber / index / args，导致后面排序和取值全变成 undefined。
  // 这里显式取出需要的字段，最稳。
  for (const e of evListed)
    stream.push({
      kind: "Listed",
      blockNumber: e.blockNumber,
      index: e.index,
      nft: e.args[0],
      tokenId: e.args[1],
      seller: e.args[2],
      price: e.args[3],
    });
  for (const e of evPrice)
    stream.push({
      kind: "PriceUpdated",
      blockNumber: e.blockNumber,
      index: e.index,
      nft: e.args[0],
      tokenId: e.args[1],
      newPrice: e.args[3],
    });
  for (const e of evCancel)
    stream.push({
      kind: "Canceled",
      blockNumber: e.blockNumber,
      index: e.index,
      nft: e.args[0],
      tokenId: e.args[1],
      seller: e.args[2],
    });
  for (const e of evSold)
    stream.push({
      kind: "Sold",
      blockNumber: e.blockNumber,
      index: e.index,
      nft: e.args[0],
      tokenId: e.args[1],
      seller: e.args[2],
      buyer: e.args[3],
      price: e.args[4],
      fee: e.args[5],
      txHash: e.transactionHash,
    });
  for (const e of evOfferAccepted)
    stream.push({
      kind: "OfferAccepted",
      blockNumber: e.blockNumber,
      index: e.index,
      nft: e.args[0],
      tokenId: e.args[1],
      seller: e.args[2],
      buyer: e.args[3],
      price: e.args[4],
      fee: e.args[5],
      txHash: e.transactionHash,
    });
  stream.sort((a, b) => byChainOrder(a, b));

  const listings = new Map(); // key -> {seller, price}
  const trades = [];
  // txHash:tokenId -> trade，用于把同一笔成交的 Sold 与 OfferAccepted 归并成一条
  const tradeKeys = new Map();

  for (const e of stream) {
    const k = keyOf(e.nft, e.tokenId);
    if (e.kind === "Listed") {
      listings.set(k, { seller: e.seller, price: e.price, nft: e.nft, tokenId: e.tokenId });
    } else if (e.kind === "PriceUpdated") {
      const cur = listings.get(k);
      if (cur) cur.price = e.newPrice;
    } else if (e.kind === "Canceled") {
      listings.delete(k);
    } else if (e.kind === "Sold") {
      listings.delete(k);
      const trade = {
        tokenId: e.tokenId,
        seller: e.seller,
        buyer: e.buyer,
        price: e.price,
        fee: e.fee,
        block: e.blockNumber,
        via: "直接购买",
      };
      trades.push(trade);
      // 同一笔交易里的 OfferAccepted 只是给这笔成交打个标签，不是第二笔成交
      tradeKeys.set(`${e.txHash}:${e.tokenId}`, trade);
    } else if (e.kind === "OfferAccepted") {
      listings.delete(k);
      const tk = `${e.txHash}:${e.tokenId}`;
      const existing = tradeKeys.get(tk);
      if (existing) {
        // 合约在 acceptOffer() 里先调 _settleSale（emit Sold）再 emit OfferAccepted，
        // 两条事件描述的是同一笔成交 —— 这里只改标签，绝不能记成第二笔
        existing.via = "接受报价";
      } else {
        trades.push({
          tokenId: e.tokenId,
          seller: e.seller,
          buyer: e.buyer,
          price: e.price,
          fee: e.fee,
          block: e.blockNumber,
          via: "接受报价",
        });
      }
    }
  }

  section(3, "当前在售（事件重放结果）");
  if (listings.size === 0) {
    console.log("  （当前没有任何在售挂单）");
  } else {
    console.log(
      "  " + padDisp("tokenId", 10) + padDisp("卖家", 16) + padDisp("价格(ETH)", 14) + "挂单 NFT 合约"
    );
    for (const v of listings.values()) {
      console.log(
        "  " +
          padDisp(String(v.tokenId), 10) +
          padDisp(short(v.seller), 16) +
          padDisp(eth(v.price), 14) +
          short(v.nft)
      );
    }
  }

  /* ---------------- 4. 成交历史 ---------------- */
  section(4, "成交历史");
  if (trades.length === 0) {
    console.log("  （暂无成交）");
  } else {
    trades.forEach((t, i) => {
      console.log(
        `  #${String(i + 1).padStart(2)} tokenId ${String(t.tokenId).padEnd(4)} ` +
          `${short(t.seller)} -> ${short(t.buyer)} | ${eth(t.price)} ETH ` +
          `(手续费 ${eth(t.fee)} ETH, ${t.via}, 区块 ${t.block})`
      );
    });
    const vol = trades.reduce((s, t) => s + BigInt(t.price), 0n);
    const fees = trades.reduce((s, t) => s + BigInt(t.fee), 0n);
    console.log("");
    console.log(`  成交笔数   : ${trades.length} 笔（已按交易哈希去重）`);
    console.log(`  累计成交额 : ${eth(vol)} ETH`);
    console.log(`  累计手续费 : ${eth(fees)} ETH`);

    // 会计恒等式自检：历史产生的手续费 = 已提取的 + 还挂在账上的
    const withdrawn = evFeeWd.reduce((s, e) => s + BigInt(e.args[1]), 0n);
    const pendingFees = await market.accumulatedFees();
    console.log("");
    console.log("  手续费对账（会计恒等式）：");
    console.log(`    事件累计产生 : ${eth(fees)} ETH`);
    console.log(`    已提取(FeesWithdrawn) : ${eth(withdrawn)} ETH`);
    console.log(`    待提取(accumulatedFees) : ${eth(pendingFees)} ETH`);
    console.log(
      BigInt(fees) === BigInt(withdrawn) + BigInt(pendingFees)
        ? "    [OK] 产生 = 已提取 + 待提取，账目自洽"
        : "    [!] 对不上，可能有事件漏拉或有其它动到手续费的路径"
    );
  }

  if (evRoyalty.length > 0) {
    console.log("");
    console.log("  版税支付记录：");
    evRoyalty.forEach((e) => {
      console.log(
        `    tokenId ${String(e.args[1]).padEnd(4)} 付给 ${short(e.args[2])} ${eth(e.args[3])} ETH`
      );
    });
  }

  /* ---------------- 5. 交叉验证：遍历 tokenId 直接 getListing ---------------- */
  section(5, "交叉验证（路线 A：逐个 getListing，与事件重放对照）");
  const nextId = await nft.nextTokenId();
  const total = Number(nextId);
  console.log(`  NFT 累计铸造 ${total} 枚（tokenId 0 .. ${total - 1}），逐枚查询链上状态：`);
  console.log("");
  console.log(
    "  " +
      padDisp("tokenId", 10) +
      padDisp("持有者", 16) +
      padDisp("在售", 8) +
      padDisp("价格(ETH)", 14) +
      "事件重放是否一致"
  );

  let activeOnChain = 0;
  let mismatch = 0;
  for (let id = 0; id < total; id++) {
    let owner = "-";
    try {
      owner = await nft.ownerOf(id);
    } catch (_) {
      owner = "(已销毁)";
    }
    const [seller, price, active] = await market.getListing(nftInfo.address, id);
    const k = keyOf(nftInfo.address, id);
    const replayed = listings.get(k);

    const chainActive = active && BigInt(price) > 0n;
    if (chainActive) activeOnChain++;

    // 一致性判定：两边对「是否在售」「价格」「卖家」的结论必须完全相同
    let ok = true;
    if (chainActive !== !!replayed) ok = false;
    if (chainActive && replayed) {
      if (BigInt(price) !== BigInt(replayed.price)) ok = false;
      if (String(seller).toLowerCase() !== String(replayed.seller).toLowerCase()) ok = false;
    }
    if (!ok) mismatch++;

    console.log(
      "  " +
        padDisp(String(id), 10) +
        padDisp(short(owner), 16) +
        padDisp(chainActive ? "是" : "否", 8) +
        padDisp(chainActive ? eth(price) : "-", 14) +
        (ok ? "一致" : "!! 不一致")
    );
  }

  console.log("");
  console.log(`  链上 active 挂单 ${activeOnChain} 条 | 事件重放得 ${listings.size} 条`);
  console.log(
    mismatch === 0 && activeOnChain === listings.size
      ? "  [OK] 两条独立路径结论完全一致 —— 事件无遗漏，重放逻辑正确"
      : `  [!] 有 ${mismatch} 条对不上（或数量不等），需检查起始区块是否为部署区块`
  );

  /* ---------------- 6. 我的持仓 ---------------- */
  section(6, "当前账户在本市场的资产快照");
  const bal = await nft.balanceOf(me.address);
  console.log("  持有 NFT :", bal.toString(), "枚");
  const myPending = await market.pendingWithdrawals(me.address);
  const myRoyalty = await market.pendingRoyalties(me.address);
  console.log("  待领退回款 :", eth(myPending), "ETH");
  console.log("  待领版税   :", eth(myRoyalty), "ETH");
  const myNonce = await market.listingNonces(me.address);
  console.log("  挂单 nonce :", myNonce.toString(), "（链下签名挂单要用它）");

  console.log("");
  console.log("============================================================");
  console.log(" 三个值得记住的点");
  console.log("============================================================");
  console.log("  1. mapping 无法枚举 —— 想做「列表页」就必须靠事件，或自己维护索引。");
  console.log("  2. 重放事件时排序必须用 (blockNumber, logIndex)，同区块内的顺序会改变结果。");
  console.log("  3. 链下索引一定要和链上状态交叉验证，否则你不知道自己漏拉了日志。");
  console.log("  4. 一笔成交可能对应多条事件（本合约 acceptOffer 同时发 Sold 和");
  console.log("     OfferAccepted）。统计成交量前必须按交易哈希去重，否则全部虚高一倍。");
  console.log("============================================================");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.log("");
    console.log(line);
    console.log(" [X] 执行失败：", (err && (err.shortMessage || err.message)) || err);
    console.log(line);
    console.log(" 堆栈：", err && err.stack ? err.stack.split("\n").slice(0, 5).join("\n") : "(无)");
    console.log(" 提示：");
    console.error("  · 确认已部署合约（deployments/ 下有对应网络的 json）");
    console.error("  · 公共 RPC 对历史日志有跨度和时效限制，可从部署区块缩小扫描范围");
    process.exit(1);
  });
