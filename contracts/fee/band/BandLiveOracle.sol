// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/IPodPriceOracle.sol";
import "../ILivePriceMetaReader.sol";
import "./BandPriceReader.sol";

/// @title BandLiveOracle
/// @notice Band StdReference adapter implementing {IPodPriceOracle}.
contract BandLiveOracle is IPodPriceOracle, ILivePriceMetaReader, Ownable {
    /// @notice Default Band quote symbol (USDC/USDT peg).
    bytes32 public constant BAND_QUOTE_USDC = bytes32("USDC");

    /// @notice Band StdReference proxy (zero disables reads).
    address public bandStdRef;

    /// @notice Max seconds since update before a read is ignored (`0` = no staleness check).
    uint256 public maxStaleness;

    /// @notice Band symbol pair per token address.
    mapping(address => BandPriceReader.Config) public feeds;

    event BandStdRefUpdated(address indexed previous, address indexed current);
    event MaxStalenessUpdated(uint256 previous, uint256 current);
    event FeedUpdated(address indexed token, bytes32 bandBase, bytes32 bandQuote);

    /// @param initialOwner Admin for feed configuration.
    constructor(address initialOwner, address _bandStdRef, uint256 _maxStaleness) Ownable(initialOwner) {
        bandStdRef = _bandStdRef;
        maxStaleness = _maxStaleness;
    }

    /// @notice Set the Band StdReference contract.
    function setBandStdRef(address ref) external onlyOwner {
        emit BandStdRefUpdated(bandStdRef, ref);
        bandStdRef = ref;
    }

    /// @notice Set max feed staleness.
    function setMaxStaleness(uint256 seconds_) external onlyOwner {
        emit MaxStalenessUpdated(maxStaleness, seconds_);
        maxStaleness = seconds_;
    }

    /// @notice Configure Band symbols for `token` (quote defaults to USDC when zero).
    function setFeed(address token, bytes32 bandBase, bytes32 bandQuote) external onlyOwner {
        if (bandQuote == bytes32(0)) {
            bandQuote = BAND_QUOTE_USDC;
        }
        feeds[token] = BandPriceReader.Config({base: bandBase, quote: bandQuote});
        emit FeedUpdated(token, bandBase, bandQuote);
    }

    /// @inheritdoc IPodPriceOracle
    function getLivePrice(address token) external view returns (uint256 priceUsd) {
        (bool ok, uint256 price) = BandPriceReader.tryReadPrice(bandStdRef, feeds[token], maxStaleness);
        return ok ? price : 0;
    }

    /// @inheritdoc IPodPriceOracle
    function getLivePrices(address tokenA, address tokenB)
        external
        view
        returns (uint256 priceA, uint256 priceB)
    {
        if (BandPriceReader.canBulkRead(feeds[tokenA], feeds[tokenB])) {
            (bool okA, uint256 a, bool okB, uint256 b) =
                BandPriceReader.tryReadPriceBulk(bandStdRef, feeds[tokenA], feeds[tokenB], maxStaleness);
            return (okA ? a : 0, okB ? b : 0);
        }
        priceA = this.getLivePrice(tokenA);
        priceB = this.getLivePrice(tokenB);
    }

    /// @inheritdoc ILivePriceMetaReader
    function readPriceWithMeta(address token) external view returns (uint256 priceUsd, uint256 updatedAt) {
        (bool ok, uint256 price, uint256 updated) =
            BandPriceReader.tryReadPriceWithMeta(bandStdRef, feeds[token], maxStaleness);
        return ok ? (price, updated) : (0, updated);
    }
}
