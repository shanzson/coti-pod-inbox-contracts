// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @title EstimateGasTarget — estimateExecutionGasForMiner / reply-size attribution test target.
contract EstimateGasTarget {
    IInbox public immutable inbox;
    uint256 public burnGas;
    bool public doRespond;
    bool public doRaise;
    bytes public respondPayload;

    constructor(IInbox inbox_) {
        inbox = inbox_;
    }

    function configure(uint256 burnGas_, bool doRespond_, bool doRaise_, bytes calldata respondPayload_) external {
        burnGas = burnGas_;
        doRespond = doRespond_;
        doRaise = doRaise_;
        respondPayload = respondPayload_;
    }

    function entry(bytes calldata) external {
        uint256 target = burnGas;
        uint256 start = gasleft();
        while (target > 0 && start > gasleft() && start - gasleft() < target && gasleft() > 40_000) {
            // burn
        }
        if (doRespond) {
            inbox.respond(respondPayload);
        } else if (doRaise) {
            inbox.raise(respondPayload);
        }
    }
}
