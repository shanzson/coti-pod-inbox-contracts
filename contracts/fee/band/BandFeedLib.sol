// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/oracle/IStdReference.sol";

/// @title BandFeedLib
/// @notice Read Band StdReference feeds; `rate` is base/quote × 1e18 (USD per whole base token when quote is USD).
/// @dev Never reverts: failures return `(false, 0)`. Staleness uses the older of base/quote update timestamps.
library BandFeedLib {
    /// @notice Read one Band pair when fresh.
    /// @param bandRef StdReference proxy (`address(0)` disables reads).
    /// @param bandBase Null-terminated symbol (e.g. `"ETH"`).
    /// @param bandQuote Null-terminated quote symbol (e.g. `"USD"`).
    /// @param maxStaleness Max seconds since last update (`0` = no age check).
    function tryReadPrice(
        address bandRef,
        bytes32 bandBase,
        bytes32 bandQuote,
        uint256 maxStaleness
    ) internal view returns (bool ok, uint256 price) {
        if (bandRef == address(0) || bandBase == bytes32(0) || bandQuote == bytes32(0)) {
            return (false, 0);
        }

        try IStdReference(bandRef).getReferenceData(_toString(bandBase), _toString(bandQuote)) returns (
            IStdReference.ReferenceData memory data
        ) {
            if (data.rate == 0) {
                return (false, 0);
            }
            uint256 updatedAt = data.lastUpdatedBase < data.lastUpdatedQuote
                ? data.lastUpdatedBase
                : data.lastUpdatedQuote;
            // Non-overflowing age check; also reject future-dated feeds.
            if (maxStaleness != 0) {
                if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxStaleness) {
                    return (false, 0);
                }
            }
            return (true, data.rate);
        } catch {
            return (false, 0);
        }
    }

    /// @notice Read one Band pair with update timestamp.
    /// @return ok True when `price` is valid.
    /// @return price 18-decimal USD per whole base token.
    /// @return updatedAt Feed update timestamp (seconds).
    function tryReadPriceWithMeta(
        address bandRef,
        bytes32 bandBase,
        bytes32 bandQuote,
        uint256 maxStaleness
    ) internal view returns (bool ok, uint256 price, uint256 updatedAt) {
        if (bandRef == address(0) || bandBase == bytes32(0) || bandQuote == bytes32(0)) {
            return (false, 0, 0);
        }

        try IStdReference(bandRef).getReferenceData(_toString(bandBase), _toString(bandQuote)) returns (
            IStdReference.ReferenceData memory data
        ) {
            if (data.rate == 0) {
                return (false, 0, 0);
            }
            updatedAt = data.lastUpdatedBase < data.lastUpdatedQuote
                ? data.lastUpdatedBase
                : data.lastUpdatedQuote;
            // Non-overflowing age check; also reject future-dated feeds.
            if (maxStaleness != 0) {
                if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxStaleness) {
                    return (false, 0, updatedAt);
                }
            }
            return (true, data.rate, updatedAt);
        } catch {
            return (false, 0, 0);
        }
    }

    /// @notice Bulk read two base symbols against one quote (portal gas optimization).
    /// @return okA True when `priceA` passed staleness and non-zero checks.
    /// @return priceA First leg USD rate (18 decimals).
    /// @return okB True when `priceB` passed staleness and non-zero checks.
    /// @return priceB Second leg USD rate (18 decimals).
    function tryReadPriceBulk(
        address bandRef,
        bytes32 baseA,
        bytes32 baseB,
        bytes32 bandQuote,
        uint256 maxStaleness
    ) internal view returns (bool okA, uint256 priceA, bool okB, uint256 priceB) {
        if (bandRef == address(0) || bandQuote == bytes32(0)) {
            return (false, 0, false, 0);
        }

        string[] memory bases = new string[](2);
        bases[0] = _toString(baseA);
        bases[1] = _toString(baseB);
        string[] memory quotes = new string[](2);
        quotes[0] = _toString(bandQuote);
        quotes[1] = _toString(bandQuote);

        try IStdReference(bandRef).getReferenceDataBulk(bases, quotes) returns (
            IStdReference.ReferenceData[] memory data
        ) {
            if (data.length < 2) {
                return (false, 0, false, 0);
            }
            (okA, priceA) = _validateBandData(data[0], maxStaleness);
            (okB, priceB) = _validateBandData(data[1], maxStaleness);
        } catch {
            return (false, 0, false, 0);
        }
    }

    function _validateBandData(IStdReference.ReferenceData memory data, uint256 maxStaleness)
        private
        view
        returns (bool ok, uint256 price)
    {
        if (data.rate == 0) {
            return (false, 0);
        }
        uint256 updatedAt = data.lastUpdatedBase < data.lastUpdatedQuote
            ? data.lastUpdatedBase
            : data.lastUpdatedQuote;
        // Non-overflowing age check; also reject future-dated feeds.
        if (maxStaleness != 0) {
            if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxStaleness) {
                return (false, 0);
            }
        }
        return (true, data.rate);
    }

    /// @dev Null-terminated bytes32 symbol (e.g. "ETH", "USD") to string.
    function _toString(bytes32 data) private pure returns (string memory) {
        uint256 len;
        while (len < 32 && data[len] != 0) {
            ++len;
        }
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            out[i] = data[i];
        }
        return string(out);
    }
}
