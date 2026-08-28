// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {Test} from "forge-std/Test.sol";
import {FeeManager} from "../../contracts/fee/FeeManager.sol";
import {LibFeeStorage} from "../../contracts/fee/LibFeeStorage.sol";
import {InboxFeeQuoter} from "../../contracts/fee/InboxFeeQuoter.sol";
import {MockPriceOracle} from "./harness/Harnesses.sol";

/// @title FeeValidateProps — SPEC.md Groups B, C, E, F′ against the REAL FeeManager.
/// @dev FeeManager deployed standalone: every storage access goes through
///      LibFeeStorage.get() on address(this), so direct calls and the production
///      DELEGATECALL see identical storage semantics (SPEC §4, critic-verified).
///      Env pinning: vm.fee(0) + vm.txGasPrice(0), then setGasPriceBounds(0, P, P)
///      forces _referenceGasPrice() == P exactly (P-REF, both clamp branches).
contract FeeValidatePropsTest is SymTest, Test {
    uint256 internal constant MAX_PRICE = 1e36; // < 2^120
    uint256 internal constant MAX_GASPRICE = 1e15; // < 2^50
    uint256 internal constant MAX_SIZE = 32768;
    uint256 internal constant MAX_EXEC = 25_000_000;
    uint256 internal constant MAX_BR = 10_000; // P-CFG-NR hypothesis

    FeeManager internal fm;
    MockPriceOracle internal oracle;
    InboxFeeQuoter internal quoter;

    function setUp() public {
        fm = new FeeManager();
        oracle = new MockPriceOracle();
        quoter = new InboxFeeQuoter();
    }

    // ─── config builders (assumes mirror _requireValidFeeConfig exactly) ─────

    function _variableCfg(string memory tag) internal view returns (LibFeeStorage.FeeConfig memory c) {
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

    function _constantCfg(string memory tag) internal view returns (LibFeeStorage.FeeConfig memory c) {
        c.constantFee = uint32(svm.createUint(32, string.concat(tag, "_cf")));
        c.maxMethodCallBytes = 32768;
        c.maxExecutionGas = 25_000_000;
        c.gasPriceMul = uint16(svm.createUint(16, string.concat(tag, "_mul")));
        c.gasPriceDiv = uint16(svm.createUint(16, string.concat(tag, "_div")));
        vm.assume(c.constantFee >= 1 && c.constantFee <= MAX_EXEC);
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

    function _pricesAndGasPrice(string memory tag)
        internal
        view
        returns (uint256 lp, uint256 rp, uint256 P)
    {
        lp = svm.createUint256(string.concat(tag, "_lp"));
        rp = svm.createUint256(string.concat(tag, "_rp"));
        P = svm.createUint256(string.concat(tag, "_P"));
        vm.assume(lp >= 1 && lp <= MAX_PRICE);
        vm.assume(rp >= 1 && rp <= MAX_PRICE);
        vm.assume(P >= 1 && P <= MAX_GASPRICE);
    }

    function _configure(
        LibFeeStorage.FeeConfig memory cl,
        LibFeeStorage.FeeConfig memory cr,
        uint256 lp,
        uint256 rp,
        uint256 P
    ) internal {
        vm.fee(0);
        // vm.txGasPrice is not a Halmos cheatcode; the sound equivalent is constraining
        // the environment value itself (concrete 0 under Halmos defaults).
        vm.assume(tx.gasprice == 0);
        oracle.setPrices(lp, rp);
        fm.setPriceOracle(address(oracle));
        fm.setGasPriceBounds(0, P, P);
        fm.updateMinFeeConfigs(cl, cr);
    }

    // ─── P-RT2: two-way round-trip theorem (flagship) ─────────────────────────

    /// Variable-template branch. H1/H2 taken in their sufficient form ds <= s_cb, ds <= s_r (L4).
    function check_RT2_variableConfigs() public {
        LibFeeStorage.FeeConfig memory cl = _variableCfg("l");
        LibFeeStorage.FeeConfig memory cr = _variableCfg("r");
        (uint256 lp, uint256 rp, uint256 P) = _pricesAndGasPrice("rt2");

        uint256 sR = svm.createUint256("rt2_sR");
        uint256 sCb = svm.createUint256("rt2_sCb");
        uint256 ds = svm.createUint256("rt2_ds");
        uint256 xR = svm.createUint256("rt2_xR");
        uint256 xCb = svm.createUint256("rt2_xCb");
        vm.assume(sR <= MAX_SIZE && sCb <= MAX_SIZE && ds <= MAX_SIZE);
        vm.assume(xR <= MAX_EXEC && xCb <= MAX_EXEC);
        vm.assume(ds <= sCb && ds <= sR); // H1, H2 via monotonicity (L4)

        (uint256 T, uint256 K) = quoter.calculateTwoWayFeeRequiredInLocalToken(
            _toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, sR, sCb, xR, xCb, P
        );

        _configure(cl, cr, lp, rp, P);

        // Acceptance IS the property: a revert here fails the check.
        (uint256 tg, uint256 cg) = fm.validateAndPrepareTwoWayFees(ds, T + K, K);

        uint256 t = fm.expectedMinFee(sR, cr) + xR;
        uint256 c = fm.expectedMinFee(sCb, cl) + xCb;
        assert(tg >= t);
        assert(cg >= c);
    }

    /// Constant-template branch (sizes irrelevant, H1/H2 vacuous).
    function check_RT2_constantConfigs() public {
        LibFeeStorage.FeeConfig memory cl = _constantCfg("l");
        LibFeeStorage.FeeConfig memory cr = _constantCfg("r");
        (uint256 lp, uint256 rp, uint256 P) = _pricesAndGasPrice("rt2c");

        uint256 xR = svm.createUint256("rt2c_xR");
        uint256 xCb = svm.createUint256("rt2c_xCb");
        uint256 ds = svm.createUint256("rt2c_ds");
        vm.assume(xR <= MAX_EXEC && xCb <= MAX_EXEC);

        (uint256 T, uint256 K) = quoter.calculateTwoWayFeeRequiredInLocalToken(
            _toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, 0, 0, xR, xCb, P
        );

        _configure(cl, cr, lp, rp, P);
        (uint256 tg, uint256 cg) = fm.validateAndPrepareTwoWayFees(ds, T + K, K);
        assert(tg >= uint256(cr.constantFee) + xR);
        assert(cg >= uint256(cl.constantFee) + xCb);
    }

    /// P-RT1: one-way round-trip (target leg only; the quote's target fee stands alone).
    function check_RT1_variableConfigs() public {
        LibFeeStorage.FeeConfig memory cl = _variableCfg("l");
        LibFeeStorage.FeeConfig memory cr = _variableCfg("r");
        (uint256 lp, uint256 rp, uint256 P) = _pricesAndGasPrice("rt1");

        uint256 sR = svm.createUint256("rt1_sR");
        uint256 ds = svm.createUint256("rt1_ds");
        uint256 xR = svm.createUint256("rt1_xR");
        vm.assume(sR <= MAX_SIZE && ds <= MAX_SIZE && xR <= MAX_EXEC);
        vm.assume(ds <= sR); // H2

        (uint256 T,) = quoter.calculateTwoWayFeeRequiredInLocalToken(
            _toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, sR, 0, xR, 0, P
        );

        _configure(cl, cr, lp, rp, P);
        uint256 tg = fm.validateAndPrepareOneWayFees(ds, T);
        assert(tg >= fm.expectedMinFee(sR, cr) + xR);
    }

    /// P-RT2-neg: the documented quote/validate size asymmetry (H1 dropped) is a REAL
    /// hazard — concrete counterexample must revert CallbackFeeTooLow.
    function check_RT2neg_sizeAsymmetryHazard_concrete() public {
        LibFeeStorage.FeeConfig memory cl = LibFeeStorage.FeeConfig(0, 800, 100_000, 256, 5000, 32768, 25_000_000, 1, 1);
        LibFeeStorage.FeeConfig memory cr = cl;
        // Honest quote for a 0-byte callback...
        (uint256 T, uint256 K) =
            quoter.calculateTwoWayFeeRequiredInLocalToken(_toQuoterCfg(cl), _toQuoterCfg(cr), 1, 1, 8192, 0, 0, 0, 1);
        _configure(cl, cr, 1, 1, 1);
        // ...validated against an 8192-byte send payload: must be rejected.
        (bool ok,) = address(fm).call(
            abi.encodeCall(FeeManager.validateAndPrepareTwoWayFees, (8192, T + K, K))
        );
        assert(!ok);
    }

    // ─── P-MONO-V: more money never hurts ─────────────────────────────────────

    function check_MONOV_moreTotalFeeNeverHurts() public {
        LibFeeStorage.FeeConfig memory cl = _variableCfg("l");
        LibFeeStorage.FeeConfig memory cr = _variableCfg("r");
        (uint256 lp, uint256 rp, uint256 P) = _pricesAndGasPrice("mono");
        uint256 fTot = svm.createUint256("mono_Ftot");
        uint256 fCb = svm.createUint256("mono_Fcb");
        uint256 delta = svm.createUint256("mono_delta");
        uint256 ds = svm.createUint256("mono_ds");
        vm.assume(fTot < 2 ** 119 && delta < 2 ** 119 && ds <= MAX_SIZE);
        vm.assume(fCb >= 1 && fCb <= fTot);

        _configure(cl, cr, lp, rp, P);
        try fm.validateAndPrepareTwoWayFees(ds, fTot, fCb) returns (uint256 tg, uint256 cg) {
            (uint256 tg2, uint256 cg2) = fm.validateAndPrepareTwoWayFees(ds, fTot + delta, fCb);
            assert(tg2 >= tg);
            assert(cg2 == cg);
        } catch {}
    }

    // ─── P-SOLV: protocol never oversold (Group C) ────────────────────────────

    /// Domain per SPEC §4: F_tot, F_cb <= 2^119 with lp, rp <= 1e36 keeps every mulDiv
    /// product < 2^256 (binding term: conv(·)·mul_r < 2^239·2^16 = 2^255).
    function check_SOLV_targetAndCallbackLegs() public {
        LibFeeStorage.FeeConfig memory cl = _variableCfg("l");
        LibFeeStorage.FeeConfig memory cr = _variableCfg("r");
        (uint256 lp, uint256 rp, uint256 P) = _pricesAndGasPrice("solv");
        uint256 fTot = svm.createUint256("solv_Ftot");
        uint256 fCb = svm.createUint256("solv_Fcb");
        uint256 ds = svm.createUint256("solv_ds");
        vm.assume(fTot < 2 ** 119 && ds <= MAX_SIZE);
        vm.assume(fCb >= 1 && fCb <= fTot);

        _configure(cl, cr, lp, rp, P);
        try fm.validateAndPrepareTwoWayFees(ds, fTot, fCb) returns (uint256 tg, uint256 cg) {
            // P-SOLV-T: tg·P·rp·div_r <= (F_tot − F_cb)·lp·mul_r
            assert(tg * P * rp * uint256(cr.gasPriceDiv) <= (fTot - fCb) * lp * uint256(cr.gasPriceMul));
            // P-SOLV-C: cg·P·div_l <= F_cb·mul_l
            assert(cg * P * uint256(cl.gasPriceDiv) <= fCb * uint256(cl.gasPriceMul));
        } catch {}
    }

    // ─── P-BUD: execution budget bounds ───────────────────────────────────────

    function check_BUD_budgetBounds() public {
        LibFeeStorage.FeeConfig memory cl = _variableCfg("l");
        LibFeeStorage.FeeConfig memory cr = _variableCfg("r");
        _configure(cl, cr, 1, 1, 1);
        uint256 F = svm.createUint256("bud_F");
        vm.assume(F < 2 ** 128);
        uint256 budget = fm.localRequestExecutionBudget(F);
        assert(budget <= F);
        uint256 errorBuffer = uint256(cl.errorLength) * uint256(cl.gasPerByte);
        assert(budget == (F > errorBuffer ? F - errorBuffer : 0));
    }

    function check_BUD_constantBranchPassthrough() public {
        LibFeeStorage.FeeConfig memory cl = _constantCfg("l");
        LibFeeStorage.FeeConfig memory cr = _constantCfg("r");
        _configure(cl, cr, 1, 1, 1);
        uint256 F = svm.createUint256("budc_F");
        assert(fm.localRequestExecutionBudget(F) == F);
    }

    // ─── P-REF: reference gas price pinned exactly to P (observational) ───────

    /// With cf=1, mul=div=1, lp=rp=1: one-way validate returns floor(F/P_v).
    /// floor(P/P_v) == 1  ∧  floor((2P−1)/P_v) == 1  ⟺  P_v == P (integers).
    /// Symbolic P spans both clamp branches (P vs DEFAULT_GAS_PRICE = 2e9).
    function check_REF_gasPricePinnedExactly() public {
        LibFeeStorage.FeeConfig memory one = LibFeeStorage.FeeConfig(1, 0, 0, 0, 0, 32768, 25_000_000, 1, 1);
        uint256 P = svm.createUint256("ref_P");
        vm.assume(P >= 1 && P <= MAX_GASPRICE);
        _configure(one, one, 1, 1, P);
        uint256 tg1 = fm.validateAndPrepareOneWayFees(0, P);
        assert(tg1 == 1); // P_v <= P
        uint256 tg2 = fm.validateAndPrepareOneWayFees(0, 2 * P - 1);
        assert(tg2 == 1); // P_v >= P
    }

    // ─── P-CFG0: unconfigured storage can never be accepted ───────────────────

    /// State (a): fully zero storage — reverts (OracleNotConfigured) for EVERY input.
    function check_CFG0_zeroStorageAlwaysReverts() public {
        FeeManager fresh = new FeeManager();
        uint256 ds = svm.createUint256("cfg0a_ds");
        uint256 fTot = svm.createUint256("cfg0a_Ftot");
        uint256 fCb = svm.createUint256("cfg0a_Fcb");
        (bool ok2,) =
            address(fresh).call(abi.encodeCall(FeeManager.validateAndPrepareTwoWayFees, (ds, fTot, fCb)));
        assert(!ok2);
        (bool ok1,) = address(fresh).call(abi.encodeCall(FeeManager.validateAndPrepareOneWayFees, (ds, fTot)));
        assert(!ok1);
    }

    /// State (b): oracle + nonzero prices set, fee templates still zero — reverts for
    /// EVERY input (zero-denominator panic in _applyGasPriceSkew, or earlier guards).
    function check_CFG0_zeroTemplatesAlwaysRevert() public {
        FeeManager fresh = new FeeManager();
        MockPriceOracle o = new MockPriceOracle();
        uint256 lp = svm.createUint256("cfg0b_lp");
        uint256 rp = svm.createUint256("cfg0b_rp");
        vm.assume(lp >= 1 && lp <= MAX_PRICE && rp >= 1 && rp <= MAX_PRICE);
        o.setPrices(lp, rp);
        fresh.setPriceOracle(address(o));
        uint256 ds = svm.createUint256("cfg0b_ds");
        uint256 fTot = svm.createUint256("cfg0b_Ftot");
        uint256 fCb = svm.createUint256("cfg0b_Fcb");
        vm.assume(fTot < 2 ** 119 && fCb < 2 ** 119);
        (bool ok2,) =
            address(fresh).call(abi.encodeCall(FeeManager.validateAndPrepareTwoWayFees, (ds, fTot, fCb)));
        assert(!ok2);
        (bool ok1,) = address(fresh).call(abi.encodeCall(FeeManager.validateAndPrepareOneWayFees, (ds, fTot)));
        assert(!ok1);
    }

    // ─── P-CFG: validated configs give positive, well-defined fee terms ───────

    function check_CFG_expectedMinFeeAtLeastOne_variable() public view {
        LibFeeStorage.FeeConfig memory c = _variableCfg("cfg");
        uint256 s = svm.createUint256("cfg_s");
        vm.assume(s < 2 ** 64);
        assert(fm.expectedMinFee(s, c) >= 1);
    }

    function check_CFG_expectedMinFeeAtLeastOne_constant() public view {
        LibFeeStorage.FeeConfig memory c = _constantCfg("cfgc");
        uint256 s = svm.createUint256("cfgc_s");
        assert(fm.expectedMinFee(s, c) >= 1);
    }
}
