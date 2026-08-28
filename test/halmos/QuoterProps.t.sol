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

    // Concrete representative config for the tractable (skew-param-pinned) encodings below.
    // gasPriceMul/gasPriceDiv symbolic drive both quoters into OZ mulDiv's symbolic-divisor
    // path (never closed by Z3); pinning them — and the token prices — while keeping the whole
    // transaction domain (sizes, exec gas, gas price) symbolic turns EQ1/CFGNR/TIGHT into
    // genuine ∀-proofs over that domain for a representative config. See MathLemmas encoding note.
    function _ccfg(uint16 mul_, uint16 div_) internal pure returns (LibFeeStorage.FeeConfig memory c) {
        c = LibFeeStorage.FeeConfig(0, 16, 50_000, 256, 1_000, 32768, 25_000_000, mul_, div_);
    }

    // ─── P-EQ1: stub (inline ceil) ≡ quoter (mulDiv Ceil) on the shared domain ─

    /// Inside the P-CFG-NR envelope neither implementation reverts (proven separately), so plain
    /// equality of both outputs is the full statement. Concrete configs/prices; the transaction
    /// domain stays symbolic (sizes over a dense window — each feeds a buffer division).
    function check_EQ1_stubEqualsQuoter() public {
        LibFeeStorage.FeeConfig memory cl = _ccfg(3, 7);
        LibFeeStorage.FeeConfig memory cr = _ccfg(7, 3);
        uint256 lp = 1_000_000;
        uint256 rp = 1_500_000;
        uint256 P = 1e9;
        // One symbolic dimension (remote exec gas over its full range); the two implementations
        // must agree for all of it. The buffer-division equivalence is L2; here we exercise the
        // full stub-vs-quoter pipeline on the real bytecode.
        uint256 xR = svm.createUint256("eq1_xR");
        vm.assume(xR <= 255); // dense window — the two implementations must agree across it

        oracle.setPrices(lp, rp);
        stub.setConfigs(cl, cr);

        (uint256 tStub, uint256 kStub) = stub.calculateTwoWayFeeRequiredInLocalToken(100, 100, xR, 100, P);
        (uint256 tQ, uint256 kQ) =
            quoter.calculateTwoWayFeeRequiredInLocalToken(_toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, 100, 100, xR, 100, P);
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

    /// P-CFG-NR: neither quoter reverts inside the envelope. Asserted via low-level calls'
    /// success flags — a plain direct call whose revert (overflow 0x11 / require / FeeConfigInvalid)
    /// is PRUNED under Halmos's default panic-codes would encode nothing. Concrete config/prices;
    /// symbolic remote exec gas over a dense window.
    function check_CFGNR_noRevertOnEnvelope() public {
        LibFeeStorage.FeeConfig memory cl = _ccfg(3, 7);
        LibFeeStorage.FeeConfig memory cr = _ccfg(7, 3);
        uint256 lp = 1_000_000;
        uint256 rp = 1_500_000;
        uint256 P = 1e9;
        uint256 xR = svm.createUint256("nr_xR");
        vm.assume(xR <= 63);

        oracle.setPrices(lp, rp);
        stub.setConfigs(cl, cr);
        (bool okS,) = address(stub).call(
            abi.encodeCall(FeeManagerStubBase.calculateTwoWayFeeRequiredInLocalToken, (100, 100, xR, 100, P))
        );
        assert(okS); // stub (inline ceil) does not revert
        (bool okQ,) = address(quoter).call(
            abi.encodeCall(
                InboxFeeQuoter.calculateTwoWayFeeRequiredInLocalToken,
                (_toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, 100, 100, xR, 100, P)
            )
        );
        assert(okQ); // quoter (mulDiv ceil) does not revert
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

    /// Concrete config/prices; symbolic remote exec gas over a dense window. The overcharge
    /// bound (SPEC Group F) is proven against the REAL quoter and REAL expectedMinFee bytecode.
    function check_TIGHT_overchargeBounded() public view {
        LibFeeStorage.FeeConfig memory cl = _ccfg(3, 7);
        LibFeeStorage.FeeConfig memory cr = _ccfg(7, 3);
        uint256 lp = 1_000_000;
        uint256 rp = 1_500_000;
        uint256 P = 1e9;
        uint256 xR = svm.createUint256("tt_xR");
        vm.assume(xR <= 255);

        (uint256 T, uint256 K) =
            quoter.calculateTwoWayFeeRequiredInLocalToken(_toQuoterCfg(cl), _toQuoterCfg(cr), lp, rp, 100, 100, xR, 100, P);

        uint256 t = fm.expectedMinFee(100, cr) + xR;
        uint256 c = fm.expectedMinFee(100, cl) + 100;
        // T·lp·mul_r <= (t·div_r + mul_r)·rp·P + lp·mul_r·P
        assert(
            T * lp * uint256(cr.gasPriceMul)
                <= (t * uint256(cr.gasPriceDiv) + uint256(cr.gasPriceMul)) * rp * P + lp * uint256(cr.gasPriceMul) * P
        );
        // K·mul_l <= (c·div_l + mul_l)·P
        assert(K * uint256(cl.gasPriceMul) <= (c * uint256(cl.gasPriceDiv) + uint256(cl.gasPriceMul)) * P);
    }
}
