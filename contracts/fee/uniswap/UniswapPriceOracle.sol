// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "../PriceOracle.sol";

/// @notice Minimal Uniswap V2 pair surface for reserve-based spot pricing.
interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

/// @title UniswapPriceOracle
/// @notice {PriceOracle} implementation that reads **Uniswap V2** pair reserves for local and remote token vs quote pricing.
/// @dev Cached reads for fee math; Uniswap is touched only inside {PriceOracle.refreshCache} after interval checks. Spot reserves are manipulable—prefer TWAP or trusted feeds in production.
contract UniswapPriceOracle is PriceOracle {
    /// @notice The selected base-token side of a V2 pair has zero reserves, so no price can be computed.
    error UniswapPriceOracleZeroReserves();

    IUniswapV2Pair public immutable localPair;
    IUniswapV2Pair public immutable remotePair;

    /// @dev If true, the local base token is `token0` in {localPair}.
    bool public immutable localTokenIsToken0;

    /// @dev If true, the remote base token is `token0` in {remotePair}.
    bool public immutable remoteTokenIsToken0;

    /// @param initialOwner Passed to {PriceOracle}.
    /// @param _localPair V2 pair for local execution token vs USD-stable quote on this chain.
    /// @param _remotePair V2 pair for remote execution token vs the same quote on this chain.
    /// @param _localTokenIsToken0 Whether the local base is `token0` in `_localPair`.
    /// @param _remoteTokenIsToken0 Whether the remote base is `token0` in `_remotePair`.
    /// @param _fetchIntervalSeconds Minimum seconds between pulls (0 = no time gate).
    constructor(
        address initialOwner,
        IUniswapV2Pair _localPair,
        IUniswapV2Pair _remotePair,
        bool _localTokenIsToken0,
        bool _remoteTokenIsToken0,
        uint256 _fetchIntervalSeconds
    ) PriceOracle(initialOwner) {
        localPair = _localPair;
        remotePair = _remotePair;
        localTokenIsToken0 = _localTokenIsToken0;
        remoteTokenIsToken0 = _remoteTokenIsToken0;
        fetchInterval = _fetchIntervalSeconds;
        // Wire inbox legs from the pairs so {refreshCache} can populate prices without a separate
        // {setInboxTokens} call (owner may still re-point legs later via {setInboxTokens}).
        address local_ = _localTokenIsToken0 ? _localPair.token0() : _localPair.token1();
        address remote_ = _remoteTokenIsToken0 ? _remotePair.token0() : _remotePair.token1();
        if (local_ == address(0) || remote_ == address(0)) {
            revert ZeroToken();
        }
        localToken = local_;
        remoteToken = remote_;
    }

    /// @dev Overrides parent to read spot price from V2 pairs for inbox leg tokens.
    function _pullCachedPrice(address token) internal view override returns (uint256) {
        if (token == localToken) {
            return _spotPrice(localPair, localTokenIsToken0);
        }
        if (token == remoteToken) {
            return _spotPrice(remotePair, remoteTokenIsToken0);
        }
        return super._pullCachedPrice(token);
    }

    /// @dev V2 marginal price: `quote_per_base = R_quote / R_base` (smallest units). Returns `quote_per_base * PRICE_SCALE`.
    function _spotPrice(IUniswapV2Pair pair, bool baseIsToken0) private view returns (uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 base;
        uint256 quote;
        if (baseIsToken0) {
            base = uint256(r0);
            quote = uint256(r1);
        } else {
            base = uint256(r1);
            quote = uint256(r0);
        }
        if (base == 0) {
            revert UniswapPriceOracleZeroReserves();
        }
        return Math.mulDiv(quote, PRICE_SCALE, base);
    }
}
