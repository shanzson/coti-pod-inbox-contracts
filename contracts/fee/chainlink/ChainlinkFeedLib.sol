// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "./AggregatorV3Interface.sol";

/// @title ChainlinkFeedLib
/// @notice Read Chainlink Data Feeds and normalize answers to 18-decimal USD per whole token.
/// @dev Never reverts: stale, incomplete rounds, non-positive answers, and failed calls return `(false, 0)`.
library ChainlinkFeedLib {
    /// @dev Scale matching {PriceOracle.PRICE_SCALE}.
    uint256 internal constant PRICE_SCALE = 10 ** 18;

    /// @notice Read a feed when fresh.
    /// @param feed Chainlink aggregator (`address(0)` disables reads).
    /// @param maxStaleness Max seconds since `updatedAt` (`0` = no age check).
    function tryReadPrice(address feed, uint256 maxStaleness) internal view returns (bool ok, uint256 price) {
        if (feed == address(0) || feed.code.length == 0) {
            return (false, 0);
        }

        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80 roundId,
            int256 answer,
            uint256,
            uint256 updatedAt,
            uint80 answeredInRound
        ) {
            if (answer <= 0 || answeredInRound < roundId) {
                return (false, 0);
            }
            if (maxStaleness != 0 && updatedAt + maxStaleness < block.timestamp) {
                return (false, 0);
            }
            // `decimals()` is outside the `latestRoundData` try body so a reverting feed cannot
            // break the documented never-revert contract of this helper.
            try AggregatorV3Interface(feed).decimals() returns (uint8 decimals) {
                uint256 normalized = _normalizeTo18(uint256(answer), decimals);
                if (normalized == 0) {
                    return (false, 0);
                }
                return (true, normalized);
            } catch {
                return (false, 0);
            }
        } catch {
            return (false, 0);
        }
    }

    /// @notice Read a feed when fresh, including `updatedAt`.
    function tryReadPriceWithMeta(address feed, uint256 maxStaleness)
        internal
        view
        returns (bool ok, uint256 price, uint256 updatedAt)
    {
        if (feed == address(0) || feed.code.length == 0) {
            return (false, 0, 0);
        }

        try AggregatorV3Interface(feed).latestRoundData() returns (
            uint80 roundId,
            int256 answer,
            uint256,
            uint256 feedUpdatedAt,
            uint80 answeredInRound
        ) {
            updatedAt = feedUpdatedAt;
            if (answer <= 0 || answeredInRound < roundId) {
                return (false, 0, updatedAt);
            }
            if (maxStaleness != 0 && updatedAt + maxStaleness < block.timestamp) {
                return (false, 0, updatedAt);
            }
            try AggregatorV3Interface(feed).decimals() returns (uint8 decimals) {
                uint256 normalized = _normalizeTo18(uint256(answer), decimals);
                if (normalized == 0) {
                    return (false, 0, updatedAt);
                }
                return (true, normalized, updatedAt);
            } catch {
                return (false, 0, updatedAt);
            }
        } catch {
            return (false, 0, 0);
        }
    }

    /// @dev Convert feed answer to 18 decimals (USD per whole token). Never reverts: absurd decimals
    ///      or overflow-prone answers return `0` (caller already treats `price == 0` as failure via `ok`).
    function _normalizeTo18(uint256 answer, uint8 decimals) private pure returns (uint256) {
        if (decimals == 18) {
            return answer;
        }
        // Reject absurd decimal counts that would make `10 ** n` OOG / overflow in practice.
        if (decimals > 36) {
            return 0;
        }
        if (decimals < 18) {
            uint256 scale = 10 ** (18 - decimals);
            if (answer != 0 && answer > type(uint256).max / scale) {
                return 0;
            }
            return answer * scale;
        }
        return Math.mulDiv(answer, PRICE_SCALE, 10 ** decimals);
    }
}
