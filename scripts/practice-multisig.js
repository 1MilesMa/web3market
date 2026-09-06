const { ethers } = require("hardhat");

/**
 * practice-multisig.js —— 多签治理本地链演练
 *
 * 跑法（在 PowerShell 里，项目根目录下）：
 *   npx hardhat run scripts/practice-multisig.js
 *
 * 默认跑在 Hardhat 内置链上：不花真钱、不用真私钥、数据用完即弃，随便折腾。
 *
 * 剧本：一个三人团队（alice / bob / carol）共同管理一个市场，规则是 2/3。
 *   第 0 步  部署市场（单人 owner）与多签（3 人 2 票）
 *   场景 1   只有 1 票就想动钱 → 被拒
 *   场景 2   凑够 2 票 → 办成
 *   场景 3   投了又反悔（撤票）→ 票数不够，办不成
 *   场景 4   把市场的 owner 从单人账号移交给多签（两步走）
 *   场景 5   移交后，原来的单人账号彻底失效
 *   场景 6   多签正式接手治理：改费率
 *
 * 这个脚本的目的不是"跑通"，而是让你把多签的手感在脑子里过一遍：
 * 每一笔 owner 操作，从"一个人说了算"变成"两个人点头才算"。
 */
function hr(title) {
  console.log("\n" + "=".repeat(66));
  console.log(title);
  console.log("=".repeat(66));
}

/** 打印某笔提案当前的票数与执行状态 */
async function showTx(ms, id, label) {
  const t = await ms.getTransaction(id);
  console.log(
    `  · 提案 #${id} [${label}] → 票数 ${t.confirmations}/2，已执行：${t.executed}`
  );
}

/** 执行一笔交易，失败时打印原因但不中断脚本 */
async function tryExec(promise, okMsg) {
  try {
    const tx = await promise;
    await tx.wait();
    console.log(`  [成功] ${okMsg}`);
    return true;
  } catch (e) {
    const msg = (e.shortMessage || e.message || String(e)).split("\n")[0];
    console.log(`  [被拒] ${msg}`);
    return false;
  }
}

async function main() {
  console.log("多签治理本地链演练 —— 3 人共管，2 票放行");

  const [deployer, alice, bob, carol] = await ethers.getSigners();

  // ==========================================================================
  hr("第 0 步：部署市场与多签");
  // ==========================================================================
  const Market = await ethers.getContractFactory("SimpleMarket");
  const market = await Market.deploy(deployer.address, 250); // 费率 250 bps = 2.5%
  await market.waitForDeployment();
  const marketAddr = await market.getAddress();

  const MultiSig = await ethers.getContractFactory("MultiSigOwner");
  const ms = await MultiSig.deploy([alice.address, bob.address, carol.address], 2);
  await ms.waitForDeployment();
  const msAddr = await ms.getAddress();

  console.log(`  市场 SimpleMarket : ${marketAddr}`);
  console.log(`  市场当前 owner    : ${await market.owner()}（deployer 单人掌控）`);
  console.log(`  多签 MultiSigOwner: ${msAddr}（3 人，阈值 ${await ms.threshold()}）`);
  console.log(`  成员 alice : ${alice.address}`);
  console.log(`  成员 bob   : ${bob.address}`);
  console.log(`  成员 carol : ${carol.address}`);

  // 先给多签账户打 1 ETH，后面演示"多签里的钱怎么两个人点头才能花"
  await (await deployer.sendTransaction({ to: msAddr, value: ethers.parseEther("1") })).wait();
  console.log(`\n  已向多签账户充值 1 ETH（模拟市场手续费累积）`);
  console.log(`  多签余额：${ethers.formatEther(await ethers.provider.getBalance(msAddr))} ETH`);

  // ==========================================================================
  hr("场景 1：只有 1 票就想花钱 —— 应该被拒绝");
  // ==========================================================================
  const payCarol = ethers.parseEther("0.1");
  const carolBefore = await ethers.provider.getBalance(carol.address);

  // alice 提议：从多签里转 0.1 ETH 给 carol（提交即自动投第一票）
  await (await ms.connect(alice).submit(carol.address, payCarol, "0x")).wait();
  await showTx(ms, 0, "转 0.1 ETH 给 carol");

  const ok1 = await tryExec(
    ms.connect(alice).execute(0),
    "提案 #0 执行完毕"
  );
  if (!ok1) {
    console.log("  结论：1/3 想动钱，合约直接拒绝 —— 单点故障已经被消灭");
  }

  // ==========================================================================
  hr("场景 2：bob 补上第二票 —— 达到阈值，办成");
  // ==========================================================================
  await (await ms.connect(bob).confirm(0)).wait();
  await showTx(ms, 0, "转 0.1 ETH 给 carol");

  const ok2 = await tryExec(ms.connect(carol).execute(0), "提案 #0 执行完毕（由 carol 代为触发）");
  const carolAfter = await ethers.provider.getBalance(carol.address);
  console.log(`  carol 余额变化：${ethers.formatEther(carolAfter - carolBefore)} ETH`);
  console.log(
    `  多签余额：${ethers.formatEther(await ethers.provider.getBalance(msAddr))} ETH`
  );
  if (ok2) {
    console.log("  结论：2/3 通过即可执行；而且执行人不必须是成员（谁付 gas 都行）");
  }

  // ==========================================================================
  hr("场景 3：投了又反悔 —— 撤票后票数不足，办不成");
  // ==========================================================================
  await (await ms.connect(alice).submit(bob.address, ethers.parseEther("0.2"), "0x")).wait();
  await (await ms.connect(bob).confirm(1)).wait();
  await showTx(ms, 1, "转 0.2 ETH 给 bob");
  console.log("  此时 bob 后悔了，撤掉自己那一票……");
  await (await ms.connect(bob).revoke(1)).wait();
  await showTx(ms, 1, "转 0.2 ETH 给 bob");

  const ok3 = await tryExec(ms.connect(alice).execute(1), "提案 #1 执行完毕");
  if (!ok3) {
    console.log("  结论：执行前随时可以反悔，这就是撤票机制（revoke）的价值");
  }

  // ==========================================================================
  hr("场景 4：把市场 owner 移交给多签（两步走）");
  // ==========================================================================
  console.log("  第 1 步：现任 owner（deployer）提名多签 —— 注意 owner 此时不变");
  await (await market.connect(deployer).transferOwnership(msAddr)).wait();
  console.log(`    pendingOwner = ${await market.pendingOwner()}`);
  console.log(`    owner        = ${await market.owner()}（还是 deployer）`);

  console.log("\n  第 2 步：多签内部投票，通过后再 acceptOwnership");
  const acceptData = market.interface.encodeFunctionData("acceptOwnership");
  await (await ms.connect(alice).submit(marketAddr, 0, acceptData)).wait();
  await (await ms.connect(bob).confirm(2)).wait();
  await showTx(ms, 2, "acceptOwnership()");
  await tryExec(ms.connect(alice).execute(2), "提案 #2 执行完毕");

  console.log(`\n  移交后 市场的 owner = ${await market.owner()}`);
  console.log(`  是不是多签地址？${(await market.owner()) === msAddr ? "是，接管成功" : "否，接管失败"}`);

  // ==========================================================================
  hr("场景 5：移交后，原来的单人账号还有特权吗？");
  // ==========================================================================
  console.log("  deployer 想直接把费率改成 999 bps（约 10%）……");
  const ok5 = await tryExec(
    market.connect(deployer).setFeeBps(999),
    "deployer 改费率成功（这不该发生）"
  );
  if (!ok5) {
    console.log("  结论：老账号彻底失去特权 —— 这正是多签要的效果");
  }

  // ==========================================================================
  hr("场景 6：多签接手治理 —— 走流程改费率");
  // ==========================================================================
  console.log(`  改之前费率：${await market.feeBps()} bps`);
  const setFeeData = market.interface.encodeFunctionData("setFeeBps", [300]);
  await (await ms.connect(alice).submit(marketAddr, 0, setFeeData)).wait();
  await showTx(ms, 3, "setFeeBps(300)");
  console.log("  只有 alice 一票时，费率不会变（提案卡住）……");
  await (await ms.connect(carol).confirm(3)).wait();
  await showTx(ms, 3, "setFeeBps(300)");
  await tryExec(ms.connect(bob).execute(3), "提案 #3 执行完毕");
  console.log(`  改之后费率：${await market.feeBps()} bps`);

  // ==========================================================================
  hr("最终状态");
  // ==========================================================================
  console.log(`  市场 owner        : ${await market.owner()}`);
  console.log(`  市场费率          : ${await market.feeBps()} bps`);
  console.log(`  市场是否暂停      : ${await market.paused()}`);
  console.log(`  多签成员数        : ${(await ms.getOwners()).length} 人，阈值 ${await ms.threshold()}`);
  console.log(`  多签累计提案      : ${await ms.getTransactionCount()} 笔`);
  console.log(`  多签余额          : ${ethers.formatEther(await ethers.provider.getBalance(msAddr))} ETH`);
  console.log("\n演练结束。以上全部发生在本地模拟链，没有花一分钱真钱。\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n演练脚本出错：", error);
    process.exit(1);
  });
