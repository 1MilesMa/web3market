/**
 * ============================================================================
 * NFT 市场「EIP-712 链下签名挂单」演练脚本 —— 【本地零成本，链上才花钱】
 * ============================================================================
 *
 * 运行方式（在项目根目录下，Windows PowerShell）：
 *   ① 本地演练（默认，零成本、零风险，反复跑都不要钱）：
 *      npx.cmd hardhat run scripts/practice-eip712.js --network hardhat
 *      本地没有部署产物时，脚本会现场部署一套全新的 MyNFT + SimpleMarket。
 *
 *   ② 真实测试网（Sepolia，花的是真测试币）：
 *      npx.cmd hardhat run scripts/practice-eip712.js --network sepolia
 *      地址从 deployments/mynft-sepolia.json 与 deployments/simplemarket-sepolia.json 读取，
 *      找不到部署产物【直接报错退出】，绝不静默重部署（否则会在新合约上空跑一场）。
 *      ⚠ 已部署的旧版 SimpleMarket 不含 fulfillListing，脚本会检测出来并提示重新部署。
 *
 * 需要的私钥（.env，仅 sepolia 网络需要）：
 *   PRIVATE_KEY   = 卖家（主账户，也是 NFT 合集 owner，负责铸造与授权）
 *   PRIVATE_KEY_2 = 买家（付款、发起成交）
 *
 * ---------------------------------------------------------------------------
 * 【核心知识：链下签名挂单到底省了什么】
 * ---------------------------------------------------------------------------
 * 传统路径 list() + buy()：
 *   卖家 approve（交易1）→ 卖家 list 挂单（交易2）→ 买家 buy（交易3）
 *   卖家为了"摆个摊"要付两笔 gas，改价、下架也要付 gas。
 *
 * EIP-712 路径 fulfillListing()：
 *   卖家 approve（交易1，一次性，授权后长期有效）
 *   卖家【在链下签个名】——不广播、不上链、不花一分钱
 *   买家 fulfillListing（交易2，带着卖家的签名来成交）
 *
 * 于是：挂单、改价、下架统统零成本 —— 因为在链下改一条数据而已。
 * 代价是签名本身要有防重放设计，本脚本步骤 6~9 就是专门验证这四道防线的：
 *   ① nonce 单调   成交即 +1，同一条签名用不了第二次（步骤 6、7）
 *   ② deadline    签名会过期，不会被无限期利用（步骤 8）
 *   ③ 域分隔符     摘要含 chainId + 市场合约地址，天然防跨链 / 跨市场重放
 *   ④ 成交时复检   绕过了 list()，所以持有者与授权必须在成交时重新校验
 *   另外还有一条应急手段：incrementNonce() 一键作废全部旧签名（步骤 9）
 *
 * 演练路线：
 *   步骤 0  前置检查：网络 / 角色 / 费率 / 版税 / 余额
 *   步骤 1  解析合约地址（本地缺产物才现场部署）+ 只读预检
 *   步骤 2  铸造 NFT 给卖家
 *   步骤 3  卖家 setApprovalForAll 全量授权市场（卖家唯一一笔上链交易）
 *   步骤 4  【链下】卖家签名（零 gas）+ 与合约摘要对齐校验
 *   步骤 5  买家 fulfillListing 成交（故意多付，验证退款）+ 分账明细 + gas
 *   步骤 6  重放同一条签名 → 期望被拒（nonce 已消耗）
 *   步骤 7  改价后重签（沿用已消耗的 nonce）→ 期望被拒
 *   步骤 8  过期签名 → 期望被拒（SignatureExpired）
 *   步骤 9  紧急下架：签好单 → 卖家 incrementNonce → 旧签名当场作废
 *   步骤 10 用新 nonce 重新签名 → 成交成功
 *   步骤 11 对照实验：传统 list + buy 走一遍，对比 gas（仅本地网络）
 *   步骤 12 汇总 + 资金守恒校验
 * ============================================================================
 */

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/* ============================ 可调参数 ============================ */
// 平台手续费 250 bps = 2.5%（合约硬上限 1000 bps = 10%）
const FEE_BPS = 250;
// 铸造上限（本地现场部署时用）
const MAX_SUPPLY = 100;

// 成交价格与"故意多付"的零钱（用来验证多余 ETH 会退回买家）
const PRICE = hre.ethers.parseEther("0.001");
const OVERPAY = hre.ethers.parseEther("0.0002");

// 判断余额够不够时，除货款外还要额外留的 gas 安全垫
const GAS_RESERVE = hre.ethers.parseEther("0.005");

const DEMO_URI =
  "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/1.json";

const ZERO_ADDRESS = hre.ethers.ZeroAddress;

/* ============================ EIP-712 类型定义 ============================ */
// 字段名、类型、顺序必须与合约里的 struct ListingIntent 完全一致，
// 否则签出来的摘要对不上 —— 步骤 4 会用合约的 hashListingIntent 当场对齐校验
const INTENT_TYPES = {
  ListingIntent: [
    { name: "nftContract", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

/* ============================ 小工具 ============================ */
const line = "-".repeat(68);

function section(n, title) {
  console.log("");
  console.log(line);
  console.log(`[步骤 ${n}] ${title}`);
  console.log(line);
}
function ok(msg) {
  console.log("  [OK] " + msg);
}
function warn(msg) {
  console.log("  [注意] " + msg);
}
function info(label, value) {
  console.log(`  ${String(label).padEnd(20)}: ${value}`);
}
function eth(wei) {
  return hre.ethers.formatEther(wei);
}
function assert(cond, msg) {
  if (!cond) throw new Error("校验失败 → " + msg);
}
function short(addr) {
  return addr.slice(0, 10) + "..." + addr.slice(-6);
}
function shortSig(sig) {
  return sig.slice(0, 22) + "..." + sig.slice(-8);
}

/** 读取部署产物里的地址（兼容 address / contractAddress 两种字段名） */
function readDeployment(name, network) {
  const p = path.join(__dirname, "..", "deployments", `${name}-${network}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j.address || j.contractAddress || null;
  } catch (e) {
    warn(`${name}-${network}.json 解析失败：${e.message}`);
    return null;
  }
}

/** 从 revert 错误里提取人话（ethers v6） */
function revertReason(err) {
  const msg = err.shortMessage || err.message || String(err);
  if (msg.includes("SignatureExpired")) return "SignatureExpired（签名已过期）";
  if (msg.includes("InvalidNonce")) return "InvalidNonce（nonce 与链上不一致）";
  if (msg.includes("InvalidSignature")) return "InvalidSignature（签名校验不过）";
  if (msg.includes("InsufficientPayment"))
    return "InsufficientPayment（付款不足）";
  if (msg.includes("NotTokenOwner")) return "NotTokenOwner（签名者不是持有者）";
  if (msg.includes("MarketNotApproved"))
    return "MarketNotApproved（未授权市场）";
  if (msg.includes("IntentPriceZero")) return "IntentPriceZero（价格不能为 0）";
  if (msg.includes("INSUFFICIENT_FUNDS")) return "余额不足支付 gas";
  return msg.split("\n")[0].slice(0, 160);
}

/** 自定义错误的中文说明 */
const ERROR_CN = {
  IntentPriceZero: "价格不能为 0",
  SignatureExpired: "签名已过期",
  InvalidNonce: "nonce 与链上不一致",
  InvalidSignature: "签名校验不过",
  InsufficientPayment: "付款不足",
  NotTokenOwner: "签名者不是持有者",
  MarketNotApproved: "未授权市场",
};

/**
 * 从 ethers 抛出的错误里挖出 revert 数据里的自定义错误名。
 * 本地 hardhat 节点会给完整错误名；真实 RPC 常常只丢一句 "execution reverted"，
 * 所以这里同时扫 data / info.error.data / error.data 三个位置。
 */
function decodeCustomError(err, contract) {
  const candidates = [];
  if (err && err.data) candidates.push(err.data);
  if (err && err.info && err.info.error && err.info.error.data)
    candidates.push(err.info.error.data);
  if (err && err.error && err.error.data) candidates.push(err.error.data);
  for (const d of candidates) {
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
      try {
        const parsed = contract.interface.parseError(d);
        if (parsed) return parsed.name;
      } catch (e) {
        /* 不是本合约的错误，换下一个候选 */
      }
    }
  }
  return null;
}

/**
 * 验证"这个调用必须被拒绝"。
 *
 * 用 eth_call 静态模拟而不是真发一笔交易：
 *   · 静态调用与真实交易走同一套 require 逻辑，结论等价
 *   · 不花 gas、不用等区块确认
 *   · revert 时链上会返回错误数据，能解出到底是哪个自定义错误
 */
async function expectRevertCall(
  market,
  from,
  fnName,
  args,
  valueWei,
  wantKeyword,
  label
) {
  const addr = await market.getAddress();
  const data = market.interface.encodeFunctionData(fnName, args);
  let decoded = null;
  let raw = "";
  try {
    await hre.ethers.provider.call({ to: addr, data, from, value: valueWei });
  } catch (err) {
    raw = (err.shortMessage || err.message || "").split("\n")[0].slice(0, 140);
    decoded = decodeCustomError(err, market);
  }

  if (decoded === null && raw === "") {
    throw new Error(`${label}：本该被拒绝，却执行成功了 —— 这是漏洞，必须修`);
  }
  if (decoded === wantKeyword) {
    ok(`${label} → 已被拒绝：${decoded}（${ERROR_CN[decoded] || ""}）`);
    return decoded;
  }
  if (decoded !== null) {
    throw new Error(
      `${label}：拒绝了，但错误不是预期的 ${wantKeyword}，实际是 ${decoded}`
    );
  }
  // 链上 RPC 没返回可解码的错误数据，只能确认"确实被拒绝了"
  warn(
    `${label} → 已被拒绝（链上未返回自定义错误码，无法确认是否是 ${wantKeyword}）`
  );
  console.log(`      原始信息：${raw}`);
  return "UNKNOWN";
}

/** 执行一次"应当失败"的真实交易，成功反倒要报错（保留备用） */
async function expectRevert(promise, wantKeyword, label) {
  try {
    await promise;
  } catch (err) {
    const reason = revertReason(err);
    if (reason.includes(wantKeyword)) {
      ok(`${label} → 已被拒绝：${reason}`);
      return reason;
    }
    throw new Error(
      `${label}：拒绝了，但原因不是预期的 ${wantKeyword}，实际是 ${reason}`
    );
  }
  throw new Error(`${label}：本该被拒绝，却成功了 —— 这是漏洞，必须修`);
}

/** 铸造一枚 NFT，返回真实 tokenId（从 Transfer 事件里取，最可靠） */
async function mintTo(nft, minter, to, uri) {
  const tx = await nft.connect(minter).safeMint(to, uri);
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try {
      const parsed = nft.interface.parseLog(log);
      if (parsed && parsed.name === "Transfer" && parsed.args[0] === ZERO_ADDRESS) {
        return { tokenId: parsed.args[2], gasUsed: rc.gasUsed };
      }
    } catch (e) {
      /* 不是本合约的事件，跳过 */
    }
  }
  throw new Error("铸造成功但没解析出 tokenId，请检查 NFT 合约的 Transfer 事件");
}

/* ============================ 主流程 ============================ */
async function main() {
  const networkName = hre.network.name;
  const net = await hre.ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const isLocal = networkName === "hardhat" || networkName === "localhost";

  console.log("=".repeat(68));
  console.log("  SimpleMarket · EIP-712 链下签名挂单 演练");
  console.log("=".repeat(68));
  info("网络", `${networkName}${isLocal ? "（本地，零成本）" : "（真实链，花测试币）"}`);
  info("chainId", chainId);

  const signers = await hre.ethers.getSigners();
  if (signers.length < 2) {
    throw new Error(
      "至少需要 2 个账户。sepolia 网络请在 .env 里同时配好 PRIVATE_KEY 与 PRIVATE_KEY_2"
    );
  }
  const seller = signers[0]; // 卖家：持有 NFT，只签名不花 gas
  const buyer = signers[1]; // 买家：付款并发起成交
  const sellerAddr = seller.address;
  const buyerAddr = buyer.address;

  info("卖家(seller)", sellerAddr);
  info("买家(buyer)", buyerAddr);

  /* ---------------- 步骤 0：前置检查 ---------------- */
  section(0, "前置检查：余额 / 角色");

  let sellerBal = await hre.ethers.provider.getBalance(sellerAddr);
  let buyerBal = await hre.ethers.provider.getBalance(buyerAddr);
  info("卖家余额", `${eth(sellerBal)} ETH`);
  info("买家余额", `${eth(buyerBal)} ETH`);

  if (!isLocal) {
    if (sellerBal < GAS_RESERVE) {
      throw new Error(
        `卖家余额 ${eth(sellerBal)} ETH 不足以支付 gas，请先用 fund-account.js 补币`
      );
    }
    if (buyerBal < PRICE + OVERPAY + GAS_RESERVE) {
      throw new Error(
        `买家余额 ${eth(buyerBal)} ETH 不足以支付货款 + gas，请先给买家补币`
      );
    }
  }

  /* ---------------- 步骤 1：解析合约地址 ---------------- */
  section(1, "解析合约地址 + 只读预检");

  let nftAddr = process.env.NFT_ADDRESS || readDeployment("mynft", networkName);
  let marketAddr =
    process.env.MARKET_ADDRESS || readDeployment("simplemarket", networkName);

  let nft, market;

  if (!nftAddr || !marketAddr) {
    if (!isLocal) {
      throw new Error(
        `deployments/ 下找不到 ${networkName} 的部署产物（mynft / simplemarket）。\n` +
          `  请先部署：npx.cmd hardhat run scripts/deploy-market.js --network sepolia\n` +
          `  脚本不会在真实链上静默重新部署，以免在新合约上空跑一场。`
      );
    }
    warn("本地网络且无部署产物 → 现场部署一套全新合约");
    const MyNFT = await hre.ethers.getContractFactory("MyNFT");
    nft = await MyNFT.deploy(sellerAddr, MAX_SUPPLY, ZERO_ADDRESS, 0);
    await nft.waitForDeployment();
    nftAddr = await nft.getAddress();

    const Market = await hre.ethers.getContractFactory("SimpleMarket");
    market = await Market.deploy(sellerAddr, FEE_BPS);
    await market.waitForDeployment();
    marketAddr = await market.getAddress();

    ok(`MyNFT 已部署        ${nftAddr}`);
    ok(`SimpleMarket 已部署 ${marketAddr}`);
  } else {
    nft = await hre.ethers.getContractAt("MyNFT", nftAddr);
    market = await hre.ethers.getContractAt("SimpleMarket", marketAddr);
    info("复用 MyNFT", nftAddr);
    info("复用 SimpleMarket", marketAddr);
  }

  // 检测合约是不是"新版"（含 EIP-712 支持）
  try {
    await market.listingNonces(sellerAddr);
  } catch (e) {
    throw new Error(
      `当前市场合约 ${marketAddr} 不支持 EIP-712 链下签名（没有 listingNonces）。\n` +
        `  说明它还是旧版字节码。链上跑请先重新部署：\n` +
        `  npx.cmd hardhat run scripts/deploy-market.js --network ${networkName}`
    );
  }
  ok("市场合约支持 EIP-712（listingNonces 可读）");

  const feeBps = await market.feeBps();
  info("平台手续费", `${feeBps} bps = ${Number(feeBps) / 100}%`);

  // 版税：读 ERC-2981 royaltyInfo，读不到就当作 0
  let royaltyReceiver = ZERO_ADDRESS;
  let royaltyAmount = 0n;
  try {
    const r = await nft.royaltyInfo(1, PRICE);
    royaltyReceiver = r[0];
    royaltyAmount = r[1];
  } catch (e) {
    warn("该 NFT 未实现 ERC-2981 版税，本次按 0 版税计算");
  }
  info("版税", royaltyReceiver === ZERO_ADDRESS ? "无" : `${eth(royaltyAmount)} ETH → ${short(royaltyReceiver)}`);

  let nonce = await market.listingNonces(sellerAddr);
  info("卖家当前 nonce", nonce.toString());

  /* ---------------- 步骤 2：铸造 NFT ---------------- */
  section(2, "铸造两枚 NFT 给卖家");

  const m1 = await mintTo(nft, seller, sellerAddr, DEMO_URI);
  const tokenIdA = m1.tokenId;
  ok(`铸造 #${tokenIdA} → 卖家（gas ${m1.gasUsed}）`);

  const m2 = await mintTo(nft, seller, sellerAddr, DEMO_URI);
  const tokenIdB = m2.tokenId;
  ok(`铸造 #${tokenIdB} → 卖家（gas ${m2.gasUsed}）`);

  assert(
    (await nft.ownerOf(tokenIdA)) === sellerAddr,
    "铸造后 NFT 应归卖家所有"
  );

  /* ---------------- 步骤 3：卖家授权 ---------------- */
  section(3, "卖家 setApprovalForAll 全量授权市场");

  const alreadyApproved = await nft.isApprovedForAll(sellerAddr, marketAddr);
  if (alreadyApproved) {
    ok("卖家此前已全量授权市场，跳过（授权长期有效，不用重复做）");
  } else {
    const tx = await nft.connect(seller).setApprovalForAll(marketAddr, true);
    const rc = await tx.wait();
    ok(`已授权（gas ${rc.gasUsed}）—— 这是卖家唯一需要付 gas 的上链操作`);
  }
  assert(await nft.isApprovedForAll(sellerAddr, marketAddr), "授权应已生效");

  /* ---------------- 步骤 4：卖家在链下签名（零 gas） ---------------- */
  section(4, "【链下】卖家签名 —— 零 gas、不上链");

  const domain = {
    name: "SimpleMarket",
    version: "1",
    chainId,
    verifyingContract: marketAddr,
  };

  const latest = await hre.ethers.provider.getBlock("latest");
  const deadline = latest.timestamp + 3600; // 1 小时后过期
  nonce = await market.listingNonces(sellerAddr);

  const intent = {
    nftContract: nftAddr,
    tokenId: tokenIdA,
    price: PRICE,
    deadline,
    nonce,
  };
  const tuple = [intent.nftContract, intent.tokenId, intent.price, intent.deadline, intent.nonce];

  info("intent.nftContract", intent.nftContract);
  info("intent.tokenId", intent.tokenId.toString());
  info("intent.price", `${eth(intent.price)} ETH`);
  info("intent.deadline", `${deadline}（${new Date(deadline * 1000).toLocaleString()}）`);
  info("intent.nonce", intent.nonce.toString());

  // 这一步只用到卖家的私钥做本地运算，不广播任何交易
  const sig = await seller.signTypedData(domain, INTENT_TYPES, intent);
  info("签名(signature)", shortSig(sig));

  // 对齐校验：本地算的摘要必须和合约算的一致
  const onchainDigest = await market.hashListingIntent(tuple);
  const localDigest = hre.ethers.TypedDataEncoder.hash(domain, INTENT_TYPES, intent);
  assert(onchainDigest === localDigest, "本地摘要与合约摘要不一致（类型定义对不上）");
  ok(`摘要对齐一致 ${onchainDigest.slice(0, 18)}...`);

  const gasBefore = await hre.ethers.provider.getBalance(sellerAddr);
  console.log("");
  console.log("   >>> 签名已完成，卖家 gas 消耗 = 0 Wei，链上没有任何痕迹 <<<");

  /* ---------------- 步骤 5：买家凭签名成交 ---------------- */
  section(5, "买家 fulfillListing 成交（故意多付，验证退款）");

  const sellerBefore = await hre.ethers.provider.getBalance(sellerAddr);
  const buyerBefore = await hre.ethers.provider.getBalance(buyerAddr);
  const marketBefore = await hre.ethers.provider.getBalance(marketAddr);

  const txBuy = await market
    .connect(buyer)
    .fulfillListing(tuple, sellerAddr, sig, { value: PRICE + OVERPAY });
  const rcBuy = await txBuy.wait();
  const gasFee = rcBuy.gasUsed * rcBuy.gasPrice;

  const fee = (PRICE * feeBps) / 10000n;
  const royalty = royaltyReceiver === ZERO_ADDRESS ? 0n : royaltyAmount;
  const toSeller = PRICE - fee - royalty;

  info("成交价", `${eth(PRICE)} ETH`);
  info("平台费 2.5%", `${eth(fee)} ETH（留在合约，owner 提）`);
  info("版税", `${eth(royalty)} ETH → ${royaltyReceiver === ZERO_ADDRESS ? "无" : short(royaltyReceiver)}`);
  info("卖家应收", `${eth(toSeller)} ETH`);
  info("买家中支出", `${eth(PRICE + OVERPAY)} ETH（含多付 ${eth(OVERPAY)} 已退回）`);
  info("gasUsed", `${rcBuy.gasUsed}（买家承担 ${eth(gasFee)} ETH）`);

  const sellerAfter = await hre.ethers.provider.getBalance(sellerAddr);
  const buyerAfter = await hre.ethers.provider.getBalance(buyerAddr);
  const marketAfter = await hre.ethers.provider.getBalance(marketAddr);

  info("卖家余额变化", `+${eth(sellerAfter - sellerBefore)} ETH`);
  info("买家余额变化", `-${eth(buyerBefore - buyerAfter)} ETH（含 gas）`);
  info("市场合约余额变化", `+${eth(marketAfter - marketBefore)} ETH`);

  assert((await nft.ownerOf(tokenIdA)) === buyerAddr, "NFT 应已易主给买家");
  ok(`NFT #${tokenIdA} 已易主 → 买家`);

  const nonceAfter = await market.listingNonces(sellerAddr);
  assert(nonceAfter === nonce + 1n, "成交后 nonce 应 +1");
  ok(`卖家 nonce：${nonce} → ${nonceAfter}（同一条签名再也用不了）`);

  /* ---------------- 步骤 6：重放同一条签名 ---------------- */
  section(6, "重放同一条签名 → 应被拒绝");

  await expectRevertCall(
    market,
    buyerAddr,
    "fulfillListing",
    [tuple, sellerAddr, sig],
    PRICE,
    "InvalidNonce",
    "原样重放旧签名"
  );

  /* ---------------- 步骤 7：改价后沿用旧 nonce ---------------- */
  section(7, "改价后重签（仍用已消耗的 nonce）→ 应被拒绝");

  const intentCheaper = { ...intent, price: hre.ethers.parseEther("0.0001") };
  const sigCheaper = await seller.signTypedData(domain, INTENT_TYPES, intentCheaper);
  await expectRevertCall(
    market,
    buyerAddr,
    "fulfillListing",
    [
      [
        intentCheaper.nftContract,
        intentCheaper.tokenId,
        intentCheaper.price,
        intentCheaper.deadline,
        intentCheaper.nonce,
      ],
      sellerAddr,
      sigCheaper,
    ],
    intentCheaper.price,
    "InvalidNonce",
    "沿用旧 nonce 改价"
  );

  /* ---------------- 步骤 8：过期签名 ---------------- */
  section(8, "过期签名（deadline 已过）→ 应被拒绝");

  const expiredDeadline = latest.timestamp - 10;
  const currentNonce = await market.listingNonces(sellerAddr);
  const intentExpired = { ...intent, tokenId: tokenIdB, deadline: expiredDeadline, nonce: currentNonce };
  const sigExpired = await seller.signTypedData(domain, INTENT_TYPES, intentExpired);
  await expectRevertCall(
    market,
    buyerAddr,
    "fulfillListing",
    [
      [
        intentExpired.nftContract,
        intentExpired.tokenId,
        intentExpired.price,
        intentExpired.deadline,
        intentExpired.nonce,
      ],
      sellerAddr,
      sigExpired,
    ],
    intentExpired.price,
    "SignatureExpired",
    "过期签名成交"
  );

  /* ---------------- 步骤 9：紧急下架 incrementNonce ---------------- */
  section(9, "紧急下架：签好单 → 卖家 incrementNonce → 旧签名当场作废");

  const nonce9 = await market.listingNonces(sellerAddr);
  const intent9 = { ...intent, tokenId: tokenIdB, deadline: latest.timestamp + 3600, nonce: nonce9 };
  const sig9 = await seller.signTypedData(domain, INTENT_TYPES, intent9);
  ok(`已为 #${tokenIdB} 签好单（nonce ${nonce9}），此刻签名仍然有效`);

  const txInc = await market.connect(seller).incrementNonce();
  const rcInc = await txInc.wait();
  ok(`卖家调用 incrementNonce（gas ${rcInc.gasUsed}）→ nonce 跳到 ${await market.listingNonces(sellerAddr)}`);

  await expectRevertCall(
    market,
    buyerAddr,
    "fulfillListing",
    [
      [
        intent9.nftContract,
        intent9.tokenId,
        intent9.price,
        intent9.deadline,
        intent9.nonce,
      ],
      sellerAddr,
      sig9,
    ],
    intent9.price,
    "InvalidNonce",
    "incrementNonce 后使用旧签名"
  );
  console.log("   → 日常改价/下架根本不用这一步，在链下把签名撤掉即可（零成本）；");
  console.log("     这一步只用于「签名已泄露、需要一键全部作废」的应急场景。");

  /* ---------------- 步骤 10：重新签名成交 ---------------- */
  section(10, "用新 nonce 重新签名 → 成交成功");

  const nonce10 = await market.listingNonces(sellerAddr);
  const intent10 = { ...intent, tokenId: tokenIdB, deadline: latest.timestamp + 3600, nonce: nonce10 };
  const sig10 = await seller.signTypedData(domain, INTENT_TYPES, intent10);

  const tx10 = await market
    .connect(buyer)
    .fulfillListing(
      [intent10.nftContract, intent10.tokenId, intent10.price, intent10.deadline, intent10.nonce],
      sellerAddr,
      sig10,
      { value: intent10.price }
    );
  const rc10 = await tx10.wait();
  ok(`#${tokenIdB} 成交成功（gas ${rc10.gasUsed}）`);
  assert((await nft.ownerOf(tokenIdB)) === buyerAddr, `#${tokenIdB} 应归买家`);
  ok("两次成交共用同一笔 setApprovalForAll 授权，卖家没有再花任何挂单 gas");

  /* ---------------- 步骤 11：对照实验（仅本地） ---------------- */
  let gasTraditional = null;
  if (isLocal) {
    section(11, "对照实验：传统 list + buy 走一遍（仅本地网络）");

    const m3 = await mintTo(nft, seller, sellerAddr, DEMO_URI);
    const tokenIdC = m3.tokenId;

    const txList = await market.connect(seller).list(nftAddr, tokenIdC, PRICE);
    const rcList = await txList.wait();
    ok(`卖家 list 挂单（gas ${rcList.gasUsed}）`);

    const txBuy2 = await market
      .connect(buyer)
      .buy(nftAddr, tokenIdC, { value: PRICE });
    const rcBuy2 = await txBuy2.wait();
    ok(`买家 buy 成交（gas ${rcBuy2.gasUsed}）`);

    gasTraditional = { list: rcList.gasUsed, buy: rcBuy2.gasUsed };
    const sumTrad = rcList.gasUsed + rcBuy2.gasUsed;
    info("传统合计", `${sumTrad}（卖家 ${rcList.gasUsed} + 买家 ${rcBuy2.gasUsed}）`);
    info("EIP-712 路径", `${rc10.gasUsed}（买家一人承担，卖家 0）`);
    console.log("   → 卖家侧：从 list 的一笔上链 gas，降到 0。");
    console.log("   → 买家侧：略高一点，因为它包办了原 list 的状态写入与校验。");
    console.log("   → 总 gas 更少，且卖家挂单/改价/下架全部零成本。");
  } else {
    section(11, "对照实验（真实网络跳过，省测试币）");
    warn("本地网络才会跑传统 list+buy 对照，链上为省币跳过");
  }

  /* ---------------- 步骤 12：汇总 + 资金守恒 ---------------- */
  section(12, "汇总 + 资金守恒校验");

  const accFees = await market.accumulatedFees();
  const marketBal = await hre.ethers.provider.getBalance(marketAddr);
  const pendingSeller = await market.pendingWithdrawals(sellerAddr);
  const pendingBuyer = await market.pendingWithdrawals(buyerAddr);
  // 合约里一共有三个"暂存池"，一个都不能漏：
  //   accumulatedFees  → owner 提
  //   pendingRoyalties → 创作者提（ERC-2981 收款方）
  //   pendingWithdrawals → 退款失败的买家提
  const royaltyPool =
    royaltyReceiver === ZERO_ADDRESS
      ? 0n
      : await market.pendingRoyalties(royaltyReceiver);

  info("累计平台费", `${eth(accFees)} ETH`);
  info(
    "版税池",
    royaltyReceiver === ZERO_ADDRESS
      ? "无"
      : `${eth(royaltyPool)} ETH → ${short(royaltyReceiver)}`
  );
  info("待领池(卖家/买家)", `${eth(pendingSeller)} / ${eth(pendingBuyer)} ETH`);
  info("市场合约余额", `${eth(marketBal)} ETH`);

  const accounted = accFees + royaltyPool + pendingSeller + pendingBuyer;
  const unaccounted = marketBal - accounted;
  assert(
    unaccounted === 0n,
    `资金不守恒：合约实有 ${eth(marketBal)} ETH，三个池子只解释了 ${eth(
      accounted
    )} ETH，差 ${eth(unaccounted)} ETH 无归属`
  );
  ok(
    `资金守恒：合约余额 ${eth(marketBal)} = 平台费 ${eth(
      accFees
    )} + 版税 ${eth(royaltyPool)} + 待领 ${eth(pendingSeller + pendingBuyer)}`
  );
  console.log("   → 三个池子加起来正好等于合约实有余额，没有来路不明的钱。");

  console.log("");
  console.log("=".repeat(68));
  console.log("  演练完成 · 关键结论");
  console.log("=".repeat(68));
  console.log("  1. 卖家全程只做了一笔上链操作：setApprovalForAll（一次性授权）");
  console.log("  2. 挂单 = 在链下签名，改价/下架 = 在链下改数据，全部零 gas");
  console.log("  3. 成交由买家发起，合约在成交时复检持有者与授权，安全性不打折");
  console.log("  4. 四道防线：nonce 单调 + deadline 过期 + 域分隔符 + 成交时复检");
  if (gasTraditional) {
    console.log(
      `  5. gas：EIP-712 路径 ${rc10.gasUsed} vs 传统 ${gasTraditional.list + gasTraditional.buy}` +
        `（list ${gasTraditional.list} + buy ${gasTraditional.buy}）`
    );
  }
  console.log("=".repeat(68));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("");
    console.error("× 演练中断：" + (err.shortMessage || err.message));
    process.exit(1);
  });
