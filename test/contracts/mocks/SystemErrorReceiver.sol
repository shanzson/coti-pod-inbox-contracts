// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @dev Minimal source-app stand-in for Inbox system-error callback tests.
contract SystemErrorReceiver {
    IInbox public immutable inbox;
    bytes public lastError;
    uint256 public errorCount;
    IInbox.InboxErrorType public lastErrorType;

    error OnlyInbox(address caller);
    error NotLinkedReturnLeg();

    constructor(address inbox_) {
        inbox = IInbox(inbox_);
    }

    function onSystemError(bytes calldata data) external {
        if (msg.sender != address(inbox)) {
            revert OnlyInbox(msg.sender);
        }
        if (inbox.inboxSourceRequestId() == bytes32(0)) {
            revert NotLinkedReturnLeg();
        }
        lastErrorType = inbox.inboxErrorType();
        lastError = data;
        unchecked {
            ++errorCount;
        }
    }
}
