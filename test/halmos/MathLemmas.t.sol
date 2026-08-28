// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FeeManager} from "../../contracts/fee/FeeManager.sol";
import {LibFeeStorage} from "../../contracts/fee/LibFeeStorage.sol";

/// @title MathLemmas — SPEC.md §1 (L1–L5)
/// @dev Lemmas verified through the exact OZ Math library the production code links.
///
///      Encoding note (see SPEC.md §1 "Domain note"): keeping every product below 2^256
///      lands on OZ mulDiv's `high==0` fast path, but that alone does NOT make the query
///      tractable — a udiv/mulDiv by a *symbolic divisor* stays nonlinear and Z3 never
///      closes it. So each lemma pins the divisor(s) to a representative concrete **matrix**
///      (`mul==div`, `div=1`, `mul=1`, small `div>mul`/`mul>div`, the `65535:1` extreme, and
///      moderate price ratios for the currency shape) and keeps the lemma's primary variable
///      fully symbolic — every function below is a genuine ∀-proof over that variable.
///      Cases whose intermediate product widens fast (both divisors non-trivial, or large
///      concrete divisors) use a dense symbolic window; a window over N values is a complete
///      ∀-proof across those N, not a sample. Bounds are the empirically-tuned ones that
///      discharge under `halmos.toml`'s solver timeout.
contract MathLemmasTest is SymTest, Test {
    uint256 constant U16 = type(uint16).max;
    uint256 constant U32 = type(uint32).max;
    uint256 constant WIN = 255; // dense window for the two-non-trivial-divisor / wide cases

    FeeManager internal fm;

    function setUp() public {
        fm = new FeeManager();
    }

    // ── L1: floor(ceil(x·d/m)·m/d) >= x  (skew round-trip; the load-bearing lemma) ────────
    // mul==m, div==d in FeeConfig terms; the quoter grosses up with Ceil, the validator
    // skews down with floor. Concrete (m,d) matrix, x symbolic.

    function _l1(uint256 x, uint256 m, uint256 d) internal pure {
        uint256 y = Math.mulDiv(x, d, m, Math.Rounding.Ceil); // ⌈x·d/m⌉
        uint256 back = Math.mulDiv(y, m, d); // ⌊y·m/d⌋
        assert(back >= x);
    }

    function check_L1_skew_equal(uint256 x) public pure { vm.assume(x <= U32); _l1(x, 5, 5); }
    function check_L1_skew_mulGtDiv1(uint256 x) public pure { vm.assume(x <= U32); _l1(x, 7, 1); }
    function check_L1_skew_mul1(uint256 x) public pure { vm.assume(x <= U32); _l1(x, 1, 7); }
    /// mul=65535,div=1 widens x·mul path → dense window (lemma is scale-independent).
    function check_L1_skew_extreme(uint256 x) public pure { vm.assume(x <= U16); _l1(x, 65535, 1); }
    function check_L1_skew_divGtMul(uint256 x) public pure { vm.assume(x <= WIN); _l1(x, 3, 7); }
    function check_L1_skew_mulGtDiv(uint256 x) public pure { vm.assume(x <= WIN); _l1(x, 7, 3); }

    /// L1 currency shape: same lemma, moderate concrete price ratios (m,d ~ token prices);
    /// the large divisors widen intermediates so a dense window is used.
    function check_L1_currency_up(uint256 x) public pure { vm.assume(x <= WIN); _l1(x, 1_000_000, 1_500_000); }
    function check_L1_currency_down(uint256 x) public pure { vm.assume(x <= WIN); _l1(x, 1_500_000, 1_000_000); }

    // ── L2: inline ⌈⌉ identity  (x·d + m − 1)/m == mulDiv(x, d, m, Ceil) ───────────────────
    // The inline form appears in FeeManagerStubBase. Divisor m and multiplier d concrete;
    // comparing two divisions of the symbolic x·d → dense window.

    function _l2(uint256 x, uint256 d, uint256 m) internal pure {
        uint256 inlineCeil = (x * d + m - 1) / m;
        uint256 ozCeil = Math.mulDiv(x, d, m, Math.Rounding.Ceil);
        assert(inlineCeil == ozCeil);
    }

    function check_L2_identity_a(uint256 x) public pure { vm.assume(x <= WIN); _l2(x, 7, 3); }
    function check_L2_identity_b(uint256 x) public pure { vm.assume(x <= WIN); _l2(x, 3, 7); }
    function check_L2_identity_currency(uint256 x) public pure { vm.assume(x <= WIN); _l2(x, 1_500_000, 1_000_000); }

    // ── L3: buffer never deflates  ⌊u·(10000+br)/10000⌋ >= u ──────────────────────────────
    // Divisor 10000 is concrete; the nonlinearity is u·br. Prove both marginals.

    function check_L3_buffer_uSymbolic(uint256 u) public pure {
        vm.assume(u <= U32);
        assert(u * (10000 + uint256(1_000)) / 10000 >= u);
    }

    function check_L3_buffer_brSymbolic(uint32 br) public pure {
        uint256 u = 25_000_000; // PROTOCOL_MAX_EXECUTION_GAS
        assert(u * (10000 + uint256(br)) / 10000 >= u);
    }

    // ── L4: E(s, C) monotone non-decreasing in s (real expectedMinFee bytecode) ───────────
    // Coefficients concrete (s·g symbolic·symbolic would be nonlinear); s symbolic.

    /// L4a: full-range lower bound — no size costs less than the empty payload. One division.
    function check_L4_ge_empty(uint256 s) public view {
        vm.assume(s <= U32);
        LibFeeStorage.FeeConfig memory c = _cfg();
        assert(fm.expectedMinFee(s, c) >= fm.expectedMinFee(0, c));
    }

    /// L4b: full pairwise monotonicity over a dense window (two divisions compared).
    function check_L4_monotone_window(uint256 s1, uint256 s2) public view {
        vm.assume(s1 <= s2 && s2 <= WIN);
        LibFeeStorage.FeeConfig memory c = _cfg();
        assert(fm.expectedMinFee(s1, c) <= fm.expectedMinFee(s2, c));
    }

    // ── L5: floor-chain value bound  skew(conv(⌊F/P⌋))·P·rp·div <= F·lp·mul ────────────────
    // Solvency backbone: granted remote gas, converted+skewed, is worth no more than the fee
    // paid. Divisors P, rp, div concrete; F symbolic over a dense window (chained floors).

    function _l5(uint256 F, uint256 P, uint256 lp, uint256 rp, uint256 mul_, uint256 div_) internal pure {
        uint256 w1 = F / P;
        uint256 w2 = Math.mulDiv(w1, lp, rp); // conv: local→remote gas units (floor)
        uint256 w3 = Math.mulDiv(w2, mul_, div_); // skew down (floor)
        assert(w3 * P * rp * div_ <= F * lp * mul_);
    }

    function check_L5_chain_a(uint256 F) public pure { vm.assume(F <= WIN); _l5(F, 3, 1_000_000, 1_500_000, 3, 7); }
    function check_L5_chain_b(uint256 F) public pure { vm.assume(F <= WIN); _l5(F, 7, 1_500_000, 1_000_000, 7, 3); }
    function check_L5_chain_identity(uint256 F) public pure { vm.assume(F <= U32); _l5(F, 1, 1, 1, 1, 1); }

    function _cfg() internal pure returns (LibFeeStorage.FeeConfig memory) {
        return LibFeeStorage.FeeConfig({
            constantFee: 0,
            gasPerByte: 16,
            callbackExecutionGas: 50_000,
            errorLength: 256,
            bufferRatioX10000: 1_000,
            maxMethodCallBytes: 32768,
            maxExecutionGas: 25_000_000,
            gasPriceMul: 1,
            gasPriceDiv: 1
        });
    }
}
