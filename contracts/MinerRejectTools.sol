// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import "./lib/MinerRejectLib.sol";

/// @title MinerRejectTools
/// @notice Pure helpers for the in-batch miner-reject encoding (kept off Inbox for create-size).
contract MinerRejectTools {
    function buildMinerRejectMethodCall(uint8 rejectionCode, bytes32 rejectionReason)
        external
        pure
        returns (IInbox.MpcMethodCall memory methodCall)
    {
        return MinerRejectLib.build(rejectionCode, rejectionReason);
    }

    function isMinerRejectMethodCall(IInbox.MpcMethodCall memory methodCall)
        external
        pure
        returns (bool isReject, uint8 rejectionCode, bytes32 rejectionReason)
    {
        return MinerRejectLib.parse(methodCall);
    }
}
