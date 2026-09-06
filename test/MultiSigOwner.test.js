const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * MultiSigOwner（2/3 多签治理）单元测试
 *
 * 这个文件同时承担两个角色：
 *   1. 单元测试 —— 验证多签合约自身的每一步行为
 *   2. 交接演练 —— 验证"多签真的能接手 SimpleMarket 的 owner"这条完整链路
 *
 * 为什么必须测第二部分？
 *   多签写对了，不代表它能管住市场。真正会出问题的是衔接处：
 *     · 两步走的所有权转让（transferOwnership → acceptOwnership）
 *     · 多签发出的 call，msg.sender 是不是市场认的那个地址
 *     · 接管之后，原来的单人 owner 账号还能不能绕过
 *   这些只有真跑一遍才知道。
 */
describe("MultiSigOwner (2/3 多签治理)", function () {
  const ZERO = ethers.ZeroAddress;

  /** 3 个 owner、阈值 2 的多签 */
  async function deployMultisigFixture() {
    const [owner, addr1, addr2, outsider] = await ethers.getSigners();
    const MultiSig = await ethers.getContractFactory("MultiSigOwner");
    const ms = await MultiSig.deploy([owner.address, addr1.address, addr2.address], 2);
    await ms.waitForDeployment();
    return { ms, owner, addr1, addr2, outsider };
  }

  /** 3 个 owner、阈值 3 的多签 —— 用于验证"移除成员后阈值自动下调" */
  async function deployStrictFixture() {
    const [owner, addr1, addr2] = await ethers.getSigners();
    const MultiSig = await ethers.getContractFactory("MultiSigOwner");
    const ms = await MultiSig.deploy([owner.address, addr1.address, addr2.address], 3);
    await ms.waitForDeployment();
    return { ms, owner, addr1, addr2 };
  }

  /** 只有 1 个 owner 的多签 —— 用于验证"不能把最后一个成员删掉" */
  async function deploySoloFixture() {
    const [owner] = await ethers.getSigners();
    const MultiSig = await ethers.getContractFactory("MultiSigOwner");
    const ms = await MultiSig.deploy([owner.address], 1);
    await ms.waitForDeployment();
    return { ms, owner };
  }

  /** 多签 + 市场（市场 owner 是部署者） */
  async function deployWithMarketFixture() {
    const [owner, addr1, addr2] = await ethers.getSigners();
    const MultiSig = await ethers.getContractFactory("MultiSigOwner");
    const ms = await MultiSig.deploy([owner.address, addr1.address, addr2.address], 2);
    await ms.waitForDeployment();

    const Market = await ethers.getContractFactory("SimpleMarket");
    const market = await Market.deploy(owner.address, 250);
    await market.waitForDeployment();

    return { ms, market, owner, addr1, addr2 };
  }

  /** 把 "function xxx(类型)" 编码成 calldata —— 多签传的就是这串字节 */
  function calldata(signature, args = []) {
    const iface = new ethers.Interface([`function ${signature}`]);
    const name = signature.slice(0, signature.indexOf("("));
    return iface.encodeFunctionData(name, args);
  }

  // ==========================================================================
  // 1. 部署与初始状态
  // ==========================================================================
  describe("部署与初始状态", function () {
    it("三个成员都应登记在册", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      expect(await ms.isOwner(owner.address)).to.equal(true);
      expect(await ms.isOwner(addr1.address)).to.equal(true);
      expect(await ms.isOwner(addr2.address)).to.equal(true);
    });

    it("阈值应为 2", async function () {
      const { ms } = await loadFixture(deployMultisigFixture);
      expect(await ms.threshold()).to.equal(2);
    });

    it("getOwners 应返回全部 3 个成员", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      const owners = await ms.getOwners();
      expect(owners.length).to.equal(3);
      expect(owners).to.include(owner.address);
      expect(owners).to.include(addr1.address);
      expect(owners).to.include(addr2.address);
    });

    it("非成员地址不应被认定为 owner", async function () {
      const { ms, outsider } = await loadFixture(deployMultisigFixture);
      expect(await ms.isOwner(outsider.address)).to.equal(false);
    });

    it("初始提案数应为 0", async function () {
      const { ms } = await loadFixture(deployMultisigFixture);
      expect(await ms.getTransactionCount()).to.equal(0);
    });

    it("成员列表为空应拒绝部署", async function () {
      const MultiSig = await ethers.getContractFactory("MultiSigOwner");
      await expect(MultiSig.deploy([], 1)).to.be.revertedWithCustomError(MultiSig, "EmptyOwners");
    });

    it("阈值为 0 应拒绝部署", async function () {
      const [owner] = await ethers.getSigners();
      const MultiSig = await ethers.getContractFactory("MultiSigOwner");
      await expect(MultiSig.deploy([owner.address], 0))
        .to.be.revertedWithCustomError(MultiSig, "ThresholdCannotBeZero");
    });

    it("阈值大于成员数应拒绝部署（否则永久锁死）", async function () {
      const [owner, addr1] = await ethers.getSigners();
      const MultiSig = await ethers.getContractFactory("MultiSigOwner");
      await expect(MultiSig.deploy([owner.address, addr1.address], 3))
        .to.be.revertedWithCustomError(MultiSig, "InvalidThreshold");
    });

    it("成员含零地址应拒绝部署", async function () {
      const [owner] = await ethers.getSigners();
      const MultiSig = await ethers.getContractFactory("MultiSigOwner");
      await expect(MultiSig.deploy([owner.address, ZERO], 1))
        .to.be.revertedWithCustomError(MultiSig, "ZeroAddress");
    });

    it("成员重复应拒绝部署", async function () {
      const [owner] = await ethers.getSigners();
      const MultiSig = await ethers.getContractFactory("MultiSigOwner");
      await expect(MultiSig.deploy([owner.address, owner.address], 1))
        .to.be.revertedWithCustomError(MultiSig, "DuplicateOwner");
    });
  });

  // ==========================================================================
  // 2. 提交提案（submit）
  // ==========================================================================
  describe("提交提案", function () {
    it("成员提交后应产生 1 条提案，并自动投第一票", async function () {
      const { ms, owner, addr2 } = await loadFixture(deployMultisigFixture);
      const data = calldata("pause()");
      await ms.connect(owner).submit(addr2.address, 0, data);

      const tx = await ms.getTransaction(0);
      expect(tx.to).to.equal(addr2.address);
      expect(tx.confirmations).to.equal(1);
      expect(tx.executed).to.equal(false);
      expect(await ms.getTransactionCount()).to.equal(1);
    });

    it("提案内容（data）应被完整保存", async function () {
      const { ms, owner, addr2 } = await loadFixture(deployMultisigFixture);
      const data = calldata("setFeeBps(uint256)", [300]);
      await ms.connect(owner).submit(addr2.address, 0, data);
      expect((await ms.getTransaction(0)).data).to.equal(data);
    });

    it("提交应触发 Submitted 事件", async function () {
      const { ms, owner, addr2 } = await loadFixture(deployMultisigFixture);
      const data = calldata("pause()");
      await expect(ms.connect(owner).submit(addr2.address, 0, data))
        .to.emit(ms, "Submitted")
        .withArgs(0, owner.address, addr2.address, 0, data);
    });

    it("非成员提交应拒绝", async function () {
      const { ms, outsider, addr2 } = await loadFixture(deployMultisigFixture);
      await expect(ms.connect(outsider).submit(addr2.address, 0, calldata("pause()")))
        .to.be.revertedWithCustomError(ms, "NotAnOwner");
    });

    it("目标地址为零地址应拒绝", async function () {
      const { ms, owner } = await loadFixture(deployMultisigFixture);
      await expect(ms.connect(owner).submit(ZERO, 0, calldata("pause()")))
        .to.be.revertedWithCustomError(ms, "ZeroAddress");
    });

    it("多条提案的编号应递增", async function () {
      const { ms, owner, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(owner).submit(addr2.address, 0, calldata("unpause()"));
      expect(await ms.getTransactionCount()).to.equal(2);
      expect((await ms.getTransaction(1)).data).to.equal(calldata("unpause()"));
    });
  });

  // ==========================================================================
  // 3. 确认（confirm）
  // ==========================================================================
  describe("确认提案", function () {
    it("第二个成员确认后票数应为 2", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      expect((await ms.getTransaction(0)).confirmations).to.equal(2);
    });

    it("确认应触发 Confirmed 事件并带上最新票数", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await expect(ms.connect(addr1).confirm(0))
        .to.emit(ms, "Confirmed")
        .withArgs(0, addr1.address, 2);
    });

    it("同一人重复确认应拒绝", async function () {
      const { ms, owner, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await expect(ms.connect(owner).confirm(0))
        .to.be.revertedWithCustomError(ms, "AlreadyConfirmed");
    });

    it("非成员确认应拒绝", async function () {
      const { ms, owner, outsider, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await expect(ms.connect(outsider).confirm(0))
        .to.be.revertedWithCustomError(ms, "NotAnOwner");
    });

    it("确认不存在的提案应拒绝", async function () {
      const { ms, addr1 } = await loadFixture(deployMultisigFixture);
      await expect(ms.connect(addr1).confirm(99))
        .to.be.revertedWithCustomError(ms, "TxDoesNotExist");
    });

    it("isConfirmedBy 应正确记录投票情况", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      expect(await ms.isConfirmedBy(0, owner.address)).to.equal(true);
      expect(await ms.isConfirmedBy(0, addr1.address)).to.equal(true);
      expect(await ms.isConfirmedBy(0, addr2.address)).to.equal(false);
    });
  });

  // ==========================================================================
  // 4. 撤票（revoke）
  // ==========================================================================
  describe("撤回确认", function () {
    it("撤票后票数应减 1", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      await ms.connect(addr1).revoke(0);
      expect((await ms.getTransaction(0)).confirmations).to.equal(1);
      expect(await ms.isConfirmedBy(0, addr1.address)).to.equal(false);
    });

    it("撤票应触发 Revoked 事件", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      await expect(ms.connect(addr1).revoke(0))
        .to.emit(ms, "Revoked")
        .withArgs(0, addr1.address, 1);
    });

    it("没投过票的人撤票应拒绝", async function () {
      const { ms, owner, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await expect(ms.connect(addr2).revoke(0))
        .to.be.revertedWithCustomError(ms, "NotConfirmedYet");
    });

    it("撤票后票数不足，执行应被拒绝", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      await ms.connect(addr1).revoke(0);
      await expect(ms.connect(owner).execute(0))
        .to.be.revertedWithCustomError(ms, "BelowThreshold")
        .withArgs(1, 2);
    });

    it("撤票后可以重新确认", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      await ms.connect(addr1).revoke(0);
      await ms.connect(addr1).confirm(0);
      expect((await ms.getTransaction(0)).confirmations).to.equal(2);
    });
  });

  // ==========================================================================
  // 5. 执行（execute）
  // ==========================================================================
  describe("执行提案", function () {
    it("只有 1 票时执行应拒绝（核心：1/3 不能动钱）", async function () {
      const { ms, owner, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await expect(ms.connect(owner).execute(0))
        .to.be.revertedWithCustomError(ms, "BelowThreshold")
        .withArgs(1, 2);
    });

    it("凑够 2 票后应执行成功并标记为已执行", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      await ms.connect(owner).execute(0);
      expect((await ms.getTransaction(0)).executed).to.equal(true);
    });

    it("执行应触发 Executed 事件", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      await expect(ms.connect(owner).execute(0))
        .to.emit(ms, "Executed")
        .withArgs(0, addr2.address, 0, true);
    });

    it("重复执行应拒绝", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      await ms.connect(owner).execute(0);
      await expect(ms.connect(addr1).execute(0))
        .to.be.revertedWithCustomError(ms, "AlreadyExecuted");
    });

    it("执行后再确认应拒绝", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      await ms.connect(owner).execute(0);
      await expect(ms.connect(addr2).confirm(0))
        .to.be.revertedWithCustomError(ms, "AlreadyExecuted");
    });

    it("任何人都可以触发执行（不限于成员）", async function () {
      const { ms, owner, addr1, addr2, outsider } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      await ms.connect(outsider).execute(0);
      expect((await ms.getTransaction(0)).executed).to.equal(true);
    });

    it("目标调用失败时应整笔回滚（ExecutionFailed）", async function () {
      const { ms, market, owner, addr1 } = await loadFixture(deployWithMarketFixture);
      const marketAddr = await market.getAddress();
      // 此时多签还不是市场 owner，pause() 会 revert
      await ms.connect(owner).submit(marketAddr, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(0);
      await expect(ms.connect(owner).execute(0))
        .to.be.revertedWithCustomError(ms, "ExecutionFailed");
      // 关键：失败后提案不能变成"已执行"
      expect((await ms.getTransaction(0)).executed).to.equal(false);
    });
  });

  // ==========================================================================
  // 6. 成员与阈值管理（只能自己调自己）
  // ==========================================================================
  describe("成员与阈值管理", function () {
    it("直接调用 addOwner 应拒绝（必须走多签流程）", async function () {
      const { ms, owner, outsider } = await loadFixture(deployMultisigFixture);
      await expect(ms.connect(owner).addOwner(outsider.address))
        .to.be.revertedWithCustomError(ms, "OnlySelf");
    });

    it("直接调用 removeOwner 应拒绝", async function () {
      const { ms, owner, addr2 } = await loadFixture(deployMultisigFixture);
      await expect(ms.connect(owner).removeOwner(addr2.address))
        .to.be.revertedWithCustomError(ms, "OnlySelf");
    });

    it("直接调用 changeThreshold 应拒绝", async function () {
      const { ms, owner } = await loadFixture(deployMultisigFixture);
      await expect(ms.connect(owner).changeThreshold(3))
        .to.be.revertedWithCustomError(ms, "OnlySelf");
    });

    it("走完多签流程后可以新增成员", async function () {
      const { ms, owner, addr1, outsider } = await loadFixture(deployMultisigFixture);
      const msAddr = await ms.getAddress();
      await ms.connect(owner).submit(msAddr, 0, calldata("addOwner(address)", [outsider.address]));
      await ms.connect(addr1).confirm(0);
      await ms.execute(0);

      expect(await ms.isOwner(outsider.address)).to.equal(true);
      expect((await ms.getOwners()).length).to.equal(4);
    });

    it("走完多签流程后可以移除成员", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      const msAddr = await ms.getAddress();
      await ms.connect(owner).submit(msAddr, 0, calldata("removeOwner(address)", [addr2.address]));
      await ms.connect(addr1).confirm(0);
      await ms.execute(0);

      expect(await ms.isOwner(addr2.address)).to.equal(false);
      expect((await ms.getOwners()).length).to.equal(2);
      // 被移除的人之后不能再提交提案
      await expect(ms.connect(addr2).submit(msAddr, 0, calldata("pause()")))
        .to.be.revertedWithCustomError(ms, "NotAnOwner");
    });

    it("移除成员后若阈值超出人数，阈值应自动下调（防锁死）", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployStrictFixture);
      const msAddr = await ms.getAddress();
      expect(await ms.threshold()).to.equal(3);

      // 3 人 / 阈值 3 → 移除 1 人后剩 2 人，阈值必须降到 2
      await ms.connect(owner).submit(msAddr, 0, calldata("removeOwner(address)", [addr2.address]));
      await ms.connect(addr1).confirm(0);
      await ms.connect(addr2).confirm(0);
      await ms.execute(0);

      expect((await ms.getOwners()).length).to.equal(2);
      expect(await ms.threshold()).to.equal(2);
    });

    it("不能移除最后一个成员（否则权限与资金全部锁死）", async function () {
      const { ms, owner } = await loadFixture(deploySoloFixture);
      const msAddr = await ms.getAddress();
      await ms.connect(owner).submit(msAddr, 0, calldata("removeOwner(address)", [owner.address]));
      // 执行阶段会失败（内部 CannotRemoveLastOwner 被外层包装成 ExecutionFailed）
      await expect(ms.connect(owner).execute(0))
        .to.be.revertedWithCustomError(ms, "ExecutionFailed");
      expect(await ms.isOwner(owner.address)).to.equal(true);
    });

    it("移除不存在的成员应失败", async function () {
      const { ms, owner, addr1, outsider } = await loadFixture(deployMultisigFixture);
      const msAddr = await ms.getAddress();
      await ms.connect(owner).submit(msAddr, 0, calldata("removeOwner(address)", [outsider.address]));
      await ms.connect(addr1).confirm(0);
      await expect(ms.execute(0))
        .to.be.revertedWithCustomError(ms, "ExecutionFailed");
    });

    it("走完多签流程后可以修改阈值", async function () {
      const { ms, owner, addr1 } = await loadFixture(deployMultisigFixture);
      const msAddr = await ms.getAddress();
      await ms.connect(owner).submit(msAddr, 0, calldata("changeThreshold(uint256)", [3]));
      await ms.connect(addr1).confirm(0);
      await ms.execute(0);
      expect(await ms.threshold()).to.equal(3);
    });

    it("阈值改成 0 应失败", async function () {
      const { ms, owner, addr1 } = await loadFixture(deployMultisigFixture);
      const msAddr = await ms.getAddress();
      await ms.connect(owner).submit(msAddr, 0, calldata("changeThreshold(uint256)", [0]));
      await ms.connect(addr1).confirm(0);
      await expect(ms.execute(0))
        .to.be.revertedWithCustomError(ms, "ExecutionFailed");
      expect(await ms.threshold()).to.equal(2);
    });

    it("阈值改成超过人数应失败", async function () {
      const { ms, owner, addr1 } = await loadFixture(deployMultisigFixture);
      const msAddr = await ms.getAddress();
      await ms.connect(owner).submit(msAddr, 0, calldata("changeThreshold(uint256)", [9]));
      await ms.connect(addr1).confirm(0);
      await expect(ms.execute(0))
        .to.be.revertedWithCustomError(ms, "ExecutionFailed");
    });

    it("阈值提高后，原来够的票数就不够了", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      const msAddr = await ms.getAddress();
      // 先把阈值提到 3
      await ms.connect(owner).submit(msAddr, 0, calldata("changeThreshold(uint256)", [3]));
      await ms.connect(addr1).confirm(0);
      await ms.execute(0);

      // 再提交一笔：owner + addr1 两票，现在不够了
      await ms.connect(owner).submit(addr2.address, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(1);
      await expect(ms.execute(1))
        .to.be.revertedWithCustomError(ms, "BelowThreshold")
        .withArgs(2, 3);

      // 第三个成员补票后就能执行
      await ms.connect(addr2).confirm(1);
      await ms.execute(1);
      expect((await ms.getTransaction(1)).executed).to.equal(true);
    });
  });

  // ==========================================================================
  // 7. ETH 收发（手续费最终会进多签）
  // ==========================================================================
  describe("ETH 收发", function () {
    it("应能接收 ETH", async function () {
      const { ms, owner } = await loadFixture(deployMultisigFixture);
      const msAddr = await ms.getAddress();
      await owner.sendTransaction({ to: msAddr, value: ethers.parseEther("1") });
      expect(await ethers.provider.getBalance(msAddr)).to.equal(ethers.parseEther("1"));
    });

    it("接收 ETH 应触发 Received 事件", async function () {
      const { ms, owner } = await loadFixture(deployMultisigFixture);
      const msAddr = await ms.getAddress();
      const amount = ethers.parseEther("0.5");
      await expect(owner.sendTransaction({ to: msAddr, value: amount }))
        .to.emit(ms, "Received")
        .withArgs(owner.address, amount);
    });

    it("多签应能把 ETH 付给外部地址（分钱场景）", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      const msAddr = await ms.getAddress();
      await owner.sendTransaction({ to: msAddr, value: ethers.parseEther("3") });

      const payout = ethers.parseEther("1");
      const before = await ethers.provider.getBalance(addr2.address);

      // data 为空、带 value → 就是一笔纯转账
      await ms.connect(owner).submit(addr2.address, payout, "0x");
      await ms.connect(addr1).confirm(0);
      await ms.execute(0);

      const after = await ethers.provider.getBalance(addr2.address);
      expect(after - before).to.equal(payout);
      expect(await ethers.provider.getBalance(msAddr)).to.equal(ethers.parseEther("2"));
    });

    it("余额不足时转账应失败", async function () {
      const { ms, owner, addr1, addr2 } = await loadFixture(deployMultisigFixture);
      await ms.connect(owner).submit(addr2.address, ethers.parseEther("5"), "0x");
      await ms.connect(addr1).confirm(0);
      await expect(ms.execute(0))
        .to.be.revertedWithCustomError(ms, "ExecutionFailed");
    });
  });

  // ==========================================================================
  // 8. 实战：把 SimpleMarket 的所有权交给多签
  // ==========================================================================
  describe("实战：接管 SimpleMarket", function () {
    it("第一步：现任 owner 提名多签（owner 此时不变）", async function () {
      const { ms, market, owner } = await loadFixture(deployWithMarketFixture);
      const msAddr = await ms.getAddress();
      await market.connect(owner).transferOwnership(msAddr);

      expect(await market.pendingOwner()).to.equal(msAddr);
      // 两步走的关键：提名不等于转让，owner 还是原来那个
      expect(await market.owner()).to.equal(owner.address);
    });

    it("第二步：多签 acceptOwnership，所有权正式移交", async function () {
      const { ms, market, owner, addr1 } = await loadFixture(deployWithMarketFixture);
      const msAddr = await ms.getAddress();
      const marketAddr = await market.getAddress();

      await market.connect(owner).transferOwnership(msAddr);
      await ms.connect(owner).submit(marketAddr, 0, calldata("acceptOwnership()"));
      await ms.connect(addr1).confirm(0);
      await ms.execute(0);

      expect(await market.owner()).to.equal(msAddr);
      expect(await market.pendingOwner()).to.equal(ZERO);
    });

    it("只有 1 票时，acceptOwnership 不应生效", async function () {
      const { ms, market, owner } = await loadFixture(deployWithMarketFixture);
      const msAddr = await ms.getAddress();
      const marketAddr = await market.getAddress();

      await market.connect(owner).transferOwnership(msAddr);
      await ms.connect(owner).submit(marketAddr, 0, calldata("acceptOwnership()"));
      await expect(ms.execute(0)).to.be.revertedWithCustomError(ms, "BelowThreshold");

      expect(await market.owner()).to.equal(owner.address);
    });

    it("接管后，多签可以修改市场费率", async function () {
      const { ms, market, owner, addr1, addr2 } = await loadFixture(deployWithMarketFixture);
      const msAddr = await ms.getAddress();
      const marketAddr = await market.getAddress();

      await market.connect(owner).transferOwnership(msAddr);
      await ms.connect(owner).submit(marketAddr, 0, calldata("acceptOwnership()"));
      await ms.connect(addr1).confirm(0);
      await ms.execute(0);

      const newFee = 300;
      await ms.connect(owner).submit(marketAddr, 0, calldata("setFeeBps(uint256)", [newFee]));
      await ms.connect(addr2).confirm(1);
      await ms.execute(1);

      expect(await market.feeBps()).to.equal(newFee);
    });

    it("接管后，原来的单人账号不能再直接改费率", async function () {
      const { ms, market, owner, addr1 } = await loadFixture(deployWithMarketFixture);
      const msAddr = await ms.getAddress();
      const marketAddr = await market.getAddress();

      await market.connect(owner).transferOwnership(msAddr);
      await ms.connect(owner).submit(marketAddr, 0, calldata("acceptOwnership()"));
      await ms.connect(addr1).confirm(0);
      await ms.execute(0);

      // 这一步是整个多签改造的验收点：老账号必须彻底失效
      await expect(market.connect(owner).setFeeBps(999)).to.be.revertedWithCustomError(
        market,
        "OwnableUnauthorizedAccount"
      );
    });

    it("接管后，多签可以暂停 / 恢复市场", async function () {
      const { ms, market, owner, addr1 } = await loadFixture(deployWithMarketFixture);
      const msAddr = await ms.getAddress();
      const marketAddr = await market.getAddress();

      await market.connect(owner).transferOwnership(msAddr);
      await ms.connect(owner).submit(marketAddr, 0, calldata("acceptOwnership()"));
      await ms.connect(addr1).confirm(0);
      await ms.execute(0);

      await ms.connect(owner).submit(marketAddr, 0, calldata("pause()"));
      await ms.connect(addr1).confirm(1);
      await ms.execute(1);
      expect(await market.paused()).to.equal(true);

      await ms.connect(owner).submit(marketAddr, 0, calldata("unpause()"));
      await ms.connect(addr1).confirm(2);
      await ms.execute(2);
      expect(await market.paused()).to.equal(false);
    });
  });
});
