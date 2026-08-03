// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @title InboxGasTarget
/// @notice Lightweight target used by Inbox gas benchmarks.
contract InboxGasTarget {
    IInbox public immutable inbox;
    bool public shouldFail;

    event Observed(bytes payload);

    constructor(IInbox inbox_) {
        inbox = inbox_;
    }

    function setShouldFail(bool value) external {
        shouldFail = value;
    }

    function observe(bytes calldata payload) external {
        if (shouldFail) {
            revert("InboxGasTarget: fail");
        }
        emit Observed(payload);
    }

    function observeAndRespond(bytes calldata payload) external {
        if (shouldFail) {
            revert("InboxGasTarget: fail");
        }
        emit Observed(payload);
        inbox.respond(payload);
    }
}
