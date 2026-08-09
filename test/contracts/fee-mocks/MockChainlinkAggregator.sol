// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../chainlink/AggregatorV3Interface.sol";

/// @title MockChainlinkAggregator
/// @notice Test double for Chainlink Data Feeds.
contract MockChainlinkAggregator is AggregatorV3Interface {
    uint8 public override decimals;
    int256 public answer;
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;
    uint256 public updatedAt;

    constructor(uint8 _decimals, int256 initialAnswer) {
        decimals = _decimals;
        answer = initialAnswer;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 newAnswer) external {
        answer = newAnswer;
        ++roundId;
        answeredInRound = roundId;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 timestamp) external {
        updatedAt = timestamp;
    }

    function setRound(uint80 newRoundId, uint80 newAnsweredInRound) external {
        roundId = newRoundId;
        answeredInRound = newAnsweredInRound;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}
