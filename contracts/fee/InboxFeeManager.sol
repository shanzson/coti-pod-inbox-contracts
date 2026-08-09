// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "./PriceOracle.sol";

/// @title InboxFeeManager
/// @notice Validates cross-chain message fee budgets. Mixed into {InboxBase}.
/// @dev `msg.value` is converted to **gas units** using {_referenceGasPrice} (basefee + priority fee when
///      available, otherwise a clamped `tx.gasprice`). {Request.targetFee} and {Request.callerFee} store gas
///      budgets, not wei. Oracle price ratio maps remote gas budgets when configured; otherwise 1:1.
///
///      Over/under-charge envelope: budgets size against a *reference* gas price, not the destination chain's
///      future gas market. Callers who tip far above `minPriorityFee` do not buy extra gas units (basefee path).
///      On chains without basefee, `tx.gasprice` is clamped to `[minGasPriceWei, maxGasPriceWei]` so extreme
///      tips cannot inflate remote `call{gas}` caps unboundedly.
abstract contract InboxFeeManager {
    /// @notice Template for minimum fees in **gas units** (not wei) plus hard admission caps.
    /// @dev If `constantFee` is non-zero it is the minimum gas units. Else: `(data * gasPerByte + callbackExecutionGas + errorLength * gasPerByte) * bufferRatioX10000 / 10000`.
    ///      `maxMethodCallBytes` / `maxExecutionGas` are **always** required (including constant-fee mode).
    ///      Size caps use **payload weight** = `data.length + datatypes.length*32 + datalens.length*32`
    ///      (not `abi.encode(methodCall).length`).
    ///      Variable-fee `gasPerByte` should reflect measured ingest storage cost (deploy templates use ≥ 800).
    ///      Constant-fee ops: set `constantFee` ≥ priced max-execution work + max-size ingest (deploy assert /
    ///      checklist); keep `maxExecutionGas >= constantFee`. Flat fees stay valid once the worst case is capped.
    ///      Packed as seven `uint32`s + two `uint16`s (`gasPriceMul`/`gasPriceDiv`) → **one storage slot**.
    struct FeeConfig {
        uint32 constantFee;
        uint32 gasPerByte;
        uint32 callbackExecutionGas;
        uint32 errorLength;
        uint32 bufferRatioX10000;
        uint32 maxMethodCallBytes;
        uint32 maxExecutionGas;
        uint16 gasPriceMul;
        uint16 gasPriceDiv;
    }

    /// @notice Oracle used to convert gas budgets between local and remote fee tokens.
    PriceOracle public priceOracle;

    /// @notice Minimum template for the local (callback) leg.
    FeeConfig public localMinFeeConfig;

    /// @notice Minimum template for the remote execution leg.
    FeeConfig public remoteMinFeeConfig;

    /// @notice Max payload weight for {respond}/{raise} return legs (admin-settable).
    /// @dev Same payload-weight units as {FeeConfig.maxMethodCallBytes}; keep ≤ peer ingest max. Single `uint32` slot.
    uint32 public maxReplyMethodCallBytes = 8192;

    /// @notice Max age (seconds) from dest ingest {Request.timestamp} before execution-failed messages become terminal.
    /// @dev `0` disables the TTL (uncapped retry). Checked on {retryFailedRequest}.
    uint32 public maxMessageLife;

    /// @notice Fallback gas price (wei) when `tx.gasprice == 0` and no basefee path applies.
    uint256 public constant DEFAULT_GAS_PRICE = 2_000_000_000 wei;

    /// @notice Added to `block.basefee` when sizing fee budgets on EIP-1559 chains.
    uint256 public minPriorityFeeWei;

    /// @notice Floor for the reference gas price (wei). Defaults to {DEFAULT_GAS_PRICE}.
    uint256 public minGasPriceWei = DEFAULT_GAS_PRICE;

    /// @notice Ceiling for the reference gas price (wei). Zero disables the ceiling.
    uint256 public maxGasPriceWei;

    /// @notice Total native fee was zero.
    error TotalFeeTooLow(uint256 totalFee);
    /// @notice Callback fee slice was zero, exceeded total, or bought too few local callback gas units.
    error CallbackFeeTooLow(uint256 callbackFee);
    /// @notice Remote execution fee slice bought too few remote gas units.
    error TargetFeeTooLow(uint256 targetFee);
    /// @notice A non-constant fee template omitted a required field.
    error FeeConfigInvalid(FeeConfig feeConfig);
    error FeeTransferFailed();
    /// @notice Fee collection recipient was zero.
    error CollectFeesZeroAddress();
    /// @notice {priceOracle} is unset.
    error OracleNotConfigured();
    /// @notice Oracle returned a zero USD price.
    error OraclePriceZero();
    /// @notice Gas-price bound configuration is inconsistent.
    error GasPriceBoundsInvalid(uint256 minGasPrice, uint256 maxGasPrice);
    /// @notice Method-call payload weight exceeds the configured max.
    error MethodCallTooLarge(uint256 size, uint256 maxSize);
    /// @notice Request fee gas budget exceeds the configured max.
    error FeeGasTooHigh(uint256 feeGas, uint256 maxGas);
    /// @notice Respond/raise payload weight exceeds {maxReplyMethodCallBytes}.
    error ResponseOutOfBounds(uint256 size, uint256 maxSize);
    /// @notice Reply max was set to zero.
    error MaxReplyMethodCallBytesInvalid(uint32 maxBytes);

    /// @notice Owner updated {maxReplyMethodCallBytes}.
    event MaxReplyMethodCallBytesUpdated(uint32 maxBytes);

    /// @notice Send the contract's entire native balance to `to` (typically called by an owner-gated wrapper).
    /// @param to Recipient of accumulated message fees; must not be zero.
    function _collectFees(address payable to) internal {
        if (to == address(0)) revert CollectFeesZeroAddress();
        uint256 amount = address(this).balance;
        if (amount == 0) {
            return;
        }
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert FeeTransferFailed();
    }

    /// @notice Execution gas budget available to an incoming target call after reserving error-return bytes.
    /// @param totalFee Stored target fee in gas units.
    /// @return budget Gas units forwarded to the target subcall.
    function _localRequestExecutionBudget(uint256 totalFee) internal view returns (uint256 budget) {
        FeeConfig memory localMin = localMinFeeConfig;
        if (localMin.constantFee > 0) {
            return totalFee;
        }
        uint256 errorBuffer = uint256(localMin.errorLength) * uint256(localMin.gasPerByte);
        return totalFee > errorBuffer ? totalFee - errorBuffer : 0;
    }

    /// @notice Point the fee manager at a price oracle.
    /// @param priceOracleAddress Oracle contract address.
    function _setPriceOracle(address priceOracleAddress) internal {
        priceOracle = PriceOracle(priceOracleAddress);
        if (priceOracleAddress != address(0)) {
            _validatedOraclePrices();
        }
    }

    /// @notice Configure reference-gas-price parameters used by fee→gas conversion.
    /// @param minPriorityFeeWei_ Priority tip added to `block.basefee` (EIP-1559 path).
    /// @param minGasPriceWei_ Floor for the reference gas price.
    /// @param maxGasPriceWei_ Ceiling; zero means no ceiling.
    function _setGasPriceBounds(uint256 minPriorityFeeWei_, uint256 minGasPriceWei_, uint256 maxGasPriceWei_)
        internal
    {
        if (minGasPriceWei_ == 0) {
            revert GasPriceBoundsInvalid(minGasPriceWei_, maxGasPriceWei_);
        }
        if (maxGasPriceWei_ != 0 && maxGasPriceWei_ < minGasPriceWei_) {
            revert GasPriceBoundsInvalid(minGasPriceWei_, maxGasPriceWei_);
        }
        minPriorityFeeWei = minPriorityFeeWei_;
        minGasPriceWei = minGasPriceWei_;
        maxGasPriceWei = maxGasPriceWei_;
    }

    /// @dev Reference wei/gas for converting prepaid fees into gas-unit budgets.
    function _referenceGasPrice() internal view returns (uint256 gasPrice) {
        if (block.basefee > 0) {
            gasPrice = block.basefee + minPriorityFeeWei;
        } else {
            gasPrice = tx.gasprice != 0 ? tx.gasprice : DEFAULT_GAS_PRICE;
        }
        if (gasPrice < minGasPriceWei) {
            gasPrice = minGasPriceWei;
        }
        if (maxGasPriceWei != 0 && gasPrice > maxGasPriceWei) {
            gasPrice = maxGasPriceWei;
        }
    }

    /// @dev Require a configured oracle with non-zero local and remote USD prices.
    function _validatedOraclePrices() internal view returns (uint256 localPrice, uint256 remotePrice) {
        if (address(priceOracle) == address(0)) {
            revert OracleNotConfigured();
        }
        (localPrice, remotePrice) = priceOracle.getPricesUSD();
        if (localPrice == 0 || remotePrice == 0) {
            revert OraclePriceZero();
        }
    }

    /// @notice Replace minimum fee templates (both must be valid if non-constant).
    /// @dev `maxMethodCallBytes` and `maxExecutionGas` must be non-zero on every template,
    ///      including constant-fee mode.
    /// @param _localMinFeeConfig Local leg template.
    /// @param _remoteMinFeeConfig Remote leg template.
    function _updateMinFeeConfigs(FeeConfig memory _localMinFeeConfig, FeeConfig memory _remoteMinFeeConfig) internal {
        _requireValidFeeConfig(_localMinFeeConfig);
        _requireValidFeeConfig(_remoteMinFeeConfig);
        localMinFeeConfig = _localMinFeeConfig;
        remoteMinFeeConfig = _remoteMinFeeConfig;
    }

    /// @dev Constant-fee templates may zero variable fields; max size/gas are always required.
    ///      When `constantFee > 0`, `maxExecutionGas` must be ≥ `constantFee` or no request can admit.
    ///      `gasPriceMul` / `gasPriceDiv` must both be non-zero.
    function _requireValidFeeConfig(FeeConfig memory feeConfig) private pure {
        if (feeConfig.maxMethodCallBytes == 0 || feeConfig.maxExecutionGas == 0) {
            revert FeeConfigInvalid(feeConfig);
        }
        if (feeConfig.gasPriceMul == 0 || feeConfig.gasPriceDiv == 0) {
            revert FeeConfigInvalid(feeConfig);
        }
        if (feeConfig.constantFee > 0 && feeConfig.maxExecutionGas < feeConfig.constantFee) {
            revert FeeConfigInvalid(feeConfig);
        }
        if (
            feeConfig.constantFee == 0
                && (
                    feeConfig.gasPerByte == 0 || feeConfig.callbackExecutionGas == 0 || feeConfig.errorLength == 0
                        || feeConfig.bufferRatioX10000 == 0
                )
        ) {
            revert FeeConfigInvalid(feeConfig);
        }
    }

    /// @dev Apply gas-price skew: `units * mul / div` (configs already in memory — no extra SLOAD).
    function _applyGasPriceSkew(uint256 gasUnits, FeeConfig memory feeConfig) private pure returns (uint256) {
        return Math.mulDiv(gasUnits, uint256(feeConfig.gasPriceMul), uint256(feeConfig.gasPriceDiv));
    }

    /// @notice Set the respond/raise payload-weight cap.
    /// @param maxBytes Non-zero max; should stay ≤ peer {FeeConfig.maxMethodCallBytes}.
    function _setMaxReplyMethodCallBytes(uint32 maxBytes) internal {
        if (maxBytes == 0) {
            revert MaxReplyMethodCallBytesInvalid(maxBytes);
        }
        maxReplyMethodCallBytes = maxBytes;
        emit MaxReplyMethodCallBytesUpdated(maxBytes);
    }

    /// @notice Validate two-way payment and compute gas budgets for target and callback legs.
    /// @param dataSize Encoded method call size for template checks.
    /// @param totalFeeLocalWei Total `msg.value` (wei).
    /// @param callbackFeeLocalWei Wei reserved for the callback leg.
    /// @return targetGasRemoteUnits Gas units stored as {Request.targetFee} on the remote leg.
    /// @return callerGasLocalUnits Gas units stored as {Request.callerFee} for the callback.
    function validateAndPrepareTwoWayFees(uint256 dataSize, uint256 totalFeeLocalWei, uint256 callbackFeeLocalWei)
        internal
        view
        returns (uint256 targetGasRemoteUnits, uint256 callerGasLocalUnits)
    {
        if (totalFeeLocalWei == 0) {
            revert TotalFeeTooLow(totalFeeLocalWei);
        }
        if (callbackFeeLocalWei == 0) {
            revert CallbackFeeTooLow(callbackFeeLocalWei);
        }
        if (callbackFeeLocalWei > totalFeeLocalWei) {
            revert CallbackFeeTooLow(callbackFeeLocalWei);
        }

        (uint256 localPrice, uint256 remotePrice) = _validatedOraclePrices();
        FeeConfig memory localMin = localMinFeeConfig;
        FeeConfig memory remoteMin = remoteMinFeeConfig;
        uint256 gasPrice = _referenceGasPrice();
        callerGasLocalUnits = _applyGasPriceSkew(callbackFeeLocalWei / gasPrice, localMin);
        uint256 remoteGasWei = totalFeeLocalWei - callbackFeeLocalWei;
        targetGasRemoteUnits =
            _applyGasPriceSkew(Math.mulDiv(remoteGasWei / gasPrice, localPrice, remotePrice), remoteMin);

        if (callerGasLocalUnits < expectedMinFee(dataSize, localMin)) {
            revert CallbackFeeTooLow(callerGasLocalUnits);
        }

        if (targetGasRemoteUnits < expectedMinFee(dataSize, remoteMin)) {
            revert TargetFeeTooLow(targetGasRemoteUnits);
        }
    }

    /// @notice Validate one-way payment and compute remote gas budget.
    /// @param dataSize Encoded method call size for template checks.
    /// @param totalFeeLocalWei Total `msg.value` (wei).
    /// @return targetGasRemoteUnits Gas units for {Request.targetFee}; {Request.callerFee} is zero.
    function validateAndPrepareOneWayFees(uint256 dataSize, uint256 totalFeeLocalWei)
        internal
        view
        returns (uint256 targetGasRemoteUnits)
    {
        if (totalFeeLocalWei == 0) {
            revert TotalFeeTooLow(totalFeeLocalWei);
        }
        (uint256 localPrice, uint256 remotePrice) = _validatedOraclePrices();
        FeeConfig memory remoteMin = remoteMinFeeConfig;
        uint256 gasPrice = _referenceGasPrice();
        targetGasRemoteUnits =
            _applyGasPriceSkew(Math.mulDiv(totalFeeLocalWei / gasPrice, localPrice, remotePrice), remoteMin);
        if (targetGasRemoteUnits < expectedMinFee(dataSize, remoteMin)) {
            revert TargetFeeTooLow(targetGasRemoteUnits);
        }
    }

    /// @notice Minimum gas units from template (no wei conversion).
    /// @param dataSize Payload size for `gasPerByte` terms.
    /// @param feeConfig Template to apply.
    /// @return Gas units required before buffer.
    function expectedMinFee(uint256 dataSize, FeeConfig memory feeConfig) internal pure returns (uint256) {
        if (feeConfig.constantFee > 0) {
            return uint256(feeConfig.constantFee);
        }
        uint256 gasUnits = (dataSize * uint256(feeConfig.gasPerByte)) + uint256(feeConfig.callbackExecutionGas)
            + (uint256(feeConfig.errorLength) * uint256(feeConfig.gasPerByte));
        return gasUnits * (10000 + uint256(feeConfig.bufferRatioX10000)) / 10000;
    }
}
