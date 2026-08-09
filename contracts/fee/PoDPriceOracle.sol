// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ILivePriceMetaReader.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/IPodPriceOracle.sol";
import "./PriceOracle.sol";

/// @title PoDPriceOracle
/// @notice Inbox cache + portal live reads via a registered {IPodPriceOracle} adapter.
contract PoDPriceOracle is PriceOracle, IPodPriceOracle {
    /// @notice Registered live-price adapter (Band or Chainlink implementation).
    IPodPriceOracle public configuredOracle;

    /// @notice Owner-set USD peg per token (18 decimals per whole token).
    mapping(address => uint256) public manualPrices;

    event ConfiguredOracleUpdated(address indexed previous, address indexed current);
    event ManualPriceUpdated(address indexed token, uint256 priceUsd);

    /// @param initialOwner {Ownable} owner and initial {priceAdmin}.
    /// @param _configuredOracle Live adapter (`address(0)` disables aggregator reads).
    /// @param _fetchIntervalSeconds Minimum seconds between {refreshCache} updates.
    constructor(address initialOwner, address _configuredOracle, uint256 _fetchIntervalSeconds)
        PriceOracle(initialOwner)
    {
        configuredOracle = IPodPriceOracle(_configuredOracle);
        fetchInterval = _fetchIntervalSeconds;
    }

    /// @notice Register or replace the live-price adapter.
    /// @dev `address(0)` disables live reads (manual / cache-only). Prefer a deliberate clear over accidental unset.
    function setConfiguredOracle(address oracle) external onlyOwner {
        emit ConfiguredOracleUpdated(address(configuredOracle), oracle);
        configuredOracle = IPodPriceOracle(oracle);
    }

    /// @inheritdoc PriceOracle
    function getCachedPrice(address token) public view override returns (uint256 priceUsd) {
        if (token == localToken || token == remoteToken) {
            uint256 cached = cachedPriceUSD[token];
            if (cached != 0) {
                return cached;
            }
        }
        uint256 manual = manualPrices[token];
        if (manual != 0) {
            return manual;
        }
        if (token == localToken || token == remoteToken) {
            return 0;
        }
        revert UnknownToken(token);
    }

    /// @inheritdoc PriceOracle
    /// @dev Also implements {IPodPriceOracle.getLivePrice}.
    function getLivePrice(address token) public view override(PriceOracle, IPodPriceOracle) returns (uint256 priceUsd) {
        return _livePrice(token);
    }

    /// @inheritdoc IPodPriceOracle
    function getLivePrices(address nativeToken, address collateralToken)
        external
        view
        returns (uint256 nativeUsd, uint256 collateralUsd)
    {
        uint256 manualNative = manualPrices[nativeToken];
        uint256 manualCollateral = manualPrices[collateralToken];

        if (manualNative != 0 && manualCollateral != 0) {
            return (manualNative, manualCollateral);
        }
        if (manualNative != 0) {
            return (manualNative, _livePrice(collateralToken));
        }
        if (manualCollateral != 0) {
            return (_livePrice(nativeToken), manualCollateral);
        }
        if (address(configuredOracle) == address(0)) {
            return (0, 0);
        }
        return configuredOracle.getLivePrices(nativeToken, collateralToken);
    }

    /// @notice Set manual USD peg for `token` (e.g. USDC $1). Use {clearTokenPriceUSD} to remove.
    function setTokenPriceUSD(address token, uint256 priceUsd) external onlyPriceAdmin {
        if (token == address(0)) {
            revert ZeroToken();
        }
        if (priceUsd == 0) {
            revert ZeroUsdPrice();
        }
        manualPrices[token] = priceUsd;
        emit ManualPriceUpdated(token, priceUsd);
    }

    /// @notice Clear the manual USD peg for `token` and any inbox-visible cached price for that token.
    /// @dev Must clear {cachedPriceUSD} as well as {manualPrices}; otherwise inbox fee reads can keep a
    ///      stale cache after the manual peg is removed.
    function clearTokenPriceUSD(address token) external onlyPriceAdmin {
        if (token == address(0)) {
            revert ZeroToken();
        }
        delete manualPrices[token];
        delete cachedPriceUSD[token];
        delete priceUpdatedAt[token];
        emit ManualPriceUpdated(token, 0);
    }

    /// @notice Ops / health-bot surface: cached vs live for both inbox legs (fail-open fee path unchanged).
    /// @dev `liveOk` is false when live returns zero; inbox sends still use non-zero cache only.
    function getOracleHealth()
        external
        view
        returns (
            uint256 localCached,
            uint256 remoteCached,
            uint256 localLive,
            uint256 remoteLive,
            bool localLiveOk,
            bool remoteLiveOk,
            uint256 localUpdatedAt,
            uint256 remoteUpdatedAt,
            uint256 lastFetchTimestamp_,
            bool fetchGateOpen_,
            bool localManual,
            bool remoteManual
        )
    {
        localCached = cachedPriceUSD[localToken];
        remoteCached = cachedPriceUSD[remoteToken];
        localLive = _livePrice(localToken);
        remoteLive = _livePrice(remoteToken);
        localLiveOk = localLive != 0;
        remoteLiveOk = remoteLive != 0;
        localUpdatedAt = priceUpdatedAt[localToken];
        remoteUpdatedAt = priceUpdatedAt[remoteToken];
        lastFetchTimestamp_ = lastFetchTimestamp;
        fetchGateOpen_ = _fetchIntervalsElapsed();
        localManual = manualPrices[localToken] != 0;
        remoteManual = manualPrices[remoteToken] != 0;
    }

    /// @inheritdoc PriceOracle
    /// @dev Return live/manual only — never the prior cache — so a zero pull is visible to refresh failure events.
    function _pullCachedPrice(address token) internal view override returns (uint256) {
        return _livePrice(token);
    }

    function _livePrice(address token) internal view returns (uint256 priceUsd) {
        uint256 manual = manualPrices[token];
        if (manual != 0) {
            return manual;
        }
        if (address(configuredOracle) == address(0)) {
            return 0;
        }
        return configuredOracle.getLivePrice(token);
    }
}
