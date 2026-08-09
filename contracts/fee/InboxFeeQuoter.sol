// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title InboxFeeQuoter
/// @notice Off-chain / UI fee quotes without bloating Inbox create bytecode.
contract InboxFeeQuoter {
    /// @dev Mirrors {InboxFeeManager.FeeConfig} packing.
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

    /// @notice Rough local-token wei cost at `gasPrice` for a two-way send.
    function calculateTwoWayFeeRequiredInLocalToken(
        FeeConfig calldata localMin,
        FeeConfig calldata remoteMin,
        uint256 localTokenPrice,
        uint256 remoteTokenPrice,
        uint256 remoteMethodCallSize,
        uint256 callBackMethodCallSize,
        uint256 remoteMethodExecutionGas,
        uint256 callBackMethodExecutionGas,
        uint256 gasPrice
    ) external pure returns (uint256 targetFeeLocalWei, uint256 callerFeeLocalWei) {
        uint256 targetGasRemoteUnits = _expectedMinFee(remoteMethodCallSize, remoteMin) + remoteMethodExecutionGas;
        uint256 callerGasLocalUnits = _expectedMinFee(callBackMethodCallSize, localMin) + callBackMethodExecutionGas;
        targetGasRemoteUnits = Math.mulDiv(
            targetGasRemoteUnits, uint256(remoteMin.gasPriceDiv), uint256(remoteMin.gasPriceMul), Math.Rounding.Ceil
        );
        callerGasLocalUnits = Math.mulDiv(
            callerGasLocalUnits, uint256(localMin.gasPriceDiv), uint256(localMin.gasPriceMul), Math.Rounding.Ceil
        );
        uint256 targetGasLocalUnits =
            Math.mulDiv(targetGasRemoteUnits, remoteTokenPrice, localTokenPrice, Math.Rounding.Ceil);
        targetFeeLocalWei = targetGasLocalUnits * gasPrice;
        callerFeeLocalWei = callerGasLocalUnits * gasPrice;
    }

    function _expectedMinFee(uint256 dataSize, FeeConfig calldata feeConfig) private pure returns (uint256) {
        if (feeConfig.constantFee > 0) {
            return uint256(feeConfig.constantFee);
        }
        uint256 gasUnits = (dataSize * uint256(feeConfig.gasPerByte)) + uint256(feeConfig.callbackExecutionGas)
            + (uint256(feeConfig.errorLength) * uint256(feeConfig.gasPerByte));
        return gasUnits * (10000 + uint256(feeConfig.bufferRatioX10000)) / 10000;
    }
}
