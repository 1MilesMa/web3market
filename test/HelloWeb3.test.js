const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * HelloWeb3（链上留言板）单元测试
 *
 * 与 MyToken 的区别：本合约没有权限控制，任何人都能写留言，
 * 因此测试重点是「状态变化」「历史记录」与「输入校验的 revert」。
 */
describe("HelloWeb3 (链上留言板)", function () {
  const INITIAL_MESSAGE = "Hello Web3 —— 我的第一个智能合约";

  async function deployHelloWeb3Fixture() {
    const [owner, addr1, addr2] = await ethers.getSigners();
    const HelloWeb3 = await ethers.getContractFactory("HelloWeb3");
    const hello = await HelloWeb3.deploy(INITIAL_MESSAGE);
    await hello.waitForDeployment();
    return { hello, owner, addr1, addr2 };
  }

  // ============================================================
  // 1. 部署初始状态
  // ============================================================
  describe("部署与初始状态", function () {
    it("初始留言应为构造函数传入的内容", async function () {
      const { hello } = await loadFixture(deployHelloWeb3Fixture);
      expect(await hello.getMessage()).to.equal(INITIAL_MESSAGE);
    });

    it("初始历史条数为 1，更新次数为 0", async function () {
      const { hello } = await loadFixture(deployHelloWeb3Fixture);
      expect(await hello.historyLength()).to.equal(1);
      expect(await hello.updateCount()).to.equal(0);
    });

    it("owner 应为部署账户", async function () {
      const { hello, owner } = await loadFixture(deployHelloWeb3Fixture);
      expect(await hello.owner()).to.equal(owner.address);
    });

    it("部署时应触发 MessageUpdated 事件（index = 0）", async function () {
      const [owner] = await ethers.getSigners();
      const HelloWeb3 = await ethers.getContractFactory("HelloWeb3");
      const hello = await HelloWeb3.deploy(INITIAL_MESSAGE);
      await hello.waitForDeployment();

      await expect(hello.deploymentTransaction())
        .to.emit(hello, "MessageUpdated")
        .withArgs(owner.address, INITIAL_MESSAGE, anyValue(), 0);
    });

    it("getEntry(0) 应返回初始留言及作者、时间戳", async function () {
      const { hello, owner } = await loadFixture(deployHelloWeb3Fixture);
      const entry = await hello.getEntry(0);
      expect(entry.content).to.equal(INITIAL_MESSAGE);
      expect(entry.author).to.equal(owner.address);
      expect(entry.timestamp).to.be.greaterThan(0);
    });
  });

  // ============================================================
  // 2. 写入与读取
  // ============================================================
  describe("setMessage 写入", function () {
    it("写入后最新留言立即更新", async function () {
      const { hello } = await loadFixture(deployHelloWeb3Fixture);
      const newMsg = "第二条留言";
      await hello.setMessage(newMsg);
      expect(await hello.getMessage()).to.equal(newMsg);
    });

    it("每次写入 updateCount +1、historyLength +1", async function () {
      const { hello } = await loadFixture(deployHelloWeb3Fixture);
      await hello.setMessage("A");
      expect(await hello.updateCount()).to.equal(1);
      expect(await hello.historyLength()).to.equal(2);

      await hello.setMessage("B");
      expect(await hello.updateCount()).to.equal(2);
      expect(await hello.historyLength()).to.equal(3);
    });

    it("事件参数应包含作者、内容、时间戳与自增序号", async function () {
      const { hello, addr1 } = await loadFixture(deployHelloWeb3Fixture);
      await expect(hello.connect(addr1).setMessage("来自 addr1 的留言"))
        .to.emit(hello, "MessageUpdated")
        .withArgs(addr1.address, "来自 addr1 的留言", anyValue(), 1);
    });

    it("任何地址都可以留言（本合约无权限限制）", async function () {
      const { hello, addr1, addr2 } = await loadFixture(deployHelloWeb3Fixture);
      await hello.connect(addr1).setMessage("addr1 说你好");
      await hello.connect(addr2).setMessage("addr2 也说你好");
      expect(await hello.getMessage()).to.equal("addr2 也说你好");
      expect(await hello.historyLength()).to.equal(3);
    });
  });

  // ============================================================
  // 3. 历史记录
  // ============================================================
  describe("历史记录", function () {
    it("历史记录按写入顺序保存，作者各自记录", async function () {
      const { hello, owner, addr1 } = await loadFixture(deployHelloWeb3Fixture);
      await hello.connect(addr1).setMessage("第二条");
      await hello.setMessage("第三条");

      const e0 = await hello.getEntry(0);
      const e1 = await hello.getEntry(1);
      const e2 = await hello.getEntry(2);

      expect(e0.content).to.equal(INITIAL_MESSAGE);
      expect(e0.author).to.equal(owner.address);
      expect(e1.content).to.equal("第二条");
      expect(e1.author).to.equal(addr1.address);
      expect(e2.content).to.equal("第三条");
      expect(e2.author).to.equal(owner.address);
    });

    it("时间戳应递增（后写入的不早于先写入的）", async function () {
      const { hello } = await loadFixture(deployHelloWeb3Fixture);
      await hello.setMessage("第二条");
      const e0 = await hello.getEntry(0);
      const e1 = await hello.getEntry(1);
      expect(e1.timestamp).to.be.greaterThanOrEqual(e0.timestamp);
    });

    it("拒绝：读取越界历史 revert（index out of range）", async function () {
      const { hello } = await loadFixture(deployHelloWeb3Fixture);
      await expect(hello.getEntry(1)).to.be.revertedWith("index out of range");
      await expect(hello.getEntry(999)).to.be.revertedWith(
        "index out of range"
      );
    });
  });

  // ============================================================
  // 4. 输入校验（revert 路径）
  // ============================================================
  describe("输入校验", function () {
    it("拒绝：空留言 revert（message cannot be empty）", async function () {
      const { hello } = await loadFixture(deployHelloWeb3Fixture);
      await expect(hello.setMessage("")).to.be.revertedWith(
        "message cannot be empty"
      );
    });

    it("拒绝：超过 280 字符的留言 revert（message too long）", async function () {
      const { hello } = await loadFixture(deployHelloWeb3Fixture);
      const tooLong = "x".repeat(281);
      await expect(hello.setMessage(tooLong)).to.be.revertedWith(
        "message too long (max 280)"
      );
    });

    it("边界：恰好 280 字符应被接受", async function () {
      const { hello } = await loadFixture(deployHelloWeb3Fixture);
      const exactly280 = "y".repeat(280);
      await expect(hello.setMessage(exactly280)).to.emit(
        hello,
        "MessageUpdated"
      );
      expect(await hello.getMessage()).to.equal(exactly280);
    });

    it("拒绝：留言被拒时历史记录不会增加", async function () {
      const { hello } = await loadFixture(deployHelloWeb3Fixture);
      await expect(hello.setMessage("")).to.be.reverted;
      expect(await hello.historyLength()).to.equal(1);
      expect(await hello.updateCount()).to.equal(0);
    });
  });
});

/**
 * 小工具：用于事件断言中"不关心具体值"的占位符。
 * chai matchers 支持传入函数作为谓词，返回 true 即视为匹配。
 * 这里用于忽略区块时间戳这类动态值。
 */
function anyValue() {
  return () => true;
}
