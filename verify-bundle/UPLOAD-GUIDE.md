# Etherscan 源码验证包 —— 上传说明

本机网络到 Etherscan 全域名超时，因此改用「离线生成 + 手动上传」的方式完成源码验证。
下面的文件已经全部备好，你只需要在一个**能打开 etherscan.io** 的设备上按步骤点。

## 需要什么

- 一个能访问 etherscan.io 的网络环境（家里 WiFi 和手机流量都试过不行的话，换其他网络）
- 一个已登录的 Etherscan 账号（免费注册，不需要 API Key）

## 每个合约要传两个东西

| 合约 | 地址 | 标准 JSON 文件 | 构造参数文件 |
| --- | --- | --- | --- |
| MyNFT | `0x9EFe00123a6A22d903D63E195B7E87Bf3622412e` | MyNFT-standard-input.json | MyNFT-constructor-args.txt |
| SimpleMarket | `0x71450D767f2b83722b88164316d7308DB20A39c8` | SimpleMarket-standard-input.json | SimpleMarket-constructor-args.txt |
| MultiSigOwner | `0xC6b85AbB9A0c00495d75C8C52Ad922DD9B045317` | MultiSigOwner-standard-input.json | MultiSigOwner-constructor-args.txt |
| MarketTimelock | `0xdF0886dCFEB54538cDC9Df59BF0E7e3e061Ee119` | MarketTimelock-standard-input.json | MarketTimelock-constructor-args.txt |
| MyToken | `0xcc9f3027899899c743593E98be543B75B7BA0A05` | MyToken-standard-input.json | MyToken-constructor-args.txt |

> MyToken 的构造参数已用其在 Sepolia 上的部署交易 calldata 反向校验过（initialOwner `0xe3C2…afCd8`、initialSupply `1000000`），与链上字节完全一致。

## 上传步骤（每个合约重复一次）

1. 打开 `https://sepolia.etherscan.io/address/<合约地址>`（把地址换成上表里的）
2. 点页面上的 **Contract** 标签页
3. 如果显示 **Verify and Publish** 链接，点它；已验证过就不用管了
4. 填写验证信息：
   - **Compiler Type**：选 `Solidity (Standard JSON Input)`
   - **Compiler Version**：`v0.8.28+commit.7893614a`
   - 点 **Continue**
5. 上传标准 JSON 文件：
   - 点 **Browse** / 选择文件，选中对应的 `<合约名>-standard-input.json`
   - 如果页面让你确认文件，直接确认
6. 填构造参数：
   - 找到 **Constructor Arguments (ABI-encoded)** 那一栏
   - 打开对应的 `<合约名>-constructor-args.txt`，全选复制，粘贴进去
   - （也可以展开下面的 **Constructor Arguments** 逐个填，但直接贴编码串更不容易错）
7. 勾选同意条款，点 **Verify and Publish**
8. 等十几秒，页面显示绿色对勾 / `Successfully verified` 就成了

## 怎么算成功

合约页面的 **Contract** 标签出现绿色对勾，且能直接看到源码和 `Read Contract` / `Write Contract` 按钮。

## 常见问题

- **报构造参数不匹配**：99% 是构造参数填错或顺序不对，用本目录里的 txt 原样复制即可
- **报编译结果不一致**：确认 Compiler Version 选的是 0.8.28，且 JSON 文件是本目录生成的（别用旧副本）
- **已经验证过了**：页面会直接显示源码，跳过即可

---

生成时间：2026-09-05T10:36:43.659Z
