// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PriceOracle.sol";

/// @title LibFeeStorage
/// @notice ERC-7201 fee storage for Inbox DELEGATECALL into {FeeManager}.
/// @dev Namespace: `pod.inbox.fee.v1` → slot `keccak256(abi.encode(uint256(keccak256("pod.inbox.fee.v1")) - 1)) & ~bytes32(uint256(0xff))`.
library LibFeeStorage {
    /// @notice Template for minimum fees in **gas units** (not wei) plus hard admission caps.
    /// @dev If `constantFee` is non-zero it is the minimum gas units. Else: `(data * gasPerByte + callbackExecutionGas + errorLength * gasPerByte) * bufferRatioX10000 / 10000`.
    ///      `maxMethodCallBytes` / `maxExecutionGas` are **always** required (including constant-fee mode).
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

    /// @custom:storage-location erc7201:pod.inbox.fee.v1
    struct Layout {
        PriceOracle priceOracle;
        FeeConfig localMinFeeConfig;
        FeeConfig remoteMinFeeConfig;
        uint32 maxReplyMethodCallBytes;
        uint32 maxMessageLife;
        uint256 minPriorityFeeWei;
        uint256 minGasPriceWei;
        uint256 maxGasPriceWei;
    }

    /// @dev ERC-7201 slot for `pod.inbox.fee.v1` (must equal {erc7201Slot}).
    bytes32 internal constant STORAGE_SLOT =
        0xd050cb16de05f0d1bf135ea8150bd588c80bebfb96a13dbebca4dce96e619600;

    function get() internal pure returns (Layout storage $) {
        bytes32 slot = STORAGE_SLOT;
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    /// @notice ERC-7201 slot for `pod.inbox.fee.v1` (for tests / tooling).
    function erc7201Slot() internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(keccak256("pod.inbox.fee.v1")) - 1)) & ~bytes32(uint256(0xff));
    }
}
