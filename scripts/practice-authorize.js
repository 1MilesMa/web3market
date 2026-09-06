/**
 * ============================================================================
 * ERC721 授权体系练习脚本 —— 【请你自己在终端执行，本脚本未被运行过】
 * ============================================================================
 *
 * 运行方式（在项目根目录下）：
 *   npx hardhat run scripts/practice-authorize.js --network sepolia
 *   （想先在本地练手：npx hardhat run scripts/practice-authorize.js --network localhost）
 *
 * 这个脚本会带你亲手走完 ERC721 的整套授权流程：
 *   步骤 0  前置检查：读合约地址、给第二账户补 gas 费
 *   步骤 1  确保主账户手上有一枚 NFT
 *   步骤 2  approve 单枚授权
 *   步骤 3  被授权方代转（由第二账户发起 transferFrom）
 *   步骤 4  验证转移后授权被自动清空
 *   步骤 5  反向转回（safeTransferFrom）
 *   步骤 6  setApprovalForAll 全量授权
 *   步骤 7  全量授权下直接代转新铸的 NFT（无需再单独 approve）
 *   步骤 8  撤销全量授权
 *   步骤 9  验证未授权必失败（捕获 ERC721InsufficientApproval）
 *
 * ---------------------------------------------------------------------------
 * 【核心知识：approve 与 setApprovalForAll 的区别与风险】
 * ---------------------------------------------------------------------------
 * 1) approve(operator, tokenId)
 *    - 作用范围：**一枚** NFT（精确到 tokenId）
 *    - 授予的能力：对方可以转走**这一枚**，且只能转一次
 *    - 生命周期：**该 NFT 一旦被转移，授权自动清空**（见步骤 4）
 *    - 典型场景：挂单出售某一枚、把某一枚抵押给某个合约
 *
 * 2) setApprovalForAll(operator, true)
 *    - 作用范围：**你这个地址持有的全部 NFT**，包括将来才铸造/转入的
 *    - 授予的能力：对方可以转走你**任何一枚**，而且是**无限次**
 *    - 生命周期：**不会**因为 NFT 转移而失效，必须你主动调用
 *      setApprovalForAll(operator, false) 撤销（见步骤 8）
 *    - 典型场景：授权给 NFT 市场合约（OpenSea/Blur 这类）以便成交时自动划转
 *
 * 3) 【为什么全量授权是钓鱼盗币的主要手法】
 *    钓鱼网站最常见的套路就是：页面弹一个「授权」或「签名」请求，看起来像登录，
 *    实际是引诱你对攻击者的合约调用 setApprovalForAll(攻击者地址, true)。
 *    一旦你签了：
 *      - 攻击者**不需要你的私钥**，就能随时把你钱包里该系列的全部 NFT 转走；
 *      - 授权**不会自动过期**，你以为事情过去了，其实权限一直开着；
 *      - 你后来新买的、新铸造的 NFT 也一并暴露（因为是「全部」，不是「当前这几枚」）。
 *    防御习惯：
 *      - 看到「授权」「Approve」「Set Approval For All」先停三秒，确认对方是谁；
 *      - 只在**真正要交易时**给**可信市场合约**开全量授权，交易完立刻撤销；
 *      - 定期用授权检查工具（如 Revoke.cash）清理历史授权；
 *      - 能用 approve 单枚授权解决的，就不要开全量。
 *
 * 4) 【transferFrom 与 safeTransferFrom 的区别】
 *    - 结果对普通钱包地址（EOA）完全一样，都会转移归属；
 *    - 差别只在接收方是**合约**时：safeTransferFrom 会在转移完成后回调接收合约的
 *      onERC721Received，要求它返回一个固定的魔数 0x150b7a02，
 *      如果对方不认识 NFT（没实现这个接口），整笔交易**直接回滚**；
 *    - 目的：防止 NFT 被打进一个无法操作它的合约而永久锁死。
 *      所以**向合约地址转 NFT 时，永远用 safe 版本**；向普通地址转两者皆可。
 *    - 本脚本步骤 5 故意用 safeTransferFrom，让你亲手感受它的存在。
 *
 * 5) 【为什么本脚本要由第二账户主动发起交易】
 *    区块链的规则是「谁发起交易，谁付 gas」。步骤 3、5、7 都是第二账户在操作，
 *    所以第二账户必须有 ETH —— 步骤 0 的转账就是为它准备 gas 费。
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

/* ============================ 可调参数 ============================ */
// 第二账户 gas 费阈值：低于这个值就从主账户转 GAS_TOPUP 过去
const MIN_BALANCE = hre.ethers.parseEther("0.005");
const GAS_TOPUP = hre.ethers.parseEther("0.01");

// 铸造时用的 metadata 链接（练习用，指向一份公开示例 JSON）
const DEMO_URI =
  process.env.MINT_URI ||
  "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/1.json";

const ZERO_ADDRESS = hre.ethers.ZeroAddress;

/* ============================ 小工具 ============================ */
const line = "-" .repeat(60);

function section(n, title) {
  console.log("");
  console.log(line);
  console.log(`[步骤 ${n}] ${title}`);
  console.log(line);
}

function ok(msg) {
  console.log("  [OK] " + msg);
}
function info(label, value) {
  console.log(`  ${label}: ${value}`);
}

/** 断言：条件为假就抛出带说明的错误，被外层 catch 捕获后退出（不静默跳过） */
function assert(cond, msg) {
  if (!cond) throw new Error("校验失败 → " + msg);
}

/** 读取部署产物里的合约地址（允许用环境变量 NFT_ADDRESS 覆盖） */
function readDeployment(networkName) {
  if (process.env.NFT_ADDRESS) return process.env.NFT_ADDRESS;
  const file = path.join(__dirname, "..", "deployments", `mynft-${networkName}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `找不到部署产物 ${path.relative(process.cwd(), file)}。\n` +
        "    请先部署合约，或设置环境变量 NFT_ADDRESS=0x..."
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")).address;
}

/**
 * 解码链上 revert：OpenZeppelin v5 用的是自定义错误（custom error），
 * 公共 RPC 往往只回一句 execution reverted，看不到具体原因。
 * 这里从异常对象的各个可能位置取出 data，用合约 ABI 反解成可读的错误名与参数。
 */
function decodeRevert(err, iface) {
  const candidates = [
    err && err.data,
    err && err.info && err.info.error && err.info.error.data,
    err && err.error && err.error.data,
    err && err.error && err.error.error && err.error.error.data,
  ].filter(Boolean);

  for (const data of candidates) {
    if (typeof data === "string" && data.startsWith("0x")) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) {
          return {
            name: parsed.name,
            args: parsed.args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))),
          };
        }
      } catch (_) {
        /* 这个 data 解不出来，换下一个候选 */
      }
    }
  }
  // 兼容老版本用 require 字符串的情况
  const msg = String((err && err.message) || err);
  const m = msg.match(/reason="([^"]+)"/) || msg.match(/reverted with reason string '([^']+)'/);
  if (m) return { name: m[1], args: [] };
  return null;
}

/** 发交易 → 等确认 → 打印结果，并累计 gas */
let gasTotal = 0n;
async function sendTx(label, txPromise) {
  console.log("  交易已发送，等待区块确认...");
  const tx = await txPromise;
  info("交易哈希", tx.hash);
  const receipt = await tx.wait();
  gasTotal += receipt.gasUsed;
  info("已确认", `区块 ${receipt.blockNumber} | gas ${receipt.gasUsed.toString()}`);
  return receipt;
}

/* ============================ 主流程 ============================ */
async function main() {
  const networkName = hre.network.name;
  const { chainId } = await hre.ethers.provider.getNetwork();
  const signers = await hre.ethers.getSigners();

  if (signers.length < 2) {
    throw new Error(
      "只找到 1 个账户。练习授权需要两个账户，请在 .env 里配置 PRIVATE_KEY 与 PRIVATE_KEY_2。\n" +
        "    （两个账户都需要在 Sepolia 上有一点测试币）"
    );
  }
  const owner = signers[0]; // 主账户：合约 owner，NFT 的主要持有者
  const buddy = signers[1]; // 第二账户：被授权方，练习「代转」

  const address = readDeployment(networkName);
  const nft = await hre.ethers.getContractAt("MyNFT", address);

  console.log("============================================================");
  console.log(" ERC721 授权体系练习（approve / setApprovalForAll）");
  console.log("============================================================");
  info("网络", `${networkName} (chainId: ${chainId.toString()})`);
  info("合约地址", address);
  info("主账户(owner)", owner.address);
  info("第二账户", buddy.address);

  /* ---------------- 步骤 0：前置检查 + 给第二账户补 gas ---------------- */
  section(0, "前置检查：合约地址与第二账户 gas 费");

  // 0.1 确认合约是活的，且主账户确实是 owner（否则后面铸造会被拒）
  const name = await nft.name();
  const symbol = await nft.symbol();
  const contractOwner = await nft.owner();
  info("name()", name);
  info("symbol()", symbol);
  info("合约 owner", contractOwner);
  assert(
    contractOwner.toLowerCase() === owner.address.toLowerCase(),
    `当前主账户 ${owner.address} 不是合约 owner（${contractOwner}），无法铸造 NFT。\n` +
      "    请检查 .env 里的 PRIVATE_KEY 是否为部署时用的那个。"
  );
  ok("合约可读，且主账户是 owner");

  // 0.2 检查第二账户余额，不够就从主账户转 0.01 ETH 过去
  //     原因：后面步骤 3/5/7 都由第二账户发起交易，得由它付 gas
  let buddyBal = await hre.ethers.provider.getBalance(buddy.address);
  info("第二账户余额", `${hre.ethers.formatEther(buddyBal)} ETH`);
  if (buddyBal < MIN_BALANCE) {
    console.log(`  余额低于 ${hre.ethers.formatEther(MIN_BALANCE)} ETH，从主账户转 ${hre.ethers.formatEther(GAS_TOPUP)} ETH 给它当 gas 费`);
    await sendTx(
      "转账 gas 费",
      owner.sendTransaction({ to: buddy.address, value: GAS_TOPUP })
    );
    buddyBal = await hre.ethers.provider.getBalance(buddy.address);
    info("转账后余额", `${hre.ethers.formatEther(buddyBal)} ETH`);
    assert(buddyBal >= MIN_BALANCE, "给第二账户充值后余额仍然不足，请检查主账户余额是否够。");
    ok("第二账户 gas 费已就绪");
  } else {
    ok("第二账户余额充足，无需充值");
  }

  /* ---------------- 步骤 1：确保主账户手上有一枚 NFT ---------------- */
  section(1, "确保主账户手上有一枚 NFT");
  let ownerBal = await nft.balanceOf(owner.address);
  info("主账户持有数量", ownerBal.toString());
  if (ownerBal === 0n) {
    console.log("  主账户当前没有 NFT，先铸造一枚（safeMint）");
    await sendTx("safeMint", nft.safeMint(owner.address, DEMO_URI));
    ownerBal = await nft.balanceOf(owner.address);
    assert(ownerBal >= 1n, "铸造后主账户持有数量仍为 0，请检查交易是否真的被确认。");
    ok("已铸造，主账户现在有 NFT");
  } else {
    ok("主账户已有 NFT，直接复用");
  }

  // 取主账户持有的第一枚：ERC721Enumerable 提供的 tokenOfOwnerByIndex(地址, 序号)
  const tokenIdA = await nft.tokenOfOwnerByIndex(owner.address, 0);
  info("本次使用的 tokenId", tokenIdA.toString());
  info("当前 ownerOf", await nft.ownerOf(tokenIdA));

  /* ---------------- 步骤 2：approve 单枚授权 ---------------- */
  section(2, "approve 单枚授权：把这一枚的操作权交给第二账户");
  console.log("  原理：approve 只授权【这一个 tokenId】，且只能被用一次。");
  await sendTx("approve", nft.approve(buddy.address, tokenIdA));

  const approved1 = await nft.getApproved(tokenIdA);
  info("getApproved(tokenId)", approved1);
  assert(
    approved1.toLowerCase() === buddy.address.toLowerCase(),
    `授权未生效：期望 ${buddy.address}，实际 ${approved1}`
  );
  ok("单枚授权生效：第二账户现在可以转走这一枚");

  /* ---------------- 步骤 3：被授权方代转 ---------------- */
  section(3, "被授权方代转：由第二账户发起 transferFrom");
  console.log("  原理：发起人是第二账户，但它转的不是自己的 NFT，而是凭授权代持转。");
  console.log("  注意：gas 由第二账户支付 —— 这就是为什么步骤 0 要先给它充钱。");

  const supplyBefore = await nft.totalSupply();
  const ownerBalBefore = await nft.balanceOf(owner.address);
  const buddyBalNftBefore = await nft.balanceOf(buddy.address);

  // 用 buddy 身份连接合约，再调 transferFrom(原来的主人, 新主人, tokenId)
  await sendTx(
    "transferFrom（第二账户发起）",
    nft.connect(buddy).transferFrom(owner.address, buddy.address, tokenIdA)
  );

  const newOwner = await nft.ownerOf(tokenIdA);
  const supplyAfter = await nft.totalSupply();
  const ownerBalAfter = await nft.balanceOf(owner.address);
  const buddyBalNftAfter = await nft.balanceOf(buddy.address);

  info("ownerOf(tokenId)", newOwner);
  info("主账户持有数", `${ownerBalBefore.toString()} -> ${ownerBalAfter.toString()}`);
  info("第二账户持有数", `${buddyBalNftBefore.toString()} -> ${buddyBalNftAfter.toString()}`);
  info("totalSupply", `${supplyBefore.toString()} -> ${supplyAfter.toString()}`);

  assert(newOwner.toLowerCase() === buddy.address.toLowerCase(), "归属未变更，transferFrom 可能没真正生效。");
  assert(ownerBalAfter === ownerBalBefore - 1n, "主账户持有数没有 -1");
  assert(buddyBalNftAfter === buddyBalNftBefore + 1n, "第二账户持有数没有 +1");
  assert(supplyAfter === supplyBefore, "totalSupply 不应变化（转账不是铸造/销毁，NFT 只是换了主人）");
  ok("代转成功：归属已变更，且 totalSupply 保持不变（转账不增不减总量）");

  /* ---------------- 步骤 4：授权已自动清空 ---------------- */
  section(4, "验证：NFT 转移后，单枚授权会被自动清空");
  const approved2 = await nft.getApproved(tokenIdA);
  info("转移后 getApproved(tokenId)", approved2);
  assert(
    approved2 === ZERO_ADDRESS,
    `授权应被自动清空（零地址），实际为 ${approved2}`
  );
  ok("授权已自动重置为零地址 —— 这是 ERC721 标准规定的行为");
  console.log("  提醒：这条规则只对 approve（单枚）有效，");
  console.log("        setApprovalForAll（全量）不会因为 NFT 被转走而失效！");

  /* ---------------- 步骤 5：反向转回（safeTransferFrom） ---------------- */
  section(5, "反向转回：第二账户用 safeTransferFrom 把 NFT 还给主账户");
  console.log("  原理：safeTransferFrom 比 transferFrom 多一步 —— 如果接收方是合约，");
  console.log("        会回调它的 onERC721Received 并要求返回固定魔数，否则整笔回滚，");
  console.log("        防止 NFT 被转进不认识它的合约里锁死。转给普通地址时两者等价。");

  // 说明：safeTransferFrom 有重载（带/不带 data 参数），用完整签名字符串消除歧义
  await sendTx(
    "safeTransferFrom（第二账户发起）",
    nft
      .connect(buddy)
      ["safeTransferFrom(address,address,uint256)"](buddy.address, owner.address, tokenIdA)
  );

  const backOwner = await nft.ownerOf(tokenIdA);
  info("ownerOf(tokenId)", backOwner);
  assert(backOwner.toLowerCase() === owner.address.toLowerCase(), "NFT 没有回到主账户手上。");
  ok("NFT 已回到主账户，safeTransferFrom 与 transferFrom 结果一致（接收方是普通地址）");

  /* ---------------- 步骤 6：setApprovalForAll 全量授权 ---------------- */
  section(6, "setApprovalForAll 全量授权：把【全部 NFT】的操作权交给第二账户");
  console.log("  ⚠ 这一步就是你签钓鱼链接时，攻击者真正想让你做的事。");
  console.log("  它授权的不是「当前这几枚」，而是「你这个地址所有、以及将来所有的 NFT」。");

  await sendTx(
    "setApprovalForAll(true)",
    nft.setApprovalForAll(buddy.address, true)
  );

  const isAll1 = await nft.isApprovedForAll(owner.address, buddy.address);
  info("isApprovedForAll(主账户 -> 第二账户)", isAll1);
  assert(isAll1 === true, "全量授权未生效");
  ok("全量授权已开启：第二账户现在可以转走主账户的任意一枚 NFT");

  /* ---------------- 步骤 7：全量授权下直接代转新 NFT ---------------- */
  section(7, "再铸一枚，第二账户无需单独 approve 就能直接转走");
  console.log("  重点：这枚 NFT 是【授权之后才铸造的】，且从未对第二账户做过 approve，");
  console.log("        但因为全量授权覆盖了「将来获得的 NFT」，它照样能被转走。");

  const nextIdBefore = await nft.nextTokenId();
  await sendTx("safeMint 第二枚", nft.safeMint(owner.address, DEMO_URI));
  const tokenIdB = nextIdBefore; // 自增铸造：铸造前 nextTokenId 就是即将分配的那个 ID
  info("新铸造的 tokenId", tokenIdB.toString());
  info("该 NFT 的 getApproved", await nft.getApproved(tokenIdB));
  info("（注意：它是零地址 —— 从未单独授权过）", "");

  const supplyBeforeB = await nft.totalSupply();
  await sendTx(
    "transferFrom 新 NFT（第二账户发起，凭全量授权）",
    nft.connect(buddy).transferFrom(owner.address, buddy.address, tokenIdB)
  );

  const ownerOfB = await nft.ownerOf(tokenIdB);
  const supplyAfterB = await nft.totalSupply();
  info("ownerOf(新 tokenId)", ownerOfB);
  info("totalSupply", `${supplyBeforeB.toString()} -> ${supplyAfterB.toString()}`);
  assert(ownerOfB.toLowerCase() === buddy.address.toLowerCase(), "全量授权下代转失败，NFT 仍在主账户手上。");
  assert(supplyAfterB === supplyBeforeB, "totalSupply 不应变化");
  ok("全量授权生效：从未单独 approve 过的新 NFT，也被第二账户转走了");

  /* ---------------- 步骤 8：撤销全量授权 ---------------- */
  section(8, "撤销全量授权");
  console.log("  这是唯一能关掉这扇门的方式：setApprovalForAll(operator, false)。");
  console.log("  现实中很多人开了全量授权就再也不管，权限会一直挂着。");

  await sendTx(
    "setApprovalForAll(false)",
    nft.setApprovalForAll(buddy.address, false)
  );

  const isAll2 = await nft.isApprovedForAll(owner.address, buddy.address);
  info("isApprovedForAll(主账户 -> 第二账户)", isAll2);
  assert(isAll2 === false, "授权未撤销，isApprovedForAll 仍为 true");
  ok("全量授权已撤销");

  /* ---------------- 步骤 9：未授权必失败 ---------------- */
  section(9, "验证：撤销后再代转，必须被链上拒绝");
  // 挑一枚主账户当前持有的 NFT 来试
  let ownerBalNow = await nft.balanceOf(owner.address);
  if (ownerBalNow === 0n) {
    console.log("  主账户当前没有 NFT，先铸一枚再测试");
    await sendTx("safeMint", nft.safeMint(owner.address, DEMO_URI));
    ownerBalNow = await nft.balanceOf(owner.address);
  }
  const tokenIdC = await nft.tokenOfOwnerByIndex(owner.address, 0);
  const ownerBeforeC = await nft.ownerOf(tokenIdC);
  info("尝试转走的 tokenId", tokenIdC.toString());
  info("当前持有者", ownerBeforeC);

  let rejected = false;
  try {
    // 期望这一行失败：ethers 在发送前会做 gas 估算，估算阶段就会 revert，
    // 因此这笔交易根本没机会上链
    await nft.connect(buddy).transferFrom(owner.address, buddy.address, tokenIdC);
    // 如果居然没抛错，说明权限没关干净，这是严重问题
    rejected = false;
  } catch (err) {
    rejected = true;
    const decoded = decodeRevert(err, nft.interface);
    const rawMsg = String((err && err.shortMessage) || err.message || err).split("\n")[0];
    console.log("  已捕获链上拒绝：");
    info("原始信息", rawMsg);
    if (decoded) {
      info("错误名", decoded.name);
      info("错误参数", decoded.args.length ? decoded.args.join(", ") : "(无)");
    } else {
      console.log("  （未能从 RPC 返回中解出错误名 —— 公共节点常常只回 execution reverted）");
    }

    // 断言错误类型：OZ v5 用自定义错误 ERC721InsufficientApproval，
    // 老版本或某些实现会回退成 require 字符串
    const text = (decoded ? decoded.name + " " + decoded.args.join(" ") : "") + " " + rawMsg;
    const matched =
      text.includes("ERC721InsufficientApproval") ||
      text.toLowerCase().includes("caller is not token owner or approved") ||
      text.includes("ERC721: caller is not token owner");
    assert(
      matched,
      `拒绝原因不是预期的「未授权」错误。实际内容：${text.slice(0, 300)}`
    );
    ok("拒绝原因确认为「未授权/未被批准」");
  }

  assert(rejected, "撤销授权后居然还能代转成功 —— 这是严重的安全问题，请立刻检查合约与授权状态！");

  // 确认归属没变、且交易没上链
  const ownerAfterC = await nft.ownerOf(tokenIdC);
  info("尝试代转后的持有者", ownerAfterC);
  assert(
    ownerAfterC.toLowerCase() === ownerBeforeC.toLowerCase(),
    `归属发生了变化：${ownerBeforeC} -> ${ownerAfterC}，说明那笔代转实际上链了！`
  );
  ok("NFT 归属未变化：失败的交易不会改变链上状态（要么全成功，要么全回滚）");

  /* ---------------- 总结 ---------------- */
  console.log("");
  console.log("============================================================");
  console.log(" 授权体系练习全部完成");
  console.log("============================================================");
  info("网络", networkName);
  info("合约地址", address);
  info("本次累计 gas", gasTotal.toString());
  console.log("");
  console.log("  本次亲手验证过的 6 个结论：");
  console.log("   1. approve 只授权【一枚】，且该 NFT 被转走后授权自动清空");
  console.log("   2. 被授权方可以代持转账，gas 由发起方（被授权方）支付");
  console.log("   3. 转账不增不减 totalSupply，只是换主人");
  console.log("   4. setApprovalForAll 授权【全部 + 将来】的 NFT，不会因转移而失效");
  console.log("   5. 必须主动 setApprovalForAll(operator, false) 才能撤销");
  console.log("   6. 撤销后再代转会被链上拒绝（ERC721InsufficientApproval），");
  console.log("      且失败的交易完全不改变链上状态");
  console.log("");
  console.log("  ⚠ 关键安全提醒（背下来）：");
  console.log("   · 全量授权 = 把钱包里该系列 NFT 的钥匙交给对方，且不过期；");
  console.log("     钓鱼网站最爱骗的就是这个签名，它不需要你的私钥。");
  console.log("   · 任何「免费领取」「验证身份」「领取空投」页面弹授权请求，先停三秒。");
  console.log("   · 只在真实交易时给可信市场开全量授权，用完立刻撤销。");
  console.log("   · 能单枚 approve 就别开全量；定期清理历史授权。");
  console.log("   · 向【合约地址】转 NFT 必须用 safeTransferFrom（防止锁死）。");
  console.log("============================================================");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("");
    console.error(line);
    console.error(" [X] 练习中断：", err.shortMessage || err.message || err);
    console.error(line);
    console.error(" 提示：中断通常意味着某一步没达到预期，脚本不会静默跳过。");
    console.error("       请根据上面的错误说明处理后再重跑本脚本。");
    process.exit(1);
  });
