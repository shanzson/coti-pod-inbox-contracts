// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @title PocRevertTarget — burns its stipend then reverts with an EXACT-SIZE raw payload.
/// @dev The shipped {AdversarialGasTarget} floors `_burn` at 40k gasleft and reverts with a
///      35-char string (132 bytes -> 8 error slots, under the 200k reserve), so it cannot reach
///      the POST_CALL_GAS_RESERVE boundary. This target burns to a configurable floor and reverts
///      with `revertSize` raw bytes so the 256-byte worst case is reachable.
contract PocRevertTarget {
    uint256 public revertSize;
    uint256 public burnFloor;

    function configure(uint256 revertSize_, uint256 burnFloor_) external {
        revertSize = revertSize_;
        burnFloor = burnFloor_;
    }

    uint256 public sink;

    fallback() external {
        uint256 floor_ = burnFloor;
        uint256 s = sink;
        // keccak in the loop body + a storage write afterwards defeats the optimizer;
        // an empty `while (gasleft() > floor_) {}` gets eliminated and burns nothing.
        while (gasleft() > floor_) {
            s = uint256(keccak256(abi.encodePacked(s)));
        }
        sink = s;
        uint256 n = revertSize;
        assembly {
            let p := mload(0x40)
            // fill with 0x41 so truncation/corruption is visible
            for { let i := 0 } lt(i, n) { i := add(i, 32) } {
                mstore(add(p, i), not(0))
            }
            revert(p, n)
        }
    }
}

/// @title PocResponder — replies with an arbitrarily large payload.
/// @dev Used to show the return leg is bounded by `maxReplyMethodCallBytes` only, never by `callerFee`.
contract PocResponder {
    IInbox public immutable inbox;
    uint256 public replySize;

    constructor(IInbox inbox_) {
        inbox = inbox_;
    }

    function configure(uint256 replySize_) external {
        replySize = replySize_;
    }

    fallback() external {
        bytes memory payload = new bytes(replySize);
        inbox.respond(payload);
    }
}

/// @title PocGasSensitiveTarget — succeeds outwardly, but its inner call OOGs when gas is tight.
/// @dev Models the "degraded branch" a retrier can steer into by choosing the tx gas limit.
contract PocGasSensitiveTarget {
    bool public innerSucceeded;
    bool public everRan;
    uint256 public innerCost = 300_000;

    function setInnerCost(uint256 c) external { innerCost = c; }

    uint256 public innerSink;

    function _inner() external {
        require(msg.sender == address(this), "self only");
        uint256 start = gasleft();
        uint256 s = innerSink;
        // real work, so the optimizer cannot drop the loop
        while (start - gasleft() < innerCost) {
            s = uint256(keccak256(abi.encodePacked(s)));
        }
        innerSink = s;
    }

    fallback() external {
        everRan = true;
        // best-effort inner call — swallowed on failure, exactly the shape the Inbox itself uses
        (bool ok, ) = address(this).call(abi.encodeWithSignature("_inner()"));
        innerSucceeded = ok;
        // returns successfully either way
    }
}
