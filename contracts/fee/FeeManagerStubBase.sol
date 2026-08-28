// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../modules/ModuleCallBase.sol";
import "./FeeManager.sol";
import "./LibFeeStorage.sol";
import "./PriceOracle.sol";

/// @title FeeManagerStubBase
/// @notice Explorer-visible fee API on Inbox — thin stubs / ERC-7201 getters.
/// @dev Admin writes and validate/budget route via {_delegateModule}({feeManager}, ...).
///      Getters read ERC-7201 `pod.inbox.fee.v1` locally (do not STATICCALL for Inbox fee state).
///      Ownership: subclasses override admin entrypoints with `onlyOwner` (see {InboxMiner}).
abstract contract FeeManagerStubBase is ModuleCallBase {
    /// @dev Alias for ABI / callers; same packing as {LibFeeStorage.FeeConfig}.
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

    /// @notice Method-call payload weight exceeds the configured max.
    error MethodCallTooLarge(uint256 size, uint256 maxSize);
    /// @notice Request fee gas budget exceeds the configured max.
    error FeeGasTooHigh(uint256 feeGas, uint256 maxGas);
    /// @notice Respond/raise payload weight exceeds {maxReplyMethodCallBytes}.
    error ResponseOutOfBounds(uint256 size, uint256 maxSize);

    // FeeManager DELEGATECALL reverts bubble with these selectors — declare on the Inbox surface so
    // apps that bind only the Inbox ABI can decode send-time / admin fee failures.
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
    /// @notice Reply max was set to zero.
    error MaxReplyMethodCallBytesInvalid(uint32 maxBytes);
    /// @notice {setPriceOracle} rejected the zero address (would brick fee-validated sends).
    error ZeroPriceOracle();

    // ─── Getters (ERC-7201 on Inbox) ─────────────────────────────────────────

    function priceOracle() public view returns (PriceOracle) {
        return LibFeeStorage.get().priceOracle;
    }

    function localMinFeeConfig()
        public
        view
        returns (
            uint32 constantFee,
            uint32 gasPerByte,
            uint32 callbackExecutionGas,
            uint32 errorLength,
            uint32 bufferRatioX10000,
            uint32 maxMethodCallBytes,
            uint32 maxExecutionGas,
            uint16 gasPriceMul,
            uint16 gasPriceDiv
        )
    {
        LibFeeStorage.FeeConfig memory c = LibFeeStorage.get().localMinFeeConfig;
        return (
            c.constantFee,
            c.gasPerByte,
            c.callbackExecutionGas,
            c.errorLength,
            c.bufferRatioX10000,
            c.maxMethodCallBytes,
            c.maxExecutionGas,
            c.gasPriceMul,
            c.gasPriceDiv
        );
    }

    function remoteMinFeeConfig()
        public
        view
        returns (
            uint32 constantFee,
            uint32 gasPerByte,
            uint32 callbackExecutionGas,
            uint32 errorLength,
            uint32 bufferRatioX10000,
            uint32 maxMethodCallBytes,
            uint32 maxExecutionGas,
            uint16 gasPriceMul,
            uint16 gasPriceDiv
        )
    {
        LibFeeStorage.FeeConfig memory c = LibFeeStorage.get().remoteMinFeeConfig;
        return (
            c.constantFee,
            c.gasPerByte,
            c.callbackExecutionGas,
            c.errorLength,
            c.bufferRatioX10000,
            c.maxMethodCallBytes,
            c.maxExecutionGas,
            c.gasPriceMul,
            c.gasPriceDiv
        );
    }

    function maxReplyMethodCallBytes() public view returns (uint32) {
        uint32 v = LibFeeStorage.get().maxReplyMethodCallBytes;
        return v == 0 ? 8192 : v;
    }

    function maxMessageLife() public view returns (uint32) {
        return LibFeeStorage.get().maxMessageLife;
    }

    function minPriorityFeeWei() public view returns (uint256) {
        return LibFeeStorage.get().minPriorityFeeWei;
    }

    function minGasPriceWei() public view returns (uint256) {
        uint256 v = LibFeeStorage.get().minGasPriceWei;
        return v == 0 ? DEFAULT_GAS_PRICE() : v;
    }

    function maxGasPriceWei() public view returns (uint256) {
        return LibFeeStorage.get().maxGasPriceWei;
    }

    function DEFAULT_GAS_PRICE() public pure returns (uint256) {
        return 2_000_000_000 wei;
    }

    /// @notice Rough local-token wei cost at `gasPrice` for a two-way send (PoD / UI / {PodERC20.estimateFee}).
    /// @dev Same math as {InboxFeeQuoter}; lean view on Inbox (views cannot DELEGATECALL {FeeManager}).
    function calculateTwoWayFeeRequiredInLocalToken(
        uint256 remoteMethodCallSize,
        uint256 callBackMethodCallSize,
        uint256 remoteMethodExecutionGas,
        uint256 callBackMethodExecutionGas,
        uint256 gasPrice
    ) public view returns (uint256 targetFeeLocalWei, uint256 callerFeeLocalWei) {
        LibFeeStorage.Layout storage $ = LibFeeStorage.get();
        PriceOracle oracle = $.priceOracle;
        if (address(oracle) == address(0)) revert FeeManager.OracleNotConfigured();
        (uint256 localTokenPrice, uint256 remoteTokenPrice) = oracle.getPricesUSD();
        if (localTokenPrice == 0 || remoteTokenPrice == 0) revert FeeManager.OraclePriceZero();

        FeeConfig memory localMin = _fromLib($.localMinFeeConfig);
        FeeConfig memory remoteMin = _fromLib($.remoteMinFeeConfig);

        // Unconfigured templates keep mul/div at 0 until updateMinFeeConfigs — do not divide.
        if (remoteMin.gasPriceMul == 0 || remoteMin.gasPriceDiv == 0) {
            revert FeeConfigInvalid(_toLib(remoteMin));
        }
        if (localMin.gasPriceMul == 0 || localMin.gasPriceDiv == 0) {
            revert FeeConfigInvalid(_toLib(localMin));
        }

        // ceil: gas * div / mul (skew invert) and remote→local price (matches InboxFeeQuoter Rounding.Ceil)
        uint256 targetGasRemoteUnits = _expectedMinFeeGasUnits(remoteMethodCallSize, remoteMin) + remoteMethodExecutionGas;
        uint256 mul = remoteMin.gasPriceMul;
        targetGasRemoteUnits = (targetGasRemoteUnits * uint256(remoteMin.gasPriceDiv) + mul - 1) / mul;
        uint256 callerGasLocalUnits = _expectedMinFeeGasUnits(callBackMethodCallSize, localMin) + callBackMethodExecutionGas;
        mul = localMin.gasPriceMul;
        callerGasLocalUnits = (callerGasLocalUnits * uint256(localMin.gasPriceDiv) + mul - 1) / mul;
        targetFeeLocalWei = ((targetGasRemoteUnits * remoteTokenPrice + localTokenPrice - 1) / localTokenPrice) * gasPrice;
        callerFeeLocalWei = callerGasLocalUnits * gasPrice;
    }

    // ─── Admin stubs (override with onlyOwner in InboxMiner) ─────────────────

    function setPriceOracle(address oracle) public virtual {
        _delegateModule(feeManager, abi.encodeCall(FeeManager.setPriceOracle, (oracle)));
    }

    function setGasPriceBounds(uint256 minPriorityFeeWei_, uint256 minGasPriceWei_, uint256 maxGasPriceWei_)
        public
        virtual
    {
        _delegateModule(
            feeManager, abi.encodeCall(FeeManager.setGasPriceBounds, (minPriorityFeeWei_, minGasPriceWei_, maxGasPriceWei_))
        );
    }

    function updateMinFeeConfigs(FeeConfig memory _local, FeeConfig memory _remote) public virtual {
        _delegateModule(
            feeManager,
            abi.encodeWithSelector(
                FeeManager.updateMinFeeConfigs.selector, _toLib(_local), _toLib(_remote)
            )
        );
    }

    function setMaxReplyMethodCallBytes(uint32 maxBytes) public virtual {
        _delegateModule(feeManager, abi.encodeCall(FeeManager.setMaxReplyMethodCallBytes, (maxBytes)));
    }

    function setMaxMessageLife(uint32 lifeSeconds) public virtual {
        _delegateModule(feeManager, abi.encodeCall(FeeManager.setMaxMessageLife, (lifeSeconds)));
    }

    function collectFees(address payable to) public virtual {
        _delegateModule(feeManager, abi.encodeCall(FeeManager.collectFees, (to))); // @audit collect's fees
    }

    // ─── Validate / budget (internal for send/mine) ──────────────────────────

    function _validateAndPrepareTwoWayFees(uint256 dataSize, uint256 totalFeeLocalWei, uint256 callbackFeeLocalWei)
        internal
        returns (uint256 targetGasRemoteUnits, uint256 callerGasLocalUnits)
    {
        bytes memory result = _delegateModule(
            feeManager,
            abi.encodeCall(FeeManager.validateAndPrepareTwoWayFees, (dataSize, totalFeeLocalWei, callbackFeeLocalWei))
        );
        return abi.decode(result, (uint256, uint256));
    }

    function _validateAndPrepareOneWayFees(uint256 dataSize, uint256 totalFeeLocalWei)
        internal
        returns (uint256 targetGasRemoteUnits)
    {
        bytes memory result = _delegateModule(
            feeManager, abi.encodeCall(FeeManager.validateAndPrepareOneWayFees, (dataSize, totalFeeLocalWei))
        );
        return abi.decode(result, (uint256));
    }

    function _localRequestExecutionBudget(uint256 totalFee) internal returns (uint256 budget) {
        bytes memory result =
            _delegateModule(feeManager, abi.encodeCall(FeeManager.localRequestExecutionBudget, (totalFee)));
        return abi.decode(result, (uint256));
    }

    function _ensureFeeDefaults() internal {
        _delegateModule(feeManager, abi.encodeCall(FeeManager.ensureDefaults, ()));
    }

    /// @dev Memory copy of local fee config for admission caps (avoids multi-SLOAD public getter).
    function _localMinFeeConfigMem() internal view returns (FeeConfig memory c) {
        return _fromLib(LibFeeStorage.get().localMinFeeConfig);
    }

    function _remoteMinFeeConfigMem() internal view returns (FeeConfig memory c) {
        return _fromLib(LibFeeStorage.get().remoteMinFeeConfig);
    }

    /// @dev Same packing as {InboxFeeQuoter._expectedMinFee} / {FeeManager.expectedMinFee}.
    function _expectedMinFeeGasUnits(uint256 dataSize, FeeConfig memory feeConfig) private pure returns (uint256) {
        if (feeConfig.constantFee > 0) {
            return uint256(feeConfig.constantFee);
        }
        uint256 gasUnits = (dataSize * uint256(feeConfig.gasPerByte)) + uint256(feeConfig.callbackExecutionGas)
            + (uint256(feeConfig.errorLength) * uint256(feeConfig.gasPerByte));
        return gasUnits * (10000 + uint256(feeConfig.bufferRatioX10000)) / 10000;
    }

    /// @dev Identical layout to {LibFeeStorage.FeeConfig} — pointer alias, no field copy (create-size).
    function _toLib(FeeConfig memory c) private pure returns (LibFeeStorage.FeeConfig memory r) {
        assembly ("memory-safe") {
            r := c
        }
    }

    function _fromLib(LibFeeStorage.FeeConfig memory c) private pure returns (FeeConfig memory r) {
        assembly ("memory-safe") {
            r := c
        }
    }
}
