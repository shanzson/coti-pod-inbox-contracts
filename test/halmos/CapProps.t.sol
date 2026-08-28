// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {Test} from "forge-std/Test.sol";
import {InboxCapHarness} from "./harness/Harnesses.sol";

/// @title CapProps — SPEC.md Group H: error-returndata DoS bound (InboxBase._capErrorReturnData).
/// @dev Execution/encode failure payloads written to storage and emitted are truncated to
///      MAX_ERROR_RETURN_DATA (256) bytes in place, so an adversarial target cannot OOG the
///      miner tx or wedge the contiguous-nonce queue with unbounded returndata. Verified on the
///      REAL InboxBase assembly via a thin harness. `capErrorReturnData` is external, so the
///      argument is ABI-copied into the callee — the returned buffer is a genuine copy compared
///      against the original `d`, not an alias of it.
contract CapPropsTest is SymTest, Test {
    uint256 constant MAX = 256; // MAX_ERROR_RETURN_DATA

    InboxCapHarness internal h;

    function setUp() public {
        h = new InboxCapHarness();
    }

    /// P-CAP-CONST: the harness sees the real constant.
    function check_CAP_constant() public view {
        assert(h.maxErrorReturnData() == MAX);
    }

    /// P-CAP: for a symbolic input of concrete length `len`:
    ///   (C1) capped.length == min(len, 256) and <= 256;
    ///   (C2/C3) capped[i] == d[i] for every i < capped.length (prefix preserved, both the
    ///           identity case len<=256 and the truncation case len>256, unified).
    /// Concrete lengths straddle the strict `gt(mload(data),256)` boundary; content is symbolic.
    function check_CAP_len0() public view { _cap(0); }
    function check_CAP_len1() public view { _cap(1); }
    function check_CAP_len255() public view { _cap(255); }
    function check_CAP_len256() public view { _cap(256); }
    function check_CAP_len257() public view { _cap(257); }
    function check_CAP_len300() public view { _cap(300); }

    function _cap(uint256 len) internal view {
        bytes memory d = svm.createBytes(len, "errData");
        bytes memory capped = h.capErrorReturnData(d);

        uint256 expected = len <= MAX ? len : MAX;
        assert(capped.length == expected);
        assert(capped.length <= MAX);
        for (uint256 i = 0; i < expected; i++) {
            assert(capped[i] == d[i]);
        }
    }
}
