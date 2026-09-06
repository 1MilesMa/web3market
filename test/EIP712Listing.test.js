const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * EIP-712 链下签名挂单（ListingIntent）测试套件
 *
 * 这份测试回答一个问题：卖家只在链下签名、不发任何链上交易，
 * 凭什么能安全成交？答案是四道防线，每一条都有对应的断言：
 *
 *   1. 域分隔符     —— 摘要里含 chainId + 市场合约地址，天然防跨链 / 跨市场重放
 *   2. nonce 单调   —— 成交即 +1，同一条签名无法使用第二次
 *   3. deadline     —— 签名会过期，不会被无限期利用
 *   4. 成交时复检   —— 绕过了 list()，所以持有者与授权必须在 fulfillListing 里重新校验
 *
 * 运行：npx hardhat test test/EIP712Listing.test.js
 */

describe("SimpleMarket · EIP-712 链下签名挂单", function () {
  const TOKEN_URI = "ipfs://QmTest123456789/metadata.json";
  const FEE_BPS = 250; // 2.5%
  const PRICE = ethers.parseEther("1");
  const ROYALTY_BPS = 500; // 5%

  // EIP-712 类型定义。字段顺序与类型必须和合约里的 struct 完全一致，
  // 否则签出来的摘要对不上 —— 这正是下面第一个测试要守的东西
  const INTENT_TYPES = {
    ListingIntent: [
      { name: "nftContract", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "price", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  /** 无版税 fixture */
  async function deployFixture() {
    const [owner, seller, buyer, other, creator] = await ethers.getSigners();

    const MyNFT = await ethers.getContractFactory("MyNFT");
    const nft = await MyNFT.deploy(owner.address, 10000, ethers.ZeroAddress, 0);
    const nftAddr = await nft.getAddress();

    const Market = await ethers.getContractFactory("SimpleMarket");
    const market = await Market.deploy(owner.address, FEE_BPS);
    const marketAddr = await market.getAddress();

    await nft.connect(owner).safeMint(seller.address, TOKEN_URI); // #1
    await nft.connect(owner).safeMint(seller.address, TOKEN_URI); // #2

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
      name: "SimpleMarket",
      version: "1",
      chainId,
      verifyingContract: marketAddr,
    };

    return { owner, seller, buyer, other, creator, nft, nftAddr, market, marketAddr, domain, chainId };
  }

  /** 带 5% 版税的 fixture，用于验证链下签名与链上挂单走同一套分账 */
  async function royaltyFixture() {
    const [owner, seller, buyer, other, creator] = await ethers.getSigners();

    const MyNFT = await ethers.getContractFactory("MyNFT");
    const nft = await MyNFT.deploy(owner.address, 10000, creator.address, ROYALTY_BPS);
    const nftAddr = await nft.getAddress();

    const Market = await ethers.getContractFactory("SimpleMarket");
    const market = await Market.deploy(owner.address, FEE_BPS);
    const marketAddr = await market.getAddress();

    await nft.connect(owner).safeMint(seller.address, TOKEN_URI); // #1
    await nft.connect(owner).safeMint(seller.address, TOKEN_URI); // #2

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
      name: "SimpleMarket",
      version: "1",
      chainId,
      verifyingContract: marketAddr,
    };

    return { owner, seller, buyer, other, creator, nft, nftAddr, market, marketAddr, domain, chainId };
  }

  /** 卖家在链下对一条挂单意图签名（不发任何链上交易） */
  async function signIntent(signer, domain, { nftContract, tokenId, price, deadline, nonce }) {
    const value = { nftContract, tokenId, price, deadline, nonce };
    const signature = await signer.signTypedData(domain, INTENT_TYPES, value);
    return { value, signature };
  }

  /** 便捷：造一条有效期 1 小时、nonce 与链上一致的意图 */
  async function makeIntent(fx, { tokenId = 1, price = PRICE, nonce = null } = {}) {
    const deadline = (await time.latest()) + 3600;
    const n = nonce === null ? await fx.market.listingNonces(fx.seller.address) : nonce;
    return signIntent(fx.seller, fx.domain, {
      nftContract: fx.nftAddr,
      tokenId,
      price,
      deadline,
      nonce: n,
    });
  }

  // ==========================================================================
  // 一、EIP-712 摘要构造的正确性
  // ==========================================================================

  it("typeHash 常量必须等于 struct 定义的 keccak256 重算值", async function () {
    const fx = await loadFixture(deployFixture);
    const expected = ethers.keccak256(
      ethers.toUtf8Bytes(
        "ListingIntent(address nftContract,uint256 tokenId,uint256 price,uint256 deadline,uint256 nonce)"
      )
    );
    expect(await fx.market.LISTING_INTENT_TYPEHASH()).to.equal(expected);
  });

  it("前端用 ethers 本地算出的摘要，必须与合约 hashListingIntent 完全一致", async function () {
    const fx = await loadFixture(deployFixture);
    const { value } = await makeIntent(fx);

    // ethers 的 TypedDataEncoder 会套上同一个域分隔符（chainId + verifyingContract）
    const localDigest = ethers.TypedDataEncoder.hash(fx.domain, INTENT_TYPES, value);
    const onchainDigest = await fx.market.hashListingIntent(value);

    expect(onchainDigest).to.equal(localDigest);
  });

  // ==========================================================================
  // 二、正常成交：卖家零 gas
  // ==========================================================================

  it("卖家仅签名（零链上交易），买家即可凭签名成交", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, nftAddr, market, marketAddr } = fx;

    // 卖家唯一的链上动作是授权，挂单本身【完全没有】链上交易
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    const { value, signature } = await makeIntent(fx);
    const expectedFee = (PRICE * 250n) / 10000n;
    const expectedProceeds = PRICE - expectedFee;

    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    ).to.changeEtherBalance(seller, expectedProceeds);

    // NFT 已易主
    expect(await nft.ownerOf(1)).to.equal(buyer.address);
    // 平台费入账（Pull Payment，不是直接转给 owner）
    expect(await market.accumulatedFees()).to.equal(expectedFee);
    // nonce 已消耗
    expect(await market.listingNonces(seller.address)).to.equal(1n);
  });

  it("成交时发出的 Sold 事件与 buy() 路径完全一致", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, nftAddr, market, marketAddr } = fx;
    await nft.connect(seller).approve(marketAddr, 1);

    const { value, signature } = await makeIntent(fx);
    const expectedFee = (PRICE * 250n) / 10000n;

    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    )
      .to.emit(market, "Sold")
      .withArgs(nftAddr, 1, seller.address, buyer.address, PRICE, expectedFee);
  });

  // ==========================================================================
  // 三、防重放：nonce 与 deadline
  // ==========================================================================

  it("同一条签名不能成交两次（nonce 已消耗）", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    // 同一卖家再铸一枚，让第二次尝试有货可卖
    await nft.connect(fx.owner).safeMint(seller.address, TOKEN_URI); // #3

    const { value, signature } = await makeIntent(fx, { tokenId: 3 });

    await market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE });

    // 第二次：nonce 已经 +1，签名里的 nonce 不再匹配
    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    )
      .to.be.revertedWithCustomError(market, "InvalidNonce")
      .withArgs(1, 0);
  });

  it("过期的签名无法成交", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    const past = (await time.latest()) - 1;
    const { value, signature } = await signIntent(seller, fx.domain, {
      nftContract: fx.nftAddr,
      tokenId: 1,
      price: PRICE,
      deadline: past,
      nonce: 0,
    });

    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    ).to.be.revertedWithCustomError(market, "SignatureExpired");
  });

  it("卖家可主动 incrementNonce，一次性作废所有未成交签名", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    // 先签一条（nonce = 0）
    const { value, signature } = await makeIntent(fx);

    // 卖家反悔：链下撤不掉也没关系，链上跳一次 nonce
    await expect(market.connect(seller).incrementNonce())
      .to.emit(market, "NonceIncremented")
      .withArgs(seller.address, 0, 1);

    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    )
      .to.be.revertedWithCustomError(market, "InvalidNonce")
      .withArgs(1, 0);
  });

  // ==========================================================================
  // 四、防篡改：签名与数据必须严格对应
  // ==========================================================================

  it("签名者不是声称的卖家时拒绝成交", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, other, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    // other 私下签了一条，却声称是 seller 的挂单
    const { value, signature } = await signIntent(other, fx.domain, {
      nftContract: fx.nftAddr,
      tokenId: 1,
      price: PRICE,
      deadline: (await time.latest()) + 3600,
      nonce: 0,
    });

    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    ).to.be.revertedWithCustomError(market, "InvalidSignature");
  });

  it("篡改价格后签名失效", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    const { value, signature } = await makeIntent(fx); // 卖家签的是 1 ETH
    const tampered = { ...value, price: ethers.parseEther("0.1") }; // 买家把价格改成 0.1 ETH

    await expect(
      market
        .connect(buyer)
        .fulfillListing(tampered, seller.address, signature, { value: ethers.parseEther("0.1") })
    ).to.be.revertedWithCustomError(market, "InvalidSignature");
  });

  it("篡改 tokenId 后签名失效", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    const { value, signature } = await makeIntent(fx, { tokenId: 1 });
    const tampered = { ...value, tokenId: 2 }; // 同一签名套到另一枚 NFT 上

    await expect(
      market.connect(buyer).fulfillListing(tampered, seller.address, signature, { value: PRICE })
    ).to.be.revertedWithCustomError(market, "InvalidSignature");
  });

  // ==========================================================================
  // 五、防跨市场 / 跨链重放（域分隔符的作用）
  // ==========================================================================

  it("另一个市场合约上签的挂单，不能拿到本市场成交", async function () {
    const fx = await loadFixture(deployFixture);
    const { owner, seller, buyer, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    // 部署第二个市场，并用它的地址构造域
    const Market = await ethers.getContractFactory("SimpleMarket");
    const market2 = await Market.deploy(owner.address, FEE_BPS);
    const domain2 = { ...fx.domain, verifyingContract: await market2.getAddress() };

    const { value, signature } = await signIntent(seller, domain2, {
      nftContract: fx.nftAddr,
      tokenId: 1,
      price: PRICE,
      deadline: (await time.latest()) + 3600,
      nonce: 0,
    });

    // 域分隔符里含 verifyingContract，所以这个签名在市场 1 上必然验签失败
    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    ).to.be.revertedWithCustomError(market, "InvalidSignature");
  });

  it("换个 chainId 签的挂单，在本链上无效", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    const wrongChainDomain = { ...fx.domain, chainId: fx.chainId + 1n };
    const { value, signature } = await signIntent(seller, wrongChainDomain, {
      nftContract: fx.nftAddr,
      tokenId: 1,
      price: PRICE,
      deadline: (await time.latest()) + 3600,
      nonce: 0,
    });

    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    ).to.be.revertedWithCustomError(market, "InvalidSignature");
  });

  // ==========================================================================
  // 六、成交时的前置校验（链下签名绕过了 list()，这些检查不能省）
  // ==========================================================================

  it("未对市场授权的签名无法成交", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, market } = fx;
    // 故意不授权

    const { value, signature } = await makeIntent(fx);

    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    ).to.be.revertedWithCustomError(market, "MarketNotApproved");
  });

  it("签名后 NFT 已被转走，成交时拒绝（陈旧签名）", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, other, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    const { value, signature } = await makeIntent(fx);

    // 签名还在，但货已经转给别人了
    await nft.connect(seller).transferFrom(seller.address, other.address, 1);

    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    ).to.be.revertedWithCustomError(market, "NotTokenOwner");
  });

  it("付款不足时拒绝", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    const { value, signature } = await makeIntent(fx);

    await expect(
      market
        .connect(buyer)
        .fulfillListing(value, seller.address, signature, { value: PRICE - 1n })
    )
      .to.be.revertedWithCustomError(market, "InsufficientPayment")
      .withArgs(PRICE - 1n, PRICE);
  });

  it("意图价格为 0 时拒绝", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    const { value, signature } = await makeIntent(fx, { price: 0n });

    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: 0 })
    ).to.be.revertedWithCustomError(market, "IntentPriceZero");
  });

  it("多付的钱原路退还给买家", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    const overpay = ethers.parseEther("1.5");
    const { value, signature } = await makeIntent(fx);
    const expectedFee = (PRICE * 250n) / 10000n;
    const expectedProceeds = PRICE - expectedFee;

    // 买家净支出 = 成交价，多付的 0.5 已退回
    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: overpay })
    ).to.changeEtherBalance(buyer, -PRICE);

    expect(await nft.ownerOf(1)).to.equal(buyer.address);
    expect(await market.accumulatedFees()).to.equal(expectedFee);
  });

  // ==========================================================================
  // 七、与链上挂单的一致性：分账必须完全一样
  // ==========================================================================

  it("链下签名成交与链上 list+buy 的三方分账完全相同", async function () {
    const fx = await loadFixture(royaltyFixture);
    const { seller, buyer, creator, nft, nftAddr, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    const expectedFee = (PRICE * 250n) / 10000n;
    const expectedRoyalty = (PRICE * 500n) / 10000n;
    const expectedProceeds = PRICE - expectedFee - expectedRoyalty;

    // 路径 A：传统链上挂单 + 购买（#1）
    await market.connect(seller).list(nftAddr, 1, PRICE);
    await market.connect(buyer).buy(nftAddr, 1, { value: PRICE });

    const feesAfterBuy = await market.accumulatedFees();
    const royaltyAfterBuy = await market.pendingRoyalties(creator.address);

    // 路径 B：链下签名成交（#2）
    const { value, signature } = await makeIntent(fx, { tokenId: 2 });
    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    ).to.changeEtherBalance(seller, expectedProceeds);

    // 两条路径各自产生的分账完全相同
    expect(await market.accumulatedFees()).to.equal(feesAfterBuy + expectedFee);
    expect(await market.pendingRoyalties(creator.address)).to.equal(
      royaltyAfterBuy + expectedRoyalty
    );
    expect((await market.accumulatedFees()) - feesAfterBuy).to.equal(expectedFee);
  });

  it("链下签名挂单与链上挂单互不干扰（两套机制可以共存）", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, nftAddr, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    // #1 走链上挂单，#2 走链下签名
    await market.connect(seller).list(nftAddr, 1, PRICE);

    const { value, signature } = await makeIntent(fx, { tokenId: 2 });
    await market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE });

    expect(await nft.ownerOf(2)).to.equal(buyer.address); // 链下签名成交成功
    expect((await market.getListing(nftAddr, 1)).active).to.equal(true); // 链上挂单不受影响
  });

  // ==========================================================================
  // 八、gas 收益
  // ==========================================================================

  it("链下签名成交比「链上挂单 + 购买」总 gas 更低", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, buyer, nft, nftAddr, market, marketAddr } = fx;
    await nft.connect(seller).setApprovalForAll(marketAddr, true);

    // 路径 A：list + buy
    await market.connect(seller).list(nftAddr, 1, PRICE);
    const txBuy = await market.connect(buyer).buy(nftAddr, 1, { value: PRICE });
    // list 的 gas 用一次等价操作量出来
    const txList = await market.connect(seller).list(nftAddr, 2, PRICE);
    await market.connect(seller).cancel(nftAddr, 2);
    const listGas = (await txList.wait()).gasUsed;
    const buyGas = (await txBuy.wait()).gasUsed;

    // 路径 B：链下签名成交（#2）
    const { value, signature } = await makeIntent(fx, { tokenId: 2 });
    const txFulfill = await market
      .connect(buyer)
      .fulfillListing(value, seller.address, signature, { value: PRICE });
    const fulfillGas = (await txFulfill.wait()).gasUsed;

    // 卖家的链上成本被完全省掉：list 那一笔不再需要
    expect(fulfillGas).to.be.lessThan(listGas + buyGas);
  });

  // ==========================================================================
  // 九、恶意买家：多付退款失败 / 重入 fulfillListing
  //
  // 这两条补的是「链下签名成交」入口独有的分支。
  // 已有的 RefundRejectingBuyer 只打过 list+buy 那条老路径，
  // fulfillListing 是独立入口，必须单独验证。
  // ==========================================================================

  it("买家多付却拒收退款：整笔成交必须回滚，而不是吞掉退款失败", async function () {
    const fx = await loadFixture(deployFixture);
    const { seller, nft, market, marketAddr } = fx;
    await nft.connect(seller).approve(marketAddr, 1);
    const { value, signature } = await makeIntent(fx);

    const Probe = await ethers.getContractFactory("FulfillListingProbe");
    const probe = await Probe.deploy(true, false); // rejectEth = true

    await expect(
      probe.attack(marketAddr, value, seller.address, signature, {
        value: PRICE + ethers.parseEther("0.5"),
      })
    ).to.be.revertedWithCustomError(market, "EthTransferFailed");

    // 整笔回滚：NFT 没易主，nonce 也没被白白消耗
    expect(await nft.ownerOf(1)).to.equal(seller.address);
    expect(await market.listingNonces(seller.address)).to.equal(0n);
  });

  it("【重入防护】买家在 onERC721Received 里重入 fulfillListing，应被锁挡下", async function () {
    const fx = await loadFixture(deployFixture);
    const { owner, seller, nft, market, marketAddr } = fx;
    await nft.connect(seller).approve(marketAddr, 1);
    const { value, signature } = await makeIntent(fx);

    const Probe = await ethers.getContractFactory("FulfillListingProbe");
    const probe = await Probe.deploy(false, true); // reenter = true
    const probeAddr = await probe.getAddress();

    // 预存一个 PRICE：确保它在回调里"有钱再打一次"，
    // 这样重入若失败，只可能是被锁挡的，而不是因为没钱
    await owner.sendTransaction({ to: probeAddr, value: PRICE });

    await probe.attack(marketAddr, value, seller.address, signature, { value: PRICE });

    // 攻击窗口确实被打开了，但第二次成交没有成功
    expect(await probe.receivedNft()).to.equal(true);
    expect(await probe.reentrySucceeded()).to.equal(false);

    // 失败原因必须是重入锁本身，而不是 nonce / 授权之类的业务错误
    const revertData = await probe.reentryRevertData();
    expect(revertData).to.equal(ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10));

    // 成交本身照常完成：NFT 到手、nonce 正常 +1
    expect(await nft.ownerOf(1)).to.equal(probeAddr);
    expect(await market.listingNonces(seller.address)).to.equal(1n);
  });

  // ==========================================================================
  // 治理加固：Pausable 对签名成交路径的覆盖
  //
  // fulfillListing 绕过了 list()，是另一条"开仓"入口，
  // 所以必须和 list / buy 一样受暂停约束；同时暂停不能吞掉卖家的 nonce。
  // ==========================================================================

  it("暂停后：链下签名成交同样被挡下（fulfillListing revert EnforcedPause）", async function () {
    const fx = await loadFixture(deployFixture);
    const { owner, seller, buyer, nft, market, marketAddr } = fx;

    await nft.connect(seller).setApprovalForAll(marketAddr, true);
    const { value, signature } = await makeIntent(fx);

    await market.connect(owner).pause();
    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    ).to.be.revertedWithCustomError(market, "EnforcedPause");

    // 暂停只是被挡下，nonce 不该被消耗 —— 否则等于卖家白签了一次
    expect(await market.listingNonces(seller.address)).to.equal(0n);

    // 解除暂停后，同一条签名依然有效
    await market.connect(owner).unpause();
    await expect(
      market.connect(buyer).fulfillListing(value, seller.address, signature, { value: PRICE })
    ).to.changeEtherBalance(seller, (PRICE * 9750n) / 10000n);
  });

});