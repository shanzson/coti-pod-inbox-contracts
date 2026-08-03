// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

/// @title MpcAbiCodecTests
/// @notice Storage contract for MPC codec test callbacks.
contract MpcAbiCodecTests {
    uint256 public lastUint;
    address public lastAddr;
    bytes32 public lastBytes32;
    uint256 public lastGtUint64;
    uint256 public lastGtBool;
    bytes32 public lastDynamicHash;
    bytes32 public lastMixedHash;
    bytes32 public lastItHash;

    /// @notice Store static values for test verification.
    /// @param a The uint256 value.
    /// @param b The address value.
    /// @param c The bytes32 value.
    function setStatic(uint256 a, address b, bytes32 c) external {
        lastUint = a;
        lastAddr = b;
        lastBytes32 = c;
    }

    /// @notice Store dynamic values for test verification by hashing inputs.
    /// @param s The string value.
    /// @param data The bytes value.
    /// @param nums The uint256[] value.
    /// @param addrs The address[] value.
    /// @param b32s The bytes32[] value.
    function setDynamic(
        string calldata s,
        bytes calldata data,
        uint256[] calldata nums,
        address[] calldata addrs,
        bytes32[] calldata b32s
    ) external {
        lastDynamicHash = keccak256(abi.encode(s, data, nums, addrs, b32s));
    }

    /// @notice Store mixed values for test verification.
    /// @param a The uint256 value.
    /// @param b The gtUint64 value.
    /// @param s The string value.
    /// @param c The bytes32 value.
    /// @param data The bytes value.
    function setMixed(
        uint256 a,
        gtUint64 b,
        string calldata s,
        bytes32 c,
        bytes calldata data
    ) external {
        lastUint = a;
        lastGtUint64 = gtUint64.unwrap(b);
        lastBytes32 = c;
        lastMixedHash = keccak256(abi.encode(s, data));
    }

    /// @notice Store it-* values for test verification.
    /// @param b The gtBool value.
    /// @param u8 The gtUint8 value.
    /// @param u16 The gtUint16 value.
    /// @param u32 The gtUint32 value.
    /// @param u64 The gtUint64 value.
    /// @param u128 The gtUint128 value.
    /// @param u256 The gtUint256 value.
    /// @param gs The gtString value.
    function setItTypes(
        gtBool b,
        gtUint8 u8,
        gtUint16 u16,
        gtUint32 u32,
        gtUint64 u64,
        gtUint128 u128,
        gtUint256 u256,
        gtString calldata gs
    ) external {
        lastGtBool = gtBool.unwrap(b);
        lastGtUint64 = gtUint64.unwrap(u64);
        lastItHash = keccak256(abi.encode(u8, u16, u32, u128, u256, gs));
    }
}

