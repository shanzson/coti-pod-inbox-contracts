// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/InboxUser.sol";

/// @dev Minimal inbox stub for {InboxUser} auth unit tests.
contract MockInboxAuth {
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
}

contract InboxUserHarness is InboxUser {
    uint256 public peerHits;
    uint256 public returnLegHits;

    constructor(address inbox_) {
        setInbox(inbox_);
    }

    function setPeer(uint256 chainId, address peer) external {
        _setTrustedRemote(chainId, peer);
    }

    function peerEntry() external onlyInboxPeer {
        unchecked {
            ++peerHits;
        }
    }

    function returnLegEntry() external onlyInboxReturnLeg {
        unchecked {
            ++returnLegHits;
        }
    }

    function transportEntry() external onlyInbox {}
}
