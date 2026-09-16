# SimpleMarket · 带版税、出价与链上治理的 NFT 市场合约

> 从零手写的 Solidity 工程实践项目：ERC20 / ERC721、EIP-2981 版税、授权式 NFT 市场、买家出价、EIP-712 免 gas 挂单、Pull Payment 资金体系，以及 2/3 多签 + 时间锁的链上治理。全部部署在 Sepolia 测试网，源码与验证材料开源。

**在线演示**：[web3market-frontend.pages.dev](https://web3market-frontend.pages.dev)（国内可直连）　·　[web3market-frontend.vercel.app](https://web3market-frontend.vercel.app)（海外）

连上钱包即可操作：挂单 / 撤单 / 改价 / 买入、EIP-712 签名挂单与成交、出价、资金领取。

**一句话定位**：一个**授权式** NFT 市场——挂单时 NFT 不离开卖家钱包，只在成交瞬间由合约代转移；管理权也不放在任何一个人手里，而是「3 人共管、2 票放行」的多签，再叠加「排队 → 公示 → 执行」的时间锁。

| 项目状态 | |
|---|---|
| 网络 | Sepolia 测试网（chainId `11155111`） |
| 合约 | 5 个地址，**全部通过 Sourcify `exact_match` 源码验证** |
| 测试 | **303 passing / 0 failing** |
| 覆盖率 | `SimpleMarket` 语句 / 分支 / 函数 / 行 **全部 100%** |
| 链上实盘 | 2026-09-13 ~ 09-14 在 Sepolia 真实上链：挂单 / 改价 / 撤单 / 出价 / 接受出价 / **EIP-712 签名两方成交** / 领回版税，逐笔可核对 |
| 静态分析 | 两轮 Slither：首轮 47 条命中全部为 INFO，治理接管后复检零中高危 |
| 治理 | 2/3 多签 + 300 秒公示时间锁，`admin = address(0)`（连改延迟本身也要再走一次公示） |
| 安全边界 | **测试网演示项目，已通过自测与静态分析，未经第三方人工审计，不可用于承载真实资产** |

---

## 已部署合约（Sepolia 测试网）

| 合约 | 地址 | 部署区块 | 源码验证 |
|---|---|---|---|
| `SimpleMarket` 市场 | [`0x71450D767f2b83722b88164316d7308DB20A39c8`](https://sepolia.etherscan.io/address/0x71450D767f2b83722b88164316d7308DB20A39c8) | 11631015 | [Sourcify `exact_match`](https://repo.sourcify.dev/contracts/full_match/11155111/0x71450D767f2b83722b88164316d7308DB20A39c8/) |
| `MyNFT` ERC721 + 版税 | [`0x9EFe00123a6A22d903D63E195B7E87Bf3622412e`](https://sepolia.etherscan.io/address/0x9EFe00123a6A22d903D63E195B7E87Bf3622412e) | 11631013 | [Sourcify `exact_match`](https://repo.sourcify.dev/contracts/full_match/11155111/0x9EFe00123a6A22d903D63E195B7E87Bf3622412e/) |
| `MultiSigOwner` 2/3 多签 | [`0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317`](https://sepolia.etherscan.io/address/0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317) | 11637734 | [Sourcify `exact_match`](https://repo.sourcify.dev/contracts/full_match/11155111/0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317/) |
| `MarketTimelock` 时间锁 | [`0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119`](https://sepolia.etherscan.io/address/0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119) | 11638781 | [Sourcify `exact_match`](https://repo.sourcify.dev/contracts/full_match/11155111/0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119/) |

> `SimpleMarket` / `MyNFT` 的 owner 已收口到 `MarketTimelock`——单人已经改不了费率，两人串通也要先公示 300 秒。练手合约 `MyToken` 的 owner 请以链上 `owner()` 实时值为准：部署产物 `deployments\*.json` 里的 `owner` 只是部署那一刻的快照，治理移交不会自动回写。
> `exact_match` 表示链上字节码与公开源码 + 编译设置在**字节级完全一致**，任何人都能独立核对；Etherscan 域名在本机网络不可达，故验证走 Sourcify 完成，离线验证包见 `verify-bundle/`。
> 项目另有两个练手合约 `HelloWeb3`、`MyToken`（ERC20），与业务逻辑无关，不应进入生产；完整地址与部署 gas 见下方「已部署合约」章节。

---

## 三个值得看的工程决策

**1. 授权式挂单，而不是托管式**
挂单只登记价格，NFT 始终留在卖家钱包，成交瞬间凭 `setApprovalForAll` 由合约代转移。少一次转账、少一份托管风险：合约被攻破也不会批量失窃。

**2. 全量 Pull Payment**
平台费、版税、退回的出价款一律先记账，由收款人主动 `withdraw*` 领取；合约从不主动向外部地址转钱。防 DoS 的设计同理——`rejectOffer` 遇到拒收 ETH 的买家**不 revert**，把钱转入待领池，卖家不会被恶意买家卡死。

**3. EIP-712 免 gas 挂单**
卖家离线签 `ListingIntent`（nft + tokenId + price + nonce + deadline），买家带签名调 `fulfillListing` 一次成交。**卖家挂单零 gas**，本地实测总 gas 从 228,283 降到 135,600（省约 40%）。防重放三重保障：nonce 用后即焚、deadline 过期失效、`chainId` + 合约地址做域分隔。

---

## 质量证据（都能自己跑出来）

| 证据 | 数值 | 怎么复现 |
|---|---|---|
| 单元测试 | 303 passing / 0 failing | `npx hardhat test` |
| 覆盖率 | `SimpleMarket` 四项指标 100% | `npx hardhat coverage` |
| 恶意场景 | 13 个攻击合约主动触发修饰符的失败分支（重入、拒收 ETH、假 ERC721 接收器） | `contracts/mocks/MaliciousActors.sol` |
| 静态分析 | Slither 两轮，零中高危 | `slither .`（Windows 下需 WSL，过程见下方章节） |
| 源码验证 | 5 个地址 Sourcify `exact_match` | 点上方链接 |
| 治理实战 | 改费率生效 / 单人 1 票被拒 / 还原，全部链上实跑 | `scripts/verify-multisig-governance.js` |
| 链上实盘 | 17 笔真实上链交易，含**首次两方成交**（区块 11701717）；区块号 / gasUsed / 事件 / 分账逐项复核 | 见下方「链上实盘记录」章节 |

---

## 链上实盘记录（2026-09-13 ~ 09-14）

合约不是只跑过单元测试：这两天在 Sepolia 上真实完成了十几笔操作，其中 **09-14 跑通了首次「两方成交」**——卖家只在链下签名（零 gas），买家付 gas 一次成交，NFT 真正换了主人，货款按「平台费 → 版税 → 卖家」当场分账。

| 动作 | 区块 | gasUsed | 交易哈希 |
|---|---|---|---|
| 挂单 `#1` @ 0.002 | 11694166 | 105,766 | `0x8c502b1b346a1f6fe4022ed0d934eaa78bbac09e51c72d197a7d4fba3ca6461c` |
| 改价 0.002 → 0.0035 | 11694195 | 35,918 | `0x73891eb453b34a9a2c5597599681f84ca4fd78745a92025f1fe7f2be4ef2eaae` |
| 撤单 `#1` | 11694215 | 26,563 | `0xaa691ff0e251670abcbe0ba53d1f78ebc98faba1cbf6b4f4a01685ffd30530e4` |
| 对 `#2` 出价 0.001 | 11694319 | 76,996 | `0x3a80b49d0c665fb431b4aa85794b3356a0fa1dccaafee01bf27cd474d781fe39` |
| 接受出价（分账 + 放款） | 11694344 | 99,409 | `0x6a26cba4db730ffc66c2bad76fb65dc977c1fbcfe5abaefbbfec71b92126c6a0` |
| 签名成交（自己签自己买，验证代码路径） | 11694490 | 108,648 | `0xc420c80ae3fbc8eb61697401b60eb8514a7991ac01a32e60fb5c0e4128bef17d` |
| 领回版税 | 11694540 | 32,472 | `0x7030f9aabf083f282d494f26d36902ba5b6268ddaa7f927efbcf540640f6ac5b` |
| 公开铸造 `#3` | 11701211 | 185,022 | `0xbc3d9498e130a22e8b1dc94425845bf7edf49bcd4db5fb19b346b4ca85260774` |
| **首次两方成交**（EIP-712 签名成交） | **11701717** | **145,426** | `0xbb6918c809fad53b2f8fdf1b6723e8a29feb5fe76ce33faff423c996324eb5d3` |
| 清掉成交后残留的脏挂单（`cancel`） | 11701833 | 26,563 | `0xfd5518b71ec430cb1e694916b539d44ad0edba28850c6f64cda57dd7908ccad2` |
| 领回代收版税 | 11701863 | 32,472 | `0xa8d7acb154446174e8bf4cf9b1bc47631b0e7a8163a375670c5037a9b113dcb1` |

**成交细节**（区块 11701717；由买家发起、买家付 gas，卖家全程只签链下名）：

- 三条事件按序：`RoyaltyPaid`（0.000075 ETH）→ `Transfer`（卖家 → 买家）→ `Sold`（0.0015 ETH / 平台费 0.0000375 ETH）
- 分账：`0.0015 = 平台费 0.0000375 + 版税 0.000075 + 卖家实得 0.0013875`
- 签名用掉后 `listingNonces` 递增，同一份签名无法二次使用

**这次也暴露了一个真实缺陷，如实记下**：`fulfillListing`（以及 `acceptOffer`）成交后**不会清掉同一枚 NFT 上原有的链上挂单**——清挂单的那句写在 `buy()` 自己的函数体里，共用的 `_settleSale()` 并不负责。后果是页面仍显示在售，此时点「买入」会在持有者校验处 revert（**不丢钱，只白付一次 gas**），需由原卖家调 `cancel()` 清掉（本次即以此收尾，区块 11701833）。因为改动 `.sol` 会让已部署合约的 Sourcify 验证立即失效，本轮只如实披露、不改代码 —— 见下方已知限制第 7 条。

---

## 快速开始

```bash
git clone https://github.com/1MilesMa/web3market.git
cd web3market
npm install

cp .env.example .env      # 填入 SEPOLIA_RPC_URL 与测试网专用私钥，切勿使用存有真实资产的钱包

npx hardhat compile       # 预期零警告
npx hardhat test          # 预期 303 passing
npx hardhat coverage

cd frontend && node serve.js   # 打开 http://localhost:5173 进入链上操作台
```

`frontend/` 是一个零框架的纯静态操作台，用 ethers v6 直连 Sepolia，覆盖挂单 / 改价 / 撤单 / 买入 / 签名挂单 / 出价 / 三笔资金领取，并把 20 余种 revert 原因翻译成中文。

---

## 已知限制（如实披露）

| # | 限制 | 说明 |
|---|---|---|
| 1 | **未经第三方人工审计** | 现有证据是自测 + 覆盖率 + Slither，不能替代对业务逻辑与经济模型的穿透式审查 |
| 2 | **合约不可升级** | 刻意不用代理：零升级后门，代价是发现 bug 只能换合约，旧数据不迁移 |
| 3 | **时间锁延迟仅 300 秒** | 演示取值，主网建议 24–72 小时；改延迟无后门，同样要走公示 |
| 4 | **暂停权是中心化开关** | 2 人即可冻结全部开仓（不冻结取款）。刻意设计，需配套公示与监控 |
| 5 | **版税只在市场内强制** | EIP-2981 由本市场执行，场外转账与其他市场可以不付 |
| 6 | **公共 RPC 无 SLA** | 实测限流返回 HTTP 403；主网须配付费节点 + 备用 |
| 7 | **签名成交不会清掉链上挂单** | `fulfillListing` / `acceptOffer` 走 `_settleSale`，而清挂单写在 `buy()` 里，成交后旧挂单会残留 `active = true`、页面仍显示在售；此时点「买入」必定 revert（不丢钱，只白浪费 gas），原卖家可用 `cancel()` 清掉。修它须改 `.sol` → 已部署合约的源码验证失效，故本轮只披露不改码。详见上方「链上实盘记录」章节 |

---

## 技术栈与环境

| 项 | 版本 | 备注 |
|---|---|---|
| Node.js | v24.20.0 | |
| Hardhat | ^2.29.1 | |
| ethers | ^6.17.0 | v6 写法，非 v5 |
| Solidity (solc) | 0.8.28 | `evmVersion: cancun` |
| OpenZeppelin Contracts | ^5.6.1 | v5 系列 |
| chai | ^4.5.0 | **必须 4.x**（CommonJS），5.x 会报 ESM 加载错误 |
| solidity-coverage | ^0.8.17 | |
| hardhat-gas-reporter | ^2.3.0 | |
| Sepolia RPC | `https://ethereum-sepolia-rpc.publicnode.com` | chainId 11155111 |

> **为什么显式声明 `evmVersion: cancun`**：solc 0.8.28 默认按 Cancun 生成字节码，而 Hardhat 默认 EVM 是 paris，不一致会报 `mcopy instruction is only available for Cancun-compatible VMs`。

---

## 合约清单

| 合约 | 体积 | 职责与关键设计 |
|---|---|---|
| `contracts/HelloWeb3.sol` | 2.5 KB | 环境连通性验证用的最小合约，确认编译/部署链路可用 |
| `contracts/MyToken.sol` | 6.0 KB | ERC20 实现，练习 mint / approve / transferFrom 标准语义 |
| `contracts/MyNFT.sol` | 30.8 KB | ERC721 + **EIP-2981 版税**；`maxSupply = 10000`；支持 `setDefaultRoyalty` 调整版税；版税收款由 `withdrawRoyalties` 自取；**Ownable2Step** 两步转移所有权 + **Pausable** 紧急暂停（只挡铸造，不挡转移） |
| `contracts/SimpleMarket.sol` | 53.1 KB | 核心市场：挂单/购买/出价/版税分账/Pull Payment/重入防护；**Ownable2Step** 两步转移所有权 + **Pausable** 紧急暂停（只挡开仓、不挡退出） |
| `contracts/MultiSigOwner.sol` | 19.9 KB | 2/3 多签治理钱包：`submit` / `confirm` / `revoke` / `execute`，成员与阈值可自管理（`onlySelf`），用来接手市场 owner，消灭单人单点故障 |
| `contracts/mocks/MaliciousActors.sol` | 28.0 KB | 13 个攻击面合约（重入、拒收 ETH、假 ERC721 接收器等），专供测试使用，**不可部署到生产** |

**SimpleMarket 的能力边界**：授权式挂单（`listing` 而非托管）、一口价购买（`buy`）、买家出价（`makeOffer` / `withdrawOffer` / `rejectOffer` / `acceptOffer`）、平台费提取（`withdrawFees`，上限 `MAX_FEE_BPS = 1000` 即 10%）、待领池自取（`withdrawPendingFunds`）。

---

## 已部署合约（Sepolia 测试网）

| 合约 | 地址 | 区块 | 部署 gas | 关键参数 |
|---|---|---|---|---|
| HelloWeb3 | `0x07f6736520685181c22bd0B58714C7a30B92bb3a` | 11613406 | 670,426 | — |
| MyToken（现行） | `0x0D85B220d780D6BD462cC5931B6a79d00bCC0A18` | 11649632 | 709,837 | ERC20，练手合约；旧地址 `0xcc9f3027…BA0A05` 已作废 |
| MyNFT | `0x9EFe00123a6A22d903D63E195B7E87Bf3622412e` | 11631013 | 2,108,841 | 版税 5%（500/10000），receiver = owner；**现任 owner = MarketTimelock（2026-09-06 移交完成）** |
| **SimpleMarket（现行 · 含 EIP-712）** | **`0x71450D767f2b83722b88164316d7308DB20A39c8`** | 11631015 | 2,582,768 | `feeBps = 250`（2.5%），**现任 owner = MarketTimelock**（2026-09-05 由多签移交，详见第九节），支持 `fulfillListing` / `listingNonces` |
| **MultiSigOwner（2/3 治理）** | **`0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317`** | 11637734 | 1,336,270 | 成员 3 人、阈值 2；先接管 SimpleMarket owner，再作为**时间锁唯一 proposer / canceller** 继续掌权（2026-09-05，10 笔交易、gas 939,152） |
| **MarketTimelock（公示治理）** | **`0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119`** | 11638781 | 1,608,860 | `minDelay = 300s`；proposer = 多签，executor = 零地址（开放执行），admin = 零地址（无后门）；**SimpleMarket 现任 owner** |

### 已作废地址（勿用）

- `0x86C6A620…2d002` —— MyNFT（2026-09-04 部署），已被**治理加固版**取代（新增 Ownable2Step + Pausable）。
- `0x1948fDC7…3c15e` —— SimpleMarket（2026-09-04 部署），已被**治理加固版**取代（新增 Ownable2Step + Pausable）。
- `0x3FeEf51d7a180C2DCA7C8CB2794F421132cF2FE8` —— 出价版市场，**不含 EIP-712**，已被 2026-09-03 重部署的签名挂单版取代。
- `0x009A41338277B4180576cAf893596E0278bC8538` —— 版税版市场，已被出价版取代。
- `0xcc9f3027899899c743593E98be543B75B7BA0A05` —— 旧 MyToken，已被 2026-09-06 重部署的现行版取代。
- `0x5C81D2DA…5B46` —— 初版市场，部署记录已被后续部署覆盖，仅存地址前缀。

> **换合约 = 换受托方**：每部署一次新市场，卖家必须重新对该地址执行 `setApprovalForAll`，旧授权对新合约无效。旧市场的 `listing` / `offer` 数据不迁移。

---

## 核心机制速览

| 机制 | 要点 |
|---|---|
| **授权式挂单** | 挂单只记价格，NFT 留在卖家钱包；成交时合约凭 `setApprovalForAll` 授权代转移。省一次转账，也避免合约被攻破时批量失窃 |
| **EIP-2981 三方分账** | 成交价先扣平台费（2.5%），再按 `royaltyInfo()` 扣版税（5%），余款给卖家。分账算法只有一份，在 `_settleSale()` 里，`buy` 与 `acceptOffer` 共用 |
| **出价并存** | 出价表按 `nft → tokenId → bidder` 分插，同一枚 NFT 可被多人同时出价；重复出价是**累加**（加价），要降价须先取回再重出 |
| **Pull Payment** | 平台费、版税、退回的出价款**一律先记账**，由收款人主动 `withdraw*`。合约从不主动 `transfer` 外部地址 |
| **防 DoS** | `rejectOffer` 单笔退款失败时**不 revert**，把钱转入待领池，确保卖家能拒绝任意出价而不被恶意买家卡死 |
| **重入防护** | 涉及 `CALL` 转 ETH 的 4 个函数加 `nonReentrant`；`makeOffer` 不加锁——它唯一的外部调用是 `ownerOf`（`STATICCALL`，无写入面） |
| **EIP-712 免 gas 挂单** | 卖家离线签 `ListingIntent`（NFT + 价格 + nonce + deadline），买家带签名调 `fulfillListing` 一次成交；**卖家挂单零 gas**，成交总 gas 比「listing + buy」省约 40%。详见 [EIP-712 章节](#eip-712-链下签名挂单2026-09-03-新增) |
| **治理加固** | 所有权走 `Ownable2Step`：转移需新 owner 主动 `acceptOwnership`，转错地址不会立刻失控；`Pausable` 紧急暂停**只挡开仓类**（挂单/改价/买入/出价/接受出价/签名成交），撤单与各类提现**一律保持可用** —— 止血的同时绝不能冻结用户资金 |
| **多签治理** | 市场 owner 交给 `MultiSigOwner` 合约持有：3 人共管、2 票放行，提案 → 确认 → 执行；反悔可 `revoke`，改成员/阈值只能多签自己发起（`onlySelf`）。详见 [多签治理章节](#多签治理2026-09-05-新增) |
| **资金守恒** | 不变量等式：**合约余额 = 代管 + 待领池 + 平台费 + 版税**。每次演练都校验，实测拆解见下 |

**实测分账样例**（演练脚本 `practice-offer.js`）：成交价 0.0015 ETH → 平台费 0.0000375（2.5%）+ 版税 0.000075（5%）+ 卖家 0.0013875；另有悬空出价代管 0.001，合约余额增量 0.0011125，**守恒校验通过**。

### 链上实跑记录（Sepolia，2026-09-02）

出价全流程 11 步已在**真实测试网**执行完毕：24 项校验全部 `[OK]`，零失败，最终资金守恒校验通过（0.0011125 ETH），累计 gas 1,507,441。

| 项目 | 结果 |
|---|---|
| 执行区块区间 | 11620201 – 11620244 |
| 成交 | 买家 A 对 #1 出价 0.0015 ETH 被接受，#1 易主至 `0xb9a429a3…46a32` |
| 三方分账 | 平台费 0.0000375 + 版税 0.000075 + 卖家 0.0013875 |
| 出价并存 | A（0.001）与 B（0.002）同时对 #1 出价，互不挤占；A 追加 0.0005 累加至 0.0015 |
| **防 DoS** | 拒收 ETH 的合约 D 被拒绝时，退款失败 → 转入**待领池**，交易**未 revert** → D 后续全额领回 |
| **重入防护** | D 在 `receive()` 中重入 `withdrawOffer` / `withdrawPendingFunds`，均被 `nonReentrant` 挡下 |
| 悬空出价 | 买家 B 对 #2 的 0.001 ETH 仍托管在合约中，等待其自行 `withdrawOffer` |

> 完整日志见 `offer-sepolia.log`。演练账户的测试币由主账户内部划转补齐（脚本 `scripts/fund-account.js`），无需经过水龙头。

> 细节推演、行号级说明与踩坑记录见 [`docs/出价功能设计笔记.md`](docs/出价功能设计笔记.md)。

---

## EIP-712 链下签名挂单（2026-09-03 新增）

### 动机：把卖家的挂单 gas 降到零

传统路径下，卖家要发一笔 `listing()` 上链才能挂单，改价、下架同样都是链上交易。EIP-712 路径下卖家**只在本地签一个名**，签好的意向单可以挂网站、发社群；任何人想成交，就带着这条签名调 `fulfillListing`，由**买家**付 gas 一次性完成撮合与结算。

**gas 对照（脚本步骤 11，本地对照实测）**：

| 路径 | 总 gas | 谁付 |
|---|---|---|
| 传统 `listing()` + `buy()` | 228,283 | 卖家付挂单 + 买家付成交 |
| EIP-712 `fulfillListing()` | **135,600** | 全部由买家承担，**卖家 0 gas** |

### 签名结构

```solidity
struct ListingIntent {
    address nft;       // NFT 合约地址
    uint256 tokenId;   //  token ID
    uint256 price;     //  一口价
    uint256 nonce;     //  卖家维度的防重放序号
    uint256 deadline;  //  过期时间戳
}
```

EIP-712 域分隔（domain separator）内含 `chainId` 与市场合约地址，签名**跨链、跨合约自动失效**。

### 三重防重放

| 层 | 机制 | 挡住的攻击 |
|---|---|---|
| 1 | `nonce` 用后即焚（`listingNonces[seller]++`） | 同一条签名被重复成交 |
| 2 | `deadline` 过期检查 | 旧签名被长期囤积后择机套现 |
| 3 | `chainId` + 合约地址域分隔 | 主网签名拿到测试网、或拿到另一个市场合约重放 |

### 紧急下架

卖家发现签名泄露或临时改主意，发一笔 `incrementNonce()` 把序号跳号，**所有未成交的旧签名一次性作废**——不必知道签名曾经发给过谁。这是纯链上方案相对链下订单簿的取舍：下架要花一笔 gas，换来的是无需信任任何中心化撮合方。

### 链上实跑记录（Sepolia，2026-09-03）

12 步全流程在**真实测试网**执行完毕，全部 `[OK]`，最终资金守恒通过（合约余额 0.00045 = 平台费 0.00015 + 版税 0.0003 + 待领池 0.0）。

| 步骤 | 内容 | 交易哈希 |
|---|---|---|
| 重部署市场（含 EIP-712） | 区块 11631015，gas 2,582,768 | [`0xfb5444dc…d78ff4a`](https://sepolia.etherscan.io/tx/0xfb5444dc050322ad89fd9329d06462c4867fd519181103ee3a09ea6fad78ff4a) |
| NFT #9 凭签名成交（买家故意多付，验证自动退款） | 区块 11624082，0.0012 ETH | [`0xce6a3e52…5a25e91b`](https://sepolia.etherscan.io/tx/0xce6a3e525bcd78ea72aca01d20ae1216129e45529da20bca3d8615fb5a25e91b) |
| 卖家紧急下架 `incrementNonce` | 区块 11624083 | [`0xc3435a5e…119f019`](https://sepolia.etherscan.io/tx/0xc3435a5e1f871e05b64f0b943b146ea1f77eef78a948c25acb36e72a3119f019) |
| NFT #10 用新 nonce 重签后成交 | 区块 11624084，0.001 ETH | [`0xba24979c…b2af3882`](https://sepolia.etherscan.io/tx/0xba24979c90ad1f1379e649d945305fdf1f4b4f44cc875e19c9605e85b2af3882) |

**四道防线全部按预期拦截**：

| 场景 | 拒绝原因 |
|---|---|
| 步骤 6 —— 原样重放已用过的签名 | `InvalidNonce` |
| 步骤 7 —— 改价后沿用已消耗的 nonce 重签 | `InvalidNonce` |
| 步骤 8 —— 使用已过期的签名 | `SignatureExpired` |
| 步骤 9 —— 卖家跳号后再用旧签名 | `InvalidNonce` |

> **踩坑记录**：Sepolia 公共 RPC 对失败交易只回 `execution reverted`，拿不到自定义错误名，脚本按字符串匹配会误判。解决办法是改用 `eth_call` 静态模拟重放同一笔交易，直接解码 revert data 拿到 `InvalidNonce()` / `SignatureExpired()` 选择器，校验才真正落到**错误类型**而不是错误信息文本。
>
> **另一个坑**：资金守恒式最初漏算了版税池 `pendingRoyalties`，链上第 12 步报「0.0002 ETH 无归属」。补齐三池（平台费 + 版税 + 待领）后守恒通过——这也说明不变量校验确实能抓出记账口径的漏洞。

> 演练脚本：`scripts/practice-eip712.js`（本地 hardhat / Sepolia 双网络，12 步）；测试：`test/EIP712Listing.test.js`（20 条）。
> 重部署会覆盖 `deployments/simplemarket-sepolia.json`，旧地址 `0x3FeEf51d7…2FE8` 已作废，文档与授权均已同步到新合约。

---

## 多签治理（2026-09-05 新增）

### 动机：把「一个人说了算」换成「两个人点头才算」

市场合约的 owner 能改平台费率、能紧急暂停、能提取平台费。**这把钥匙只躺在一个人的钱包里，就是单点故障**：私钥一丢、一人作恶，项目当场完蛋。

多签把钥匙换成一个合约 `MultiSigOwner`，规则是 **3 人共管、2 票放行** —— 任何一笔 owner 操作都要先在链上提案，凑够 2 个人确认，才准执行。

### 一笔提案的四种动作

| 动作 | 谁可以做 | 效果 |
|---|---|---|
| `submit(to, value, data)` | 任意成员 | 建提案，并自动投第一票 |
| `confirm(txId)` | 任意成员（重复投票 revert） | 票数 +1 |
| `revoke(txId)` | 已投票的成员，**限执行前** | 票数 −1 —— 反悔机制 |
| `execute(txId)` | **任何人**（不够票则 revert） | 达标才真正发出这笔调用 |

`execute` 不做成员限制是刻意的：提案通过后谁付 gas 谁触发都行，免得"提案卡在没人有钱付 gas"。

### 四个安全细节

| 设计 | 为什么 |
|---|---|
| `onlySelf`：加人、踢人、改阈值只能由多签自己发起 | 外部谁都别想偷偷把自己加成 owner，或把阈值改成 1 |
| 先改状态、先发事件，最后才 `call` | 恶意目标合约回调 `execute` 会撞上 `AlreadyExecuted` |
| 用 `call` 而非 `delegatecall` | 目标合约无法借机篡改多签自己的存储 |
| `call` 失败即整笔回滚 | 绝不留"记了账却没办成"的半执行状态 |

### 本地演练：6 个场景（零成本、不花真钱）

```powershell
npx hardhat run scripts/practice-multisig.js
```

| 场景 | 结果 |
|---|---|
| 只有 1 票就想转走 0.1 ETH | revert `BelowThreshold(1, 2)` |
| 第 2 票补上后执行 | 成功 —— 而且由**非成员**代为触发也行 |
| 投了又反悔（`revoke`） | 票数退回 1，执行被拒 |
| 移交 owner（两步走） | 先 `transferOwnership`，多签投票通过再 `acceptOwnership` 才生效 |
| 移交后老账号想改费率 | revert `OwnableUnauthorizedAccount` —— 特权彻底消失 |
| 多签接手改费率 | 250 → 300 bps，走完提案流程才生效 |

### Sepolia 部署

| 项目 | 值 |
|---|---|
| 多签地址 | `0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317` |
| 部署交易 | `0xe7e5475ffa7c04be377b2c930a0ffff760c8adf3d4dcae4d49f1d94fd8efc04a` |
| 区块 / gasUsed | 11637734 / 1,336,270 |
| 部署后校验 | 回读链上 `threshold` = 2、`getOwners()` = 3 人、三个地址 `isOwner` 均为 true |

三位成员即 `.env` 里的三个测试网账号（`PRIVATE_KEY` / `PRIVATE_KEY_2` / `PRIVATE_KEY_3`）。部署脚本是**幂等**的：检测到已部署就复用，不会作废旧地址。

### owner 移交已完成（2026-09-05）

四步全部在 Sepolia 真实执行，区块区间 11638095 – 11638123：

| 步骤 | 交易 | 区块 | gas |
|---|---|---|---|
| 1. 账号 1 提名多签（`transferOwnership`） | `0x5b206a39…79e5500a` | 11638095 | 47,813 |
| 2. 多签提案 #0（`submit acceptOwnership`） | `0x578b655f…75caed77` | 11638096 | 146,756 |
| 3. 账号 2 补第二票（`confirm`） | `0x1c1d2bf2…cfc737215` | 11638098 | 58,143 |
| 4. 执行接管（`execute`） | `0x23c34e73…197b9a4c93` | 11638099 | 69,746 |

接管后市场 `owner()` 返回多签地址；账号 1 再调 `setFeeBps(999)` 直接 revert —— 特权彻底消失。

### 治理实战三关（接管后当场验证）

只证明"老账号失效"还不够，还得证明"多签真能办事"，否则等于把市场锁死。于是又跑了三关：

| 关卡 | 内容 | 结果 |
|---|---|---|
| 第 1 关 | 两人同意，费率 250 → 300 bps | 链上生效 ✓（提案 #1，gas 308,353） |
| 第 2 关 | 只凑 1 票，想把费率改成 999 | `execution reverted` —— **换账号 2 来触发也一样被拒** ✓ |
| 第 3 关 | 两人同意，费率改回 250 bps | 已还原 ✓（提案 #3，gas 308,341） |

第 2 关特意**换一个成员来触发执行**，为的是在链上留下"挡住它的不是提交者本人的特权，而是阈值"这个证据。

最终状态：`owner` = 多签 `0xC6b85AbB…9B045317`，费率 250 bps，阈值 2，提案总数 4（其中 #2 是那张只有 1 票、永远不会执行的废弃提案）。

> 想复现：`npx hardhat run scripts/transfer-market-to-multisig.js --network sepolia` 移交，`npx hardhat run scripts/verify-multisig-governance.js --network sepolia` 跑三关。两个脚本都可重入，中途断了再跑一次会接着做，不会重复提交。

---

## 测试与覆盖率

**`npx hardhat test` → 303 passing (4s)，0 failing**（2026-09-05 实测；其中 `MultiSigOwner.test.js` 专项 **56 passing**，含多签接管市场的三步实战）。

| 文件 | % Stmts | % Branch | % Funcs | % Lines | 未覆盖 |
|---|---|---|---|---|---|
| SimpleMarket.sol | **100** | **100** | **100** | **100** | — |
| MultiSigOwner.sol | **100** | 90.28 | **100** | **100** | — |
| MyToken.sol | 100 | 100 | 100 | 100 | — |
| HelloWeb3.sol | 100 | 100 | 100 | 100 | — |
| MyNFT.sol | 96.77 | 100 | 94.44 | 97.62 | 第 552 行 |
| MaliciousActors.sol | 92.5 | 66.67 | 90.63 | 88.5 | 644/660/738 |

- **MultiSigOwner 分支 90.28%**：缺口集中在「成员自管理」里几条防御性分支（如把阈值改成 0、移除非成员等已在入口被别的 require 挡住的组合路径），语句与函数均 100%。

- **MyNFT 第 552 行未覆盖（已实证，非缺陷）**：`_increaseBalance` 是菱形继承强制要求的转发钩子（`ERC721` 与
  `ERC721Enumerable` 都声明了它，C3 线性化要求最终合约显式 override，否则编译不过）。但 OZ **5.6.1** 的
  `ERC721._update` 已经不再调用这个钩子，而是把 `_balances[to] += 1` 直接内联——所以它在实际铸造流程中
  **根本不可达**，是库版本演进留下的死代码。为确认这一点，我比对了链上字节码与本地产物，差异只有
  immutable 填入的真值，代码逻辑完全一致（比对工具已固化为 `scripts/check-sepolia-sync.js`）。
- 恶意合约覆盖率偏低属预期——它们是攻击载体，分支未全触发不代表风险。

**测试覆盖面**：正常路径、边界（零价/超额/过期授权）、权限（非 owner、非卖家）、重入（4 类重入载体）、拒收（`EthRejectingReceiver` / `RefundRejectingBuyer` / `RoyaltyRejectingReceiver` / `RejectingOfferBidder` / `RejectingSeller`）、不变量（资金守恒）。

---

## 本地运行指南

### 1. 安装依赖

```powershell
cd <项目目录>
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填入：

```
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
PRIVATE_KEY=<测试网钱包私钥>
PRIVATE_KEY_2=<第二个测试账户，用于多角色交互>
PRIVATE_KEY_3=<第三个测试账户，出价演练的买家B，可选>
```

> 私钥请使用**专门的测试网钱包**，切勿放入存放真实资产的钱包。`.env` 不要上传 GitHub / 网盘 / 聊天工具。

### 3. 编译

```powershell
npx hardhat compile
```

### 4. 跑测试

```powershell
npx hardhat test
```

预期结尾：`202 passing (2s)`。

### 5. 本地演练（零成本）

```powershell
npx hardhat run scripts/practice-offer.js
```

跑完会打印步骤 0–11 的完整出价流程，含资金守恒校验。

多签治理同样有本地演练，六个场景把"1 票被拒 → 2 票办成 → 撤票 → 移交 owner → 老账号失效 → 改费率"完整走一遍：

```powershell
npx hardhat run scripts/practice-multisig.js
```

> 演练脚本优先读取 `deployments/` 下已部署地址；本地链无有效记录时自动回退现场部署。真实网络上若地址无代码会**直接报错**，绝不静默重部署。

> 本地演练实测（2026-09-05）：6 个场景全绿 —— 1 票执行被 `BelowThreshold(1, 2)` 拒、补第 2 票后由**非成员 carol 代为触发**执行成功、撤票后票数回落到 1/2 再次被拒、owner 两步走移交（提名时 `owner` 不变，多签投票通过后才 `acceptOwnership`）、老账号改费率被 `OwnableUnauthorizedAccount` 拒、多签走流程把费率 250 → 300 bps。

### 6. 部署到 Sepolia

```powershell
npx hardhat run scripts/deploy-mynft.js --network sepolia
npx hardhat run scripts/deploy-market.js --network sepolia
```

### Windows / PowerShell 三个坑

| 现象 | 原因与解法 |
|---|---|
| `无法加载文件 npx.ps1，因为在此系统上禁止运行脚本` | 执行策略限制。用 `npx.cmd` 代替 `npx`，或先跑 `Set-ExecutionPolicy -Scope Process Bypass -Force` |
| 终端中文乱码 | 先执行 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` |
| 日志落盘为空或出现名为 `1` 的文件 | 合并标准错误必须用 `2>&1`（不是 `2>1`）。正确写法：`npx hardhat test 2>&1 \| Out-File -Encoding utf8 test-result.txt`；想终端和文件都有输出，用 `Tee-Object` 代替 `Out-File` |

> 注意：`npx hardhat run` 每次是独立的进程级内存链，进程结束即销毁，**跨脚本验证读不到上一次的合约**。需要串联部署+验证时，先起常驻节点 `npx hardhat node`，再用 `--network localhost` 跑各脚本。

---

## 项目结构

```
web3-contract-project/
├─ contracts/
│  ├─ HelloWeb3.sol          环境验证
│  ├─ MyToken.sol            ERC20
│  ├─ MyNFT.sol              ERC721 + EIP-2981 版税
│  ├─ SimpleMarket.sol       市场 + 出价 + Pull Payment
│  ├─ MultiSigOwner.sol      2/3 多签治理钱包（接手 owner 用）
│  └─ mocks/MaliciousActors.sol   13 个攻击面合约
├─ test/
│  ├─ SimpleMarket.test.js   202 条用例的主战场
│  ├─ MultiSigOwner.test.js  多签专项 56 条（含接管市场实战）
│  ├─ MyNFT.test.js / MyToken.test.js / HelloWeb3.test.js
├─ scripts/
│  ├─ deploy.js / deploy-mynft.js / deploy-mytoken.js / deploy-market.js
│  ├─ deploy-multisig-sepolia.js        部署多签（幂等：已部署则复用）
│  ├─ transfer-market-to-multisig.js    两步走移交市场 owner（可重入）
│  ├─ verify-multisig-governance.js     治理实战三关：改费率 → 1 票被拒 → 还原
│  ├─ restore-fee-multisig.js           收尾：验证 1 票无效并把费率还原（可重入）
│  ├─ practice-offer.js      出价全流程演练（读已部署地址）
│  ├─ practice-multisig.js   多签治理 6 场景本地演练（零成本）
│  ├─ check-balances.js      只读：查 .env 各账号余额与 nonce
│  ├─ fund-account.js        主账户向指定地址内部划转测试币
│  ├─ practice-market.js / practice-authorize.js / nft-history.js
│  ├─ verify-*.js / check-balance.js / local-demo.js / settle-return.js
│  ├─ gen-frontend-config.js      部署后同步地址到前端 config.js
│  └─ verify-eip712-frontend.js   校验前端签名算法与链上摘要一致
├─ frontend/                 纯静态链上操作台（无框架，ethers v6 直连）
│  ├─ index.html / app.js    页面结构与全部业务逻辑
│  ├─ serve.js               零依赖静态服务器（node serve.js → :5173）
│  ├─ config.js              自动生成：合约地址与链配置
│  ├─ abi/                   从 artifacts 导出的两份 ABI
│  └─ README.md              启动方式、三条操作路径、常见问题
├─ deployments/              各网络部署记录（JSON）
├─ docs/
│  ├─ 出价功能设计笔记.md     行号级设计推演与踩坑
│  ├─ 项目交付清单.md         交付物索引、地址表、一键复现、验证证据
│  └─ 项目陈述与答辩稿.md     电梯陈述、5 大技术决策、12 组答辩 Q&A、诚实边界
└─ metadata/                 NFT metadata 示例
```

`.bak` 文件为出价功能合并前的备份，可安全删除。

---

## 安全审计：Slither 静态分析（2026-09-03 于 WSL 完成）

**结论：47 条告警全部为 INFO 级，零 Medium / 零 High；命中项目自身源码的 16 条已逐条判定，其中 12 条为设计使然或工具误报、4 条列为可选加固。**

> **2026-09-03 更新**：4 条可选加固已全部落地，编译零生产警告、225 测试零回归、Slither 复检通过，详见[第六节](#六可选加固已落地2026-09-03-复检)。

### 一、Windows 下的 6 次失败（如实归档，不伪造残缺报告）

| # | 方式 | 结果 |
|---|---|---|
| 1 | `slither .`（默认走 Hardhat 集成） | 卡死在 crytic-compile 解析阶段 |
| 2 | `--hardhat-ignore-compile` 直读 artifacts | 报 `Problem deserializing hardhat configuration` |
| 3 | `--filter-paths node_modules` / 丢弃输出 | 同样卡死 |
| 4 | 修 dotenv v17 的 stdout 污染（`config({ quiet: true })`）后重跑 | 污染消除，仍卡 crytic-compile |
| 5 | 装 solc-select + 独立 solc 0.8.28 二进制绕过 Hardhat | 参数 `--solc-solcs-binary` 不被识别（正确名为 `--solc-solcs-bin`） |
| 6 | 改用 `--compile-force-framework solc --solc <二进制路径>` | 仍退回 usage 输出，exit 1 |

根因是 Windows 下 crytic-compile 解析 Hardhat 项目卡死（工具链与平台兼容问题），不是本项目配置缺陷。

### 二、WSL 环境实跑（绕过 Hardhat 解析层）

环境：WSL2 Ubuntu 22.04.5 LTS（装在 `D:\WSL`）、Slither **0.11.6**、solc **0.8.28+commit.7893614a**。

关键做法：**不让 Slither 碰 Hardhat**，只把合约和 OZ 依赖复制进 WSL 原生 ext4 目录，用 `--solc` 显式指定编译器、`--solc-remaps` 手工解析 `@openzeppelin`：

```bash
mkdir -p /root/web3-audit
cp -r /mnt/d/web3/web3-contract-project/contracts /root/web3-audit/
cp -r /mnt/d/web3/web3-contract-project/node_modules/@openzeppelin /root/web3-audit/
cd /root/web3-audit
slither contracts/SimpleMarket.sol --solc /usr/local/bin/solc \
  --solc-remaps '@openzeppelin/=/root/web3-audit/@openzeppelin/'
```

完整报告：`logs/slither-report.txt`（1201 行，五个合约全量输出）。

### 三、结果总览

| 合约 | 分析单元内合约数 | 告警总数 | 命中自身源码 | 最高级别 |
|---|---|---|---|---|
| `HelloWeb3.sol` | 1 | 2 | 2 | INFO |
| `MyToken.sol` | 10 | 7 | 1 | INFO |
| `MyNFT.sol` | 25 | 60 | 7 | INFO |
| `SimpleMarket.sol` | 22 | 85 | 6 | INFO |
| `mocks/MaliciousActors.sol` | 42 | 124 | 8 | INFO（测试用恶意合约，不计入生产） |

说明：告警总数包含被 import 的 OpenZeppelin 库合约——Slither 会把整个编译单元都分析一遍，这是正常行为；判断项目质量要看「命中自身源码」那一列。

### 四、逐条判定（命中自身源码的 16 条，不含 mocks）

**HelloWeb3.sol（2）**

| Detector | 位置 | 判定 | 处置 |
|---|---|---|---|
| `timestamp` | #63 `require(index < _history.length)` | **误报**：检测的是数组越界检查，与 `block.timestamp` 无关 | 不改 |
| `immutable-states` | #19 `owner` | **误报**：`owner` 来自 OZ `Ownable`，会被 `transferOwnership` 改写，加 `immutable` 会直接破坏功能 | 不改 |

**MyToken.sol（1）**

| Detector | 位置 | 判定 | 处置 |
|---|---|---|---|
| `pragma` | 5 种 pragma 并存 | 全部来自 OZ 各版本声明，项目自身统一 `^0.8.28` | 不改 |

**MyNFT.sol（7）**

| Detector | 位置 | 判定 | 处置 |
|---|---|---|---|
| `reentrancy-no-eth` | #225-237 `_mintInternal` | 中等关注：`_safeMint` 回调之后才自增 `totalMinted`。当前仅作计数用、`adminMint` 有权限门，风险低 | **✅ 已落地（2026-09-03）**：`totalMinted += 1` 提到 `_safeMint` 之前（CEI），`adminMintWithTokenId` 同步调整 |
| `shadowing-local` | #284 `burn()` 局部变量 `owner` | 遮蔽 `Ownable.owner()`，可读性隐患 | **✅ 已落地（2026-09-03）**：改名为 `tokenOwner` |
| `reentrancy-benign` / `reentrancy-events` | #217 / #235 | OZ `_safeMint` 的 `onERC721Received` 回调是 ERC721 规范强制行为，benign 级 | 不改 |
| `dead-code` | #510 `_increaseBalance` | **误报**：这是 `ERC721` + `ERC721Enumerable` 菱形继承**必须**显式声明的 `override`，删掉会编译失败 | 不改 |
| `immutable-states` | #104 `maxSupply` | 构造后不再改写，加 `immutable` 可省每次读取的 SLOAD | **✅ 已落地（2026-09-03）**：声明为 `immutable` |
| `pragma` | 6 种 pragma 并存 | 同上，OZ 依赖导致 | 不改 |

**SimpleMarket.sol（6）**

| Detector | 位置 | 判定 | 处置 |
|---|---|---|---|
| `arbitrary-send-eth` | #896 `_settleSale` | **设计使然**：向卖家结算货款是市场合约的核心职责，调用前已校验卖家为 NFT 当前持有者，且外层 `buy` / `acceptOffer` 均带 `nonReentrant` | 不改 |
| `missing-zero-check` | #755 `rejectOffer` 的 `bidder` | 零地址的 offer 金额为 0，实际无资金风险 | **✅ 已落地（2026-09-03）**：Checks 首行加 `if (bidder == address(0)) revert ZeroAddress();` |
| `reentrancy-benign` | #769-772 `rejectOffer` | 函数已带 `nonReentrant`；且只有 `call` 返回 false 时才累加 `pendingWithdrawals` | 不改 |
| `timestamp` | #578 `block.timestamp > intent.deadline` | **设计使然**：EIP-712 签名的过期判断本来就必须依赖区块时间 | 不改 |
| `low-level-calls` | #543 / #620 / #728 / #769 | 四处均为退款或找零，都检查返回值，失败转待领池，是 Pull Payment 的标准写法 | 不改 |
| `pragma` | 5 种 pragma 并存 | OZ 依赖导致 | 不改 |

### 五、与其他验证手段的交叉印证

| 手段 | 结果 |
|---|---|
| Slither（WSL） | 47 条全 INFO，零中高危 |
| solc 0.8.28 编译警告 | 生产合约**零警告**（唯一一条 `pure` 提示在测试用恶意合约 `MaliciousActors.sol:107`） |
| 单元测试 | 225 passing（2026-09-03 那轮复检时的用例数），含 13 个恶意合约攻击载体 |
| 覆盖率 | SimpleMarket 100 / 100 / 100 / 100 |
| 链上实跑 | 出价 24 项 OK + EIP-712 四道防重放拦截，资金守恒通过 |
| 不变量校验 | 余额 = 代管 + 待领池 + 平台费 + 版税，每次演练校验通过 |

### 六、可选加固已落地（2026-09-03 复检）

四条全部改完，改动前后都留了备份（`contracts/MyNFT.sol.bak-slither-hardening`、`contracts/SimpleMarket.sol.bak-slither-hardening`）：

| 加固项 | 实际改动 | 复检结果 |
|---|---|---|
| `_mintInternal` CEI | `totalMinted += 1` 提到 `_safeMint` 之前；`adminMintWithTokenId` 同步调整，两条铸造路径顺序一致 | 报告中 `totalMinted` 相关的重入写入**归零** |
| `burn()` 局部变量改名 | `owner` → `tokenOwner` | `shadowing-local` **归零** |
| `maxSupply` 改 `immutable` | 构造后只读，省掉每次读取的 SLOAD | `immutable-states` 中该条**消失** |
| `rejectOffer` 零地址检查 | Checks 首行 `if (bidder == address(0)) revert ZeroAddress();` | 防御性补齐，零 gas 成本 |

落地后验证：

- `npx hardhat compile`：生产合约**零警告**（唯一一条 `pure` 提示仍在测试用 `mocks/MaliciousActors.sol:107`）
- `npx hardhat test`：**225 passing，零回归**
- Slither 复检：`logs/slither-report-v3.txt`（改用 `slither contracts` 口径，只扫生产 4 个文件，27 个 detector 结果块）

仍保留的 2 条 INFO（`reentrancy-benign` / `reentrancy-events`）来自 OZ v5 的 `_setTokenURI`：它内部要求 token 已存在（`_requireMinted`），因此只能在 `_safeMint` 之后调用，顺序无法再调，属于**依赖库约束**而非本项目缺陷。

---

### 七、多签合约复检（2026-09-05）

`MultiSigOwner.sol` 单独跑 Slither（WSL2 / solc 0.8.28 / 102 个 detector）：

| 轮次 | 结果 |
|---|---|
| 首轮 | 3 条 INFO：`reentrancy-events`、`costly-loop`、`low-level-calls` |
| 加固后 | **1 条 INFO**：只剩 `low-level-calls` |

两条已消除，改法都是为了让意图在代码里显式可见：

- **`reentrancy-events`**：把 `Executed` 事件提到 `call` **之前**发出。`call` 失败会整笔回滚，事件一并撤销，不留"半执行"状态。
- **`costly-loop`**：`removeOwner` 改成循环内只定位下标，`swap-and-pop` 移到循环外，循环里不再写状态。

保留的那条是设计使然，不改：多签要能调用**任意合约的任意函数**，`call` 是唯一选择，Gnosis Safe 同样如此。真正的防线是「先改状态再交互 + 失败即回滚」，而不是拒绝使用 `call`。

---

### 八、接管后全量复检（2026-09-05）

owner 移交与治理三关都跑完后，把整个项目（含 `mocks/`，共 58 个合约）重新扫了一遍：

```
slither . --filter-paths node_modules > slither-multisig.log 2>&1
```

> 这次是在本机 Windows 上直接跑的 —— 2026-09-03 在 WSL 里 `slither .` 会卡死在 crytic-compile，只能绕开 Hardhat 手工指定 `--solc`；这次本机一次跑通，算是意外收获。

**结果：58 个合约、102 个 detector、53 条结果，零中高危。** 生产三合约的命中如下：

| 合约 | 命中 detector | 说明 |
|---|---|---|
| SimpleMarket | `arbitrary-send-eth`、`reentrancy-benign`、`timestamp`、`low-level-calls` | 前两条来自给卖家打款（`_settleSale`）这一业务必需动作，且已有 CEI 防护；`timestamp` 是挂单/出价的截止时间判断，与金钱无关 |
| MyNFT | `dead-code` | 存在未被调用的函数，属清理项，无安全影响 |
| **MultiSigOwner** | **`low-level-calls`（仅 1 处）** | 就是 `execute()` 里那次 `call` |

多签的这条结论与第七节**独立复检完全一致** —— 两次分开跑、口径不同，都只剩同一个设计必然项，可以放心。`mocks/MaliciousActors.sol` 里的命中很多，但那是专门写来搞破坏的测试合约（拒绝收款、回调重入……），本来就该长那样，不计入。

---

### 九、时间锁治理：在多签之上再加一道公示（2026-09-05）

**为什么有了多签还不够**：多签解决的是"不能一个人说了算"，但它管不了"两个人半夜偷偷改完就跑"。用户看到费率被改时，钱可能已经按新费率成交了。时间锁补上的是**反应窗口**——任何敏感操作必须提前排队、公开晒满公示期才能生效，期间任何人都能在区块浏览器上看到，发现不对劲还来得及撤资或抗议。

**合约实现**：`contracts/MarketTimelock.sol` 是 OpenZeppelin `TimelockController` 的**薄封装，零新增逻辑**。用现成审计实现、一行业务逻辑都不加，是本轮刻意的选择——时间锁的每一行自定义代码都是新的攻击面，没必要自己发明。

| 角色 | 持有者 | 含义 |
|---|---|---|
| `PROPOSER_ROLE` | 多签合约 | 只有 2 票通过才能排队 |
| `CANCELLER_ROLE` | 多签合约 | 公示期内发现不对可以反悔撤销 |
| `EXECUTOR_ROLE` | `address(0)` | **对公众开放**，公示满了任何人都能点，不怕最后一公里没人执行 |
| `DEFAULT_ADMIN_ROLE` | `address(0)` | **零后门**，连改延迟本身都要再排一次队 |

**两道防线叠起来后的效果**：

| 场景 | 只有多签 | 多签 + 时间锁 |
|---|---|---|
| 单人想改费率 | 被拒（票数不够） | 被拒 |
| 两人串通改费率 | **立即生效** | 排队 → 公示 300 秒 → 才生效，期间可被撤销 |
| 外部账号（有钱有币）想排队 | — | 被拒（不是 proposer） |
| 公示没到点就抢跑执行 | — | 被拒 |
| 改延迟给自己留后门 | 可以 | 不行，admin 是零地址，改延迟也要排队公示 |

**链上动作（全部 Sepolia 实证）**：

```
1. 部署时间锁     0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119
                  区块 11638781，gas 1,608,860，回读校验 5/5 通过
2. 多签提名       提案 #4：transferOwnership(时间锁)
3. 排队接受 owner  提案 #5：schedule(acceptOwnership)，区块 11638804 – 11638807
4. 公示 300 秒    ⏳ 期间 owner 仍是多签 —— 交接期无权力真空
5. 执行易主       区块 11638841，gas 45,280 → owner() = 时间锁
6. 治理实战       改费率 250→300：排队 → 抢跑被拒 → 到期执行生效（区块 11638875）
                  再排队还原 250：抢跑被拒 → 到期执行（区块 11638906）
                  外部账号排队：被拒
```

合计 **12 笔交易、gas 3,200,131、区块 11638781 – 11638906**，费率最终回到 250 bps，零残留。日志在 `logs/verify-timelock-sepolia.log`。

#### MyNFT 侧移交时间锁（2026-09-06 完成）

市场归时间锁管了，但 NFT 侧一度还是部署者 EOA——能一个人改版税、开关公开铸造、冻结铸造。这一步把它收进同一套治理：

```
1. EOA 提名时间锁   tx 0x978063dceb843020084fe529c9bc7e0986fda9c23d6b5ef236d92bc8e3fd2c35   区块 11647034
2. 多签排队接受     提案 #8：schedule(MyNFT.acceptOwnership)
                    tx 0x571f887086352126030af91cccf8f22a297555c95037accc4bdf99ab4697c3ba   区块 11647038
3. 公示 300 秒      CallScheduled 全网可见，期间可由多签撤销
4. 到期执行         CallExecuted tx 0xa89939aa319cb26df60e592c58bc8c5669ac84a133eddfca12f084f76da47e46
                    区块 11647067 → MyNFT.owner() = 0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119
```

脚本 `scripts/transfer-mynft-to-timelock.js`：默认演练（只读链上状态、打印将要做什么），`EXECUTE=1` 才真正发交易；可重入，中途断开重跑会从断点继续。

#### MyToken 侧移交时间锁（2026-09-06 完成）

MyToken 是 ERC20，`owner` 握着 `onlyOwner` 的 `mint` / `burn`——留在部署者 EOA 手里，等于"项目方还能一个人印钱"。这一步把它并进同一套治理：

```
1. 演练   npx hardhat run scripts/transfer-mytoken-to-timelock.js --network sepolia
          读出：owner = 部署者 EOA、多签确为时间锁 proposer、EOA 余额够 gas
2. 上链   transferOwnership(0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119)
          tx 0x4b4e388d7b9a912d213f55f53a112fdbd6dc87f930312199607ab03faa6db893
          区块 11647801，gas 28,656 → MyToken.owner() = 时间锁
```

与 MyNFT 的差异值得记一笔：MyNFT 是 `Ownable2Step`，必须「提名 → 对方 acceptOwnership」两步，而 accept 只能由时间锁发起，所以要多签排队 + 公示；MyToken 是普通 `Ownable`，`transferOwnership` 一笔到位，**不需要走公示**——因为移交那一刻权力完整地从 EOA 移到时间锁，中间没有需要被监督的空档。移交之后，想再增发同样得 2/2 多签排队 + 300 秒公示。

**HelloWeb3 为何不收编**：它的 `owner` 只是部署时在构造函数里记下的一个地址，源码里没有 `onlyOwner` 函数、也没有 `transferOwnership`，**既无实权也无处可交**。留着不影响任何安全结论。

**gas 参考（本地实测）**：

| 操作 | gas |
|---|---|
| 时间锁部署 | 1,608,860 |
| 多签提交提案 | 248,267 |
| 多签补第二票 | 58,152 |
| 多签执行（触发排队） | 100,608 |
| 时间锁执行 | 47,924 |

**公示延迟怎么选**：没有标准答案，取决于项目阶段。

| 场景 | 建议 | 理由 |
|---|---|---|
| 学习验证（本项目） | 5 分钟 | 全流程十分钟内闭环，快速拿链上凭证 |
| 测试网准生产 | 1 小时 | 更贴近真实治理节奏 |
| 主网生产 | 2 天 | 主流 DeFi（Compound / Uniswap）的通行值，给用户留出看到变更、决定撤资的窗口 |

延迟不是写死的：多签排一次 `updateDelay(3600)`，等公示走完即可改成 1 小时，改完立即生效。也就是说**今天用 5 分钟验证链路，明天想加严，成本只是一次治理流程**。

**验证覆盖**：本地演练 31 项断言全 PASS（零 gas）+ 单元测试 `TimelockGovernance.test.js` 7 passing（全量 `npx hardhat test` **303 passing / 0 failing**，零回归）+ Slither 复检 68 合约 / 59 条结果**新增合约零告警**。脚本全部可重入，跑到任何一步被中断，重跑都能接着走。

---

## 后续路线

- ~~**Slither 静态分析**~~ **已完成两轮**：2026-09-03 首轮（WSL2，47 条全 INFO）；2026-09-05 接管后全量复检（本机 Windows，58 合约 / 53 条结果，零中高危），报告存 `slither-multisig.log`，结论见第六、七、八节。
- **Etherscan 源码验证**（**待办**）：需要一枚 Etherscan API Key（免费注册即得）。拿到后逐个合约提交源码验证，验证通过即可在区块浏览器上公开阅读与直接调用。
- ~~**多签治理上链**~~ **已于 2026-09-05 完成**：多签部署 + owner 移交 + 治理三关全部在 Sepolia 跑通（10 笔交易，gas 939,152，区块 11638095 – 11638123）。市场 owner 现由多签持有，单人已无法改费率。
- ~~**时间锁治理上链**~~ **已于 2026-09-05 完成**：时间锁部署 + owner 从多签移交 + 治理实战（改费率 → 生效 → 还原）+ 三项越权拦截全部在 Sepolia 跑通（12 笔交易，gas 3,200,131，区块 11638781 – 11638906）。市场 owner 现由时间锁持有，敏感操作必须「2 票通过 + 公示满点」。详见第九节。
- ~~**链上出价实跑**~~ **已于 2026-09-02 完成**：`.env` 已补齐 `PRIVATE_KEY_3`，`npx hardhat run scripts/practice-offer.js --network sepolia` 执行完毕，24 项校验全过（详见上方「链上实跑记录」）。
- **合规技术路线延伸**：Solidity 公链练手之后，可转向联盟链方向（FISCO BCOS / 长安链），贴合国内合规场景。

---

## 前端控制台（2026-09-04 新增）

一个纯静态页面，用 ethers v6 直接和 Sepolia 上的 MyNFT / SimpleMarket 对话，覆盖全部对外接口：
挂单 / 改价 / 撤单 / 买入、EIP-712 签名挂单与成交、出价与处置出价、三笔资金的领取，
并把 20 余种 revert 原因翻译成中文提示。

```bash
cd frontend && node serve.js     # 然后打开 http://localhost:5173
```

之所以要用本地服务器而不是双击 html：`file://` 协议下浏览器会禁止读取同目录的 `abi/*.json`，页面将拿不到 ABI。

三条完整操作路径、分区说明与常见问题见 `frontend/README.md`。

**签名链路已做链上验证**：`scripts/verify-eip712-frontend.js` 让合约的 `hashListingIntent()`
与前端的 `TypedDataEncoder` 各算一次摘要并逐字节比对，当前一致 —— 前端生成的签名可被链上正确验签。

---

## 免责说明

本项目为**技术学习用途**，所有合约仅部署于 Sepolia 测试网，不涉及任何代币发行、融资或交易撮合业务。请勿将测试网私钥用于存放真实资产的钱包。
