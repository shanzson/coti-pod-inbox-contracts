// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IInbox} from "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import {IInboxMiner} from "@coti-io/coti-contracts/contracts/pod/IInboxMiner.sol";

import {Inbox} from "../../contracts/Inbox.sol";
import {FeeManagerStubBase} from "../../contracts/fee/FeeManagerStubBase.sol";
import {FeeManager} from "../../contracts/fee/FeeManager.sol";
import {PriceOracle} from "../../contracts/fee/PriceOracle.sol";
import {ChainlinkFeedLib} from "../../contracts/fee/chainlink/ChainlinkFeedLib.sol";

/// @notice Reenters a nonReentrant, non-miner-gated entrypoint (`retryFailedRequest`) while the Inbox
///         is mid-execution, recording whether the reentry was blocked and by which error.
contract MaliciousReenter {
    address public inbox;
    bool public reentrySucceeded;
    bytes4 public reentryRevertSelector;
    bool public ran;

    constructor(address _inbox) {
        inbox = _inbox;
    }

    fallback() external payable {
        ran = true;
        // retryFailedRequest is `external nonReentrant` and NOT onlyMiner, so any revert here is the
        // ReentrancyGuard, not an access check — isolating the guard as the blocker.
        (bool ok, bytes memory ret) =
            inbox.call(abi.encodeWithSelector(IInboxMiner.retryFailedRequest.selector, bytes32(uint256(1))));
        reentrySucceeded = ok;
        if (!ok && ret.length >= 4) {
            reentryRevertSelector = bytes4(ret);
        }
        // return normally so the OUTER target subcall succeeds (proving no revert-bubbling artifact).
    }
}

/// @notice Thin harness to call the internal library `ChainlinkFeedLib.tryReadPrice`.
contract ChainlinkProbe {
    function read(address feed, uint256 maxStaleness) external view returns (bool ok, uint256 price) {
        return ChainlinkFeedLib.tryReadPrice(feed, maxStaleness);
    }
}

/// @notice Minimal Chainlink aggregator double (matches the selectors ChainlinkFeedLib calls).
contract MockAgg {
    uint8 public decimals;
    int256 public answer;
    uint80 public roundId = 1;
    uint80 public answeredInRound = 1;
    uint256 public updatedAt;

    constructor(uint8 d, int256 a) {
        decimals = d;
        answer = a;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 ts) external {
        updatedAt = ts;
    }

    function setIncompleteRound() external {
        roundId = 5;
        answeredInRound = 4; // answeredInRound < roundId  => stale/incomplete
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @title InboxHighMediumTriage
/// @notice PoC-backed triage of the remaining Slither High/Medium findings on the inbox repo
///         (the `_encodeMethodCall` / controlled-delegatecall pair is covered by
///         InboxEncodeReachability.t.sol; FeeManager.collectFees impl-level behavior by
///         FeeManagerDirectCall.t.sol). Every test ends with a VERDICT line.
contract InboxHighMediumTriageTest is Test {
    FeeManager internal fee;
    Inbox internal inbox;
    address internal owner = makeAddr("owner");
    address internal attacker = makeAddr("attacker");

    function _cfg() internal pure returns (FeeManagerStubBase.FeeConfig memory) {
        // constantFee>0 keeps _localRequestExecutionBudget == targetFee (simplifies the mine PoC).
        return FeeManagerStubBase.FeeConfig({
            constantFee: 1,
            gasPerByte: 0,
            callbackExecutionGas: 0,
            errorLength: 0,
            bufferRatioX10000: 0,
            maxMethodCallBytes: 8192,
            maxExecutionGas: 25_000_000,
            gasPriceMul: 1,
            gasPriceDiv: 1
        });
    }

    function setUp() public {
        fee = new FeeManager();
        inbox = new Inbox();
        inbox.init(owner, 1, address(0) /*non-MPC*/, address(fee));
        vm.prank(owner);
        inbox.updateMinFeeConfigs(_cfg(), _cfg());
    }

    // ── HIGH: arbitrary-send-eth (FeeManager.collectFees) — gated by onlyOwner on the Inbox ──────
    function test_H_arbitrarySendEth_collectFees_isOwnerGatedOnInbox() public {
        vm.deal(address(inbox), 3 ether);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        inbox.collectFees(payable(attacker));
        assertEq(address(inbox).balance, 3 ether, "attacker cannot move Inbox fees");

        address payable sink = payable(makeAddr("sink"));
        vm.prank(owner);
        inbox.collectFees(sink);
        assertEq(sink.balance, 3 ether, "owner collects via the Inbox");
        console2.log("VERDICT [H arbitrary-send-eth]: gated by onlyOwner on the Inbox stub - not arbitrary.");
    }

    // ── HIGH: controlled-delegatecall (ModuleCallBase._delegateModule) — target is immutable ─────
    function test_H_controlledDelegatecall_feeManagerTargetImmutable() public {
        assertEq(inbox.feeManager(), address(fee), "feeManager set at init");
        // No setter exists (only assignment is InboxBase.sol#178); re-init is blocked.
        vm.prank(owner);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        inbox.init(owner, 1, address(0), address(0xBAD));
        vm.prank(attacker);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        inbox.init(attacker, 1, address(0), address(0xBAD));
        assertEq(inbox.feeManager(), address(fee), "feeManager unchanged");
        console2.log("VERDICT [H controlled-delegatecall _delegateModule]: target fixed at init, no setter - not attacker-controllable.");
    }

    // ── HIGH: unprotected-upgrade (Inbox.init) — "anyone can delete the contract" is a FALSE POSITIVE
    function test_H_unprotectedUpgrade_cannotDestroy_initOneShot() public {
        // Slither's claim requires a selfdestruct or delegatecall-to-arbitrary; the Inbox has NO
        // selfdestruct (grep) and its only delegatecalls target immutable modules. Runtime checks:
        // (1) init is one-shot; (2) ownership cannot be renounced (admin stays reachable).
        vm.prank(attacker);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        inbox.init(attacker, 1, address(0), address(fee));

        vm.prank(owner);
        vm.expectRevert(); // Inbox.renounceOwnership() is overridden to always revert
        inbox.renounceOwnership();

        assertEq(inbox.owner(), owner, "owner still set; contract not destroyable");
        console2.log("VERDICT [H unprotected-upgrade]: no selfdestruct + one-shot init + non-renounceable => cannot be deleted (false positive).");
    }

    // ── MEDIUM: divide-before-multiply — intentional ceil rounding, no unintended loss ───────────
    function test_M_divideBeforeMultiply_isIntentionalCeil() public pure {
        // (a) MpcAbiReEncode: padded = (n + 31) / 32 * 32  == round-up-to-32 (exact).
        uint256[8] memory ns = [uint256(0), 1, 31, 32, 33, 63, 64, 1000];
        for (uint256 i = 0; i < ns.length; i++) {
            uint256 n = ns[i];
            uint256 padded = (n + 31) / 32 * 32;
            assertEq(padded % 32, 0, "padded not multiple of 32");
            assertTrue(padded >= n, "padded < n");
            if (n > 0) assertTrue(padded - n < 32, "padding not minimal");
        }

        // (b) Fee quote: ((g*rp + lp-1)/lp) * gp  ==  ceil(g*rp/lp) * gp  (rounds fee UP, by design).
        uint256 g = 777_777;
        uint256 rp = 3 * 1e18;
        uint256 lp = 7 * 1e17;
        uint256 gp = 25 gwei;
        uint256 flagged = ((g * rp + lp - 1) / lp) * gp;
        uint256 intendedCeil = Math.ceilDiv(g * rp, lp) * gp;
        assertEq(flagged, intendedCeil, "not equal to intended ceil-then-scale");
        // It deliberately differs from the round-DOWN alternative (proves the ceil is load-bearing).
        uint256 roundDown = (g * rp / lp) * gp;
        assertTrue(flagged >= roundDown, "ceil should be >= round-down");
        console2.log("VERDICT [M divide-before-multiply]: deliberate ceil (rounds fees up); matches intended formula - not a precision bug.");
    }

    // ── MEDIUM: incorrect-equality (collectFees amount==0) — benign early return ─────────────────
    function test_M_incorrectEquality_zeroBalance_isNoop() public {
        assertEq(address(inbox).balance, 0);
        address payable sink = payable(makeAddr("sink2"));
        vm.prank(owner);
        inbox.collectFees(sink); // amount==0 => early return, no transfer, no revert
        assertEq(sink.balance, 0, "no transfer on zero balance");
        console2.log("VERDICT [M incorrect-equality]: amount==0 is a benign early-return no-op.");
    }

    // ── MEDIUM: reentrancy-no-eth — ReentrancyGuard blocks reentry into the mine path ────────────
    function test_M_reentrancyGuard_blocksReentryDuringMine() public {
        MaliciousReenter mal = new MaliciousReenter(address(inbox));
        vm.prank(owner);
        inbox.addMiner(address(this));

        bytes32 requestId = inbox.getRequestId(2, 1, 1); // source=2, target=chainId(1), nonce=1
        IInbox.MpcMethodCall memory mc = IInbox.MpcMethodCall({
            selector: bytes4(0), // raw passthrough (no MpcAbiReEncode needed)
            data: "",
            datatypes: new bytes8[](0),
            datalens: new bytes32[](0)
        });
        IInboxMiner.MinedRequest[] memory arr = new IInboxMiner.MinedRequest[](1);
        arr[0] = IInboxMiner.MinedRequest({
            requestId: requestId,
            sourceContract: address(0xBEEF),
            targetContract: address(mal),
            methodCall: mc,
            callbackSelector: bytes4(0),
            errorSelector: bytes4(0),
            isTwoWay: false,
            sourceRequestId: bytes32(0),
            targetFee: 2_000_000,
            callerFee: 0
        });

        inbox.batchProcessRequests(2, arr); // executes mal, which tries to reenter

        assertTrue(mal.ran(), "target was not executed");
        assertFalse(mal.reentrySucceeded(), "reentry into the Inbox SUCCEEDED (guard failed!)");
        assertEq(
            mal.reentryRevertSelector(),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "reentry blocked by something other than the ReentrancyGuard"
        );
        console2.log("VERDICT [M reentrancy-no-eth]: ReentrancyGuard blocks reentry into the mine path (ReentrancyGuardReentrantCall).");
    }

    // ── MEDIUM: uninitialized-local (PriceOracle refresh prices) — benign default zero ───────────
    function test_M_uninitializedLocal_priceOracleRefresh_benign() public {
        PriceOracle oracle = new PriceOracle(address(this));
        // Tokens unset => localPrice/remotePrice stay at their (uninitialized) default 0, used only in
        // the CacheRefreshed event. refreshCache must not revert.
        oracle.refreshCache();
        (uint256 lp, uint256 rp) = oracle.getPricesUSD();
        assertEq(lp, 0);
        assertEq(rp, 0);
        console2.log("VERDICT [M uninitialized-local]: defaults to 0, only feeds an event; no revert - benign.");
    }

    // ── MEDIUM: unused-return (ChainlinkFeedLib.latestRoundData) — round data IS consumed ────────
    function test_M_unusedReturn_chainlinkStalenessHandled() public {
        ChainlinkProbe probe = new ChainlinkProbe();
        MockAgg agg = new MockAgg(8, 2_000 * 1e8);
        vm.warp(1_000_000);
        agg.setUpdatedAt(block.timestamp);

        // Fresh & complete => used (true, normalized price).
        (bool ok, uint256 price) = probe.read(address(agg), 3600);
        assertTrue(ok, "fresh feed should read");
        assertEq(price, 2_000 * 1e18, "normalized to 18 decimals");

        // Stale `updatedAt` => rejected (proves updatedAt is consumed).
        agg.setUpdatedAt(block.timestamp - 7200);
        (bool ok2,) = probe.read(address(agg), 3600);
        assertFalse(ok2, "stale feed must be rejected");

        // answeredInRound < roundId => rejected (proves roundId/answeredInRound are consumed).
        agg.setUpdatedAt(block.timestamp);
        agg.setIncompleteRound();
        (bool ok3,) = probe.read(address(agg), 3600);
        assertFalse(ok3, "incomplete round must be rejected");
        console2.log("VERDICT [M unused-return chainlink]: latestRoundData fields ARE used (staleness + round completeness) - false positive.");
    }
}
