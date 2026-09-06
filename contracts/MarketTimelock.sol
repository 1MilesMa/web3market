// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title MarketTimelock
 * @notice 市场治理的"公示延迟层"：多签每做一次参数修改，都要先排队公示一段时间才能生效。
 *
 * 为什么需要它？
 *   多签解决的是"一个人说了不算"，但解决不了"几个人半夜偷偷改参数、用户来不及跑"。
 *   时间锁补上第二个维度：任何治理动作在上链生效前必须公示 minDelay 秒。
 *   这段时间里用户可以观察到 CallScheduled 事件，发现不对劲就撤出资金或发起撤销。
 *
 * 角色设计（部署参数固定为下面这套，见 scripts/ 下的部署与演练脚本）：
 *   - PROPOSER_ROLE  = 多签合约地址（唯一有权排队的人；构造函数会自动同时给它 CANCELLER_ROLE）
 *   - EXECUTOR_ROLE  = address(0)（开放执行：延迟期已走完的动作任何人都能触发，
 *                      避免"多签批准了却没人手点最后一公里"导致治理卡死）
 *   - TIMELOCK_ADMIN = address(0)（不留管理员后门；改延迟、改角色都必须走时间锁自己排一次队）
 *
 * 完整治理链路：
 *   成员提交多签提案 -> 2 票通过 -> 多签调用 schedule(...) 排队
 *   -> 公示 minDelay 秒（期间任何人可见，多签可 cancel）
 *   -> 到期后任何人调用 execute(...) -> 动作真正落到市场合约上
 *
 * @dev 这是对 OpenZeppelin TimelockController 的零逻辑薄封装。
 *      不新增状态变量、不覆写任何函数，目的仅有两个：
 *        1. 让 hardhat 编译出名为 MarketTimelock 的 artifact，脚本可以直接 getContractFactory
 *        2. 给这份标准的角色约定留个项目内的说明入口，方便答辩时讲清设计取舍
 *      安全属性完全继承 OZ 已审计的实现。
 */
contract MarketTimelock is TimelockController {
    /**
     * @param minDelay   最小公示延迟（秒）。部署后只能通过时间锁自身的治理流程修改。
     * @param proposers  获得 PROPOSER_ROLE + CANCELLER_ROLE 的地址，本项目中传多签合约地址。
     * @param executors  获得 EXECUTOR_ROLE 的地址；传 [address(0)] 表示开放给所有人执行。
     * @param admin      获得 TIMELOCK_ADMIN_ROLE 的地址；传 address(0) 表示不留管理员。
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
