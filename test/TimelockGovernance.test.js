// SPDX-License-Identifier: MIT
/**
 * 多签 + 时间锁 双层治理测试
 *
 * 覆盖点：
 *   - 角色分配是否符合设计（多签 proposer/canceller，执行开放，无管理员后门）
 *   - owner 从多签移交时间锁的全过程与中间态
 *   - 排队 / 公示 / 执行 三阶段状态机
 *   - 越权路径：非 proposer 排队、单人投票、未到期执行、重复执行、被撤销的执行
 *   - 端到端：费率改完再还原，零残留
 */
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;

const DELAY = 3600;
const ORIGINAL_FEE = 250;
const NEW_FEE = 300;
const ZERO = ethers.ZeroAddress;
const ZERO_BYTES32 = ethers.ZeroHash;

async function increase(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("多签 + 时间锁 双层治理", function () {
  async function deployFixture() {
    const [deployer, alice, bob, carol, outsider] = await ethers.getSigners();

    const market = await (await ethers.getContractFactory("SimpleMarket")).deploy(deployer.address, ORIGINAL_FEE);
    await market.waitForDeployment();

    const multisig = await (await ethers.getContractFactory("MultiSigOwner")).deploy(
      [alice.address, bob.address, carol.address],
      2
    );
    await multisig.waitForDeployment();

    const timelock = await (await ethers.getContractFactory("MarketTimelock")).deploy(
      DELAY,
      [await multisig.getAddress()],
      [ZERO],
      ZERO
    );
    await timelock.waitForDeployment();

    const marketAddr = await market.getAddress();
    const msAddr = await multisig.getAddress();
    const tlAddr = await timelock.getAddress();

    return { deployer, alice, bob, carol, outsider, market, multisig, timelock, marketAddr, msAddr, tlAddr };
  }

  /** 多签三步走：submit → confirm → execute */
  async function multisigRun(multisig, submitter, confirmer, to, data) {
    const txId = await multisig.getTransactionCount();
    await (await multisig.connect(submitter).submit(to, 0, data)).wait();
    await (await multisig.connect(confirmer).confirm(txId)).wait();
    await (await multisig.connect(confirmer).execute(txId)).wait();
    return txId;
  }

  it("角色分配符合设计：多签可提案可撤销、执行对所有人开放、无管理员后门", async function () {
    const { deployer, multisig, timelock, msAddr } = await deployFixture();
    expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), msAddr)).to.equal(true);
    expect(await timelock.hasRole(await timelock.CANCELLER_ROLE(), msAddr)).to.equal(true);
    expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), ZERO)).to.equal(true);
    expect(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(false);
    expect(await timelock.getMinDelay()).to.equal(BigInt(DELAY));
    expect(await multisig.threshold()).to.equal(2n);
  });

  it("owner 可从多签移交时间锁，移交期间不出现权力真空", async function () {
    const { alice, bob, market, multisig, timelock, marketAddr, msAddr, tlAddr } = await deployFixture();

    // 多签先接管
    await (await market.transferOwnership(msAddr)).wait();
    const acceptData = market.interface.encodeFunctionData("acceptOwnership", []);
    await multisigRun(multisig, alice, bob, marketAddr, acceptData);
    expect(await market.owner()).to.equal(msAddr);

    // 提名时间锁
    const nominate = market.interface.encodeFunctionData("transferOwnership", [tlAddr]);
    await multisigRun(multisig, alice, bob, marketAddr, nominate);
    expect(await market.pendingOwner()).to.equal(tlAddr);
    expect(await market.owner()).to.equal(msAddr); // 权力未真空

    // 时间锁接受：同样要排队公示
    const salt = ethers.id("ACCEPT");
    const schedule = timelock.interface.encodeFunctionData("schedule", [
      marketAddr,
      0,
      acceptData,
      ZERO_BYTES32,
      salt,
      DELAY,
    ]);
    await multisigRun(multisig, alice, bob, tlAddr, schedule);
    const id = await timelock.hashOperation(marketAddr, 0, acceptData, ZERO_BYTES32, salt);
    expect(await timelock.getOperationState(id)).to.equal(1n); // Waiting

    await increase(DELAY + 1);
    expect(await timelock.getOperationState(id)).to.equal(2n); // Ready

    await (await timelock.execute(marketAddr, 0, acceptData, ZERO_BYTES32, salt)).wait();
    expect(await market.owner()).to.equal(tlAddr);
    expect(await timelock.getOperationState(id)).to.equal(3n); // Done
  });

  it("非 proposer 排队被拒（外部账号与多签成员个人都不行）", async function () {
    const { alice, outsider, market, timelock, marketAddr } = await deployFixture();
    const data = market.interface.encodeFunctionData("setFeeBps", [NEW_FEE]);

    await expect(
      timelock.connect(outsider).schedule(marketAddr, 0, data, ZERO_BYTES32, ethers.id("X1"), DELAY)
    ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");

    await expect(
      timelock.connect(alice).schedule(marketAddr, 0, data, ZERO_BYTES32, ethers.id("X2"), DELAY)
    ).to.be.revertedWithCustomError(timelock, "AccessControlUnauthorizedAccount");
  });

  it("公示期内执行被拒，到期后才能执行，且任何人都能触发", async function () {
    const { alice, bob, carol, outsider, market, multisig, timelock, marketAddr, msAddr, tlAddr } =
      await deployFixture();

    // 先把 owner 交给时间锁
    await (await market.transferOwnership(msAddr)).wait();
    const acceptData = market.interface.encodeFunctionData("acceptOwnership", []);
    await multisigRun(multisig, alice, bob, marketAddr, acceptData);
    const nominate = market.interface.encodeFunctionData("transferOwnership", [tlAddr]);
    await multisigRun(multisig, alice, bob, marketAddr, nominate);
    const saltAcc = ethers.id("ACC2");
    await multisigRun(
      multisig,
      alice,
      bob,
      tlAddr,
      timelock.interface.encodeFunctionData("schedule", [marketAddr, 0, acceptData, ZERO_BYTES32, saltAcc, DELAY])
    );
    await increase(DELAY + 1);
    await (await timelock.execute(marketAddr, 0, acceptData, ZERO_BYTES32, saltAcc)).wait();
    expect(await market.owner()).to.equal(tlAddr);

    // 排队改费率
    const feeData = market.interface.encodeFunctionData("setFeeBps", [NEW_FEE]);
    const saltFee = ethers.id("FEE2");
    await multisigRun(
      multisig,
      alice,
      bob,
      tlAddr,
      timelock.interface.encodeFunctionData("schedule", [marketAddr, 0, feeData, ZERO_BYTES32, saltFee, DELAY])
    );

    await expect(
      timelock.connect(carol).execute(marketAddr, 0, feeData, ZERO_BYTES32, saltFee)
    ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");

    await increase(DELAY + 1);
    // 由完全无关的外部账号执行
    await (await timelock.connect(outsider).execute(marketAddr, 0, feeData, ZERO_BYTES32, saltFee)).wait();
    expect(await market.feeBps()).to.equal(BigInt(NEW_FEE));

    // 重复执行被拒
    await expect(
      timelock.connect(outsider).execute(marketAddr, 0, feeData, ZERO_BYTES32, saltFee)
    ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
  });

  it("单人只有 1 票时无法完成排队", async function () {
    const { carol, market, multisig, timelock, marketAddr, tlAddr } = await deployFixture();
    const feeData = market.interface.encodeFunctionData("setFeeBps", [NEW_FEE]);
    const schedule = timelock.interface.encodeFunctionData("schedule", [
      marketAddr,
      0,
      feeData,
      ZERO_BYTES32,
      ethers.id("ONE"),
      DELAY,
    ]);
    const txId = await multisig.getTransactionCount();
    await (await multisig.connect(carol).submit(tlAddr, 0, schedule)).wait();
    await expect(multisig.connect(carol).execute(txId)).to.be.revertedWithCustomError(multisig, "BelowThreshold");
  });

  it("公示期内多签可以撤销，撤销后到期也无法执行", async function () {
    const { alice, bob, outsider, market, multisig, timelock, marketAddr, tlAddr } = await deployFixture();
    const evil = market.interface.encodeFunctionData("setFeeBps", [999]);
    const salt = ethers.id("EVIL");
    await multisigRun(
      multisig,
      alice,
      bob,
      tlAddr,
      timelock.interface.encodeFunctionData("schedule", [marketAddr, 0, evil, ZERO_BYTES32, salt, DELAY])
    );
    const id = await timelock.hashOperation(marketAddr, 0, evil, ZERO_BYTES32, salt);
    expect(await timelock.isOperationPending(id)).to.equal(true);

    await multisigRun(
      multisig,
      alice,
      bob,
      tlAddr,
      timelock.interface.encodeFunctionData("cancel", [id])
    );
    expect(await timelock.isOperationPending(id)).to.equal(false);

    await increase(DELAY + 1);
    await expect(
      timelock.connect(outsider).execute(marketAddr, 0, evil, ZERO_BYTES32, salt)
    ).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
  });

  it("端到端：暂停 → 改费率 → 全部还原，零残留", async function () {
    const { alice, bob, outsider, market, multisig, timelock, marketAddr, msAddr, tlAddr } = await deployFixture();

    // 移交 owner 给时间锁
    await (await market.transferOwnership(msAddr)).wait();
    const acceptData = market.interface.encodeFunctionData("acceptOwnership", []);
    await multisigRun(multisig, alice, bob, marketAddr, acceptData);
    await multisigRun(
      multisig,
      alice,
      bob,
      marketAddr,
      market.interface.encodeFunctionData("transferOwnership", [tlAddr])
    );
    const sAcc = ethers.id("E2E_ACC");
    await multisigRun(
      multisig,
      alice,
      bob,
      tlAddr,
      timelock.interface.encodeFunctionData("schedule", [marketAddr, 0, acceptData, ZERO_BYTES32, sAcc, DELAY])
    );
    await increase(DELAY + 1);
    await (await timelock.connect(outsider).execute(marketAddr, 0, acceptData, ZERO_BYTES32, sAcc)).wait();

    const run = async (data, saltTag) => {
      const salt = ethers.id(saltTag);
      await multisigRun(
        multisig,
        alice,
        bob,
        tlAddr,
        timelock.interface.encodeFunctionData("schedule", [marketAddr, 0, data, ZERO_BYTES32, salt, DELAY])
      );
      await increase(DELAY + 1);
      await (await timelock.connect(outsider).execute(marketAddr, 0, data, ZERO_BYTES32, salt)).wait();
    };

    await run(market.interface.encodeFunctionData("pause", []), "E2E_PAUSE");
    expect(await market.paused()).to.equal(true);

    await run(market.interface.encodeFunctionData("setFeeBps", [NEW_FEE]), "E2E_FEE");
    expect(await market.feeBps()).to.equal(BigInt(NEW_FEE));

    await run(market.interface.encodeFunctionData("setFeeBps", [ORIGINAL_FEE]), "E2E_RESTORE");
    await run(market.interface.encodeFunctionData("unpause", []), "E2E_UNPAUSE");

    expect(await market.feeBps()).to.equal(BigInt(ORIGINAL_FEE));
    expect(await market.paused()).to.equal(false);
    expect(await market.owner()).to.equal(tlAddr);
  });
});
