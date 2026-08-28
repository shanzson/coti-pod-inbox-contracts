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
    // Encoding note: the validate/quote pipeline divides by the config's gasPriceMul/Div, by the
    // token prices, and by the reference gas price. With any of those SYMBOLIC, OZ mulDiv's
    // symbolic-divisor path is never closed by Z3 (SPEC §1 domain note). So the round-trip /
    // solvency / monotonicity properties below pin the config, prices, and gas price to
    // representative concrete values and keep the economic inputs (sizes, exec gas, fee amounts)
    // symbolic over dense windows — each a genuine ∀-proof over those inputs for that config.
    // Pure revert/observational properties (CFG0, REF, BUD) keep wider symbolic domains.
    uint256 internal constant MAX_PRICE = 1e36; // < 2^120
    uint256 internal constant MAX_GASPRICE = 1e15; // < 2^50
    uint256 internal constant MAX_SIZE = 255; // dense window (payload size feeds a buffer division)
    uint256 internal constant MAX_EXEC = 255; // dense window (exec gas feeds the skew/price mulDivs)
    uint256 internal constant MAX_BR = 10_000; // P-CFG-NR hypothesis
    // Representative concrete environment shared by the pinned encodings.
    uint256 internal constant LP = 1_000_000;
    uint256 internal constant RP = 1_500_000;
    uint256 internal constant GP = 1e9;

    FeeManager internal fm;
    MockPriceOracle internal oracle;
    InboxFeeQuoter internal quoter;

    function setUp() public {
        fm = new FeeManager();
        oracle = new MockPriceOracle();
        quoter = new InboxFeeQuoter();
    }

    // ─── config builders (assumes mirror _requireValidFeeConfig exactly) ─────

    /// Representative concrete variable-template config (see encoding note). `tag == "r"` yields
    /// a DISTINCT remote config from the local one so a localMin↔remoteMin leg-swap regression is
    /// observable (they differ in gasPerByte, coefficients, and mul/div).
    function _variableCfg(string memory tag) internal pure returns (LibFeeStorage.FeeConfig memory c) {
        if (_isRemote(tag)) {
            c = LibFeeStorage.FeeConfig(0, 24, 40_000, 200, 800, 32768, 25_000_000, 5, 9);
        } else {
            c = LibFeeStorage.FeeConfig(0, 16, 50_000, 256, 1_000, 32768, 25_000_000, 3, 7);
        }
    }

    /// Representative concrete constant-template config; local/remote distinct (see above).
    function _constantCfg(string memory tag) internal pure returns (LibFeeStorage.FeeConfig memory c) {
        if (_isRemote(tag)) {
            c = LibFeeStorage.FeeConfig(120_000, 0, 0, 0, 0, 32768, 25_000_000, 5, 9);
        } else {
            c = LibFeeStorage.FeeConfig(100_000, 0, 0, 0, 0, 32768, 25_000_000, 1, 1);
        }
    }

    function _isRemote(string memory tag) private pure returns (bool) {
        return keccak256(bytes(tag)) == keccak256(bytes("r"));
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

    /// Representative concrete prices + gas price (see encoding note).
    function _pricesAndGasPrice(string memory tag)
        internal
        pure
        returns (uint256 lp, uint256 rp, uint256 P)
    {
        tag;
        (lp, rp, P) = (LP, RP, GP);
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
    /// The round-trip is quote→validate (≈6 chained divisions), the heaviest query in the suite,
    /// so sizes are pinned (with ds == s so H1/H2 hold as equalities) and the exec-gas legs stay
    /// symbolic over a dense window — a genuine ∀-proof over the additive fee dimension.
    function check_RT2_variableConfigs() public {
        LibFeeStorage.FeeConfig memory cl = _variableCfg("l");
        LibFeeStorage.FeeConfig memory cr = _variableCfg("r");
        (uint256 lp, uint256 rp, uint256 P) = _pricesAndGasPrice("rt2");

        uint256 sR = 200;
        uint256 sCb = 200;
        uint256 ds = 200; // ds <= sCb, ds <= sR (H1, H2)
        // Heaviest query in the suite (quote→validate, both legs). Keep one exec-gas leg
        // symbolic over a dense window; pin the other so the two-way pipeline discharges.
        uint256 xR = svm.createUint256("rt2_xR");
        uint256 xCb = 20;
        vm.assume(xR <= 63);

        (uint256 T, uint256 K) = quoter.calculateTwoWayFeeRequiredInLocalToken(
            _toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, sR, sCb, xR, xCb, P
        );

        _configure(cl, cr, lp, rp, P);

        // Acceptance IS half the property — assert it explicitly (a bare direct call whose
        // rejection-revert would be pruned under default panic codes could pass vacuously).
        (bool ok, bytes memory ret) =
            address(fm).call(abi.encodeCall(FeeManager.validateAndPrepareTwoWayFees, (ds, T + K, K)));
        assert(ok);
        (uint256 tg, uint256 cg) = abi.decode(ret, (uint256, uint256));

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
        (bool ok, bytes memory ret) =
            address(fm).call(abi.encodeCall(FeeManager.validateAndPrepareTwoWayFees, (ds, T + K, K)));
        assert(ok); // acceptance asserted explicitly
        (uint256 tg, uint256 cg) = abi.decode(ret, (uint256, uint256));
        assert(tg >= uint256(cr.constantFee) + xR);
        assert(cg >= uint256(cl.constantFee) + xCb);
    }

    /// P-RT1: one-way round-trip (target leg only; the quote's target fee stands alone).
    function check_RT1_variableConfigs() public {
        LibFeeStorage.FeeConfig memory cl = _variableCfg("l");
        LibFeeStorage.FeeConfig memory cr = _variableCfg("r");
        (uint256 lp, uint256 rp, uint256 P) = _pricesAndGasPrice("rt1");

        uint256 sR = 200;
        uint256 ds = 200; // ds <= sR (H2)
        uint256 xR = svm.createUint256("rt1_xR");
        vm.assume(xR <= 63); // dense window over the additive exec-gas dimension

        (uint256 T,) = quoter.calculateTwoWayFeeRequiredInLocalToken(
            _toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, sR, 0, xR, 0, P
        );

        _configure(cl, cr, lp, rp, P);
        (bool ok, bytes memory ret) =
            address(fm).call(abi.encodeCall(FeeManager.validateAndPrepareOneWayFees, (ds, T)));
        assert(ok); // acceptance asserted explicitly
        uint256 tg = abi.decode(ret, (uint256));
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

    /// Gas price is pinned to 1 so raw fees map 1:1 to gas units, and the fee window sits in the
    /// ACCEPTING region (above the min-fee floor); the base validate is asserted to accept, so the
    /// monotonicity assertions can never be vacuously skipped by a swallowed rejection-revert.
    function check_MONOV_moreTotalFeeNeverHurts() public {
        LibFeeStorage.FeeConfig memory cl = _variableCfg("l");
        LibFeeStorage.FeeConfig memory cr = _variableCfg("r");
        uint256 ds = 100;
        uint256 fCb = 200_000; // >= min callback fee floor (~142952) for cl at ds=100
        uint256 fTot = 400_000; // fTot-fCb >= target floor (~137635); concrete base
        uint256 delta = svm.createUint256("mono_delta");
        vm.assume(delta <= 255); // symbolic increment — the ∀ dimension

        _configure(cl, cr, LP, RP, 1);
        (bool ok, bytes memory ret) =
            address(fm).call(abi.encodeCall(FeeManager.validateAndPrepareTwoWayFees, (ds, fTot, fCb)));
        assert(ok);
        (uint256 tg, uint256 cg) = abi.decode(ret, (uint256, uint256));

        (bool ok2, bytes memory ret2) =
            address(fm).call(abi.encodeCall(FeeManager.validateAndPrepareTwoWayFees, (ds, fTot + delta, fCb)));
        assert(ok2); // more total fee is still accepted
        (uint256 tg2, uint256 cg2) = abi.decode(ret2, (uint256, uint256));
        assert(tg2 >= tg); // extra total fee never lowers the target budget
        assert(cg2 == cg); // callback budget depends only on the (unchanged) callback fee
    }

    // ─── P-SOLV: protocol never oversold (Group C) ────────────────────────────

    /// Gas price pinned to 1; both fee legs symbolic over dense windows in the ACCEPTING region.
    /// The base validate is asserted to accept, so the solvency bounds are always evaluated (the
    /// old encoding's `fTot<2^16` domain was wholly rejecting → the asserts never ran).
    /// The underlying floor-chain bound is MathLemmas L5 (proven ∀).
    function check_SOLV_targetAndCallbackLegs() public {
        LibFeeStorage.FeeConfig memory cl = _variableCfg("l");
        LibFeeStorage.FeeConfig memory cr = _variableCfg("r");
        uint256 ds = 100;
        uint256 fCb = svm.createUint256("solv_Fcb");
        uint256 rem = svm.createUint256("solv_rem");
        vm.assume(fCb >= 200_000 && fCb <= 200_031); // >= callback floor
        vm.assume(rem >= 200_000 && rem <= 200_031); // remote slice >= target floor
        uint256 fTot = fCb + rem;

        _configure(cl, cr, LP, RP, 1);
        (bool ok, bytes memory ret) =
            address(fm).call(abi.encodeCall(FeeManager.validateAndPrepareTwoWayFees, (ds, fTot, fCb)));
        assert(ok);
        (uint256 tg, uint256 cg) = abi.decode(ret, (uint256, uint256));
        // P-SOLV-T: tg·P·rp·div_r <= (F_tot − F_cb)·lp·mul_r  (P == 1)
        assert(tg * RP * uint256(cr.gasPriceDiv) <= (fTot - fCb) * LP * uint256(cr.gasPriceMul));
        // P-SOLV-C: cg·P·div_l <= F_cb·mul_l
        assert(cg * uint256(cl.gasPriceDiv) <= fCb * uint256(cl.gasPriceMul));
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
        vm.assume(s < 2 ** 32);
        assert(fm.expectedMinFee(s, c) >= 1);
    }

    function check_CFG_expectedMinFeeAtLeastOne_constant() public view {
        LibFeeStorage.FeeConfig memory c = _constantCfg("cfgc");
        uint256 s = svm.createUint256("cfgc_s");
        assert(fm.expectedMinFee(s, c) >= 1);
    }
}
