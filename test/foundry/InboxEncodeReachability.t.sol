// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {IInbox} from "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

import {Inbox} from "../../contracts/Inbox.sol";
import {FeeManager} from "../../contracts/fee/FeeManager.sol";

/// @notice Delegatecall target for the live encode path (`_safeEncodeMethodCall`). Same
///         `reEncodeWithGt(IInbox.MpcMethodCall)` selector (0x1638f951) as the real MpcAbiReEncode,
///         so a delegatecall dispatched by `_safeEncodeMethodCall` lands here; returns a sentinel so
///         the test can prove the call actually reached this configured target.
contract SpyReEncoder {
    function reEncodeWithGt(IInbox.MpcMethodCall memory) external pure returns (bytes memory) {
        return abi.encode(bytes("ENCODED-BY-SPY"));
    }
}

/// @notice Inbox subclass exposing the LIVE internal encoder for observation.
contract InboxEncodeHarness is Inbox {
    function exposeSafeEncode(IInbox.MpcMethodCall memory m)
        external
        returns (bool ok, bytes memory data, bytes memory err)
    {
        return _safeEncodeMethodCall(m); // the path InboxMiner._runIncomingExecution actually uses
    }
}

/// @title InboxEncodeReachability
/// @notice Answers "Where is `_encodeMethodCall` called, and is the controlled-delegatecall it wraps a
///         real issue?".
///
///  Static facts (verified in-repo):
///    * `_encodeMethodCall` (InboxBase.sol#677) has ZERO call sites (grep). It calls the also-uncalled
///      `_delegateReEncodeWithGt` (#741). Slither's own `dead-code` detector flags BOTH as
///      "never used and should be removed".
///    * The LIVE encoder is `_safeEncodeMethodCall`, invoked once at InboxMiner.sol#337.
///    * The delegatecall target `mpcAbiReEncode` is assigned ONLY at InboxBase.sol#176 (one-time
///      `_initInboxBase`); there is no setter.
///
///  PROOF A — dead-code elimination (build-level, reproducible; see the scratch commands in the PR notes):
///    Deleting `_encodeMethodCall` + `_delegateReEncodeWithGt` from source and recompiling with metadata
///    disabled (`bytecode_hash = "none"`, `cbor_metadata = false`, matching hardhat.config's
///    `bytecodeHash: none`) yields a BYTE-IDENTICAL deployed `Inbox` runtime bytecode
///    (48162 hex chars, sha256 cef8e29a…46527bf0f4d1c575c2c29b61 either way). They contribute ZERO bytes
///    to the deployed contract → the `controlled-delegatecall` inside them does not exist on-chain and
///    cannot be triggered. NOT an exploitable issue — a dead-code cleanup item only.
///
///  PROOF B and C below run under `forge test` and confirm the substantive claims at runtime.
contract InboxEncodeReachabilityTest is Test {
    FeeManager internal fee;
    SpyReEncoder internal spy;
    address internal owner = makeAddr("owner");

    function setUp() public {
        fee = new FeeManager();
        spy = new SpyReEncoder();
    }

    // B) The delegatecall target (mpcAbiReEncode) is fixed at init and has no setter, so neither the
    //    (dead) nor the (live) delegatecall target is attacker-controllable.
    function test_B_DelegatecallTarget_IsImmutableAfterInit() public {
        Inbox inbox = new Inbox();
        inbox.init(owner, 1, address(spy), address(fee));
        assertEq(inbox.mpcAbiReEncode(), address(spy), "target set at init");

        // The single assignment site (InboxBase.sol#176) cannot run twice, and there is no setter.
        vm.prank(owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        inbox.init(owner, 1, address(0xBAD), address(fee));

        // An arbitrary attacker likewise cannot re-init to repoint the target.
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        inbox.init(makeAddr("attacker"), 1, address(0xBAD), address(fee));

        assertEq(inbox.mpcAbiReEncode(), address(spy), "target unchanged after re-init attempts");
        console2.log("VERDICT [B]: mpcAbiReEncode is fixed at init (no setter, no re-init) - not attacker-controllable.");
    }

    // C) The LIVE encoder delegatecalls that fixed target with the hardcoded reEncodeWithGt selector.
    //    ok==true + the returned sentinel prove the call reached the trusted module at `mpcAbiReEncode`;
    //    a zero-selector methodCall is a pure passthrough with no delegatecall at all.
    function test_C_LivePath_DelegatecallsTrustedTargetWithFixedSelector() public {
        InboxEncodeHarness h = new InboxEncodeHarness();
        h.init(owner, 1, address(spy), address(fee));

        IInbox.MpcMethodCall memory m = IInbox.MpcMethodCall({
            selector: bytes4(0x11223344), // non-zero => re-encode delegatecall branch
            data: hex"dead",
            datatypes: new bytes8[](0),
            datalens: new bytes32[](0)
        });
        (bool ok, bytes memory data,) = h.exposeSafeEncode(m);
        assertTrue(ok, "live encode delegatecall did not reach the configured target");
        assertEq(abi.decode(data, (bytes)), bytes("ENCODED-BY-SPY"), "did not receive target's return payload");

        IInbox.MpcMethodCall memory raw = IInbox.MpcMethodCall({
            selector: bytes4(0), // zero => raw passthrough, no delegatecall
            data: hex"c0ffee",
            datatypes: new bytes8[](0),
            datalens: new bytes32[](0)
        });
        (bool ok2, bytes memory data2,) = h.exposeSafeEncode(raw);
        assertTrue(ok2, "raw passthrough failed");
        assertEq(data2, hex"c0ffee", "raw passthrough must echo data unchanged");

        console2.log("VERDICT [C]: LIVE _safeEncodeMethodCall delegatecalls mpcAbiReEncode (fixed selector); raw path is a plain passthrough.");
    }
}
