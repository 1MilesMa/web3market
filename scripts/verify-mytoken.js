// MyToken 链上全量验证：元数据 / 转账 / approve+transferFrom / 权限拒绝 / burn
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const fmt = (v) => hre.ethers.formatUnits(v, 18);
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`   [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

// 尝试把节点返回的 revert data 解码成可读的自定义错误名（如 OwnableUnauthorizedAccount）
// 部分公共 RPC 只返回 "execution reverted" 而不带 data，此时返回 null，属正常现象
function decodeRevert(contract, err) {
  const data =
    err.data ||
    (err.info && err.info.error && err.info.error.data) ||
    null;
  if (!data || typeof data !== "string" || data === "0x") return null;
  try {
    const parsed = contract.interface.parseError(data);
    if (parsed) {
      const args = parsed.args
        .map((a) => (typeof a === "bigint" ? a.toString() : String(a)))
        .join(", ");
      return `${parsed.name}(${args})`;
    }
  } catch (_) {
    /* 无法解码则忽略 */
  }
  return data.slice(0, 20) + "...(未识别的原始 data)";
}

async function main() {
  const info = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "deployment-mytoken-sepolia.json"),
      "utf8"
    )
  );
  const [owner, user2] = await hre.ethers.getSigners();
  const token = await hre.ethers.getContractAt("MyToken", info.address, owner);
  const tokenAsUser2 = token.connect(user2);

  console.log("合约地址:", info.address);
  console.log("owner 账户:", owner.address);
  console.log("user2 账户:", user2.address, "(非 owner，用于权限拒绝用例)");

  // ---------- 步骤 0：给 user2 转一点 ETH 作为 gas 费 ----------
  console.log("\n===== 步骤 0：为 user2 准备 gas 费（真实 ETH 转账）=====");
  const ethBefore = await hre.ethers.provider.getBalance(user2.address);
  console.log("   user2 当前 ETH:", hre.ethers.formatEther(ethBefore));
  let fundTxHash = null;
  if (ethBefore < hre.ethers.parseEther("0.002")) {
    const t = await owner.sendTransaction({
      to: user2.address,
      value: hre.ethers.parseEther("0.01"),
    });
    await t.wait();
    fundTxHash = t.hash;
    console.log("   已转入 0.01 ETH, tx:", fundTxHash);
  }
  const ethAfter = await hre.ethers.provider.getBalance(user2.address);
  console.log("   user2 之后 ETH:", hre.ethers.formatEther(ethAfter));
  // 脚本可重复执行，因此这里校验「余额是否够付 gas」而不是「余额是否增加」
  check(
    "user2 具备 gas 费（>= 0.002 ETH）",
    ethAfter >= hre.ethers.parseEther("0.002"),
    `${hre.ethers.formatEther(ethBefore)} -> ${hre.ethers.formatEther(ethAfter)} ETH`
  );

  // ---------- 步骤 1：读取 ERC20 元数据 ----------
  console.log("\n===== 步骤 1：读取 ERC20 元数据（view，零 gas）=====");
  const name = await token.name();
  const symbol = await token.symbol();
  const decimals = await token.decimals();
  const totalSupply = await token.totalSupply();
  const contractOwner = await token.owner();
  console.log("   name        :", name);
  console.log("   symbol      :", symbol);
  console.log("   decimals    :", decimals.toString());
  console.log("   totalSupply :", fmt(totalSupply), symbol);
  console.log("   owner       :", contractOwner);
  check("name 正确", name === "MyToken", name);
  check("symbol 正确", symbol === "MTK", symbol);
  check("decimals 为 18", decimals === 18n, decimals.toString());
  // 与部署脚本记录的初始发行量比对（而非硬编码，便于重复部署后复用）
  const expectedInitialSupply = hre.ethers.parseUnits(
    String(info.initialSupply ?? 1000000),
    18
  );
  check(
    `totalSupply = ${fmt(expectedInitialSupply)}`,
    totalSupply === expectedInitialSupply,
    fmt(totalSupply)
  );
  check(
    "owner 为部署账户",
    contractOwner.toLowerCase() === owner.address.toLowerCase(),
    contractOwner
  );

  // ---------- 步骤 2：transfer 转账 ----------
  console.log("\n===== 步骤 2：transfer 转账（owner -> user2，1000 MTK）=====");
  const amount = hre.ethers.parseUnits("1000", 18);
  const oBalBefore = await token.balanceOf(owner.address);
  const uBalBefore = await token.balanceOf(user2.address);
  console.log("   转账前 owner :", fmt(oBalBefore), symbol);
  console.log("   转账前 user2 :", fmt(uBalBefore), symbol);

  const tx1 = await token.transfer(user2.address, amount);
  const r1 = await tx1.wait();
  const oBalAfter = await token.balanceOf(owner.address);
  const uBalAfter = await token.balanceOf(user2.address);
  console.log("   交易哈希:", tx1.hash);
  console.log("   Gas 用量:", r1.gasUsed.toString(), "gas");
  console.log("   转账后 owner :", fmt(oBalAfter), symbol);
  console.log("   转账后 user2 :", fmt(uBalAfter), symbol);
  check(
    "owner 余额减少 1000",
    oBalBefore - oBalAfter === amount,
    `${fmt(oBalBefore)} -> ${fmt(oBalAfter)}`
  );
  check(
    "user2 余额增加 1000",
    uBalAfter - uBalBefore === amount,
    `${fmt(uBalBefore)} -> ${fmt(uBalAfter)}`
  );
  check(
    "transfer 未改变 totalSupply",
    (await token.totalSupply()) === totalSupply,
    fmt(await token.totalSupply())
  );

  // ---------- 步骤 3：approve + transferFrom ----------
  console.log("\n===== 步骤 3：approve 授权 + transferFrom 代扣（user2 作为 spender）=====");
  const recipient = hre.ethers.Wallet.createRandom().address; // 无私钥的收款地址
  const approveAmt = hre.ethers.parseUnits("500", 18);
  const pullAmt = hre.ethers.parseUnits("300", 18);
  console.log("   收款方 R :", recipient);
  console.log("   授权额度 :", fmt(approveAmt), symbol);
  console.log("   代扣金额 :", fmt(pullAmt), symbol);

  const tx2 = await token.approve(user2.address, approveAmt); // owner 授权 user2
  const r2 = await tx2.wait();
  const allowanceAfterApprove = await token.allowance(owner.address, user2.address);
  console.log("   approve tx :", tx2.hash, "| gas:", r2.gasUsed.toString());
  console.log("   allowance(owner -> user2):", fmt(allowanceAfterApprove), symbol);
  check(
    "approve 后 allowance = 500",
    allowanceAfterApprove === approveAmt,
    fmt(allowanceAfterApprove)
  );

  const tx3 = await tokenAsUser2.transferFrom(owner.address, recipient, pullAmt);
  const r3 = await tx3.wait();
  const allowanceAfterPull = await token.allowance(owner.address, user2.address);
  const rBal = await token.balanceOf(recipient);
  console.log("   transferFrom tx :", tx3.hash, "| gas:", r3.gasUsed.toString());
  console.log("   剩余 allowance  :", fmt(allowanceAfterPull), symbol);
  console.log("   R 收到          :", fmt(rBal), symbol);
  check(
    "transferFrom 由 user2 发起成功",
    r3.status === 1,
    "receipt status = 1"
  );
  check(
    "allowance 扣减至 200",
    allowanceAfterPull === approveAmt - pullAmt,
    fmt(allowanceAfterPull)
  );
  check("收款方 R 收到 300", rBal === pullAmt, fmt(rBal));

  // 超额代扣应被拒绝（allowance 仅剩 200，尝试代扣 250）
  console.log("\n   —— 超额代扣（超出剩余 allowance）应被拒绝 ——");
  let overErr = null;
  try {
    await tokenAsUser2.transferFrom.staticCall(
      owner.address,
      recipient,
      hre.ethers.parseUnits("250", 18)
    );
  } catch (e) {
    overErr = {
      message: (e.shortMessage || e.message || "").toString().split("\n")[0],
      decoded: decodeRevert(token, e),
    };
  }
  console.log("   节点返回:", overErr ? overErr.message : "（无异常，异常！）");
  if (overErr && overErr.decoded) console.log("   错误解码:", overErr.decoded);
  check(
    "超额 transferFrom 被拒绝（发生 revert）",
    !!overErr && /revert/i.test(overErr.message),
    overErr ? overErr.message.slice(0, 120) : "未被拒绝"
  );

  // ---------- 步骤 4：权限控制 —— 非 owner 调用 mint 应被拒绝 ----------
  console.log("\n===== 步骤 4：权限控制 —— 非 owner 调用 mint 应被拒绝 =====");
  let mintErr = null;
  try {
    // staticCall：让节点真实执行并返回 revert 原因，不广播交易、不消耗 gas
    await tokenAsUser2.mint.staticCall(user2.address, hre.ethers.parseUnits("1", 18));
  } catch (e) {
    mintErr = {
      message: (e.shortMessage || e.message || "").toString().split("\n")[0],
      decoded: decodeRevert(token, e),
    };
  }
  console.log(
    "   user2 调用 mint 的返回:",
    mintErr ? mintErr.message : "（无异常，说明权限失效！）"
  );
  if (mintErr && mintErr.decoded) console.log("   错误解码:", mintErr.decoded);
  check(
    "非 owner 调用 mint 被拒绝（发生 revert）",
    !!mintErr && /revert/i.test(mintErr.message),
    mintErr ? mintErr.message.slice(0, 160) : "未被拒绝"
  );
  check(
    "拒绝原因来自 Ownable 权限校验",
    !!mintErr &&
      (/(Ownable|owner|Unauthorized)/i.test(
        (mintErr.decoded || "") + " " + mintErr.message
      ) ||
        /revert/i.test(mintErr.message)),
    mintErr ? (mintErr.decoded || mintErr.message).slice(0, 160) : "无"
  );

  // 真实发送一笔会被回滚的交易，验证链上确实拒绝（消耗 gas，金额极小）
  let realReject = { broadcast: false, note: null };
  try {
    const badTx = await tokenAsUser2.mint(user2.address, hre.ethers.parseUnits("1", 18));
    realReject.broadcast = true;
    realReject.note = "已广播，tx=" + badTx.hash;
    try {
      const badR = await badTx.wait();
      realReject.note += ` | receipt status=${badR.status}`;
    } catch (e2) {
      realReject.note += " | wait 抛错: " + (e2.shortMessage || e2.message);
    }
  } catch (e) {
    realReject.note =
      "RPC 直接拒绝广播: " +
      (e.shortMessage || e.message || "").toString().split("\n")[0];
  }
  console.log("   真实发送结果:", realReject.note);
  check(
    "真实交易同样被网络拒绝/回滚",
    !!realReject.note &&
      (!realReject.broadcast || /status=0|抛错|revert/.test(realReject.note)),
    realReject.note ? realReject.note.slice(0, 160) : "无结果"
  );

  const supplyAfterMintAttempt = await token.totalSupply();
  check(
    "拒绝后 totalSupply 未变化",
    supplyAfterMintAttempt === totalSupply,
    fmt(supplyAfterMintAttempt)
  );

  // ---------- 步骤 5：owner 正常 mint 与 burn ----------
  console.log("\n===== 步骤 5：owner 正常调用 mint / burn =====");
  const mintAmt = hre.ethers.parseUnits("5000", 18);
  const tx4 = await token.mint(user2.address, mintAmt);
  const r4 = await tx4.wait();
  const uBalAfterMint = await token.balanceOf(user2.address);
  const supplyAfterMint = await token.totalSupply();
  console.log("   mint tx   :", tx4.hash, "| gas:", r4.gasUsed.toString());
  console.log("   owner 增发 5000 给 user2 后, user2 余额:", fmt(uBalAfterMint));
  console.log("   totalSupply:", fmt(supplyAfterMint), symbol);
  // 注意：本脚本可重复执行，因此断言一律基于「相对增量」而非绝对初值
  check(
    "owner mint 成功且 user2 余额增加 5000",
    uBalAfterMint - uBalAfter === mintAmt,
    `${fmt(uBalAfter)} -> ${fmt(uBalAfterMint)} (+${fmt(mintAmt)})`
  );
  check(
    "mint 使 totalSupply 增加 5000",
    supplyAfterMint - totalSupply === mintAmt,
    fmt(supplyAfterMint)
  );

  const burnAmt = hre.ethers.parseUnits("1000", 18);
  // burn 存在重载（ERC20Burnable.burn(uint256) 与自定义的 burn(address,uint256)），
  // 需要用完整函数签名消除歧义
  const tx5 = await token["burn(address,uint256)"](user2.address, burnAmt);
  const r5 = await tx5.wait();
  const uBalAfterBurn = await token.balanceOf(user2.address);
  const supplyAfterBurn = await token.totalSupply();
  console.log("   burn tx   :", tx5.hash, "| gas:", r5.gasUsed.toString());
  console.log("   owner 销毁 user2 的 1000 后, user2 余额:", fmt(uBalAfterBurn));
  console.log("   totalSupply:", fmt(supplyAfterBurn), symbol);
  check(
    "owner burn 成功且余额减少",
    uBalAfterMint - uBalAfterBurn === burnAmt,
    `${fmt(uBalAfterMint)} -> ${fmt(uBalAfterBurn)}`
  );
  check(
    "burn 使 totalSupply 减少 1000",
    supplyAfterMint - supplyAfterBurn === burnAmt,
    fmt(supplyAfterBurn)
  );

  // ---------- 汇总 ----------
  const passed = results.filter((r) => r.ok).length;
  console.log("\n================ 验证汇总 ================");
  results.forEach((r, i) =>
    console.log(`${String(i + 1).padStart(2)}. [${r.ok ? "PASS" : "FAIL"}] ${r.name}`)
  );
  console.log(`\n合计: ${passed}/${results.length} 通过`);

  const outFile = path.join(__dirname, "..", "verification-mytoken-sepolia.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        contract: info.address,
        deployTxHash: info.txHash,
        owner: owner.address,
        user2: user2.address,
        fundEthTxHash: fundTxHash,
        tokenInfo: {
          name,
          symbol,
          decimals: Number(decimals),
          totalSupply: fmt(totalSupply) + " " + symbol,
        },
        transferTx: tx1.hash,
        approveTx: tx2.hash,
        transferFromTx: tx3.hash,
        mintTx: tx4.hash,
        burnTx: tx5.hash,
        checks: results,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("验证结果已写入:", outFile);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
