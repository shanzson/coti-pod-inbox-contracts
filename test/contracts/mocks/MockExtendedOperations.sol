// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title MockExtendedOperations
/// @notice Stand-in for COTI `validateCiphertext` during tests.
contract MockExtendedOperations {
    event ValidateCiphertextCalled(bytes1 metaData, uint256 ciphertext, bytes signature);
    event ValidateCiphertext256Called(
        bytes1 metaData, uint256 ciphertextHigh, uint256 ciphertextLow, bytes signature
    );

    /// @notice Echoes `ciphertext + 1` and emits `ValidateCiphertextCalled`.
    function ValidateCiphertext(bytes1 metaData, uint256 ciphertext, bytes calldata signature)
        external
        returns (uint256 result)
    {
        emit ValidateCiphertextCalled(metaData, ciphertext, signature);
        return ciphertext + 1;
    }

    /// @notice Echoes `(ciphertextHigh + 1) << 128 | (ciphertextLow + 1)` for 256-bit validation.
    function ValidateCiphertext(
        bytes1 metaData,
        uint256 ciphertextHigh,
        uint256 ciphertextLow,
        bytes calldata signature
    ) external returns (uint256 result) {
        emit ValidateCiphertext256Called(metaData, ciphertextHigh, ciphertextLow, signature);
        return ((ciphertextHigh + 1) << 128) | (ciphertextLow + 1);
    }
}
