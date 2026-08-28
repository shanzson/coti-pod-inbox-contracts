// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {Test} from "forge-std/Test.sol";
import {RejectCodecWrapper} from "./harness/Harnesses.sol";
import {IInbox} from "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @title CodecProps — SPEC.md Group G: miner-reject sentinel codec + storage-slot constant.
contract CodecPropsTest is SymTest, Test {
    RejectCodecWrapper internal w;

    function setUp() public {
        w = new RejectCodecWrapper();
    }

    /// P-REJ1: parse(build(code, reason)) == (true, code, reason) for all inputs.
    function check_REJ1_roundTrip(uint8 code, bytes32 reason) public view {
        IInbox.MpcMethodCall memory mc = w.build(code, reason);
        (bool isReject, uint8 code2, bytes32 reason2) = w.parse(mc);
        assert(isReject);
        assert(code2 == code);
        assert(reason2 == reason);
    }

    /// P-REJ2 (bounded-completeness): over data lengths {0,1,2,33,34,35} with symbolic
    /// content and symbolic selector, isReject holds IFF the exact sentinel shape.
    function check_REJ2_detectionIffShape() public view {
        uint256[6] memory lens = [uint256(0), 1, 2, 33, 34, 35];
        string[6] memory names = ["rej2_d0", "rej2_d1", "rej2_d2", "rej2_d33", "rej2_d34", "rej2_d35"];
        bytes4 sel = svm.createBytes4("rej2_sel");
        for (uint256 i = 0; i < lens.length; i++) {
            IInbox.MpcMethodCall memory mc;
            mc.selector = sel;
            mc.datatypes = new bytes8[](0);
            mc.datalens = new bytes32[](0);
            mc.data = svm.createBytes(lens[i], names[i]);
            (bool isReject, uint8 code, bytes32 reason) = w.parse(mc);
            bool shape = sel == bytes4(0) && mc.data.length == 34 && mc.data.length > 0 && uint8(mc.data[0]) == 0xff;
            assert(isReject == shape);
            if (!isReject) {
                assert(code == 0 && reason == bytes32(0));
            }
            // structuralSize identity for these shapes (no arrays):
            assert(w.structuralSize(mc) == mc.data.length);
        }
    }

    /// P-REJ2 (array guard): non-empty datatypes/datalens never parse as reject, even
    /// with a perfect 34-byte 0xff payload.
    function check_REJ2_nonEmptyArraysNeverReject() public view {
        bytes memory payload = svm.createBytes(34, "rej2a_data");
        vm.assume(uint8(payload[0]) == 0xff);
        IInbox.MpcMethodCall memory mc;
        mc.selector = bytes4(0);
        mc.data = payload;
        mc.datatypes = new bytes8[](1);
        mc.datalens = new bytes32[](0);
        (bool r1,,) = w.parse(mc);
        assert(!r1);
        mc.datatypes = new bytes8[](0);
        mc.datalens = new bytes32[](1);
        (bool r2,,) = w.parse(mc);
        assert(!r2);
        // structuralSize counts each array slot as 32 bytes:
        mc.datatypes = new bytes8[](1);
        assert(w.structuralSize(mc) == 34 + 64);
    }

    /// P-SLOT: hard-coded ERC-7201 slot equals its keccak derivation.
    function check_SLOT_erc7201ConstantMatchesDerivation() public view {
        assert(w.storedSlotConstant() == w.derivedSlot());
    }
}
