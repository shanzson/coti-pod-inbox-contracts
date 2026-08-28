// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {Test} from "forge-std/Test.sol";
import {InboxBase} from "../../contracts/InboxBase.sol";
import {IInbox} from "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @title PackProps — SPEC.md Group D on the REAL InboxBase pack/unpack surface.
/// @dev InboxBase is concrete with no constructor; getRequestId / unpackRequestId are
///      external pure, so the un-initialized deployment is a faithful harness.
contract PackPropsTest is SymTest, Test {
    InboxBase internal inbox;

    function setUp() public {
        inbox = new InboxBase();
    }

    /// P-PACK1: unpack(pack(s,t,n)) == (s,t,n) on the in-range domain.
    function check_PACK1_roundTrip(uint256 s, uint256 t, uint256 n) public view {
        vm.assume(s <= type(uint64).max);
        vm.assume(t <= type(uint64).max);
        vm.assume(n <= type(uint128).max);
        bytes32 id = inbox.getRequestId(s, t, n);
        (uint256 s2, uint256 t2, uint256 n2) = inbox.unpackRequestId(id);
        assert(s2 == s && t2 == t && n2 == n);
    }

    /// P-PACK2: pack reverts IFF an input is out of range.
    function check_PACK2_revertCompleteness(uint256 s, uint256 t, uint256 n) public view {
        (bool ok,) = address(inbox).staticcall(abi.encodeCall(IInbox.getRequestId, (s, t, n)));
        bool inRange = s <= type(uint64).max && t <= type(uint64).max && n <= type(uint128).max;
        assert(ok == inRange);
    }

    /// P-PACK3: injectivity on in-range tuples ⇒ requestId uniqueness.
    function check_PACK3_injective(uint256 s1, uint256 t1, uint256 n1, uint256 s2, uint256 t2, uint256 n2)
        public
        view
    {
        vm.assume(s1 <= type(uint64).max && t1 <= type(uint64).max && n1 <= type(uint128).max);
        vm.assume(s2 <= type(uint64).max && t2 <= type(uint64).max && n2 <= type(uint128).max);
        bytes32 a = inbox.getRequestId(s1, t1, n1);
        bytes32 b = inbox.getRequestId(s2, t2, n2);
        if (a == b) {
            assert(s1 == s2 && t1 == t2 && n1 == n2);
        }
    }
}
