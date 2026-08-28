// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {Test} from "forge-std/Test.sol";
import {FeeManager} from "../../contracts/fee/FeeManager.sol";
import {LibFeeStorage} from "../../contracts/fee/LibFeeStorage.sol";
import {InboxFeeQuoter} from "../../contracts/fee/InboxFeeQuoter.sol";
import {FeeManagerStubBase} from "../../contracts/fee/FeeManagerStubBase.sol";
import {MockPriceOracle, StubQuoteHarness} from "./harness/Harnesses.sol";

/// @title QuoterProps — SPEC.md Groups A, E(P-CFG-NR/FG), F against the two REAL quoters.
contract QuoterPropsTest is SymTest, Test {
    uint256 internal constant MAX_PRICE = 1e36;
    uint256 internal constant MAX_GASPRICE = 1e15;
    uint256 internal constant MAX_SIZE = 32768;
    uint256 internal constant MAX_EXEC = 25_000_000;
    uint256 internal constant MAX_BR = 10_000;

    InboxFeeQuoter internal quoter;
    StubQuoteHarness internal stub;
    MockPriceOracle internal oracle;
    FeeManager internal fm;

    function setUp() public {
        quoter = new InboxFeeQuoter();
        stub = new StubQuoteHarness();
        oracle = new MockPriceOracle();
        stub.setOracle(address(oracle));
        fm = new FeeManager();
    }

    function _envelopeCfg(string memory tag) internal view returns (LibFeeStorage.FeeConfig memory c) {
        c.constantFee = 0;
        c.gasPerByte = uint32(svm.createUint(32, string.concat(tag, "_g")));
        c.callbackExecutionGas = uint32(svm.createUint(32, string.concat(tag, "_cbg")));
        c.errorLength = uint32(svm.createUint(32, string.concat(tag, "_el")));
        c.bufferRatioX10000 = uint32(svm.createUint(32, string.concat(tag, "_br")));
        c.maxMethodCallBytes = 32768;
        c.maxExecutionGas = 25_000_000;
        c.gasPriceMul = uint16(svm.createUint(16, string.concat(tag, "_mul")));
        c.gasPriceDiv = uint16(svm.createUint(16, string.concat(tag, "_div")));
        vm.assume(c.gasPerByte >= 1 && c.callbackExecutionGas >= 1 && c.errorLength >= 1);
        vm.assume(c.bufferRatioX10000 >= 1 && c.bufferRatioX10000 <= MAX_BR);
        vm.assume(c.gasPriceMul >= 1 && c.gasPriceDiv >= 1);
    }

    function _toQuoterCfg(LibFeeStorage.FeeConfig memory c)
        internal
        pure
        returns (InboxFeeQuoter.FeeConfig memory q)
    {
        q = InboxFeeQuoter.FeeConfig(
            c.constantFee,
            c.gasPerByte,
            c.callbackExecutionGas,
            c.errorLength,
            c.bufferRatioX10000,
            c.maxMethodCallBytes,
            c.maxExecutionGas,
            c.gasPriceMul,
            c.gasPriceDiv
        );
    }

    function _domain(string memory tag)
        internal
        view
        returns (uint256 lp, uint256 rp, uint256 P, uint256 sR, uint256 sCb, uint256 xR, uint256 xCb)
    {
        lp = svm.createUint256(string.concat(tag, "_lp"));
        rp = svm.createUint256(string.concat(tag, "_rp"));
        P = svm.createUint256(string.concat(tag, "_P"));
        sR = svm.createUint256(string.concat(tag, "_sR"));
        sCb = svm.createUint256(string.concat(tag, "_sCb"));
        xR = svm.createUint256(string.concat(tag, "_xR"));
        xCb = svm.createUint256(string.concat(tag, "_xCb"));
        vm.assume(lp >= 1 && lp <= MAX_PRICE && rp >= 1 && rp <= MAX_PRICE);
        vm.assume(P >= 1 && P <= MAX_GASPRICE);
        vm.assume(sR <= MAX_SIZE && sCb <= MAX_SIZE);
        vm.assume(xR <= MAX_EXEC && xCb <= MAX_EXEC);
    }

    // ─── P-EQ1: stub (inline ceil) ≡ quoter (mulDiv Ceil) on the shared domain ─

    /// Inside the P-CFG-NR envelope neither implementation reverts (proven separately),
    /// so plain equality of both outputs is the full statement here.
    function check_EQ1_stubEqualsQuoter() public {
        LibFeeStorage.FeeConfig memory cl = _envelopeCfg("l");
        LibFeeStorage.FeeConfig memory cr = _envelopeCfg("r");
        (uint256 lp, uint256 rp, uint256 P, uint256 sR, uint256 sCb, uint256 xR, uint256 xCb) = _domain("eq1");

        oracle.setPrices(lp, rp);
        stub.setConfigs(cl, cr);

        (uint256 tStub, uint256 kStub) = stub.calculateTwoWayFeeRequiredInLocalToken(sR, sCb, xR, xCb, P);
        (uint256 tQ, uint256 kQ) =
            quoter.calculateTwoWayFeeRequiredInLocalToken(_toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, sR, sCb, xR, xCb, P);
        assert(tStub == tQ);
        assert(kStub == kQ);
    }

    // ─── P-EQ2: E cross-implementation agreement (degenerate extraction) ──────

    /// With mul=div=1, rp=lp, P=1, x=0 the quoter's callerFee is exactly E(s_cb, C_l),
    /// compared against the REAL FeeManager.expectedMinFee bytecode.
    function check_EQ2_expectedMinFeeAgree() public view {
        LibFeeStorage.FeeConfig memory c = _envelopeCfg("eq2");
        c.gasPriceMul = 1;
        c.gasPriceDiv = 1;
        uint256 s = svm.createUint256("eq2_s");
        vm.assume(s <= MAX_SIZE);
        (, uint256 K) =
            quoter.calculateTwoWayFeeRequiredInLocalToken(_toQuoterCfg(c), _toQuoterCfg(c), 1, 1, 0, s, 0, 0, 1);
        assert(K == fm.expectedMinFee(s, c));
    }

    // ─── P-CFG-NR: no-unexpected-revert envelope ──────────────────────────────

    /// Direct (non-try) calls: any revert inside the envelope fails the check.
    function check_CFGNR_noRevertOnEnvelope() public {
        LibFeeStorage.FeeConfig memory cl = _envelopeCfg("l");
        LibFeeStorage.FeeConfig memory cr = _envelopeCfg("r");
        (uint256 lp, uint256 rp, uint256 P, uint256 sR, uint256 sCb, uint256 xR, uint256 xCb) = _domain("nr");

        oracle.setPrices(lp, rp);
        stub.setConfigs(cl, cr);
        (uint256 tStub,) = stub.calculateTwoWayFeeRequiredInLocalToken(sR, sCb, xR, xCb, P);
        (uint256 tQ,) =
            quoter.calculateTwoWayFeeRequiredInLocalToken(_toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, sR, sCb, xR, xCb, P);
        // Reaching here without revert is the property; touch outputs to keep them live.
        assert(tStub == tQ);
    }

    /// P-CFG-FG: the documented foot-gun — an admin-VALIDATED config with br ≈ 2^32
    /// bricks quoting at in-range prices/gas prices (concrete expected-CEX probe).
    function check_CFGFG_validatedConfigCanStillOverflow_concrete() public {
        LibFeeStorage.FeeConfig memory cr = LibFeeStorage.FeeConfig({
            constantFee: 0,
            gasPerByte: 4294967295,
            callbackExecutionGas: 1,
            errorLength: 4294967295,
            bufferRatioX10000: 4294967295, // passes _requireValidFeeConfig!
            maxMethodCallBytes: 32768,
            maxExecutionGas: 25_000_000,
            gasPriceMul: 1,
            gasPriceDiv: 65535
        });
        LibFeeStorage.FeeConfig memory cl = LibFeeStorage.FeeConfig(0, 1, 1, 1, 1, 32768, 25_000_000, 1, 1);
        // Confirm the config really is admin-acceptable (updateMinFeeConfigs must not revert):
        MockPriceOracle o = new MockPriceOracle();
        o.setPrices(1, 1);
        FeeManager freshFm = new FeeManager();
        freshFm.setPriceOracle(address(o));
        freshFm.updateMinFeeConfigs(cl, cr);
        // ...yet both quoters overflow-revert at in-range (1e36, 1e15) price/gasPrice:
        (bool okQ,) = address(quoter).call(
            abi.encodeCall(
                InboxFeeQuoter.calculateTwoWayFeeRequiredInLocalToken,
                (_toQuoterCfg(cl), _toQuoterCfg(cr), 1, 1e36, 32768, 0, 0, 0, 1e15)
            )
        );
        assert(!okQ);
        oracle.setPrices(1, 1e36);
        stub.setConfigs(cl, cr);
        (bool okS,) = address(stub).call(
            abi.encodeCall(FeeManagerStubBase.calculateTwoWayFeeRequiredInLocalToken, (32768, 0, 0, 0, 1e15))
        );
        assert(!okS);
    }

    // ─── P-TIGHT: bounded overcharge (integer forms from SPEC Group F) ────────

    function check_TIGHT_overchargeBounded() public view {
        LibFeeStorage.FeeConfig memory cl = _envelopeCfg("l");
        LibFeeStorage.FeeConfig memory cr = _envelopeCfg("r");
        (uint256 lp, uint256 rp, uint256 P, uint256 sR, uint256 sCb, uint256 xR, uint256 xCb) = _domain("tt");

        (uint256 T, uint256 K) =
            quoter.calculateTwoWayFeeRequiredInLocalToken(_toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, sR, sCb, xR, xCb, P);

        uint256 t = fm.expectedMinFee(sR, cr) + xR;
        uint256 c = fm.expectedMinFee(sCb, cl) + xCb;
        // T·lp·mul_r <= (t·div_r + mul_r)·rp·P + lp·mul_r·P
        assert(
            T * lp * uint256(cr.gasPriceMul)
                <= (t * uint256(cr.gasPriceDiv) + uint256(cr.gasPriceMul)) * rp * P + lp * uint256(cr.gasPriceMul) * P
        );
        // K·mul_l <= (c·div_l + mul_l)·P
        assert(K * uint256(cl.gasPriceMul) <= (c * uint256(cl.gasPriceDiv) + uint256(cl.gasPriceMul)) * P);
    }
}
