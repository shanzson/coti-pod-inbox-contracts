// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

import "@coti-io/coti-contracts/contracts/pod/InboxUser.sol";

/// @title MpcExecutorGt64Repro
/// @notice Test-only executor: `gt64` paths used to reproduce {InboxMiner} `ERROR_CODE_EXECUTION_FAILED` (1) with the
/// same empty `errorMessage` pattern as failed real `MpcExecutor.gt64` subcalls (bare `revert()` or OOG).
contract MpcExecutorGt64Repro is InboxUser {
    event GtResult(ctBool result, address cOwner);

    constructor(address _inbox) {
        setInbox(_inbox);
    }

    function gt64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        _emitRespondBool(MpcCore.gt(a, b), cOwner);
    }

    function _emitRespondBool(gtBool v, address cOwner) private {
        utBool memory combined = MpcCore.offBoardCombined(v, cOwner);
        emit GtResult(combined.userCiphertext, cOwner);
        inbox.respond(abi.encode(combined.userCiphertext));
    }
}
