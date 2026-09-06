// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title HelloWeb3 —— 链上留言板
 * @dev 每一次留言都会连同作者地址、时间戳被永久记录在链上，任何人可查、无人可改。
 *      作为 Solidity 入门的第一个合约，它覆盖了：
 *      状态变量、结构体、数组、事件(Event)、函数可见性、require 校验、msg.sender
 */
contract HelloWeb3 {
    /// @dev 一条留言记录
    struct Entry {
        string content;    // 留言内容
        address author;    // 留言者地址
        uint256 timestamp; // 区块时间戳
    }

    Entry[] private _history;   // 全部历史留言
    address public owner;       // 合约部署者
    uint256 public updateCount; // 留言更新次数

    /// @dev 每次留言更新时触发，前端可监听该事件做实时展示
    event MessageUpdated(
        address indexed author,
        string content,
        uint256 timestamp,
        uint256 index
    );

    constructor(string memory initialMessage) {
        owner = msg.sender;
        updateCount = 0;
        _history.push(Entry(initialMessage, msg.sender, block.timestamp));
        emit MessageUpdated(msg.sender, initialMessage, block.timestamp, 0);
    }

    /// @notice 写入一条新留言（会改变链上状态，需要支付 gas）
    function setMessage(string calldata newMessage) external {
        require(bytes(newMessage).length > 0, "message cannot be empty");
        require(bytes(newMessage).length <= 280, "message too long (max 280)");

        _history.push(Entry(newMessage, msg.sender, block.timestamp));
        updateCount += 1;
        emit MessageUpdated(
            msg.sender,
            newMessage,
            block.timestamp,
            updateCount
        );
    }

    /// @notice 读取最新一条留言（view 函数，不消耗 gas）
    function getMessage() external view returns (string memory) {
        return _history[_history.length - 1].content;
    }

    /// @notice 按序号读取某条历史留言
    function getEntry(uint256 index)
        external
        view
        returns (string memory content, address author, uint256 timestamp)
    {
        require(index < _history.length, "index out of range");
        Entry memory e = _history[index];
        return (e.content, e.author, e.timestamp);
    }

    /// @notice 历史留言总条数
    function historyLength() external view returns (uint256) {
        return _history.length;
    }
}
