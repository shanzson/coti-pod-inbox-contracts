// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title PriceOracle
/// @notice Cached USD oracle for inbox fee conversion.
/// @dev Inbox reads cache only; {PoDPriceOracle} adds live adapter reads for the portal.
///      Fee path stays fail-open (non-zero prices); freshness is monitored via meta views / ops bot.
contract PriceOracle is Ownable {
    /// @notice Price is stored with 18 decimals of precision.
    uint256 public constant PRICE_SCALE = 10 ** 18;

    /// @notice Minimum seconds between successful cache refreshes. Zero disables the time gate.
    uint256 public fetchInterval;

    /// @notice Timestamp of the last successful {refreshCache} that ran past the interval gate.
    /// @dev Manual {setLocalTokenPriceUSD}/{setRemoteTokenPriceUSD} do **not** advance this, so a
    ///      manual write on one leg cannot suppress live refresh of the other.
    uint256 public lastFetchTimestamp;

    /// @notice Local execution-chain token whose USD price is cached for inbox fees.
    address public localToken;

    /// @notice Remote paired-chain token whose USD price is cached for inbox fees.
    address public remoteToken;

    /// @notice Cached USD price per inbox leg token (18 decimals per whole token).
    mapping(address => uint256) public cachedPriceUSD;

    /// @notice Timestamp of the last genuine cache write per token (refresh or manual set).
    mapping(address => uint256) public priceUpdatedAt;

    /// @notice Address allowed to set manual prices (in addition to {refreshCache}).
    address public priceAdmin;

    /// @notice USD price of zero is not a valid peg.
    error ZeroUsdPrice();

    /// @notice Token address was zero.
    error ZeroToken();

    /// @notice Local and remote inbox tokens must differ.
    error IdenticalInboxTokens(address token);

    /// @notice Token is not a configured inbox leg.
    error UnknownToken(address token);

    /// @notice Caller is not the configured price admin.
    error NotPriceAdmin();

    /// @notice Price admin cannot be the zero address.
    error ZeroPriceAdmin();

    /// @notice Inbox leg tokens were (re)configured.
    event InboxTokensUpdated(address indexed previousLocal, address indexed previousRemote, address indexed newLocal, address newRemote);

    /// @notice Fetch interval changed.
    event FetchIntervalUpdated(uint256 previous, uint256 current);

    /// @notice Price admin changed.
    event PriceAdminUpdated(address indexed previous, address indexed current);

    /// @notice Cached USD price written for an inbox leg.
    event CachedPriceUpdated(address indexed token, uint256 priceUsd, uint256 updatedAt);

    /// @notice Both inbox legs were refreshed past the interval gate.
    event CacheRefreshed(address indexed localToken, uint256 localPrice, address indexed remoteToken, uint256 remotePrice);

    /// @notice A refresh kept the prior cache because the live pull returned zero.
    event CacheRefreshLegFailed(address indexed token, uint256 retainedCachedPrice);

    /// @dev Reverts unless `msg.sender` is {priceAdmin}.
    modifier onlyPriceAdmin() {
        if (msg.sender != priceAdmin) {
            revert NotPriceAdmin();
        }
        _;
    }

    /// @param initialOwner {Ownable} owner; also initial {priceAdmin}.
    constructor(address initialOwner) Ownable(initialOwner) {
        priceAdmin = initialOwner;
    }

    /// @notice Configure inbox leg tokens (e.g. WETH local, COTI remote).
    /// @dev Clears cache + update timestamps for any replaced leg so the next refresh is not gated on stale state.
    function setInboxTokens(address localToken_, address remoteToken_) external onlyOwner {
        if (localToken_ == address(0) || remoteToken_ == address(0)) {
            revert ZeroToken();
        }
        if (localToken_ == remoteToken_) {
            revert IdenticalInboxTokens(localToken_);
        }
        address prevLocal = localToken;
        address prevRemote = remoteToken;
        if (prevLocal != address(0) && prevLocal != localToken_ && prevLocal != remoteToken_) {
            delete cachedPriceUSD[prevLocal];
            delete priceUpdatedAt[prevLocal];
        }
        if (prevRemote != address(0) && prevRemote != localToken_ && prevRemote != remoteToken_) {
            delete cachedPriceUSD[prevRemote];
            delete priceUpdatedAt[prevRemote];
        }
        localToken = localToken_;
        remoteToken = remoteToken_;
        emit InboxTokensUpdated(prevLocal, prevRemote, localToken_, remoteToken_);
    }

    /// @notice Cached USD price for an inbox leg token.
    function getCachedPrice(address token) public view virtual returns (uint256 priceUsd) {
        if (token == localToken || token == remoteToken) {
            return cachedPriceUSD[token];
        }
        revert UnknownToken(token);
    }

    /// @notice Live USD price for `token` (defaults to cache on the base oracle).
    function getLivePrice(address token) public view virtual returns (uint256 priceUsd) {
        return getCachedPrice(token);
    }

    /// @notice Refresh both inbox cache legs when the interval gate allows.
    function refreshCache() public {
        _refreshInboxCache();
    }

    function _refreshInboxCache() internal {
        if (!_fetchIntervalsElapsed()) {
            return;
        }
        lastFetchTimestamp = block.timestamp;
        uint256 localPrice;
        uint256 remotePrice;
        if (localToken != address(0)) {
            localPrice = _refreshLeg(localToken);
        }
        if (remoteToken != address(0)) {
            remotePrice = _refreshLeg(remoteToken);
        }
        emit CacheRefreshed(localToken, localPrice, remoteToken, remotePrice);
        _afterRefreshCache();
    }

    /// @dev Pull live (or subclass) price; write on success, emit failure when pull is zero and cache retained.
    function _refreshLeg(address token) private returns (uint256 stored) {
        uint256 previous = cachedPriceUSD[token];
        uint256 pulled = _pullCachedPrice(token);
        if (pulled != 0) {
            cachedPriceUSD[token] = pulled;
            priceUpdatedAt[token] = block.timestamp;
            emit CachedPriceUpdated(token, pulled, block.timestamp);
            return pulled;
        }
        emit CacheRefreshLegFailed(token, previous);
        return previous;
    }

    /// @notice Cached local and remote inbox leg prices.
    function getPricesUSD() external view returns (uint256 localPrice, uint256 remotePrice) {
        return (cachedPriceUSD[localToken], cachedPriceUSD[remoteToken]);
    }

    /// @notice Cached prices plus per-leg write times and last refresh gate timestamp.
    function getPricesUSDWithMeta()
        external
        view
        returns (
            uint256 localPrice,
            uint256 remotePrice,
            uint256 localUpdatedAt,
            uint256 remoteUpdatedAt,
            uint256 lastFetchTimestamp_
        )
    {
        return (
            cachedPriceUSD[localToken],
            cachedPriceUSD[remoteToken],
            priceUpdatedAt[localToken],
            priceUpdatedAt[remoteToken],
            lastFetchTimestamp
        );
    }

    /// @notice Whether the interval gate would allow {refreshCache} to run now.
    function fetchGateOpen() external view returns (bool) {
        return _fetchIntervalsElapsed();
    }

    /// @notice Cached local leg price.
    function getLocalTokenPriceUSD() external view returns (uint256 price) {
        return cachedPriceUSD[localToken];
    }

    /// @notice Cached remote leg price.
    function getRemoteTokenPriceUSD() external view returns (uint256 price) {
        return cachedPriceUSD[remoteToken];
    }

    /// @notice Whether {refreshCache} would update storage at this block.
    function previewRefreshCache() external view returns (bool canRefresh) {
        return _fetchIntervalsElapsed();
    }

    /// @notice Minimum seconds between cache refreshes.
    function setFetchInterval(uint256 secondsBetweenFetches) external onlyOwner {
        emit FetchIntervalUpdated(fetchInterval, secondsBetweenFetches);
        fetchInterval = secondsBetweenFetches;
    }

    /// @notice Set the address allowed to set manual inbox prices.
    function setPriceAdmin(address admin) external onlyOwner {
        if (admin == address(0)) {
            revert ZeroPriceAdmin();
        }
        emit PriceAdminUpdated(priceAdmin, admin);
        priceAdmin = admin;
    }

    /// @notice Manually set the cached local inbox price.
    function setLocalTokenPriceUSD(uint256 price) external onlyPriceAdmin {
        _setCachedPrice(localToken, price);
    }

    /// @notice Manually set the cached remote inbox price.
    function setRemoteTokenPriceUSD(uint256 price) external onlyPriceAdmin {
        _setCachedPrice(remoteToken, price);
    }

    /// @dev Hook after {refreshCache}; subclasses may refresh additional state.
    function _afterRefreshCache() internal virtual {}

    /// @dev Pull a fresh value for an inbox leg token.
    function _pullCachedPrice(address token) internal view virtual returns (uint256) {
        return cachedPriceUSD[token];
    }

    function _setCachedPrice(address token, uint256 price) internal {
        if (token == address(0)) {
            revert ZeroToken();
        }
        if (price == 0) {
            revert ZeroUsdPrice();
        }
        cachedPriceUSD[token] = price;
        priceUpdatedAt[token] = block.timestamp;
        // Do not touch {lastFetchTimestamp}: manual writes must not suppress live refresh of the other leg.
        emit CachedPriceUpdated(token, price, block.timestamp);
    }

    function _fetchIntervalsElapsed() internal view returns (bool) {
        if (fetchInterval != 0 && lastFetchTimestamp != 0 && block.timestamp - lastFetchTimestamp < fetchInterval) {
            return false;
        }
        return true;
    }
}
