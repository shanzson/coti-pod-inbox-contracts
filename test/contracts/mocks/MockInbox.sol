// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";
import "./MpcExecutorGt64Repro.sol";

/// @title MockInbox
/// @notice Mock inbox for testing purposes (minimal {IInbox} context surface for peer auth).
contract MockInbox {
    event Respond(bytes data);
    event Error(bytes data);

    uint256 public remoteChainId;
    address public remoteContract;
    bytes32 public sourceRequestId;

    function setContext(uint256 chainId, address peer, bytes32 sourceId) external {
        remoteChainId = chainId;
        remoteContract = peer;
        sourceRequestId = sourceId;
    }

    function inboxMsgSender() external view returns (uint256, address) {
        return (remoteChainId, remoteContract);
    }

    function inboxSourceRequestId() external view returns (bytes32) {
        return sourceRequestId;
    }

    function respond(bytes memory data) external {
        emit Respond(data);
    }

    function call64WithGas(
        address target,
        uint64 _a,
        uint64 _b,
        address cOwner,
        uint256 gasAllowed
    ) external {
        gtUint64 a = MpcCore.setPublic64(_a);
        gtUint64 b = MpcCore.setPublic64(_b);
        bytes memory methodCall = abi.encodeWithSelector(MpcExecutorGt64Repro.gt64.selector, a, b, cOwner);
        (bool success, bytes memory returnData) = target.call{gas: gasAllowed}(methodCall);
        if (!success) {
            emit Error(returnData);
        }
        emit Respond(returnData);
    }
}
