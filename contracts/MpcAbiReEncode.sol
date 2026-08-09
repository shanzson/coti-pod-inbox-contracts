// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";
import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @title MpcAbiReEncode
/// @notice Storage-free COTI helper: validate it-* and rebuild gt-* calldata.
/// @dev Inbox must DELEGATECALL this contract so `address(this)` stays the Inbox for MPC.
///      dApps on source chains use {MpcAbiCodec} builders only — do not deploy this off COTI.
///      Lives in coti-pod-inbox-contracts; builder library stays in coti-contracts.
contract MpcAbiReEncode {
    /// @dev Must stay aligned with {MpcAbiCodec.MpcDataType}.
    enum MpcDataType {
        UINT256,
        ADDRESS,
        BYTES32,
        STRING,
        BYTES,
        UINT256_ARRAY,
        ADDRESS_ARRAY,
        BYTES32_ARRAY,
        STRING_ARRAY,
        BYTES_ARRAY,
        IT_BOOL,
        IT_UINT8,
        IT_UINT16,
        IT_UINT32,
        IT_UINT64,
        IT_UINT128,
        IT_UINT256,
        IT_STRING
    }

    /// @notice Max encrypted string cells (`itString.signature.length`) accepted per argument.
    /// @dev Each cell is one `validateCiphertext` precompile; unbounded cells amplify gas (encode OOG).
    uint256 public constant MAX_IT_STRING_CELLS = 128;

    event ValidateCiphertextStart(uint8 dataType, uint256 argLen, bytes32 argHash);
    event ValidateCiphertextSuccess(uint8 dataType);

    /// @notice Re-encode a method call, validating it-* types to gt-* and rebuilding calldata.
    function reEncodeWithGt(IInbox.MpcMethodCall memory data) external returns (bytes memory) {
        uint argCount = data.datatypes.length;
        require(data.datalens.length == argCount, "MpcAbiReEncode: invalid datalens");
        bytes memory encodedArgs = data.data;

        bytes[] memory processed = new bytes[](argCount);
        bool[] memory isDynamic = new bool[](argCount);
        uint[] memory staticWords = new uint[](argCount);
        uint totalTailSize = 0;

        uint cursor = 0;
        for (uint i = 0; i < argCount; i++) {
            uint argLen = uint(uint256(data.datalens[i]));
            require(cursor + argLen <= encodedArgs.length, "MpcAbiReEncode: arg out of bounds");

            bytes memory argData = _slice(encodedArgs, cursor, argLen);
            cursor += argLen;

            // Reject high-byte datatype malleability (only low byte is meaningful).
            uint64 rawType = uint64(data.datatypes[i]);
            require(rawType <= uint64(uint8(type(MpcDataType).max)), "MpcAbiReEncode: bad datatype");
            require(data.datatypes[i] == bytes8(rawType), "MpcAbiReEncode: datatype alias");
            MpcDataType dataType = MpcDataType(uint8(rawType));
            (bytes memory encodedArg, bool dynamicType, uint words) = _normalizeArg(argData, dataType);
            processed[i] = encodedArg;
            isDynamic[i] = dynamicType;
            staticWords[i] = words;
            if (dynamicType) {
                require(encodedArg.length >= 32, "MpcAbiReEncode: invalid dynamic arg");
                require(encodedArg.length % 32 == 0, "MpcAbiReEncode: unaligned dynamic arg");
                totalTailSize += (encodedArg.length - 32);
            } else {
                require(encodedArg.length == words * 32, "MpcAbiReEncode: invalid static arg");
            }
        }
        require(cursor == encodedArgs.length, "MpcAbiReEncode: trailing data");

        uint headSize = 0;
        for (uint i = 0; i < argCount; i++) {
            headSize += isDynamic[i] ? 32 : (staticWords[i] * 32);
        }
        bytes memory recoded = new bytes(4 + headSize + totalTailSize);
        bytes4 selector = data.selector;
        assembly {
            mstore(add(recoded, 32), selector)
        }

        uint tailCursor = 0;
        uint headCursor = 0;
        for (uint i = 0; i < argCount; i++) {
            if (isDynamic[i]) {
                uint offset = headSize + tailCursor;
                _writeWord(recoded, 4 + headCursor, offset);
                bytes memory tailData = processed[i];
                uint tailLen = tailData.length - 32;
                _copyBytes(recoded, 4 + headSize + tailCursor, tailData, 32, tailLen);
                tailCursor += tailLen;
                headCursor += 32;
            } else {
                bytes memory staticData = processed[i];
                _copyBytes(recoded, 4 + headCursor, staticData, 0, staticData.length);
                headCursor += staticData.length;
            }
        }

        return recoded;
    }

    function _writeWord(bytes memory data, uint offset, uint256 value) private pure {
        assembly {
            mstore(add(add(data, 32), offset), value)
        }
    }

    function _slice(bytes memory data, uint offset, uint length) private pure returns (bytes memory result) {
        result = new bytes(length);
        for (uint i = 0; i < length; i++) {
            result[i] = data[offset + i];
        }
    }

    /// @dev Cheap ABI shape checks for flat dynamic args. Nested string/bytes arrays only get alignment.
    function _requireWellFormedDynamic(bytes memory argData, MpcDataType dataType) private pure {
        uint256 len = argData.length;
        require(len >= 64 && len % 32 == 0, "MpcAbiReEncode: bad dynamic layout");
        uint256 offset;
        uint256 n;
        assembly {
            offset := mload(add(argData, 32))
            n := mload(add(argData, 64))
        }
        require(offset == 32, "MpcAbiReEncode: bad dynamic offset");
        if (dataType == MpcDataType.STRING || dataType == MpcDataType.BYTES) {
            uint256 padded = (n + 31) / 32 * 32;
            require(len == 64 + padded, "MpcAbiReEncode: bad bytes/string size");
        } else if (
            dataType == MpcDataType.UINT256_ARRAY || dataType == MpcDataType.ADDRESS_ARRAY
                || dataType == MpcDataType.BYTES32_ARRAY
        ) {
            require(len == 64 + n * 32, "MpcAbiReEncode: bad array size");
        }
        // STRING_ARRAY / BYTES_ARRAY: nested offsets — alignment + head offset only.
    }

    function _normalizeArg(bytes memory argData, MpcDataType dataType)
        private
        returns (bytes memory encodedArg, bool dynamicType, uint staticWordCount)
    {
        if (dataType == MpcDataType.UINT256) {
            return (argData, false, 1);
        }
        if (dataType == MpcDataType.ADDRESS) {
            return (argData, false, 1);
        }
        if (dataType == MpcDataType.BYTES32) {
            return (argData, false, 1);
        }
        if (dataType == MpcDataType.IT_UINT64) {
            itUint64 memory itValue = abi.decode(argData, (itUint64));
            emit ValidateCiphertextStart(uint8(dataType), argData.length, keccak256(argData));
            gtUint64 gtValue = MpcCore.validateCiphertext(itValue);
            emit ValidateCiphertextSuccess(uint8(dataType));
            return (abi.encode(gtUint64.unwrap(gtValue)), false, 1);
        }
        if (dataType == MpcDataType.IT_BOOL) {
            itBool memory itValue = abi.decode(argData, (itBool));
            emit ValidateCiphertextStart(uint8(dataType), argData.length, keccak256(argData));
            gtBool gtValue = MpcCore.validateCiphertext(itValue);
            emit ValidateCiphertextSuccess(uint8(dataType));
            return (abi.encode(gtBool.unwrap(gtValue)), false, 1);
        }
        if (dataType == MpcDataType.IT_UINT8) {
            itUint8 memory itValue = abi.decode(argData, (itUint8));
            emit ValidateCiphertextStart(uint8(dataType), argData.length, keccak256(argData));
            gtUint8 gtValue = MpcCore.validateCiphertext(itValue);
            emit ValidateCiphertextSuccess(uint8(dataType));
            return (abi.encode(gtUint8.unwrap(gtValue)), false, 1);
        }
        if (dataType == MpcDataType.IT_UINT16) {
            itUint16 memory itValue = abi.decode(argData, (itUint16));
            emit ValidateCiphertextStart(uint8(dataType), argData.length, keccak256(argData));
            gtUint16 gtValue = MpcCore.validateCiphertext(itValue);
            emit ValidateCiphertextSuccess(uint8(dataType));
            return (abi.encode(gtUint16.unwrap(gtValue)), false, 1);
        }
        if (dataType == MpcDataType.IT_UINT32) {
            itUint32 memory itValue = abi.decode(argData, (itUint32));
            emit ValidateCiphertextStart(uint8(dataType), argData.length, keccak256(argData));
            gtUint32 gtValue = MpcCore.validateCiphertext(itValue);
            emit ValidateCiphertextSuccess(uint8(dataType));
            return (abi.encode(gtUint32.unwrap(gtValue)), false, 1);
        }
        if (dataType == MpcDataType.IT_UINT128) {
            itUint128 memory itValue = abi.decode(argData, (itUint128));
            emit ValidateCiphertextStart(uint8(dataType), argData.length, keccak256(argData));
            gtUint128 gtValue = MpcCore.validateCiphertext(itValue);
            emit ValidateCiphertextSuccess(uint8(dataType));
            bytes memory encoded = abi.encode(gtValue);
            return (encoded, false, encoded.length / 32);
        }
        if (dataType == MpcDataType.IT_UINT256) {
            itUint256 memory itValue = abi.decode(argData, (itUint256));
            emit ValidateCiphertextStart(uint8(dataType), argData.length, keccak256(argData));
            gtUint256 gtValue = MpcCore.validateCiphertext(itValue);
            emit ValidateCiphertextSuccess(uint8(dataType));
            bytes memory encoded = abi.encode(gtValue);
            return (encoded, false, encoded.length / 32);
        }
        if (dataType == MpcDataType.IT_STRING) {
            itString memory itValue = abi.decode(argData, (itString));
            require(itValue.signature.length <= MAX_IT_STRING_CELLS, "MpcAbiReEncode: itString too long");
            require(
                itValue.ciphertext.value.length == itValue.signature.length, "MpcAbiReEncode: itString len mismatch"
            );
            emit ValidateCiphertextStart(uint8(dataType), argData.length, keccak256(argData));
            gtString memory gtValue = MpcCore.validateCiphertext(itValue);
            emit ValidateCiphertextSuccess(uint8(dataType));
            return (abi.encode(gtValue), true, 0);
        }
        if (
            dataType == MpcDataType.STRING || dataType == MpcDataType.BYTES || dataType == MpcDataType.UINT256_ARRAY
                || dataType == MpcDataType.ADDRESS_ARRAY || dataType == MpcDataType.BYTES32_ARRAY
                || dataType == MpcDataType.STRING_ARRAY || dataType == MpcDataType.BYTES_ARRAY
        ) {
            _requireWellFormedDynamic(argData, dataType);
            return (argData, true, 0);
        }

        revert("MpcAbiReEncode: unknown type");
    }

    /// @dev Word-safe copy; trailing partial words use `mstore8` (Shanghai — no `mcopy`).
    function _copyBytes(bytes memory dest, uint destOffset, bytes memory src, uint srcOffset, uint length)
        private
        pure
    {
        if (length == 0) {
            return;
        }
        require(destOffset + length <= dest.length, "MpcAbiReEncode: dest OOB");
        require(srcOffset + length <= src.length, "MpcAbiReEncode: src OOB");
        assembly {
            let destPtr := add(add(dest, 32), destOffset)
            let srcPtr := add(add(src, 32), srcOffset)

            let remaining := length
            for {} gt(remaining, 31) {} {
                mstore(destPtr, mload(srcPtr))
                destPtr := add(destPtr, 32)
                srcPtr := add(srcPtr, 32)
                remaining := sub(remaining, 32)
            }

            // Byte-by-byte for the tail — avoids low-byte mask corruption and past-end mstore.
            for { let i := 0 } lt(i, remaining) { i := add(i, 1) } {
                mstore8(add(destPtr, i), byte(0, mload(add(srcPtr, i))))
            }
        }
    }
}
