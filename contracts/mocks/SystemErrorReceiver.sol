// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @dev Minimal source-app stand-in for Inbox system-error callback tests.
contract SystemErrorReceiver {
    IInbox public immutable inbox;
    bytes public lastError;
    uint256 public errorCount;
    IInbox.InboxErrorType public lastErrorType;

    constructor(address inbox_) {
        inbox = IInbox(inbox_);
    }

    function onSystemError(bytes calldata data) external {
        lastErrorType = inbox.inboxErrorType();
        lastError = data;
        unchecked {
            ++errorCount;
        }
    }
}
