// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title MyNFT —— 一份用来学习 ERC721（NFT 标准）的教学合约
 *
 * ============================================================================
 * 一、ERC721 与 ERC20 的本质区别（这是理解 NFT 的第一关）
 * ============================================================================
 *
 * ERC20（同质化代币，FT）：
 *   - 账本结构是 mapping(address => uint256)，记录"某地址有多少币"
 *   - 每一枚币完全等价，你的 1 MTK 和我的 1 MTK 没有任何区别，可以互换（fungible）
 *   - 所以 ERC20 只有 "余额" 概念，没有 "哪一枚" 的概念
 *   - transfer(to, amount)：转的是一个**数量**
 *
 * ERC721（非同质化代币，NFT）：
 *   - 账本结构是 mapping(uint256 => address)，记录"第 N 号 token 归谁"
 *   - 每个 tokenId 全局唯一、不可互换、不可分割（non-fungible）
 *   - 所以 ERC721 没有 amount 参数，只有 tokenId
 *   - transferFrom(from, to, tokenId)：转的是一个**具体编号的物件**
 *
 *   类比：ERC20 是银行账户里的钱（只关心金额），ERC721 是房产证（关心是哪一套房）。
 *
 * 由此带来 API 上的连锁差异：
 *   ERC20：balanceOf(owner) -> uint256（我有多少钱）
 *   ERC721：balanceOf(owner) -> uint256（我有几个 NFT） + ownerOf(tokenId) -> address（这个 NFT 归谁）
 *   ERC20：transfer(to, amount)           ERC721：transferFrom(from, to, tokenId)
 *   ERC20：approve(spender, amount)       ERC721：approve(spender, tokenId) / setApprovalForAll(operator, true)
 *
 * ============================================================================
 * 二、为什么继承四个合约（多重继承的"菱形问题"）
 * ============================================================================
 *
 *   ERC721            基础实现：ownerOf / transferFrom / approve / 事件
 *     ├── ERC721URIStorage   给每个 tokenId 存一份独立的 metadata 链接（tokenURI）
 *     └── ERC721Enumerable   提供"枚举"能力：totalSupply / tokenOfOwnerByIndex
 *   ERC2981           版税标准（EIP-2981）：royaltyInfo + _setDefaultRoyalty / _setTokenRoyalty
 *   Ownable           权限控制：onlyOwner 修饰符
 *
 * 这四个父合约里有三个都重写了同一个底层函数（_update / supportsInterface / tokenURI），
 * Solidity 的多重继承要求：当多个父合约都覆写了同一个函数时，子合约必须显式
 * 再覆写一次并列出所有父合约，否则编译器报 "Derived contract must override function"。
 * 这就是下面那几个 override(...) 的由来，详见文末 "四、为什么必须 override"。
 *
 * ============================================================================
 * 二点五、EIP-2981 版税到底解决了什么（本次新增的核心）
 * ============================================================================
 *
 * 背景：传统艺术市场里，画家把画卖给画廊后，画廊再加价转卖 —— 画家一分钱拿不到。
 *      NFT 让"二次销售分成"在技术上第一次变得可行：每一笔转卖都能自动给创作者分钱。
 *      这就是版税（royalty）。
 *
 * EIP-2981 定义的东西【极少】，只有一个函数：
 *
 *      function royaltyInfo(uint256 tokenId, uint256 salePrice)
 *          external view returns (address receiver, uint256 royaltyAmount);
 *
 * 它的语义是："如果这枚 tokenId 以 salePrice 成交，请给 receiver 打 royaltyAmount 这么多钱。"
 *
 * 三个必须记住的关键点：
 *
 *   1) 它是【只读的报价单】，不是自动扣款。
 *      标准只规定"怎么问"，不规定"必须付"。
 *      真正付不付、付多少，取决于市场合约（也就是我们的 SimpleMarket）自觉调用它。
 *      这就是为什么有的市场（如早期的 Sudoswap、Blur）会"绕开版税"：
 *      标准本身没有任何强制力，纯粹靠市场自觉与生态共识。
 *
 *   2) 金额单位用【基点】（basis points）：分母固定 10000。
 *      500 表示 5%，250 表示 2.5%。整数运算，绝不用浮点。
 *      注意 OZ 的实现里 royaltyAmount = salePrice * royaltyFraction / 10000，
 *      是【向下取整】的 —— 余数怎么处理，是市场合约的责任（我们让余数归卖家）。
 *
 *   3) 它【只认 tokenId，不认买卖双方】。
 *      同一个合集里，#1 可以是 5%、#2 可以是 10%（_setTokenRoyalty），
 *      没有单独设置过的 token 走默认版税（_setDefaultRoyalty）。
 *      但标准无法表达"只在某几个市场收版税"或"只收前三次转卖"这类复杂规则，
 *      那些要靠市场侧自己扩展。
 *
 * 为什么市场侧必须用 ERC165 做能力检测？
 *      因为 2021 年之前部署的海量 NFT 合约根本不认识 EIP-2981，
 *      直接调 royaltyInfo 会因"函数不存在"而 revert。
 *      结果是：不支持版税的老 NFT 在你的市场里根本卖不掉。
 *      所以正确姿势是：
 *          if (IERC165(nft).supportsInterface(0x2a55205a)) { ...查版税... } else { ...跳过... }
 *      0x2a55205a 就是 IERC2981 的 interfaceId（royaltyInfo 一个函数选择器的值）。
 * ============================================================================
 */
contract MyNFT is ERC721, ERC721URIStorage, ERC721Enumerable, ERC2981, Ownable2Step, Pausable {
    // ========================================================================
    // 状态变量
    // ========================================================================

    /// @notice 下一个待铸造的 tokenId。从 1 开始（0 会与"不存在"的语义混淆）
    uint256 private _nextTokenId;

    /// @notice 铸造上限（本次学习项目设为 10000）
    /// @dev immutable：构造后不再改写，读取时免一次 SLOAD，每次铸造都省 gas
    uint256 public immutable maxSupply;

    /// @notice 累计铸造数量（只增不减，即使销毁也不回退）
    uint256 public totalMinted;

    /// @notice 是否开放"任何人都能铸造"的公开铸造（默认关闭）
    bool public publicMintEnabled;

    // ========================================================================
    // 自定义错误（Solidity 0.8.4+ 推荐做法：比 require 字符串省 gas，且可携带参数）
    // ========================================================================

    /// @notice 铸造数量超过上限
    error ExceedsMaxSupply(uint256 requested, uint256 maxSupply);

    /// @notice 公开铸造未开启
    error PublicMintDisabled();

    /// @notice tokenURI 不能为空（空 URI 意味着 NFT 没有 metadata，钱包里会显示成空白方块）
    error EmptyTokenURI();

    /// @notice 没有销毁权限（既不是持有者，也没有被授权）
    error NotAuthorizedToBurn(address caller, uint256 tokenId);

    // ========================================================================
    // 事件
    // ========================================================================

    /// @notice 公开铸造开关被切换
    event PublicMintToggled(bool enabled);

    /// @notice 默认版税被更新（OZ 的 _setDefaultRoyalty 不 emit 事件，我们自己补一个，
    ///         否则前端与市场无法监听"版税率变了"这件事）
    event DefaultRoyaltyUpdated(address indexed receiver, uint96 feeNumerator);

    /// @notice 单枚 token 的版税被单独设置
    event TokenRoyaltyUpdated(uint256 indexed tokenId, address indexed receiver, uint96 feeNumerator);

    /// @notice 单枚 token 的版税被清除，回退到默认版税
    event TokenRoyaltyReset(uint256 indexed tokenId);

    // ========================================================================
    // 构造函数
    // ========================================================================

    /**
     * @param initialOwner        合约 owner（OpenZeppelin v5 强制要求显式传入，v4 时代默认 msg.sender）
     * @param maxSupply_          铸造上限
     * @param royaltyReceiver     版税接收者（创作者地址）。传 address(0) 表示"本次不设版税"，
     *                            之后仍可由 owner 调用 setDefaultRoyalty 补上
     * @param royaltyFeeNumerator 版税分子，分母固定 10000。500 = 5%，250 = 2.5%
     *
     * 注意初始化父合约的写法：ERC721("名称", "符号") 里这两个字符串就是
     * 钱包 / 市场里显示的 NFT 合集名与代号，由 ERC721Metadata 的 name() / symbol() 暴露。
     *
     * 兼容说明：本轮把构造函数从 2 个参数扩到 4 个参数。Solidity 不支持构造函数重载，
     * 所以所有部署点（测试 fixture 与 scripts/deploy-mynft.js）都必须同步带上后两个参数；
     * 想维持"无版税"的老行为，就传 (address(0), 0)。
     */
    constructor(
        address initialOwner,
        uint256 maxSupply_,
        address royaltyReceiver,
        uint96 royaltyFeeNumerator
    ) ERC721("MyNFT", "MNFT") Ownable(initialOwner) {
        require(maxSupply_ > 0, "maxSupply must be > 0");
        maxSupply = maxSupply_;
        _nextTokenId = 1; // 从 1 开始编号
        publicMintEnabled = false; // 默认只有 owner 能铸造

        // 版税：零地址表示"暂不设版税"。OZ 的 _setDefaultRoyalty 本身会拒绝零地址，
        // 这里提前判断是为了保留"先部署、后补设"的灵活性
        if (royaltyReceiver != address(0)) {
            _setDefaultRoyalty(royaltyReceiver, royaltyFeeNumerator);
        }
    }

    // ========================================================================
    // 铸造
    // ========================================================================

    /**
     * @notice owner 定向铸造：把新 NFT 铸造给指定地址
     * @param to  接收者
     * @param uri 该 token 的 metadata 链接（通常是 ipfs://... 或 https://...）
     * @return 铸造出来的 tokenId
     *
     * 为什么用 _safeMint 而不是 _mint？见下方【_safeMint 与 _mint 的区别】。
     */
    function safeMint(address to, string calldata uri) external onlyOwner whenNotPaused returns (uint256) {
        return _mintInternal(to, uri);
    }

    /**
     * @notice 公开铸造：任何人调用都会铸造给自己（msg.sender），可由 owner 开关
     *
     * 真实项目里这里通常还会加：单次限购、白名单（Merkle Tree）、铸造价格（msg.value）等。
     * 本合约为了聚焦学习，只保留"开关"这个最简形态。
     */
    function publicMint(string calldata uri) external whenNotPaused returns (uint256) {
        if (!publicMintEnabled) {
            revert PublicMintDisabled();
        }
        return _mintInternal(msg.sender, uri);
    }

    /**
     * @notice 【教学专用】允许 owner 指定 tokenId 铸造
     *
     * 存在的唯一目的：让你可以亲手验证"同一个 tokenId 不能被铸造两次"。
     * 正常业务里不应该开放指定 tokenId 的能力（容易被抢注 / 打乱编号）。
     * 当你用同一个 tokenId 调第二次时，会 revert：ERC721InvalidSender(address(0))
     */
    function adminMintWithTokenId(address to, uint256 tokenId, string calldata uri) external onlyOwner whenNotPaused {
        if (bytes(uri).length == 0) revert EmptyTokenURI();
        // 与 _mintInternal 保持同样的 CEI 顺序：先记账，再做会回调接收者的外部调用
        totalMinted += 1;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
    }

    /// @dev 内部铸造逻辑：分配 ID → 铸造 → 绑定 metadata → 计数
    function _mintInternal(address to, string calldata uri) private returns (uint256 tokenId) {
        if (bytes(uri).length == 0) revert EmptyTokenURI();
        if (totalMinted >= maxSupply) {
            revert ExceedsMaxSupply(totalMinted + 1, maxSupply);
        }

        tokenId = _nextTokenId;
        _nextTokenId += 1;

        // CEI：先把账记上，再做会回调接收者的外部调用。
        // _safeMint 内部会回调 to 的 onERC721Received，理论上存在重入窗口；
        // 提前自增 totalMinted 后，即便发生重入，供应量计数也已是正确值。
        totalMinted += 1;

        _safeMint(to, tokenId); // 铸造：内部会 emit Transfer(address(0), to, tokenId)
        _setTokenURI(tokenId, uri); // 绑定 metadata 链接
    }

    /*
     * ==========================================================================
     * 【知识点】_safeMint 与 _mint 的区别（面试与实战都常考）
     * ==========================================================================
     *
     * _mint(to, tokenId)：
     *   只做一件事 —— 把 tokenId 的所有权写进 _owners 映射，emit Transfer 事件。
     *   它**不检查** to 是不是能处理 NFT 的合约。
     *   如果 to 是一个合约地址，而这个合约没有实现 IERC721Receiver.onERC721Received()，
     *   那么这枚 NFT 就被永久锁死在那个合约里 —— 谁也转不出来（因为转出需要合约主动调用
     *   transferFrom，而合约没写这段逻辑）。这就是著名的 "NFT stuck in contract" 事故。
     *
     * _safeMint(to, tokenId)：
     *   先执行 _mint，然后额外做一次"接收方安全检查"：
     *     if (to 是合约地址) {
     *         调用 to.onERC721Received(msg.sender, address(0), tokenId, data)
     *         要求必须返回魔法值 0x150b7a02（IERC721Receiver.onERC721Received.selector）
     *         返回值不对 / 没实现 / 调用失败 → 整个交易 revert
     *     }
     *     if (to 是普通钱包地址) 直接放行（EOA 没有代码，无需检查）
     *
     * 代价：多一次外部调用，gas 会贵一些（约 +2k~10k，取决于接收合约实现）。
     * 结论：**对外开放的铸造一律用 _safeMint**，_mint 只在你能 100% 确定接收方是 EOA
     * 或者是你自己写的可信合约时才用。OpenZeppelin 的注释里也明确写了
     * "Usage of this method is discouraged, use {_safeMint} whenever possible"。
     *
     * 同理，转账侧也有两个版本：
     *   transferFrom(from, to, tokenId)      —— 不检查接收方，可能把 NFT 转进黑洞合约
     *   safeTransferFrom(from, to, tokenId)  —— 检查接收方（可选再带一个 bytes data 参数）
     * ==========================================================================
     */

    // ========================================================================
    // 销毁
    // ========================================================================

    /**
     * @notice 销毁一枚 NFT。持有者本人、或持有者授权过的地址（approve / setApprovalForAll）可调用
     *
     * 销毁后：
     *   - ownerOf(tokenId) 会 revert（ERC721NonexistentToken）
     *   - ERC721Enumerable.totalSupply() 减 1
     *   - 但 totalMinted 不减（它是历史累计值，用来做"已铸造过多少"的统计）
     */
    function burn(uint256 tokenId) external {
        // 局部变量不叫 owner，避免遮蔽 Ownable.owner()（Slither shadowing-local）
        address tokenOwner = ownerOf(tokenId); // tokenId 不存在时这里就会 revert ERC721NonexistentToken
        if (!_isAuthorized(tokenOwner, msg.sender, tokenId)) {
            revert NotAuthorizedToBurn(msg.sender, tokenId);
        }
        _burn(tokenId);
    }

    // ========================================================================
    // 管理
    // ========================================================================

    /**
     * @notice 紧急暂停：阻断所有铸造（safeMint / publicMint / adminMintWithTokenId）
     *
     * 只挡"新增供给"，不挡转移 / 销毁 / 查询 —— 已持有 NFT 的用户在暂停期间依然能正常转卖。
     */
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice 解除暂停
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice 切换公开铸造开关（仅 owner）
    function setPublicMintEnabled(bool enabled) external onlyOwner {
        publicMintEnabled = enabled;
        emit PublicMintToggled(enabled);
    }

    // ========================================================================
    // 版税管理（EIP-2981，仅 owner）
    // ========================================================================

    /*
     * 为什么还要自己包一层 onlyOwner 的函数？
     *   OZ 提供的 _setDefaultRoyalty / _setTokenRoyalty 是 internal 的，外部调不到，
     *   而且【不 emit 任何事件】。对外暴露的 setter 要解决三件事：
     *     1. 权限：谁能改版税率（这里限定 owner；真实项目里常见做法是给版税接收者
     *        单独一个角色，或干脆部署后永久不可改 —— 用来向藏家证明不会乱来）
     *     2. 可观测：发事件，让前端 / 市场 / 索引服务能感知变化
     *     3. 校验：OZ 内部已经做了两道校验（接收者非零、分子不超过分母），
     *        越界会 revert ERC2981InvalidDefaultRoyalty / ERC2981InvalidDefaultRoyaltyReceiver
     *
     * 想让某枚 token 回到默认版税：把它的分子设成 0 是【不够】的 ——
     *   0 表示"这枚 token 版税为 0"，依然会覆盖默认值。
     *   要真正回退，用下面的 resetTokenRoyalty（内部调 _resetTokenRoyalty 删掉这条记录）。
     */

    /**
     * @notice 设置全合约默认版税
     * @param receiver     版税接收者（不能是零地址）
     * @param feeNumerator 版税分子，分母 10000。500 = 5%
     */
    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        _setDefaultRoyalty(receiver, feeNumerator);
        emit DefaultRoyaltyUpdated(receiver, feeNumerator);
    }

    /**
     * @notice 给某一枚 token 单独设置版税（优先级高于默认版税）
     * @param tokenId      目标 token
     * @param receiver     版税接收者（不能是零地址）
     * @param feeNumerator 版税分子，分母 10000。1000 = 10%
     */
    function setTokenRoyalty(
        uint256 tokenId,
        address receiver,
        uint96 feeNumerator
    ) external onlyOwner {
        _setTokenRoyalty(tokenId, receiver, feeNumerator);
        emit TokenRoyaltyUpdated(tokenId, receiver, feeNumerator);
    }

    /// @notice 清除某枚 token 的单独版税，让它回退到默认版税
    function resetTokenRoyalty(uint256 tokenId) external onlyOwner {
        _resetTokenRoyalty(tokenId);
        emit TokenRoyaltyReset(tokenId);
    }

    /// @notice 版税分母（默认 10000，前端算百分比时直接读它，别把 10000 硬编码在自己代码里）
    function royaltyDenominator() external pure returns (uint96) {
        return _feeDenominator();
    }

    // ========================================================================
    // 查询辅助
    // ========================================================================

    /// @notice 下一个将被铸造的 tokenId（前端常用来展示"即将铸造 #N"）
    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    /*
     * ==========================================================================
     * 【知识点】tokenURI 与 metadata JSON 的关系
     * ==========================================================================
     *
     * 链上只存了这一条信息：tokenId -> 一个 URI 字符串（例如 ipfs://QmXXX/1.json）。
     * **图片、名称、属性全都存在链下**，由这个 URI 指向的 JSON 文件描述。
     *
     * 调用链是这样的：
     *   钱包/市场 调 tokenURI(1)
     *        -> 返回 "ipfs://QmXxx.../1.json"
     *   钱包/市场 去 IPFS 网关取这个 JSON（例如 https://ipfs.io/ipfs/QmXxx.../1.json）
     *        -> 拿到下面这段 JSON
     *   钱包/市场 解析 JSON，读取 image 字段再取图片，显示给用户
     *
     * 标准 metadata JSON 长这样（本项目已放在 metadata/nft-metadata-example.json）：
     *
     * {
     *   "name": "MyNFT #1",
     *   "description": "我亲手铸造的第一枚 NFT",
     *   "image": "ipfs://QmYyy.../1.png",
     *   "external_url": "https://example.com/nft/1",
     *   "attributes": [
     *     { "trait_type": "Generation", "value": "Genesis" },
     *     { "trait_type": "Level",      "value": 1, "display_type": "number" },
     *     { "trait_type": "Rarity",     "value": "Common" }
     *   ]
     * }
     *
     * 关键字段：
     *   name        —— 单枚 NFT 的名字（区别于合集名 name()）
     *   description —— 描述
     *   image       —— 图片链接，OpenSea 等市场就是渲染它
     *   attributes  —— 属性数组，市场用它做"稀有度筛选"和"特征统计"
     *
     * 为什么 image 通常指向 IPFS 而不是 https？
     *   - IPFS 是内容寻址：URI 里带的是内容哈希（QmXxx...），内容一改哈希就变，无法偷偷换图
     *   - 抗单点故障：不依赖某一台服务器活着。用 https://my-server.com/1.png 的话，
     *     服务器一关、域名一过期，你的 NFT 就变成空白方块 —— 这在圈内叫 "rug metadata"
     *   - 代价：需要有人 pin（固定）住文件，否则没人访问时可能被节点垃圾回收。
     *     主流做法是付费给 Pinata / NFT.Storage / Infura 这类 pinning 服务
     *
     * 进阶方案（了解即可）：
     *   - 完全链上 NFT：把 SVG 或 metadata 直接编码进合约返回（base64 data URI），
     *     永不下线，但部署 gas 很贵
     *   - ERC4906：本合约继承的 ERC721URIStorage 实现了它，metadata 变更时会 emit
     *     MetadataUpdate 事件，让市场知道该刷新缓存
     * ==========================================================================
     */

    // ========================================================================
    // 以下四个函数是多重继承必须显式覆写的部分
    // ========================================================================

    /*
     * ==========================================================================
     * 【知识点】为什么必须 override supportsInterface
     * ==========================================================================
     *
     * ERC165 解决的是"自报家门"问题：外部合约（比如 OpenSea 的交易合约）拿到一个地址，
     * 怎么知道它支持哪些接口？答案就是调 supportsInterface(interfaceId)，
     * 参数是一组函数选择器的异或值（XOR），返回 true 表示"我支持"。
     *
     * 本合约有四个父合约都想往这个判断里"加码"：
     *   ERC721            -> 支持 IERC721(0x80ac58cd)、IERC721Metadata(0x5b5e139f)
     *   ERC721Enumerable  -> 额外支持 IERC721Enumerable(0x780e9d63)
     *   ERC721URIStorage  -> 额外支持 IERC4906(0x49064906)
     *   ERC2981           -> 额外支持 IERC2981(0x2a55205a)   ← 本轮新增，版税的"身份证"
     *
     * 由于它们各自只写了 super.supportsInterface(...)，如果不在这里汇总，
     * 编译器无法确定调用顺序，直接报错。显式写成 super 调用链后，四者会依次判断，
     * 最终"我支持 ERC721 + Metadata + Enumerable + ERC4906 + ERC2981"这个完整答案
     * 才能对外正确表达。
     *
     * 现实影响：不覆写或覆写漏了，市场可能识别不出你的 NFT 支持枚举 / metadata 更新 / 版税，
     * 表现为"在 OpenSea 上看不到图片刷新"、"卖出去创作者却拿不到版税"这类玄学问题。
     *
     * 【0x2a55205a 是怎么来的？】
     *   interfaceId = 该接口里所有函数选择器的 XOR。
     *   IERC2981 只有一个函数 royaltyInfo(uint256,uint256)，
     *   所以 interfaceId == bytes4(keccak256("royaltyInfo(uint256,uint256)")) == 0x2a55205a。
     *   验证方式：在 hardhat console 里执行
     *     ethers.id("royaltyInfo(uint256,uint256)").slice(0, 10)   // '0x2a55205a'
     * ==========================================================================
     */
    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, ERC721Enumerable, ERC721URIStorage, ERC2981) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /**
     * @dev tokenURI：ERC721 基础实现是 "baseURI + tokenId"，
     *      URIStorage 改成 "每个 tokenId 存独立字符串"，两者冲突，必须显式指定走哪个。
     *      这里 super.tokenURI() 会命中 ERC721URIStorage 的实现（它先检查 base，
     *      base 为空时返回我们 _setTokenURI 存进去的那条 URI）。
     */
    function tokenURI(
        uint256 tokenId
    ) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    /**
     * @dev _update 是 ERC721 v5 的核心内部函数，所有铸造 / 转账 / 销毁最终都走它。
     *      ERC721Enumerable 覆写了它，用来维护下面这些额外的索引结构：
     *        _allTokens[]                      全局 token 列表
     *        _allTokensIndex[tokenId]          tokenId -> 在全局列表中的位置
     *        _ownedTokens[owner][index]        某地址拥有的第 index 个 tokenId
     *        _ownedTokensIndex[tokenId]        tokenId -> 在拥有者列表中的位置
     *
     *      【ERC721Enumerable 的作用与 gas 代价】
     *      作用：基础 ERC721 只有 ownerOf(tokenId)，无法回答"这个地址有哪些 NFT"。
     *            补上枚举后就能实现：
     *              totalSupply()                        合约现存 NFT 总数
     *              tokenByIndex(i)                      第 i 个 NFT 的 tokenId
     *              tokenOfOwnerByIndex(owner, i)        某地址的第 i 个 NFT
     *            前端"我的 NFT 收藏夹"、市场"浏览全部"全都依赖它。
     *
     *      代价：每次铸造 / 转账 / 销毁都要额外写 4 个 storage slot，
     *            单次 mint 的 gas 大约从 7 万涨到 14 万左右（翻倍）。
     *            删除时用 swap-and-pop（把最后一个元素搬到被删位置再 pop），
     *            所以**枚举顺序不稳定**：转账后 tokenOfOwnerByIndex 的返回顺序可能变化，
     *            业务代码绝不能依赖这个顺序。
     *
     *      什么时候可以不用它？
     *        - 纯链上游戏道具、只需要 ownerOf 判断归属：省掉它，gas 省一半
     *        - 需要"列出某个地址的所有 NFT"：必须用它，或者自己在合约里维护一套索引，
     *          再或者（更主流的做法）干脆不在链上枚举，改用 The Graph / Alchemy NFT API
     *          这类链下索引服务去扫 Transfer 事件
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721, ERC721Enumerable) returns (address) {
        return super._update(to, tokenId, auth);
    }

    /**
     * @dev 菱形继承必须补的转发钩子 —— 删不掉，但也跑不到。
     *
     * 为什么删不掉：
     *      ERC721 与 ERC721Enumerable 都声明了 _increaseBalance，
     *      C3 线性化强制要求最终合约显式 override，否则根本编译不过。
     *
     * 为什么覆盖率打不上（这条最重要）：
     *      OZ 5.6.1 的 ERC721._update 已经**不再调用**这个钩子了，
     *      它把增减余额直接内联成了 `_balances[to] += 1`。
     *      所以本函数在正常铸造流程里根本不可达 —— 它不是"测试漏了"，
     *      而是**库版本演进留下的死代码**，保留它纯粹为了满足编译要求。
     *
     * 那"禁止批量铸造"的约束还在不在：
     *      在。ERC721Enumerable 的实现是
     *      `if (amount > 0) revert ERC721EnumerableForbiddenBatchMint();`
     *      只是如今只有在有人显式调用这个钩子时才会触发，
     *      而本合约只提供单枚铸造（safeMint / publicMint / adminMintWithTokenId），
     *      没有任何批量入口，所以这条约束在当前设计下用不上，风险为零。
     *      （真要做空投，请看 ERC721Consecutive / ERC-2309，别硬塞进 Enumerable。）
     */
    function _increaseBalance(
        address account,
        uint128 amount
    ) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, amount);
    }
}

/*
 * ==========================================================================
 * 附：本合约涉及的 OpenZeppelin v5 内置错误速查（写测试时要用）
 * ==========================================================================
 *
 *   ERC721NonexistentToken(tokenId)                        查询/操作了不存在的 tokenId
 *   ERC721InvalidOwner(address(0))                         balanceOf 传入零地址
 *   ERC721InvalidReceiver(address)                         铸造或转入的接收方是零地址
 *   ERC721InvalidSender(address(0))                        铸造了一个已存在的 tokenId（重复 ID）
 *   ERC721IncorrectOwner(sender, tokenId, realOwner)       转账时 from 参数不是真正的持有者
 *   ERC721InsufficientApproval(operator, tokenId)          调用者既不是持有者也没被授权
 *   ERC721OutOfBoundsIndex(owner, index)                   Enumerable 的索引越界（owner=0 表示全局越界）
 *   ERC721EnumerableForbiddenBatchMint()                   尝试批量铸造（Enumerable 不支持）
 *   OwnableUnauthorizedAccount(account)                    非 owner 调用 onlyOwner 函数
 *
 * EIP-2981（版税）内置错误，写测试时会用到：
 *   ERC2981InvalidDefaultRoyalty(numerator, denominator)   默认版税分子 > 10000（超过 100%）
 *   ERC2981InvalidDefaultRoyaltyReceiver(address(0))       默认版税接收者是零地址
 *   ERC2981InvalidTokenRoyalty(tokenId, numerator, denominator)  单枚 token 版税 > 100%
 *   ERC2981InvalidTokenRoyaltyReceiver(tokenId, address(0))      单枚 token 版税接收者是零地址
 *
 * 本项目自定义错误：
 *   ExceedsMaxSupply(requested, maxSupply)
 *   PublicMintDisabled()
 *   EmptyTokenURI()
 *   NotAuthorizedToBurn(caller, tokenId)
 * ==========================================================================
 */
