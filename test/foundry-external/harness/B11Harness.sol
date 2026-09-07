// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

// Harness written by the verifier (not part of the gist): exposes InboxBase._safeEncodeMethodCall so the
// gist's B11 test can drive _tryDecodeAbiBytes with hostile re-encode returndata.
import {InboxBase} from "../../../contracts/InboxBase.sol";
import {IInbox} from "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @dev Delegatecall target that returns `mc.data` verbatim as raw returndata (no ABI wrapping).
contract EvilEchoModule {
    function reEncodeWithGt(IInbox.MpcMethodCall memory mc) external pure returns (bytes memory) {
        bytes memory d = mc.data;
        assembly {
            return(add(d, 0x20), mload(d))
        }
    }
}

contract B11Harness is InboxBase {
    function setModule(address m) external {
        mpcAbiReEncode = m;
    }

    /// @return ok      decoder verdict
    /// @return len     length word of the decoded bytes (read only; never copied)
    function safeEncodeLen(IInbox.MpcMethodCall memory mc) external returns (bool ok, uint256 len) {
        (bool ok_, bytes memory cd,) = _safeEncodeMethodCall(mc);
        uint256 l;
        assembly {
            l := mload(cd)
        }
        return (ok_, ok_ ? l : 0);
    }
}
