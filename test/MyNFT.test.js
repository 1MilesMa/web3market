const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * MyNFT（ERC721）单元测试
 *
 * ERC721 与 ERC20 测试的最大不同：
 *   ERC20 断言的是"数量"（balanceOf 变化多少）
 *   ERC721 断言的是"归属"（某个 tokenId 的 ownerOf 是谁）+ "数量"（balanceOf 有几个）
 * 所以每条转账用例都要同时检查 ownerOf 与 balanceOf 两侧，缺一不可。
 */
describe("MyNFT (ERC721)", function () {
  // ---- 常量 ----
  const MAX_SUPPLY = 10000;
  const ZERO_ADDRESS = ethers.ZeroAddress;

  const URI_1 = "ipfs://QmTest1111111111111111111111111111111111111111/1.json";
  const URI_2 = "ipfs://QmTest2222222222222222222222222222222222222222/2.json";
  const URI_3 = "ipfs://QmTest3333333333333333333333333333333333333333/3.json";

  // ERC165 接口 ID（接口内所有函数选择器的异或值）
  const IFACE = {
    ERC721: "0x80ac58cd",
    ERC721Metadata: "0x5b5e139f",
    ERC721Enumerable: "0x780e9d63",
    ERC4906: "0x49064906",
    ERC2981: "0x2a55205a",
  };

  /** 该 fixture 用的版税率：5%（分母 10000） */
  const ROYALTY_BPS = 500;

  /**
   * fixture：部署一份全新的 MyNFT
   * owner —— 部署者，拥有 onlyOwner 权限（safeMint / setPublicMintEnabled / 版税设置）
   * addr1 / addr2 —— 普通用户，用于转账、授权与权限拒绝用例
   *
   * 版税接收者默认设为 addr2，方便测试 royaltyInfo 与版税提取。
   */
  async function deployNFTFixture() {
    const [owner, addr1, addr2] = await ethers.getSigners();
    const MyNFT = await ethers.getContractFactory("MyNFT");
    const nft = await MyNFT.deploy(owner.address, MAX_SUPPLY, addr2.address, ROYALTY_BPS);
    await nft.waitForDeployment();
    return { nft, owner, addr1, addr2 };
  }

  /** 专门用于测试"供应上限"的 fixture：上限只有 2 个 */
  async function deploySmallSupplyFixture() {
    const [owner, addr1] = await ethers.getSigners();
    const MyNFT = await ethers.getContractFactory("MyNFT");
    const nft = await MyNFT.deploy(owner.address, 2, addr1.address, ROYALTY_BPS);
    await nft.waitForDeployment();
    return { nft, owner, addr1 };
  }

  // ==========================================================================
  // 1. 部署与初始状态
  // ==========================================================================
  describe("部署与初始状态", function () {
    it("name / symbol 应正确", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.name()).to.equal("MyNFT");
      expect(await nft.symbol()).to.equal("MNFT");
    });

    it("owner 应为部署账户", async function () {
      const { nft, owner } = await loadFixture(deployNFTFixture);
      expect(await nft.owner()).to.equal(owner.address);
    });

    it("maxSupply 应为构造时传入的值", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.maxSupply()).to.equal(MAX_SUPPLY);
    });

    it("初始状态：totalSupply / totalMinted 为 0，nextTokenId 为 1", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.totalSupply()).to.equal(0);
      expect(await nft.totalMinted()).to.equal(0);
      expect(await nft.nextTokenId()).to.equal(1);
    });

    it("初始状态：公开铸造默认关闭", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.publicMintEnabled()).to.equal(false);
    });

    it("支持 ERC721 与 ERC721Metadata 接口", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.supportsInterface(IFACE.ERC721)).to.equal(true);
      expect(await nft.supportsInterface(IFACE.ERC721Metadata)).to.equal(true);
    });

    it("支持 ERC721Enumerable 与 ERC4906 接口（多继承覆写生效）", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.supportsInterface(IFACE.ERC721Enumerable)).to.equal(true);
      expect(await nft.supportsInterface(IFACE.ERC4906)).to.equal(true);
    });

    it("拒绝：构造时 maxSupply 为 0 revert", async function () {
      const [owner] = await ethers.getSigners();
      const MyNFT = await ethers.getContractFactory("MyNFT");
      await expect(
        MyNFT.deploy(owner.address, 0, ZERO_ADDRESS, 0)
      ).to.be.revertedWith("maxSupply must be > 0");
    });

    it("不支持的随机接口应返回 false", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  // ==========================================================================
  // 2. safeMint 铸造
  // ==========================================================================
  describe("safeMint 铸造", function () {
    it("owner 铸造：ownerOf 与 balanceOf 正确，totalSupply 增加", async function () {
      const { nft, owner, addr1 } = await loadFixture(deployNFTFixture);

      await nft.safeMint(addr1.address, URI_1);

      expect(await nft.ownerOf(1)).to.equal(addr1.address);
      expect(await nft.balanceOf(addr1.address)).to.equal(1);
      expect(await nft.balanceOf(owner.address)).to.equal(0);
      expect(await nft.totalSupply()).to.equal(1);
    });

    it("铸造应从零地址发出 Transfer 事件", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await expect(nft.safeMint(addr1.address, URI_1))
        .to.emit(nft, "Transfer")
        .withArgs(ZERO_ADDRESS, addr1.address, 1);
    });

    it("tokenId 从 1 开始自增，totalMinted 同步递增", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.safeMint(addr1.address, URI_2);

      expect(await nft.ownerOf(1)).to.equal(addr1.address);
      expect(await nft.ownerOf(2)).to.equal(addr1.address);
      expect(await nft.nextTokenId()).to.equal(3);
      expect(await nft.totalMinted()).to.equal(2);
    });

    it("tokenURI 应为铸造时传入的 metadata 链接", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      expect(await nft.tokenURI(1)).to.equal(URI_1);
    });

    it("拒绝：非 owner 铸造 revert（OwnableUnauthorizedAccount）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await expect(nft.connect(addr1).safeMint(addr1.address, URI_1))
        .to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount")
        .withArgs(addr1.address);
    });

    it("拒绝：空 tokenURI revert（EmptyTokenURI）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await expect(
        nft.safeMint(addr1.address, "")
      ).to.be.revertedWithCustomError(nft, "EmptyTokenURI");
    });

    it("拒绝：铸造给零地址 revert（ERC721InvalidReceiver）", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      await expect(nft.safeMint(ZERO_ADDRESS, URI_1))
        .to.be.revertedWithCustomError(nft, "ERC721InvalidReceiver")
        .withArgs(ZERO_ADDRESS);
    });

    it("拒绝：超过供应上限 revert（ExceedsMaxSupply）", async function () {
      const { nft, addr1 } = await loadFixture(deploySmallSupplyFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.safeMint(addr1.address, URI_2);
      expect(await nft.totalSupply()).to.equal(2);

      await expect(nft.safeMint(addr1.address, URI_3))
        .to.be.revertedWithCustomError(nft, "ExceedsMaxSupply")
        .withArgs(3, 2);
    });
  });

  // ==========================================================================
  // 3. publicMint 公开铸造
  // ==========================================================================
  describe("publicMint 公开铸造", function () {
    it("拒绝：开关未打开时 revert（PublicMintDisabled）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await expect(
        nft.connect(addr1).publicMint(URI_1)
      ).to.be.revertedWithCustomError(nft, "PublicMintDisabled");
    });

    it("开启后任何人可铸造，且铸造给 msg.sender", async function () {
      const { nft, owner, addr1 } = await loadFixture(deployNFTFixture);
      await nft.setPublicMintEnabled(true);
      expect(await nft.publicMintEnabled()).to.equal(true);

      await nft.connect(addr1).publicMint(URI_1);
      expect(await nft.ownerOf(1)).to.equal(addr1.address);
      expect(await nft.balanceOf(addr1.address)).to.equal(1);
    });

    it("公开铸造不影响 owner 归属，且切换开关会发出事件", async function () {
      const { nft, owner } = await loadFixture(deployNFTFixture);
      await expect(nft.setPublicMintEnabled(true))
        .to.emit(nft, "PublicMintToggled")
        .withArgs(true);
      expect(await nft.owner()).to.equal(owner.address);
    });

    it("拒绝：非 owner 切换开关 revert（OwnableUnauthorizedAccount）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await expect(nft.connect(addr1).setPublicMintEnabled(true))
        .to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount")
        .withArgs(addr1.address);
    });
  });

  // ==========================================================================
  // 4. tokenId 唯一性
  // ==========================================================================
  describe("tokenId 唯一性", function () {
    it("owner 可指定 tokenId 铸造", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await nft.adminMintWithTokenId(addr1.address, 42, URI_1);
      expect(await nft.ownerOf(42)).to.equal(addr1.address);
      expect(await nft.totalSupply()).to.equal(1);
    });

    it("拒绝：重复 tokenId 铸造 revert（ERC721InvalidSender）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await nft.adminMintWithTokenId(addr1.address, 42, URI_1);

      // 同一个 tokenId 已被占用，_mint 检测到 previousOwner != 0，抛 ERC721InvalidSender
      await expect(nft.adminMintWithTokenId(addr1.address, 42, URI_2))
        .to.be.revertedWithCustomError(nft, "ERC721InvalidSender")
        .withArgs(ZERO_ADDRESS);
    });

    it("拒绝：指定 tokenId 铸造时空 URI revert（EmptyTokenURI）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await expect(
        nft.adminMintWithTokenId(addr1.address, 42, "")
      ).to.be.revertedWithCustomError(nft, "EmptyTokenURI");
    });

    it("拒绝：非 owner 指定 tokenId 铸造 revert", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await expect(nft.connect(addr1).adminMintWithTokenId(addr1.address, 42, URI_1))
        .to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount")
        .withArgs(addr1.address);
    });
  });

  // ==========================================================================
  // 5. 转账：transferFrom 与 safeTransferFrom
  // ==========================================================================
  describe("转账", function () {
    it("持有者可用 transferFrom 转出：归属与余额同步变化", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);

      await nft.connect(addr1).transferFrom(addr1.address, addr2.address, 1);

      expect(await nft.ownerOf(1)).to.equal(addr2.address);
      expect(await nft.balanceOf(addr1.address)).to.equal(0);
      expect(await nft.balanceOf(addr2.address)).to.equal(1);
      expect(await nft.totalSupply()).to.equal(1); // 转账不改变总量
    });

    it("转账应触发 Transfer 事件", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await expect(nft.connect(addr1).transferFrom(addr1.address, addr2.address, 1))
        .to.emit(nft, "Transfer")
        .withArgs(addr1.address, addr2.address, 1);
    });

    it("safeTransferFrom 与 transferFrom 结果一致（对 EOA 无额外检查）", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.connect(addr1)["safeTransferFrom(address,address,uint256)"](
        addr1.address,
        addr2.address,
        1
      );
      expect(await nft.ownerOf(1)).to.equal(addr2.address);
    });

    it("拒绝：未授权者转账他人 NFT revert（ERC721InsufficientApproval）", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);

      await expect(
        nft.connect(addr2).transferFrom(addr1.address, addr2.address, 1)
      )
        .to.be.revertedWithCustomError(nft, "ERC721InsufficientApproval")
        .withArgs(addr2.address, 1);
    });

    it("拒绝：from 参数与真实持有者不符 revert（ERC721IncorrectOwner）", async function () {
      const { nft, owner, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      // addr1 先把 token 1 授权给 addr2，让 addr2 通过权限检查
      await nft.connect(addr1).approve(addr2.address, 1);
      // 但 addr2 把 from 故意写成 owner（真持有者是 addr1）
      await expect(
        nft.connect(addr2).transferFrom(owner.address, addr2.address, 1)
      )
        .to.be.revertedWithCustomError(nft, "ERC721IncorrectOwner")
        .withArgs(owner.address, 1, addr1.address);
    });

    it("拒绝：转账到零地址 revert（ERC721InvalidReceiver）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await expect(nft.connect(addr1).transferFrom(addr1.address, ZERO_ADDRESS, 1))
        .to.be.revertedWithCustomError(nft, "ERC721InvalidReceiver")
        .withArgs(ZERO_ADDRESS);
    });

    it("拒绝：转账不存在的 tokenId revert（ERC721NonexistentToken）", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await expect(
        nft.connect(addr1).transferFrom(addr1.address, addr2.address, 999)
      )
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
        .withArgs(999);
    });
  });

  // ==========================================================================
  // 6. 授权：approve 与 setApprovalForAll
  // ==========================================================================
  describe("授权", function () {
    it("approve 后 getApproved 正确，并触发 Approval 事件", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);

      await expect(nft.connect(addr1).approve(addr2.address, 1))
        .to.emit(nft, "Approval")
        .withArgs(addr1.address, addr2.address, 1);

      expect(await nft.getApproved(1)).to.equal(addr2.address);
    });

    it("被授权者可代持转账，转账后授权自动清空", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.connect(addr1).approve(addr2.address, 1);

      await nft.connect(addr2).transferFrom(addr1.address, addr2.address, 1);

      expect(await nft.ownerOf(1)).to.equal(addr2.address);
      expect(await nft.getApproved(1)).to.equal(ZERO_ADDRESS);
    });

    it("拒绝：非持有者调用 approve revert（ERC721InvalidApprover）", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await expect(nft.connect(addr2).approve(addr2.address, 1))
        .to.be.revertedWithCustomError(nft, "ERC721InvalidApprover")
        .withArgs(addr2.address);
    });

    it("拒绝：approve 不存在的 tokenId revert（ERC721NonexistentToken）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await expect(nft.connect(addr1).approve(addr1.address, 1))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
        .withArgs(1);
    });

    it("setApprovalForAll 授权后，operator 可转走该持有者的任意 NFT", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.safeMint(addr1.address, URI_2);

      await expect(nft.connect(addr1).setApprovalForAll(addr2.address, true))
        .to.emit(nft, "ApprovalForAll")
        .withArgs(addr1.address, addr2.address, true);
      expect(await nft.isApprovedForAll(addr1.address, addr2.address)).to.equal(
        true
      );

      await nft.connect(addr2).transferFrom(addr1.address, addr2.address, 1);
      await nft.connect(addr2).transferFrom(addr1.address, addr2.address, 2);

      expect(await nft.balanceOf(addr1.address)).to.equal(0);
      expect(await nft.balanceOf(addr2.address)).to.equal(2);
    });

    it("setApprovalForAll 可撤销授权", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.connect(addr1).setApprovalForAll(addr2.address, true);
      await nft.connect(addr1).setApprovalForAll(addr2.address, false);
      expect(await nft.isApprovedForAll(addr1.address, addr2.address)).to.equal(
        false
      );

      await expect(
        nft.connect(addr2).transferFrom(addr1.address, addr2.address, 1)
      ).to.be.revertedWithCustomError(nft, "ERC721InsufficientApproval");
    });

    it("拒绝：把零地址设为 operator revert（ERC721InvalidOperator）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await expect(nft.connect(addr1).setApprovalForAll(ZERO_ADDRESS, true))
        .to.be.revertedWithCustomError(nft, "ERC721InvalidOperator")
        .withArgs(ZERO_ADDRESS);
    });
  });

  // ==========================================================================
  // 7. ERC721Enumerable 枚举
  // ==========================================================================
  describe("Enumerable 枚举", function () {
    it("tokenOfOwnerByIndex 应返回该地址持有的第 N 个 tokenId", async function () {
      const { nft, owner, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1); // #1 -> addr1
      await nft.safeMint(addr1.address, URI_2); // #2 -> addr1
      await nft.safeMint(addr2.address, URI_3); // #3 -> addr2

      expect(await nft.tokenOfOwnerByIndex(addr1.address, 0)).to.equal(1);
      expect(await nft.tokenOfOwnerByIndex(addr1.address, 1)).to.equal(2);
      expect(await nft.tokenOfOwnerByIndex(addr2.address, 0)).to.equal(3);
      expect(await nft.balanceOf(addr1.address)).to.equal(2);
    });

    it("tokenByIndex 与 totalSupply 配合可遍历全部 NFT", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.safeMint(addr1.address, URI_2);

      const total = await nft.totalSupply();
      expect(total).to.equal(2);
      expect(await nft.tokenByIndex(0)).to.equal(1);
      expect(await nft.tokenByIndex(1)).to.equal(2);
    });

    it("拒绝：tokenOfOwnerByIndex 越界 revert（ERC721OutOfBoundsIndex）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);

      await expect(nft.tokenOfOwnerByIndex(addr1.address, 1))
        .to.be.revertedWithCustomError(nft, "ERC721OutOfBoundsIndex")
        .withArgs(addr1.address, 1);
    });

    it("拒绝：对空地址调用 tokenOfOwnerByIndex 越界 revert", async function () {
      const { nft, addr2 } = await loadFixture(deployNFTFixture);
      await expect(nft.tokenOfOwnerByIndex(addr2.address, 0))
        .to.be.revertedWithCustomError(nft, "ERC721OutOfBoundsIndex")
        .withArgs(addr2.address, 0);
    });

    it("拒绝：tokenByIndex 全局越界 revert（owner 为零地址）", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      await expect(nft.tokenByIndex(0))
        .to.be.revertedWithCustomError(nft, "ERC721OutOfBoundsIndex")
        .withArgs(ZERO_ADDRESS, 0);
    });

    it("转账后枚举结果随之更新", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.connect(addr1).transferFrom(addr1.address, addr2.address, 1);

      // addr1 已无 NFT，addr2 的 0 号索引变成 tokenId 1
      expect(await nft.tokenOfOwnerByIndex(addr2.address, 0)).to.equal(1);
      await expect(nft.tokenOfOwnerByIndex(addr1.address, 0))
        .to.be.revertedWithCustomError(nft, "ERC721OutOfBoundsIndex");
    });
  });

  // ==========================================================================
  // 8. burn 销毁
  // ==========================================================================
  describe("burn 销毁", function () {
    it("持有者可销毁自己的 NFT，totalSupply 减少", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);

      await nft.connect(addr1).burn(1);

      expect(await nft.totalSupply()).to.equal(0);
      expect(await nft.balanceOf(addr1.address)).to.equal(0);
    });

    it("销毁后 ownerOf 该 tokenId 应 revert", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.connect(addr1).burn(1);

      await expect(nft.ownerOf(1))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
        .withArgs(1);
    });

    it("销毁不会回退 totalMinted（它是历史累计值）", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.connect(addr1).burn(1);

      expect(await nft.totalMinted()).to.equal(1);
      expect(await nft.totalSupply()).to.equal(0);
    });

    it("被授权者可代持有者销毁", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);
      await nft.connect(addr1).approve(addr2.address, 1);

      await nft.connect(addr2).burn(1);
      expect(await nft.totalSupply()).to.equal(0);
    });

    it("拒绝：无权限者销毁 revert（NotAuthorizedToBurn）", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);

      await expect(nft.connect(addr2).burn(1))
        .to.be.revertedWithCustomError(nft, "NotAuthorizedToBurn")
        .withArgs(addr2.address, 1);
    });

    it("拒绝：销毁不存在的 tokenId revert（ERC721NonexistentToken）", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      await expect(nft.burn(1))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
        .withArgs(1);
    });
  });

  // ==========================================================================
  // 9. 查询不存在的 tokenId
  // ==========================================================================
  describe("查询不存在的 tokenId", function () {
    it("ownerOf 不存在的 tokenId revert（ERC721NonexistentToken）", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      await expect(nft.ownerOf(1))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
        .withArgs(1);
    });

    it("tokenURI 不存在的 tokenId revert（ERC721NonexistentToken）", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      await expect(nft.tokenURI(1))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
        .withArgs(1);
    });

    it("getApproved 不存在的 tokenId revert（ERC721NonexistentToken）", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      await expect(nft.getApproved(1))
        .to.be.revertedWithCustomError(nft, "ERC721NonexistentToken")
        .withArgs(1);
    });

    it("balanceOf 零地址 revert（ERC721InvalidOwner）", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      await expect(nft.balanceOf(ZERO_ADDRESS))
        .to.be.revertedWithCustomError(nft, "ERC721InvalidOwner")
        .withArgs(ZERO_ADDRESS);
    });
  });

  // ==========================================================================
  // 10. 版税（EIP-2981）
  //
  // 要验证的：
  //   1. 接口自报家门：supportsInterface(0x2a55205a) == true
  //   2. royaltyInfo 的返回值（接收者 + 金额）算得对，且随 salePrice 线性变化
  //   3. 默认版税 / 单枚版税 / 清除单枚版税后回退默认
  //   4. 权限与越界校验（只有 owner 能改，版税率不能超过分母，接收者不能是零地址）
  // ==========================================================================
  describe("版税（EIP-2981）", function () {
    const SALE_PRICE = ethers.parseEther("1");

    /** 把 bps 换算成金额：salePrice * bps / 10000 */
    const calcRoyalty = (salePrice, bps) => (BigInt(salePrice) * BigInt(bps)) / 10000n;

    it("应支持 ERC2981 接口（0x2a55205a）", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.supportsInterface(IFACE.ERC2981)).to.equal(true);
    });

    it("royaltyDenominator 应为 10000", async function () {
      const { nft } = await loadFixture(deployNFTFixture);
      expect(await nft.royaltyDenominator()).to.equal(10000);
    });

    it("royaltyInfo 应返回构造时设置的接收者与 5% 金额", async function () {
      const { nft, addr2 } = await loadFixture(deployNFTFixture);

      const [receiver, amount] = await nft.royaltyInfo(1, SALE_PRICE);
      expect(receiver).to.equal(addr2.address);
      expect(amount).to.equal(calcRoyalty(SALE_PRICE, ROYALTY_BPS));
    });

    it("royaltyInfo 的金额应随成交价线性变化", async function () {
      const { nft } = await loadFixture(deployNFTFixture);

      const [_, amount1] = await nft.royaltyInfo(1, SALE_PRICE);
      const [__, amount2] = await nft.royaltyInfo(1, SALE_PRICE * 2n);
      expect(amount2).to.equal(amount1 * 2n);

      // 小额也能算（整数除法向下取整，1 wei 的 5% 是 0）
      const [___, tiny] = await nft.royaltyInfo(1, 19);
      expect(tiny).to.equal(0);
    });

    it("owner 可修改默认版税，并发出 DefaultRoyaltyUpdated", async function () {
      const { nft, owner, addr1 } = await loadFixture(deployNFTFixture);

      await expect(nft.connect(owner).setDefaultRoyalty(addr1.address, 750)) // 7.5%
        .to.emit(nft, "DefaultRoyaltyUpdated")
        .withArgs(addr1.address, 750);

      const [receiver, amount] = await nft.royaltyInfo(1, SALE_PRICE);
      expect(receiver).to.equal(addr1.address);
      expect(amount).to.equal(calcRoyalty(SALE_PRICE, 750));
    });

    it("拒绝：非 owner 修改默认版税 revert（OwnableUnauthorizedAccount）", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);

      await expect(
        nft.connect(addr1).setDefaultRoyalty(addr2.address, 500)
      ).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    });

    it("拒绝：版税率超过分母（10001）revert（ERC2981InvalidDefaultRoyalty）", async function () {
      const { nft, owner, addr1 } = await loadFixture(deployNFTFixture);

      await expect(
        nft.connect(owner).setDefaultRoyalty(addr1.address, 10001)
      ).to.be.revertedWithCustomError(nft, "ERC2981InvalidDefaultRoyalty");
    });

    it("拒绝：版税接收者为零地址 revert（ERC2981InvalidDefaultRoyaltyReceiver）", async function () {
      const { nft, owner } = await loadFixture(deployNFTFixture);

      await expect(
        nft.connect(owner).setDefaultRoyalty(ZERO_ADDRESS, 500)
      ).to.be.revertedWithCustomError(nft, "ERC2981InvalidDefaultRoyaltyReceiver");
    });

    it("单枚版税优先于默认版税，并发出 TokenRoyaltyUpdated", async function () {
      const { nft, owner, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1); // #1
      await nft.safeMint(addr1.address, URI_2); // #2

      await expect(nft.connect(owner).setTokenRoyalty(1, addr2.address, 1000)) // 10%
        .to.emit(nft, "TokenRoyaltyUpdated")
        .withArgs(1, addr2.address, 1000);

      // #1 走单枚版税 10%，#2 仍是默认 5%
      const [r1, a1] = await nft.royaltyInfo(1, SALE_PRICE);
      const [r2, a2] = await nft.royaltyInfo(2, SALE_PRICE);
      expect(r1).to.equal(addr2.address);
      expect(a1).to.equal(calcRoyalty(SALE_PRICE, 1000));
      expect(a2).to.equal(calcRoyalty(SALE_PRICE, ROYALTY_BPS));
    });

    it("清除单枚版税后应回退到默认版税（emit TokenRoyaltyReset）", async function () {
      const { nft, owner, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.safeMint(addr1.address, URI_1);

      await nft.connect(owner).setTokenRoyalty(1, addr2.address, 1000);
      expect((await nft.royaltyInfo(1, SALE_PRICE))[1]).to.equal(calcRoyalty(SALE_PRICE, 1000));

      await expect(nft.connect(owner).resetTokenRoyalty(1))
        .to.emit(nft, "TokenRoyaltyReset")
        .withArgs(1);

      // 回退到默认 5%（接收者也回到默认的 addr2）
      const [receiver, amount] = await nft.royaltyInfo(1, SALE_PRICE);
      expect(receiver).to.equal(addr2.address);
      expect(amount).to.equal(calcRoyalty(SALE_PRICE, ROYALTY_BPS));
    });

    it("拒绝：非 owner 设置单枚版税 revert（OwnableUnauthorizedAccount）", async function () {
      const { nft, addr1, addr2 } = await loadFixture(deployNFTFixture);

      await expect(
        nft.connect(addr1).setTokenRoyalty(1, addr2.address, 500)
      ).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    });

    it("拒绝：非 owner 清除单枚版税 revert（OwnableUnauthorizedAccount）", async function () {
      const { nft, owner, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.connect(owner).setTokenRoyalty(1, addr2.address, 1000);

      await expect(
        nft.connect(addr1).resetTokenRoyalty(1)
      ).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    });

    it("拒绝：单枚版税接收者为零地址 revert（ERC2981InvalidTokenRoyaltyReceiver）", async function () {
      const { nft, owner } = await loadFixture(deployNFTFixture);

      await expect(
        nft.connect(owner).setTokenRoyalty(1, ZERO_ADDRESS, 500)
      ).to.be.revertedWithCustomError(nft, "ERC2981InvalidTokenRoyaltyReceiver");
    });

    it("构造时版税接收者传零地址：不设版税，royaltyInfo 返回（零地址, 0）", async function () {
      const [owner] = await ethers.getSigners();
      const MyNFT = await ethers.getContractFactory("MyNFT");
      const nft = await MyNFT.deploy(owner.address, MAX_SUPPLY, ZERO_ADDRESS, 0);

      const [receiver, amount] = await nft.royaltyInfo(1, SALE_PRICE);
      expect(receiver).to.equal(ZERO_ADDRESS);
      expect(amount).to.equal(0);

      // 接口仍然声明支持 2981（支持这个能力，只是当前版税为 0）
      expect(await nft.supportsInterface(IFACE.ERC2981)).to.equal(true);
    });
  });

  // ==========================================================================
  // 治理加固（Ownable2Step + Pausable）
  //
  // 与 SimpleMarket 同一套治理升级：
  //   1. Ownable2Step —— 所有权转移需新 owner 确认，转错地址也不会立刻失控
  //   2. Pausable     —— 紧急止血只挡"新增供给"（铸造），
  //                      不挡转移 / 销毁 / 查询，已持有者的资产处置权不受影响
  // ==========================================================================
  describe("治理加固（Ownable2Step + Pausable）", function () {
    it("暂停后：铸造全部 revert EnforcedPause（safeMint / publicMint）", async function () {
      const { nft, owner, addr1 } = await loadFixture(deployNFTFixture);
      await nft.connect(owner).setPublicMintEnabled(true);

      await nft.connect(owner).pause();
      expect(await nft.paused()).to.equal(true);

      await expect(
        nft.connect(owner).safeMint(addr1.address, URI_1)
      ).to.be.revertedWithCustomError(nft, "EnforcedPause");
      await expect(
        nft.connect(addr1).publicMint(URI_1)
      ).to.be.revertedWithCustomError(nft, "EnforcedPause");
      // 指定 tokenId 的铸造同样被挡（它也是"新增供给"入口）
      await expect(
        nft.connect(owner).adminMintWithTokenId(addr1.address, 99, URI_1)
      ).to.be.revertedWithCustomError(nft, "EnforcedPause");
    });

    it("暂停只挡铸造，不挡转移：已持有 NFT 的用户仍可自由转卖", async function () {
      const { nft, owner, addr1, addr2 } = await loadFixture(deployNFTFixture);
      await nft.connect(owner).safeMint(addr1.address, URI_1); // #1

      await nft.connect(owner).pause();
      await nft.connect(addr1).transferFrom(addr1.address, addr2.address, 1);

      expect(await nft.ownerOf(1)).to.equal(addr2.address);
    });

    it("非 owner 调用 pause 应 revert OwnableUnauthorizedAccount", async function () {
      const { nft, addr1 } = await loadFixture(deployNFTFixture);

      await expect(nft.connect(addr1).pause())
        .to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount")
        .withArgs(addr1.address);
      // unpause 同样只认 owner
      await expect(nft.connect(addr1).unpause())
        .to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount")
        .withArgs(addr1.address);
    });

    it("unpause 后恢复铸造", async function () {
      const { nft, owner, addr1 } = await loadFixture(deployNFTFixture);

      await nft.connect(owner).pause();
      await nft.connect(owner).unpause();
      expect(await nft.paused()).to.equal(false);

      await nft.connect(owner).safeMint(addr1.address, URI_1);
      expect(await nft.ownerOf(1)).to.equal(addr1.address);
    });

    it("重复 pause / 未暂停时 unpause：都被 Pausable 的状态校验挡下", async function () {
      const { nft, owner } = await loadFixture(deployNFTFixture);

      await nft.connect(owner).pause();
      await expect(nft.connect(owner).pause()).to.be.revertedWithCustomError(
        nft,
        "EnforcedPause"
      );

      await nft.connect(owner).unpause();
      await expect(nft.connect(owner).unpause()).to.be.revertedWithCustomError(
        nft,
        "ExpectedPause"
      );
    });

    it("两步转移所有权：需新 owner acceptOwnership 才生效", async function () {
      const { nft, owner, addr1 } = await loadFixture(deployNFTFixture);

      await nft.connect(owner).transferOwnership(addr1.address);
      // 转移后 owner 不变，pendingOwner 才是新地址
      expect(await nft.owner()).to.equal(owner.address);
      expect(await nft.pendingOwner()).to.equal(addr1.address);

      await nft.connect(addr1).acceptOwnership();
      expect(await nft.owner()).to.equal(addr1.address);
      expect(await nft.pendingOwner()).to.equal(ZERO_ADDRESS);
    });
  });

});