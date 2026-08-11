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
    /// @dev Same math as {InboxFeeQuoter}; kept on Inbox so apps keep calling one address after the FeeManager split.
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

        LibFeeStorage.FeeConfig memory localMin = $.localMinFeeConfig;
        LibFeeStorage.FeeConfig memory remoteMin = $.remoteMinFeeConfig;

        uint256 targetGasRemoteUnits = _expectedMinFeeGasUnits(remoteMethodCallSize, remoteMin) + remoteMethodExecutionGas;
        uint256 callerGasLocalUnits = _expectedMinFeeGasUnits(callBackMethodCallSize, localMin) + callBackMethodExecutionGas;
        // ceil mulDiv for skew invert: gas * div / mul (matches InboxFeeQuoter Rounding.Ceil)
        targetGasRemoteUnits = (targetGasRemoteUnits * uint256(remoteMin.gasPriceDiv) + uint256(remoteMin.gasPriceMul) - 1)
            / uint256(remoteMin.gasPriceMul);
        callerGasLocalUnits = (callerGasLocalUnits * uint256(localMin.gasPriceDiv) + uint256(localMin.gasPriceMul) - 1)
            / uint256(localMin.gasPriceMul);
        uint256 targetGasLocalUnits =
            (targetGasRemoteUnits * remoteTokenPrice + localTokenPrice - 1) / localTokenPrice;
        targetFeeLocalWei = targetGasLocalUnits * gasPrice;
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
        _delegateModule(feeManager, abi.encodeCall(FeeManager.collectFees, (to)));
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
        LibFeeStorage.FeeConfig memory lib = LibFeeStorage.get().localMinFeeConfig;
        return _fromLib(lib);
    }

    function _remoteMinFeeConfigMem() internal view returns (FeeConfig memory c) {
        LibFeeStorage.FeeConfig memory lib = LibFeeStorage.get().remoteMinFeeConfig;
        return _fromLib(lib);
    }

    /// @dev Same packing as {InboxFeeQuoter._expectedMinFee}.
    function _expectedMinFeeGasUnits(uint256 dataSize, LibFeeStorage.FeeConfig memory feeConfig)
        private
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

    function _toLib(FeeConfig memory c) private pure returns (LibFeeStorage.FeeConfig memory) {
        return LibFeeStorage.FeeConfig({
            constantFee: c.constantFee,
            gasPerByte: c.gasPerByte,
            callbackExecutionGas: c.callbackExecutionGas,
            errorLength: c.errorLength,
            bufferRatioX10000: c.bufferRatioX10000,
            maxMethodCallBytes: c.maxMethodCallBytes,
            maxExecutionGas: c.maxExecutionGas,
            gasPriceMul: c.gasPriceMul,
            gasPriceDiv: c.gasPriceDiv
        });
    }

    function _fromLib(LibFeeStorage.FeeConfig memory c) private pure returns (FeeConfig memory) {
        return FeeConfig({
            constantFee: c.constantFee,
            gasPerByte: c.gasPerByte,
            callbackExecutionGas: c.callbackExecutionGas,
            errorLength: c.errorLength,
            bufferRatioX10000: c.bufferRatioX10000,
            maxMethodCallBytes: c.maxMethodCallBytes,
            maxExecutionGas: c.maxExecutionGas,
            gasPriceMul: c.gasPriceMul,
            gasPriceDiv: c.gasPriceDiv
        });
    }
}
