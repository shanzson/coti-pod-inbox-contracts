// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/IPodPriceOracle.sol";
import "../ILivePriceMetaReader.sol";
import "./ChainlinkPriceReader.sol";

/// @title ChainlinkLiveOracle
/// @notice Chainlink Data Feed adapter implementing {IPodPriceOracle}.
contract ChainlinkLiveOracle is IPodPriceOracle, ILivePriceMetaReader, Ownable {
    /// @notice Max seconds since `updatedAt` before a read is ignored (`0` = no staleness check).
    uint256 public maxStaleness;

    /// @notice Chainlink aggregator per token address.
    mapping(address => address) public aggregators;

    event MaxStalenessUpdated(uint256 previous, uint256 current);
    event FeedUpdated(address indexed token, address aggregator);

    /// @param initialOwner Admin for feed configuration.
    constructor(address initialOwner, uint256 _maxStaleness) Ownable(initialOwner) {
        maxStaleness = _maxStaleness;
    }

    /// @notice Set max feed staleness.
    function setMaxStaleness(uint256 seconds_) external onlyOwner {
        emit MaxStalenessUpdated(maxStaleness, seconds_);
        maxStaleness = seconds_;
    }

    /// @notice Configure Chainlink aggregator for `token`.
    function setFeed(address token, address aggregator) external onlyOwner {
        aggregators[token] = aggregator;
        emit FeedUpdated(token, aggregator);
    }

    /// @inheritdoc IPodPriceOracle
    function getLivePrice(address token) external view returns (uint256 priceUsd) {
        (bool ok, uint256 price) =
            ChainlinkPriceReader.tryReadPrice(ChainlinkPriceReader.Config({aggregator: aggregators[token]}), maxStaleness);
        return ok ? price : 0;
    }

    /// @inheritdoc IPodPriceOracle
    function getLivePrices(address tokenA, address tokenB)
        external
        view
        returns (uint256 priceA, uint256 priceB)
    {
        priceA = this.getLivePrice(tokenA);
        priceB = this.getLivePrice(tokenB);
    }

    /// @inheritdoc ILivePriceMetaReader
    function readPriceWithMeta(address token) external view returns (uint256 priceUsd, uint256 updatedAt) {
        (bool ok, uint256 price, uint256 updated) = ChainlinkPriceReader.tryReadPriceWithMeta(
            ChainlinkPriceReader.Config({aggregator: aggregators[token]}),
            maxStaleness
        );
        return ok ? (price, updated) : (0, updated);
    }
}
