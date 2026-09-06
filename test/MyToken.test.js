const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * MyToken（ERC20）单元测试
 *
 * 结构说明：
 *   describe  —— 一个功能模块的测试集合（可嵌套分组）
 *   it        —— 一条具体的测试用例（一个断言场景）
 *   beforeEach —— 每条用例执行前的准备动作
 *   loadFixture —— 把"部署合约"这项昂贵操作做成快照，
 *                  首次执行真实部署，之后每条用例直接回滚到快照状态，
 *                  既保证用例之间状态隔离，又避免重复部署（速度快很多）
 */
describe("MyToken (ERC20)", function () {
  // 初始发行量：100 万个整币
  const INITIAL_SUPPLY = 1000000;
  const ZERO_ADDRESS = ethers.ZeroAddress;

  // 单位换算辅助：链上只存最小单位（1 整币 = 1e18 最小单位）
  const toUnits = (n) => ethers.parseUnits(String(n), 18);

  /**
   * fixture：部署一份全新的 MyToken，并返回三个测试账户
   * owner —— 部署者，拥有 onlyOwner 权限
   * addr1 / addr2 —— 普通用户（非 owner），用于转账与权限拒绝用例
   */
  async function deployTokenFixture() {
    const [owner, addr1, addr2] = await ethers.getSigners();
    const MyToken = await ethers.getContractFactory("MyToken");
    const token = await MyToken.deploy(owner.address, INITIAL_SUPPLY);
    await token.waitForDeployment();
    return { token, owner, addr1, addr2 };
  }

  // ============================================================
  // 1. 部署与初始状态
  // ============================================================
  describe("部署与初始状态", function () {
    it("name / symbol / decimals 应正确", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      expect(await token.name()).to.equal("MyToken");
      expect(await token.symbol()).to.equal("MTK");
      expect(await token.decimals()).to.equal(18);
    });

    it("totalSupply 应为 100 万枚（最小单位）", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      expect(await token.totalSupply()).to.equal(toUnits(INITIAL_SUPPLY));
    });

    it("owner 应为部署账户", async function () {
      const { token, owner } = await loadFixture(deployTokenFixture);
      expect(await token.owner()).to.equal(owner.address);
    });

    it("初始发行量应全部归 owner，其他账户为 0", async function () {
      const { token, owner, addr1, addr2 } = await loadFixture(
        deployTokenFixture
      );
      expect(await token.balanceOf(owner.address)).to.equal(
        toUnits(INITIAL_SUPPLY)
      );
      expect(await token.balanceOf(addr1.address)).to.equal(0);
      expect(await token.balanceOf(addr2.address)).to.equal(0);
    });

    it("部署时应从零地址发出 Transfer 事件（铸造语义）", async function () {
      const { token, owner } = await loadFixture(deployTokenFixture);
      // 部署时就在构造函数里铸造，这里重新部署一次以捕获事件
      const MyToken = await ethers.getContractFactory("MyToken");
      const fresh = await MyToken.deploy(owner.address, INITIAL_SUPPLY);
      await fresh.waitForDeployment();
      await expect(fresh.deploymentTransaction())
        .to.emit(fresh, "Transfer")
        .withArgs(ZERO_ADDRESS, owner.address, toUnits(INITIAL_SUPPLY));
    });
  });

  // ============================================================
  // 2. transfer
  // ============================================================
  describe("transfer", function () {
    it("正常转账：双方余额变化，totalSupply 不变", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      const amount = toUnits(1000);
      const supplyBefore = await token.totalSupply();

      await expect(token.transfer(addr1.address, amount)).to.changeTokenBalances(
        token,
        [owner, addr1],
        [-amount, amount]
      );

      expect(await token.totalSupply()).to.equal(supplyBefore);
    });

    it("转账应触发 Transfer 事件", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      const amount = toUnits(100);
      await expect(token.connect(owner).transfer(addr1.address, amount))
        .to.emit(token, "Transfer")
        .withArgs(owner.address, addr1.address, amount);
    });

    it("边界：转账给自己，余额不变但事件照常触发", async function () {
      const { token, owner } = await loadFixture(deployTokenFixture);
      const before = await token.balanceOf(owner.address);
      const amount = toUnits(50);

      await expect(token.transfer(owner.address, amount))
        .to.emit(token, "Transfer")
        .withArgs(owner.address, owner.address, amount);

      expect(await token.balanceOf(owner.address)).to.equal(before);
    });

    it("边界：转账 0，余额不变且允许成功", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      await expect(token.transfer(addr1.address, 0))
        .to.emit(token, "Transfer")
        .withArgs(owner.address, addr1.address, 0);
      expect(await token.balanceOf(addr1.address)).to.equal(0);
    });

    it("拒绝：余额不足时 revert（ERC20InsufficientBalance）", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      const balance = await token.balanceOf(addr1.address); // 0
      const amount = toUnits(1);

      await expect(
        token.connect(addr1).transfer(owner.address, amount)
      )
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(addr1.address, balance, amount);
    });

    it("拒绝：转账到零地址 revert（ERC20InvalidReceiver）", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      await expect(token.transfer(ZERO_ADDRESS, toUnits(1)))
        .to.be.revertedWithCustomError(token, "ERC20InvalidReceiver")
        .withArgs(ZERO_ADDRESS);
    });
  });

  // ============================================================
  // 3. approve + transferFrom
  // ============================================================
  describe("approve 与 transferFrom", function () {
    it("approve 后 allowance 正确，并触发 Approval 事件", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      const amount = toUnits(500);

      await expect(token.approve(addr1.address, amount))
        .to.emit(token, "Approval")
        .withArgs(owner.address, addr1.address, amount);

      expect(await token.allowance(owner.address, addr1.address)).to.equal(
        amount
      );
    });

    it("边界：approve 0 表示撤销授权", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      await token.approve(addr1.address, toUnits(500));
      await token.approve(addr1.address, 0);
      expect(await token.allowance(owner.address, addr1.address)).to.equal(0);

      // 授权归零后代扣应立即失败
      await expect(
        token.connect(addr1).transferFrom(owner.address, addr1.address, 1)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });

    it("代扣成功：资金从 owner 流向收款方，allowance 递减", async function () {
      const { token, owner, addr1, addr2 } = await loadFixture(
        deployTokenFixture
      );
      const allowance = toUnits(500);
      const spend = toUnits(300);
      await token.approve(addr1.address, allowance);

      // addr1 作为 spender 发起，钱从 owner 出，进 addr2 口袋
      await expect(
        token.connect(addr1).transferFrom(owner.address, addr2.address, spend)
      ).to.changeTokenBalances(token, [owner, addr2], [-spend, spend]);

      expect(await token.allowance(owner.address, addr1.address)).to.equal(
        allowance - spend
      );
      expect(await token.balanceOf(addr1.address)).to.equal(0); // spender 自己不获得代币
    });

    it("拒绝：超额代扣 revert（ERC20InsufficientAllowance）", async function () {
      const { token, owner, addr1, addr2 } = await loadFixture(
        deployTokenFixture
      );
      const allowance = toUnits(200);
      const overspend = toUnits(250);
      await token.approve(addr1.address, allowance);

      await expect(
        token
          .connect(addr1)
          .transferFrom(owner.address, addr2.address, overspend)
      )
        .to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance")
        .withArgs(addr1.address, allowance, overspend);
    });

    it("拒绝：未授权就代扣 revert（allowance 为 0）", async function () {
      const { token, owner, addr1, addr2 } = await loadFixture(
        deployTokenFixture
      );
      await expect(
        token.connect(addr1).transferFrom(owner.address, addr2.address, 1)
      )
        .to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance")
        .withArgs(addr1.address, 0, 1);
    });

    it("拒绝：approve 给零地址 revert（ERC20InvalidSpender）", async function () {
      const { token } = await loadFixture(deployTokenFixture);
      await expect(token.approve(ZERO_ADDRESS, toUnits(1)))
        .to.be.revertedWithCustomError(token, "ERC20InvalidSpender")
        .withArgs(ZERO_ADDRESS);
    });
  });

  // ============================================================
  // 4. mint（权限控制）
  // ============================================================
  describe("mint 权限与增发", function () {
    it("owner 可增发：余额与 totalSupply 同步增加", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      const amount = toUnits(5000);
      const supplyBefore = await token.totalSupply();
      const balanceBefore = await token.balanceOf(addr1.address);

      await expect(token.mint(addr1.address, amount))
        .to.emit(token, "Transfer")
        .withArgs(ZERO_ADDRESS, addr1.address, amount);

      expect(await token.balanceOf(addr1.address)).to.equal(
        balanceBefore + amount
      );
      expect(await token.totalSupply()).to.equal(supplyBefore + amount);
    });

    it("拒绝：非 owner 调用 mint revert（OwnableUnauthorizedAccount）", async function () {
      const { token, addr1 } = await loadFixture(deployTokenFixture);
      await expect(token.connect(addr1).mint(addr1.address, toUnits(1)))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(addr1.address);
    });

    it("拒绝：非 owner 增发后 totalSupply 不变", async function () {
      const { token, addr1 } = await loadFixture(deployTokenFixture);
      const supplyBefore = await token.totalSupply();
      await expect(
        token.connect(addr1).mint(addr1.address, toUnits(1))
      ).to.be.reverted;
      expect(await token.totalSupply()).to.equal(supplyBefore);
    });
  });

  // ============================================================
  // 5. burn
  // ============================================================
  describe("burn 销毁", function () {
    it("持币人可用 ERC20Burnable.burn 销毁自己的代币", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      const minted = toUnits(600);
      const burnAmount = toUnits(100);
      await token.transfer(addr1.address, minted);

      const supplyBefore = await token.totalSupply();
      // 注意：合约里同时存在 burn(uint256) 与 burn(address,uint256) 两个重载，
      // 必须用完整签名消除歧义
      await expect(token.connect(addr1)["burn(uint256)"](burnAmount))
        .to.emit(token, "Transfer")
        .withArgs(addr1.address, ZERO_ADDRESS, burnAmount);

      expect(await token.balanceOf(addr1.address)).to.equal(
        minted - burnAmount
      );
      expect(await token.totalSupply()).to.equal(supplyBefore - burnAmount);
    });

    it("owner 可用 burn(address,uint256) 销毁指定地址的代币", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      const given = toUnits(1000);
      const burnAmount = toUnits(400);
      await token.transfer(addr1.address, given);

      const supplyBefore = await token.totalSupply();
      await expect(token["burn(address,uint256)"](addr1.address, burnAmount))
        .to.emit(token, "Transfer")
        .withArgs(addr1.address, ZERO_ADDRESS, burnAmount);

      expect(await token.balanceOf(addr1.address)).to.equal(given - burnAmount);
      expect(await token.totalSupply()).to.equal(supplyBefore - burnAmount);
    });

    it("拒绝：非 owner 调用 burn(address,uint256) revert", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      await token.transfer(addr1.address, toUnits(100));
      await expect(
        token.connect(addr1)["burn(address,uint256)"](owner.address, 1)
      )
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(addr1.address);
    });

    it("拒绝：销毁数量超过余额 revert（ERC20InsufficientBalance）", async function () {
      const { token, addr1 } = await loadFixture(deployTokenFixture);
      const balance = await token.balanceOf(addr1.address); // 0
      await expect(token.connect(addr1)["burn(uint256)"](1))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(addr1.address, balance, 1);
    });

    it("拒绝：owner 超额销毁他人代币 revert", async function () {
      const { token, owner, addr1 } = await loadFixture(deployTokenFixture);
      await token.transfer(addr1.address, toUnits(10));
      const balance = await token.balanceOf(addr1.address);
      const tooMuch = toUnits(999);
      await expect(token["burn(address,uint256)"](addr1.address, tooMuch))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(addr1.address, balance, tooMuch);
    });
  });

  // ============================================================
  // 6. 综合：代币守恒
  // ============================================================
  describe("综合：供应量守恒", function () {
    it("多轮转账 + 增发 + 销毁后，各账户余额之和恒等于 totalSupply", async function () {
      const { token, owner, addr1, addr2 } = await loadFixture(
        deployTokenFixture
      );

      await token.transfer(addr1.address, toUnits(10000));
      await token.transfer(addr2.address, toUnits(20000));
      await token.mint(addr1.address, toUnits(5000));
      await token.connect(addr1)["burn(uint256)"](toUnits(500));

      const sum =
        (await token.balanceOf(owner.address)) +
        (await token.balanceOf(addr1.address)) +
        (await token.balanceOf(addr2.address));

      expect(sum).to.equal(await token.totalSupply());
    });

    it("授权额度可被多次代扣，累计不超过授权上限", async function () {
      const { token, owner, addr1, addr2 } = await loadFixture(
        deployTokenFixture
      );
      await token.approve(addr1.address, toUnits(100));

      await token.connect(addr1).transferFrom(owner.address, addr2.address, toUnits(60));
      await token.connect(addr1).transferFrom(owner.address, addr2.address, toUnits(40));
      expect(await token.allowance(owner.address, addr1.address)).to.equal(0);

      // 额度用尽后再代扣必然失败
      await expect(
        token.connect(addr1).transferFrom(owner.address, addr2.address, 1)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });
  });
});
