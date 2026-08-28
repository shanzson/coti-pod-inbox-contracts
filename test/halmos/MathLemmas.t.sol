// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SymTest} from "halmos-cheatcodes/SymTest.sol";
import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FeeManager} from "../../contracts/fee/FeeManager.sol";
import {LibFeeStorage} from "../../contracts/fee/LibFeeStorage.sol";

/// @title MathLemmas — SPEC.md §1 (L1–L5)
/// @dev Lemmas verified through the exact OZ Math library the production code links.
///      Domains keep every mulDiv product below 2^256 (high==0 fast path) per SPEC §1's
///      domain note; these domains cover everything the fee pipeline reaches inside its
///      own no-overflow envelope (P-CFG-NR).
contract MathLemmasTest is SymTest, Test {
    FeeManager internal fm;

    function setUp() public {
        fm = new FeeManager();
    }

    /// L1 (skew pair): floor(ceil(x·d/m)·m/d) >= x with uint16 mul/div as in FeeConfig.
    function check_L1_skewPair(uint224 x, uint16 m, uint16 d) public pure {
        vm.assume(m >= 1 && d >= 1);
        uint256 y = Math.mulDiv(x, d, m, Math.Rounding.Ceil); // y <= x*d < 2^240
        uint256 back = Math.mulDiv(y, m, d); // y*m <= x*d + m < 2^256
        assert(back >= x);
    }

    /// L1 (currency pair): same lemma with wide numerator/denominator (lp, rp < 2^120).
    function check_L1_currencyPair(uint128 x, uint120 m, uint120 d) public pure {
        vm.assume(m >= 1 && d >= 1);
        uint256 y = Math.mulDiv(x, d, m, Math.Rounding.Ceil); // y <= x*d/m + 1
        uint256 back = Math.mulDiv(y, m, d); // y*m <= x*d + m < 2^248 + 2^120
        assert(back >= x);
    }

    /// L2: inline (x*d + m - 1)/m equals mulDiv(x, d, m, Ceil) on the inline form's
    /// non-reverting domain (both skew-shaped and currency-shaped instantiations).
    function check_L2_inlineCeilIdentity_skew(uint240 x, uint16 d, uint16 m) public pure {
        vm.assume(m >= 1);
        uint256 inlineCeil = (uint256(x) * uint256(d) + m - 1) / m; // < 2^256, no revert
        uint256 ozCeil = Math.mulDiv(x, d, m, Math.Rounding.Ceil);
        assert(inlineCeil == ozCeil);
    }

    function check_L2_inlineCeilIdentity_currency(uint128 x, uint120 d, uint120 m) public pure {
        vm.assume(m >= 1);
        uint256 inlineCeil = (uint256(x) * uint256(d) + m - 1) / m; // x*d < 2^248
        uint256 ozCeil = Math.mulDiv(x, d, m, Math.Rounding.Ceil);
        assert(inlineCeil == ozCeil);
    }

    /// L3: the buffer factor never deflates: floor(u·(10000+br)/10000) >= u.
    function check_L3_bufferInflationary(uint128 u, uint32 br) public pure {
        uint256 buffed = uint256(u) * (10000 + uint256(br)) / 10000; // u*(1e4+2^32) < 2^162
        assert(buffed >= u);
    }

    /// L4: E(s, C) monotone non-decreasing in s (real expectedMinFee bytecode).
    function check_L4_expectedMinFeeMonotone(
        uint64 s1,
        uint64 s2,
        uint32 cf,
        uint32 g,
        uint32 cbg,
        uint32 el,
        uint32 br
    ) public view {
        vm.assume(s1 <= s2);
        LibFeeStorage.FeeConfig memory c = _cfg(cf, g, cbg, el, br);
        // s2*g < 2^96, gasUnits < 2^97, * (1e4 + 2^32) < 2^131: no overflow-revert.
        uint256 e1 = fm.expectedMinFee(s1, c);
        uint256 e2 = fm.expectedMinFee(s2, c);
        assert(e1 <= e2);
    }

    /// L5: floor-chain value bound — skew(conv(floor(F/P)))·P·rp·div <= F·lp·mul.
    /// Domain mirrors the P-SOLV encoding domain (F < 2^119, prices < 2^120, P < 2^50).
    function check_L5_floorChainValueBound(
        uint120 F,
        uint48 P,
        uint120 lp,
        uint120 rp,
        uint16 mul_,
        uint16 div_
    ) public pure {
        vm.assume(P >= 1 && lp >= 1 && rp >= 1 && mul_ >= 1 && div_ >= 1);
        vm.assume(F < 2 ** 119);
        uint256 w1 = uint256(F) / P;
        uint256 w2 = Math.mulDiv(w1, lp, rp); // w1*lp < 2^119 * 2^120 = 2^239
        uint256 w3 = Math.mulDiv(w2, mul_, div_); // w2 <= w1*lp/rp < 2^239; *mul < 2^255
        // Property (slack 0): w3*P*rp*div <= F*lp*mul. Each LHS partial product is
        // bounded by the RHS (< 2^255) whenever the property holds; a violation big
        // enough to overflow reverts, which is also a failure.
        assert(w3 * P * rp * div_ <= uint256(F) * lp * mul_);
    }

    function _cfg(uint32 cf, uint32 g, uint32 cbg, uint32 el, uint32 br)
        internal
        pure
        returns (LibFeeStorage.FeeConfig memory)
    {
        return LibFeeStorage.FeeConfig({
            constantFee: cf,
            gasPerByte: g,
            callbackExecutionGas: cbg,
            errorLength: el,
            bufferRatioX10000: br,
            maxMethodCallBytes: 32768,
            maxExecutionGas: 25_000_000,
            gasPriceMul: 1,
            gasPriceDiv: 1
        });
    }
}
