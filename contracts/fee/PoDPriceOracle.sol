// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ILivePriceMetaReader.sol";
import "./IPodPriceOracle.sol";
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

    /// @notice Clear the manual USD peg for `token` so live/adapter pricing resumes.
    function clearTokenPriceUSD(address token) external onlyPriceAdmin {
        if (token == address(0)) {
            revert ZeroToken();
        }
        delete manualPrices[token];
        emit ManualPriceUpdated(token, 0);
    }

    /// @inheritdoc PriceOracle
    function _pullCachedPrice(address token) internal view override returns (uint256) {
        uint256 price = _livePrice(token);
        if (price != 0) {
            return price;
        }
        return cachedPriceUSD[token];
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
