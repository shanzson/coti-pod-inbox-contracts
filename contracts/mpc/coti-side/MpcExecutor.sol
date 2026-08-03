// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

import "@coti-io/coti-contracts/contracts/pod/InboxUser.sol";
import "@coti-io/coti-contracts/contracts/pod/mpc/coti-side/IPodExecutorOps.sol";

/// @title MpcExecutor
/// @notice COTI-side MPC executor: routes `onlyInbox` calls to `MpcCore` for 64/128/256-bit operations.
contract MpcExecutor is InboxUser, IPodExecutor64, IPodExecutor128, IPodExecutor256 {
    event GtResult(ctBool result, address cOwner);
    event AddResult(ctUint64 result, address cOwner);
    event Add128Result(ctUint128 result, address cOwner);
    event Add256Result(ctUint256 result, address cOwner);

    constructor(address _inbox) {
        setInbox(_inbox);
    }

    // --- IPodExecutor64 ---

    function add64(gtUint64 gtA, gtUint64 gtB, address cOwner) external onlyInbox {
        gtUint64 gtC = MpcCore.checkedAdd(gtA, gtB);
        _emitRespondU64(gtC, cOwner, true);
    }

    function sub64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.checkedSub(a, b), cOwner, false);
    }

    function mul64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.checkedMul(a, b), cOwner, false);
    }

    /// @notice Wrapping multiply modulo 2^64. Callers must require modulo arithmetic as part of their invariant.
    function mulWrapping64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.mul(a, b), cOwner, false);
    }

    /// @dev COTI MPC requires `setPublic*` and `checkedMul` in the same contract; do not pass `gt*` from another contract.
    function mul64FromPlain(uint64 a, uint64 b, address cOwner) external onlyInbox {
        gtUint64 ga = MpcCore.setPublic64(a);
        gtUint64 gb = MpcCore.setPublic64(b);
        _emitRespondU64(MpcCore.checkedMul(ga, gb), cOwner, false);
    }

    /// @notice Plain-input wrapping multiply modulo 2^64. Use only for explicit modulo arithmetic.
    function mulWrapping64FromPlain(uint64 a, uint64 b, address cOwner) external onlyInbox {
        gtUint64 ga = MpcCore.setPublic64(a);
        gtUint64 gb = MpcCore.setPublic64(b);
        _emitRespondU64(MpcCore.mul(ga, gb), cOwner, false);
    }

    function div64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.div(a, b), cOwner, false);
    }

    function rem64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.rem(a, b), cOwner, false);
    }

    function and64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.and(a, b), cOwner, false);
    }

    function or64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.or(a, b), cOwner, false);
    }

    function xor64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.xor(a, b), cOwner, false);
    }

    function min64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.min(a, b), cOwner, false);
    }

    function max64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.max(a, b), cOwner, false);
    }

    function eq64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.eq(a, b), cOwner);
    }

    function ne64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.ne(a, b), cOwner);
    }

    function ge64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.ge(a, b), cOwner);
    }

    function gt64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.gt(a, b), cOwner);
    }

    function le64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.le(a, b), cOwner);
    }

    function lt64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.lt(a, b), cOwner);
    }

    /// @dev Plaintext `itBool` from user `encryptValue(0|1)` matches SBOOL validation but mux bit sense
    ///      is inverted vs SDK plaintext; swap branches so `1` selects `a` and `0` selects `b`.
    function mux64(gtBool bit, gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.mux(bit, b, a), cOwner, false);
    }

    function shl64(gtUint64 a, uint8 s, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.shl(a, s), cOwner, false);
    }

    function shr64(gtUint64 a, uint8 s, address cOwner) external onlyInbox {
        _emitRespondU64(MpcCore.shr(a, s), cOwner, false);
    }

    /// @dev Returns `abi.encode(uint256)` plaintext (not user ciphertext).
    function rand64(address) external onlyInbox {
        uint64 v = MpcCore.decrypt(MpcCore.rand64());
        _respondPlainUint256(uint256(v));
    }

    /// @dev Returns `abi.encode(uint256)` plaintext (not user ciphertext).
    function randBoundedBits64(uint8 numBits, address) external onlyInbox {
        uint64 v = MpcCore.decrypt(MpcCore.randBoundedBits64(numBits));
        _respondPlainUint256(uint256(v));
    }

    // --- IPodExecutor128 ---

    function add128(gtUint128 gtA, gtUint128 gtB, address cOwner) external onlyInbox {
        gtUint128 gtC = MpcCore.checkedAdd(gtA, gtB);
        _emitRespondU128(gtC, cOwner, true);
    }

    function sub128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.checkedSub(a, b), cOwner, false);
    }

    /// @notice Checked multiplication. Reverts when the true product does not fit in uint128.
    function mul128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.checkedMul(a, b), cOwner, false);
    }

    /// @notice Wrapping multiply modulo 2^128. Callers must require modulo arithmetic as part of their invariant.
    function mulWrapping128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.mul(a, b), cOwner, false);
    }

    /// @dev COTI MPC requires `setPublic*` and `checkedMul` in the same contract; do not pass `gt*` from another contract.
    function mul128FromPlain(uint128 a, uint128 b, address cOwner) external onlyInbox {
        gtUint128 ga = MpcCore.setPublic128(a);
        gtUint128 gb = MpcCore.setPublic128(b);
        _emitRespondU128(MpcCore.checkedMul(ga, gb), cOwner, false);
    }

    /// @notice Plain-input wrapping multiply modulo 2^128. Use only for explicit modulo arithmetic.
    function mulWrapping128FromPlain(uint128 a, uint128 b, address cOwner) external onlyInbox {
        gtUint128 ga = MpcCore.setPublic128(a);
        gtUint128 gb = MpcCore.setPublic128(b);
        _emitRespondU128(MpcCore.mul(ga, gb), cOwner, false);
    }

    function and128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.and(a, b), cOwner, false);
    }

    function or128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.or(a, b), cOwner, false);
    }

    function xor128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.xor(a, b), cOwner, false);
    }

    function min128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.min(a, b), cOwner, false);
    }

    function max128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.max(a, b), cOwner, false);
    }

    function eq128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.eq(a, b), cOwner);
    }

    function ne128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.ne(a, b), cOwner);
    }

    function ge128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.ge(a, b), cOwner);
    }

    function gt128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.gt(a, b), cOwner);
    }

    function le128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.le(a, b), cOwner);
    }

    function lt128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.lt(a, b), cOwner);
    }

    /// @dev See `mux64` — same `b,a` swap for client `itBool` ciphertexts.
    function mux128(gtBool bit, gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.mux(bit, b, a), cOwner, false);
    }

    function shl128(gtUint128 a, uint8 s, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.shl(a, s), cOwner, false);
    }

    function shr128(gtUint128 a, uint8 s, address cOwner) external onlyInbox {
        _emitRespondU128(MpcCore.shr(a, s), cOwner, false);
    }

    /// @dev Returns `abi.encode(uint256)` plaintext (not user ciphertext).
    function rand128(address) external onlyInbox {
        uint128 v = MpcCore.decrypt(MpcCore.rand128());
        _respondPlainUint256(uint256(v));
    }

    /// @dev Returns `abi.encode(uint256)` plaintext (not user ciphertext).
    function randBoundedBits128(uint8 numBits, address) external onlyInbox {
        uint128 v = MpcCore.decrypt(MpcCore.randBoundedBits128(numBits));
        _respondPlainUint256(uint256(v));
    }

    // --- IPodExecutor256 ---

    function add256(gtUint256 gtA, gtUint256 gtB, address cOwner) external onlyInbox {
        gtUint256 gtC = MpcCore.checkedAdd(gtA, gtB);
        _emitRespondU256(gtC, cOwner, true);
    }

    function sub256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.checkedSub(a, b), cOwner, false);
    }

    /// @notice Checked multiplication. Reverts when the true product does not fit in uint256.
    function mul256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.checkedMul(a, b), cOwner, false);
    }

    /// @notice Wrapping multiply modulo 2^256. Callers must require modulo arithmetic as part of their invariant.
    function mulWrapping256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.mul(a, b), cOwner, false);
    }

    /// @dev COTI MPC requires `setPublic*` and `checkedMul` in the same contract; do not pass `gt*` from another contract.
    function mul256FromPlain(uint256 a, uint256 b, address cOwner) external onlyInbox {
        gtUint256 ga = MpcCore.setPublic256(a);
        gtUint256 gb = MpcCore.setPublic256(b);
        _emitRespondU256(MpcCore.checkedMul(ga, gb), cOwner, false);
    }

    /// @notice Plain-input wrapping multiply modulo 2^256. Use only for explicit modulo arithmetic.
    function mulWrapping256FromPlain(uint256 a, uint256 b, address cOwner) external onlyInbox {
        gtUint256 ga = MpcCore.setPublic256(a);
        gtUint256 gb = MpcCore.setPublic256(b);
        _emitRespondU256(MpcCore.mul(ga, gb), cOwner, false);
    }

    function and256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.and(a, b), cOwner, false);
    }

    function or256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.or(a, b), cOwner, false);
    }

    function xor256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.xor(a, b), cOwner, false);
    }

    function min256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.min(a, b), cOwner, false);
    }

    function max256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.max(a, b), cOwner, false);
    }

    function eq256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.eq(a, b), cOwner);
    }

    function ne256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.ne(a, b), cOwner);
    }

    function ge256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.ge(a, b), cOwner);
    }

    function gt256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.gt(a, b), cOwner);
    }

    function le256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.le(a, b), cOwner);
    }

    function lt256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.lt(a, b), cOwner);
    }

    /// @dev See `mux64` — same `b,a` swap for client `itBool` ciphertexts.
    function mux256(gtBool bit, gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.mux(bit, b, a), cOwner, false);
    }

    function shl256(gtUint256 a, uint8 s, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.shl(a, s), cOwner, false);
    }

    function shr256(gtUint256 a, uint8 s, address cOwner) external onlyInbox {
        _emitRespondU256(MpcCore.shr(a, s), cOwner, false);
    }

    /// @dev Returns `abi.encode(uint256)` plaintext (not user ciphertext).
    function rand256(address) external onlyInbox {
        uint256 v = MpcCore.decrypt(MpcCore.rand256());
        _respondPlainUint256(v);
    }

    /// @dev Returns `abi.encode(uint256)` plaintext (not user ciphertext).
    function randBoundedBits256(uint8 numBits, address) external onlyInbox {
        uint256 v = MpcCore.decrypt(MpcCore.randBoundedBits256(numBits));
        _respondPlainUint256(v);
    }

    // --- internal ---
    function _respondPlainUint256(uint256 v) private {
        inbox.respond(abi.encode(v));
    }

    function _emitRespondU64(gtUint64 v, address cOwner, bool emitAddEvent) private {
        utUint64 memory combined = MpcCore.offBoardCombined(v, cOwner);
        if (emitAddEvent) {
            emit AddResult(combined.userCiphertext, cOwner);
        }
        inbox.respond(abi.encode(combined.userCiphertext));
    }

    function _emitRespondBool(gtBool v, address cOwner) private {
        utBool memory combined = MpcCore.offBoardCombined(v, cOwner);
        emit GtResult(combined.userCiphertext, cOwner);
        inbox.respond(abi.encode(combined.userCiphertext));
    }

    function _emitRespondU128(gtUint128 v, address cOwner, bool emitAdd128) private {
        utUint128 memory combined = MpcCore.offBoardCombined(v, cOwner);
        if (emitAdd128) {
            emit Add128Result(combined.userCiphertext, cOwner);
        }
        inbox.respond(abi.encode(combined.userCiphertext));
    }

    function _emitRespondU256(gtUint256 v, address cOwner, bool emitAdd256) private {
        utUint256 memory combined = MpcCore.offBoardCombined(v, cOwner);
        if (emitAdd256) {
            emit Add256Result(combined.userCiphertext, cOwner);
        }
        inbox.respond(abi.encode(combined.userCiphertext));
    }
}
