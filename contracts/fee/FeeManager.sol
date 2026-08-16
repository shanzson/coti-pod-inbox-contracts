// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "./LibFeeStorage.sol";
import "./PriceOracle.sol";

/// @title FeeManager
/// @notice Fee validation and admin logic for Inbox via DELEGATECALL.
/// @dev Written for DELEGATECALL identity: storage is ERC-7201 on `address(this)` = Inbox.
///      Not the address apps configure; explorers interact with Inbox stubs.
contract FeeManager {
    /// @notice Fallback gas price (wei) when `tx.gasprice == 0` and no basefee path applies.
    uint256 public constant DEFAULT_GAS_PRICE = 2_000_000_000 wei;

    /// @notice Default respond/raise payload-weight cap until admin sets {setMaxReplyMethodCallBytes}.
    uint32 public constant DEFAULT_MAX_REPLY_METHOD_CALL_BYTES = 8192;

    /// @notice Default dest-ingest TTL (seconds) until admin sets {setMaxMessageLife} (48 hours).
    /// @dev `0` after explicit owner set still means uncapped retry; bootstrap only writes this while
    ///      `maxReplyMethodCallBytes` is still unset (fresh fee storage).
    uint32 public constant DEFAULT_MAX_MESSAGE_LIFE = 172_800;

    /// @notice Protocol ceiling for FeeConfig.maxMethodCallBytes (all chains).
    uint32 public constant PROTOCOL_MAX_METHOD_CALL_BYTES = 32_768;

    /// @notice Protocol ceiling for FeeConfig.maxExecutionGas (and shipped constantFee) on all chains.
    uint32 public constant PROTOCOL_MAX_EXECUTION_GAS = 25_000_000;

    /// @notice Total native fee was zero.
    error TotalFeeTooLow(uint256 totalFee);
    /// @notice Callback fee slice was zero, exceeded total, or bought too few local callback gas units.
    error CallbackFeeTooLow(uint256 callbackFee);
    /// @notice Remote execution fee slice bought too few remote gas units.
    error TargetFeeTooLow(uint256 targetFee);
    /// @notice A non-constant fee template omitted a required field.
    error FeeConfigInvalid(LibFeeStorage.FeeConfig feeConfig);
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
    /// @notice {setPriceOracle} rejected the zero address (would brick fee-validated sends).
    error ZeroPriceOracle();

    /// @notice Owner updated {maxReplyMethodCallBytes}.
    event MaxReplyMethodCallBytesUpdated(uint32 maxBytes);
    /// @notice Owner pointed the fee manager at a new price oracle.
    event PriceOracleUpdated(address indexed previous, address indexed current);

    /// @notice Apply storage defaults once under Inbox DELEGATECALL (safe to call repeatedly).
    function ensureDefaults() external {
        LibFeeStorage.Layout storage $ = LibFeeStorage.get();
        if ($.maxReplyMethodCallBytes == 0) {
            $.maxReplyMethodCallBytes = DEFAULT_MAX_REPLY_METHOD_CALL_BYTES;
            // Fresh fee storage: also apply 48h message life. Do not overwrite later owner
            // setMaxMessageLife(0) (uncapped) — that path runs when maxReply is already non-zero.
            if ($.maxMessageLife == 0) {
                $.maxMessageLife = DEFAULT_MAX_MESSAGE_LIFE;
            }
        }
        if ($.minGasPriceWei == 0) {
            $.minGasPriceWei = DEFAULT_GAS_PRICE;
        }
    }

    /// @notice Send the contract's entire native balance to `to`.
    function collectFees(address payable to) external {
        if (to == address(0)) revert CollectFeesZeroAddress();
        uint256 amount = address(this).balance;
        if (amount == 0) {
            return;
        }
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert FeeTransferFailed();
    }

    /// @notice Execution gas budget available to an incoming target call after reserving error-return bytes.
    /// @dev `payable` so DELEGATECALL from value-bearing mine paths is not rejected by callvalue checks.
    function localRequestExecutionBudget(uint256 totalFee) external payable returns (uint256 budget) {
        LibFeeStorage.FeeConfig memory localMin = LibFeeStorage.get().localMinFeeConfig;
        if (localMin.constantFee > 0) {
            return totalFee;
        }
        uint256 errorBuffer = uint256(localMin.errorLength) * uint256(localMin.gasPerByte);
        return totalFee > errorBuffer ? totalFee - errorBuffer : 0;
    }

    /// @notice Point the fee manager at a price oracle.
    function setPriceOracle(address priceOracleAddress) external {
        if (priceOracleAddress == address(0)) {
            revert ZeroPriceOracle();
        }
        LibFeeStorage.Layout storage $ = LibFeeStorage.get();
        address previous = address($.priceOracle);
        $.priceOracle = PriceOracle(priceOracleAddress);
        _validatedOraclePrices($);
        emit PriceOracleUpdated(previous, priceOracleAddress);
    }

    /// @notice Configure reference-gas-price parameters used by fee→gas conversion.
    function setGasPriceBounds(uint256 minPriorityFeeWei_, uint256 minGasPriceWei_, uint256 maxGasPriceWei_)
        external
    {
        if (minGasPriceWei_ == 0) {
            revert GasPriceBoundsInvalid(minGasPriceWei_, maxGasPriceWei_);
        }
        if (maxGasPriceWei_ != 0 && maxGasPriceWei_ < minGasPriceWei_) {
            revert GasPriceBoundsInvalid(minGasPriceWei_, maxGasPriceWei_);
        }
        LibFeeStorage.Layout storage $ = LibFeeStorage.get();
        $.minPriorityFeeWei = minPriorityFeeWei_;
        $.minGasPriceWei = minGasPriceWei_;
        $.maxGasPriceWei = maxGasPriceWei_;
    }

    /// @notice Replace minimum fee templates (both must be valid if non-constant).
    function updateMinFeeConfigs(
        LibFeeStorage.FeeConfig memory _localMinFeeConfig,
        LibFeeStorage.FeeConfig memory _remoteMinFeeConfig
    ) external {
        _requireValidFeeConfig(_localMinFeeConfig);
        _requireValidFeeConfig(_remoteMinFeeConfig);
        LibFeeStorage.Layout storage $ = LibFeeStorage.get();
        $.localMinFeeConfig = _localMinFeeConfig;
        $.remoteMinFeeConfig = _remoteMinFeeConfig;
    }

    /// @notice Set the respond/raise payload-weight cap.
    function setMaxReplyMethodCallBytes(uint32 maxBytes) external {
        if (maxBytes == 0) {
            revert MaxReplyMethodCallBytesInvalid(maxBytes);
        }
        LibFeeStorage.get().maxReplyMethodCallBytes = maxBytes;
        emit MaxReplyMethodCallBytesUpdated(maxBytes);
    }

    /// @notice Set max age (seconds) from dest ingest before execution-failed requests terminalize on retry.
    /// @dev `0` = uncapped. Fresh inboxes default to {DEFAULT_MAX_MESSAGE_LIFE} (48h) via {ensureDefaults}.
    function setMaxMessageLife(uint32 lifeSeconds) external {
        LibFeeStorage.get().maxMessageLife = lifeSeconds;
    }

    /// @notice Validate two-way payment and compute gas budgets for target and callback legs.
    /// @dev `payable` so DELEGATECALL from value-bearing send paths is not rejected by callvalue checks.
    function validateAndPrepareTwoWayFees(uint256 dataSize, uint256 totalFeeLocalWei, uint256 callbackFeeLocalWei)
        external
        payable
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

        LibFeeStorage.Layout storage $ = LibFeeStorage.get();
        (uint256 localPrice, uint256 remotePrice) = _validatedOraclePrices($);
        LibFeeStorage.FeeConfig memory localMin = $.localMinFeeConfig;
        LibFeeStorage.FeeConfig memory remoteMin = $.remoteMinFeeConfig;
        uint256 gasPrice = _referenceGasPrice($);
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
    /// @dev `payable` so DELEGATECALL from value-bearing send paths is not rejected by callvalue checks.
    function validateAndPrepareOneWayFees(uint256 dataSize, uint256 totalFeeLocalWei)
        external
        payable
        returns (uint256 targetGasRemoteUnits)
    {
        if (totalFeeLocalWei == 0) {
            revert TotalFeeTooLow(totalFeeLocalWei);
        }
        LibFeeStorage.Layout storage $ = LibFeeStorage.get();
        (uint256 localPrice, uint256 remotePrice) = _validatedOraclePrices($);
        LibFeeStorage.FeeConfig memory remoteMin = $.remoteMinFeeConfig;
        uint256 gasPrice = _referenceGasPrice($);
        targetGasRemoteUnits =
            _applyGasPriceSkew(Math.mulDiv(totalFeeLocalWei / gasPrice, localPrice, remotePrice), remoteMin);
        if (targetGasRemoteUnits < expectedMinFee(dataSize, remoteMin)) {
            revert TargetFeeTooLow(targetGasRemoteUnits);
        }
    }

    /// @notice Minimum gas units from template (no wei conversion).
    function expectedMinFee(uint256 dataSize, LibFeeStorage.FeeConfig memory feeConfig)
        public
        pure
        returns (uint256)
    {
        if (feeConfig.constantFee > 0) {
            return uint256(feeConfig.constantFee);
        }
        uint256 gasUnits = (dataSize * uint256(feeConfig.gasPerByte)) + uint256(feeConfig.callbackExecutionGas)
            + (uint256(feeConfig.errorLength) * uint256(feeConfig.gasPerByte));
        return gasUnits * (10000 + uint256(feeConfig.bufferRatioX10000)) / 10000;
    }

    function _referenceGasPrice(LibFeeStorage.Layout storage $) private view returns (uint256 gasPrice) {
        if (block.basefee > 0) {
            gasPrice = block.basefee + $.minPriorityFeeWei;
        } else {
            gasPrice = tx.gasprice != 0 ? tx.gasprice : DEFAULT_GAS_PRICE;
        }
        uint256 minGas = $.minGasPriceWei;
        if (minGas == 0) {
            minGas = DEFAULT_GAS_PRICE;
        }
        if (gasPrice < minGas) {
            gasPrice = minGas;
        }
        if ($.maxGasPriceWei != 0 && gasPrice > $.maxGasPriceWei) {
            gasPrice = $.maxGasPriceWei;
        }
    }

    function _validatedOraclePrices(LibFeeStorage.Layout storage $)
        private
        view
        returns (uint256 localPrice, uint256 remotePrice)
    {
        if (address($.priceOracle) == address(0)) {
            revert OracleNotConfigured();
        }
        (localPrice, remotePrice) = $.priceOracle.getPricesUSD();
        if (localPrice == 0 || remotePrice == 0) {
            revert OraclePriceZero();
        }
    }

    function _requireValidFeeConfig(LibFeeStorage.FeeConfig memory feeConfig) private pure {
        if (feeConfig.maxMethodCallBytes == 0 || feeConfig.maxExecutionGas == 0) {
            revert FeeConfigInvalid(feeConfig);
        }
        if (
            feeConfig.maxMethodCallBytes > PROTOCOL_MAX_METHOD_CALL_BYTES
                || feeConfig.maxExecutionGas > PROTOCOL_MAX_EXECUTION_GAS
        ) {
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

    function _applyGasPriceSkew(uint256 gasUnits, LibFeeStorage.FeeConfig memory feeConfig)
        private
        pure
        returns (uint256)
    {
        return Math.mulDiv(gasUnits, uint256(feeConfig.gasPriceMul), uint256(feeConfig.gasPriceDiv));
    }
}
