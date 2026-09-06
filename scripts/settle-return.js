/**
 * ============================================================================
 * 练习收尾：把第二账户手上的 NFT 全部还给主账户，并核对最终状态
 * ============================================================================
 *
 * 运行方式（在项目根目录下）：
 *   npx hardhat run scripts/settle-return.js --network sepolia
 *
 * 背景：上一轮 practice-authorize.js 跑到结束时，第二账户手上还扣着一枚
 *       （步骤 7 凭全量授权转走的那枚，没有还回来），链上处于「未清账」状态。
 *       本脚本把状态收成一个干净闭环，方便你核对终态。
 *
 * 做的三件事：
 *   1. 循环把第二账户持有的每一枚 NFT 用 safeTransferFrom 还给主账户
 *      （不硬编码 tokenId —— 用 tokenOfOwnerByIndex 现查，跑几次都不会错）
 *   2. 核对最终归属：主账户持有数 == totalSupply，第二账户归零
 *   3. 核对授权状态：没有任何残留的单枚授权或全量授权
 *
 * 为什么这里用 safeTransferFrom 而不是 transferFrom：
 *   养成习惯。转给普通地址时两者效果一样，但 safe 版本在接收方是合约时
 *   会校验 onERC721Received，能防止 NFT 被锁死。真实项目里一律用 safe。
 * ============================================================================
 */

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const line = "-".repeat(60);
const ZERO_ADDRESS = hre.ethers.ZeroAddress;

function section(n, title) {
  console.log("");
  console.log(line);
  console.log(`[${n}] ${title}`);
  console.log(line);
}
function ok(msg) {
  console.log("  [OK] " + msg);
}
function info(label, value) {
  console.log(`  ${label}: ${value}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error("校验失败 → " + msg);
}

/** 读取部署产物里的合约地址（可用环境变量 NFT_ADDRESS 覆盖） */
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

async function main() {
  const networkName = hre.network.name;
  const { chainId } = await hre.ethers.provider.getNetwork();
  const signers = await hre.ethers.getSigners();
  if (signers.length < 2) {
    throw new Error("只找到 1 个账户，请在 .env 里配置 PRIVATE_KEY 与 PRIVATE_KEY_2。");
  }
  const owner = signers[0];
  const buddy = signers[1];

  const address = readDeployment(networkName);
  const nft = await hre.ethers.getContractAt("MyNFT", address);

  console.log("============================================================");
  console.log(" 练习收尾：归还 NFT 并核对最终状态");
  console.log("============================================================");
  info("网络", `${networkName} (chainId: ${chainId.toString()})`);
  info("合约地址", address);
  info("主账户", owner.address);
  info("第二账户", buddy.address);

  /* ---------- 1. 归还：把第二账户手上的 NFT 一枚一枚还回去 ---------- */
  section(1, "归还：第二账户 -> 主账户（safeTransferFrom）");

  const supply = await nft.totalSupply();
  let buddyBal = await nft.balanceOf(buddy.address);
  info("totalSupply", supply.toString());
  info("第二账户持有数量", buddyBal.toString());

  if (buddyBal === 0n) {
    console.log("  第二账户没有 NFT，无需归还（可能你已经手动还过了）");
  } else {
    // 每次都取「当前第 0 枚」：还掉一枚后列表会缩短，循环自然结束
    // 不能先算好 ID 列表再遍历 —— 转移会改变 tokenOfOwnerByIndex 的结果
    const returned = [];
    while ((await nft.balanceOf(buddy.address)) > 0n) {
      const tid = await nft.tokenOfOwnerByIndex(buddy.address, 0);
      const holder = await nft.ownerOf(tid);
      info("准备归还 tokenId", `${tid.toString()}（当前持有者 ${holder}）`);
      await sendTx(
        `safeTransferFrom tokenId ${tid}`,
        nft
          .connect(buddy)
          ["safeTransferFrom(address,address,uint256)"](buddy.address, owner.address, tid)
      );
      const after = await nft.ownerOf(tid);
      assert(
        after.toLowerCase() === owner.address.toLowerCase(),
        `tokenId ${tid} 归还后仍属于 ${after}`
      );
      returned.push(tid.toString());
    }
    ok(`已归还 ${returned.length} 枚：tokenId ${returned.join(", ")}`);
  }

  /* ---------- 2. 核对最终归属 ---------- */
  section(2, "核对最终归属");

  const ownerBal = await nft.balanceOf(owner.address);
  const buddyBalAfter = await nft.balanceOf(buddy.address);
  const supplyAfter = await nft.totalSupply();

  info("主账户持有数量", ownerBal.toString());
  info("第二账户持有数量", buddyBalAfter.toString());
  info("totalSupply", supplyAfter.toString());

  assert(buddyBalAfter === 0n, `第二账户仍有 ${buddyBalAfter} 枚 NFT，未清账`);
  assert(
    ownerBal === supplyAfter,
    `主账户持有数 ${ownerBal} 与 totalSupply ${supplyAfter} 不一致，说明还有 NFT 落在第三方地址上`
  );
  assert(supplyAfter === supply, "totalSupply 发生了变化 —— 归还只是转账，不应改变总量");
  ok("第二账户已归零，全部 NFT 回到主账户，totalSupply 未变");

  // 逐枚列出主账户持有的 tokenId，方便你对账
  if (ownerBal > 0n) {
    const ids = [];
    for (let i = 0; i < ownerBal; i++) {
      ids.push((await nft.tokenOfOwnerByIndex(owner.address, i)).toString());
    }
    info("主账户持有的 tokenId", ids.join(", "));
  }

  /* ---------- 3. 核对授权状态：不能有任何残留权限 ---------- */
  section(3, "核对授权状态（必须全部干净）");

  const isAll = await nft.isApprovedForAll(owner.address, buddy.address);
  info("isApprovedForAll(主账户 -> 第二账户)", isAll);
  assert(isAll === false, "主账户对第二账户仍有全量授权，请手动撤销");

  let dirty = 0;
  for (let i = 0; i < ownerBal; i++) {
    const tid = await nft.tokenOfOwnerByIndex(owner.address, i);
    const approved = await nft.getApproved(tid);
    if (approved !== ZERO_ADDRESS) {
      dirty++;
      info(`tokenId ${tid} 的授权`, approved);
    }
  }
  info("残留单枚授权的 NFT 数量", dirty.toString());
  assert(dirty === 0, "仍有 NFT 挂着单枚授权，请逐个 approve(ZERO_ADDRESS, tokenId) 撤销");
  ok("无全量授权、无单枚授权残留 —— 权限状态干净");

  /* ---------- 4. 余额与 gas 汇总 ---------- */
  section(4, "账户余额与本次开销");
  const ownerEth = await hre.ethers.provider.getBalance(owner.address);
  const buddyEth = await hre.ethers.provider.getBalance(buddy.address);
  info("主账户 ETH", hre.ethers.formatEther(ownerEth));
  info("第二账户 ETH", hre.ethers.formatEther(buddyEth));
  info("本脚本累计 gas", gasTotal.toString());
  console.log("");
  console.log("  说明：第二账户还会剩下一点 ETH（之前补的 gas 费没花完）。");
  console.log("        那是测试币，留着后面练手用，不用特意转回去。");

  /* ---------- 收尾 ---------- */
  console.log("");
  console.log("============================================================");
  console.log(" 清账完成，状态已闭环");
  console.log("============================================================");
  console.log("  · 全部 NFT 归属主账户，第二账户持有数为 0");
  console.log("  · totalSupply 保持不变（转账不增不减总量）");
  console.log("  · 授权全部撤销，无残留权限");
  console.log("");
  console.log("  顺带复习这次亲手验证的点：");
  console.log("   1. safeTransferFrom 由持有方发起，不需要任何人给它授权");
  console.log("      —— 授权是给别人转【你的】资产用的，转自己的东西不需要授权");
  console.log("   2. 遍历某地址持有的 NFT 时，边转边查 tokenOfOwnerByIndex(addr, 0)；");
  console.log("      不能先存 ID 列表再遍历，因为转移会改变索引结果");
  console.log("   3. 转让不改变 totalSupply，只改变 ownerOf");
  console.log("============================================================");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("");
    console.error(line);
    console.error(" [X] 收尾中断：", err.shortMessage || err.message || err);
    console.error(line);
    console.error(" 提示：中断说明某一步没达到预期，脚本不会静默跳过。");
    console.error("       请根据错误说明处理后再重跑。");
    process.exit(1);
  });
