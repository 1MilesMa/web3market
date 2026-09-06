// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// OpenZeppelin v5 导入路径说明：
//   @openzeppelin/contracts/token/ERC20/ERC20.sol          —— ERC20 标准的基础实现
//   @openzeppelin/contracts/token/ERC20/extensions/...     —— 官方扩展（燃烧、快照、投票等）
//   @openzeppelin/contracts/access/Ownable.sol             —— 最简权限模型：单一 owner
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MyToken —— 基于 OpenZeppelin 的标准 ERC20 代币（学习实践版）
 *
 * @dev 【为什么要继承，而不是自己写？】
 *      ERC20 是一套被行业验证过的接口标准，自己手写容易在边界条件上出错
 *      （例如转账 0 值、授权竞态、事件缺失等）。OpenZeppelin 的实现经过
 *      多次审计与实战检验，继承它是业界默认做法。
 *
 *      本合约同时继承三个父类，Solidity 支持多重继承：
 *        - ERC20         : 提供 totalSupply / balanceOf / transfer / approve /
 *                          allowance / transferFrom 全套标准接口，以及内部的
 *                          _mint / _burn / _update / _approve 等底层钩子。
 *        - ERC20Burnable : 在 ERC20 之上增加 burn(amount) 与 burnFrom(account, amount)，
 *                          让任何持币人都能销毁自己手里的代币。
 *        - Ownable       : 提供 owner 状态变量、onlyOwner 修饰符、
 *                          transferOwnership / renounceOwnership，
 *                          以及 modifier onlyOwner 做函数调用权限控制。
 *
 *      【继承顺序的含义】Solidity 要求「最底层、最基础」的父合约写在最前面
 *      （C3 线性化规则）。ERC20 是根基，ERC20Burnable 是它的扩展，
 *      Ownable 独立，因此顺序为 ERC20, ERC20Burnable, Ownable。
 */
contract MyToken is ERC20, ERC20Burnable, Ownable {
    /// @dev 代币精度（小数位数）。ERC20 标准是 18，与 ETH 保持一致，
    ///      意味着 1 个代币在链上实际存储为 1 * 10^18 个最小单位。
    uint8 private constant DECIMALS = 18;

    /**
     * @param initialOwner    合约部署后拥有 owner 权限的地址（可 mint / burn）
     * @param initialSupply   初始发行量，单位是「整币」（例如 1000000 表示 100 万枚），
     *                        构造函数内部会按 DECIMALS 把它放大成链上整数。
     */
    constructor(
        address initialOwner,
        uint256 initialSupply
    )
        ERC20("MyToken", "MTK") // 父合约构造：ERC20(name, symbol)
        Ownable(initialOwner) // 父合约构造：Ownable(initialOwner)，v5 起必须显式传入
    {
        // _mint 是 ERC20 内部的「铸造」函数：
        //   - 给 to 地址增加 amount 余额
        //   - 增加 totalSupply
        //   - 触发 Transfer(address(0), to, amount) 事件
        //     注意事件里 from 是零地址，链上浏览器据此识别为「铸造」。
        // 它本身不带权限校验，因此「谁能调用它」必须由我们自己控制：
        // 这里放在构造函数里，意味着只在部署时执行一次，天然安全。
        _mint(initialOwner, initialSupply * 10 ** DECIMALS);
    }

    /**
     * @notice 增发代币（只有 owner 能调用）
     * @dev 【权限修饰符 onlyOwner】这是 Ownable 提供的 modifier。
     *      它等价于在函数体最前面插入：
     *          require(msg.sender == owner(), "Ownable: caller is not the owner");
     *      若调用者不是 owner，交易会 revert（回滚），状态不被修改，
     *      错误信息为 OwnableUnauthorizedAccount(address caller)。
     *      modifier 是 Solidity 复用「前置/后置校验逻辑」的标准写法，
     *      比在每个函数里手写 require 更清晰、更不容易漏。
     *
     *      【为什么 mint 要受控】无限增发会稀释所有持币人的资产，
     *      是代币经济模型的核心风险点，所以必须收敛权限。
     */
    function mint(address to, uint256 amount) external onlyOwner {
        // amount 的单位是「最小单位」（即已含 18 位小数），
        // 与 transfer/balanceOf 等标准接口保持一致，避免调用方混淆。
        _mint(to, amount);
    }

    /**
     * @notice 从指定地址销毁代币（只有 owner 能调用）
     * @dev 与 ERC20Burnable.burn() 的区别：
     *        burn(amount)          —— 任何人都只能烧「自己」的币
     *        burnFrom(acc, amount) —— 烧别人的币，但需要先获得对方的 approve 授权（扣 allowance）
     *      本函数是第三种：由 owner 强制销毁任意地址的代币，属于高权限操作，
     *      实际项目中通常用于锁仓回收、错误补偿等场景，需谨慎使用。
     *
     *      _burn 是 ERC20 内部「销毁」函数：
     *        - 减少 account 的余额（余额不足会自动 revert）
     *        - 减少 totalSupply
     *        - 触发 Transfer(account, address(0), amount) 事件
     */
    function burn(address account, uint256 amount) external onlyOwner {
        _burn(account, amount);
    }

    /**
     * @notice 代币精度，覆盖 ERC20 默认的 18
     * @dev 【decimals 到底有什么用】
     *      链上只存整数，不存在「小数点」。decimals() 是给前端/钱包看的
     *      「显示规则」：余额 1500000000000000000（1.5e18）配合 decimals=18，
     *      前端就显示成 1.5。因此它只影响展示，不影响任何链上数学运算。
     *      绝大多数代币都用 18（与 ETH 对齐）；USDC 是特例，用 6。
     *      本函数仅作教学演示，返回值与默认值一致。
     */
    function decimals() public pure virtual override returns (uint8) {
        return DECIMALS;
    }
}
