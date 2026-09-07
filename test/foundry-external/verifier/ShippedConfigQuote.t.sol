// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
// Verifier-written cross-repo test (not from the gist): real Inbox + FeeManager + PriceOracle configured with the
// fee templates shipped in scripts/deploy-utils.ts (FEE_CONFIG_SEPOLIA_SIDE local, FEE_CONFIG_COTI_SIDE remote),
// driven by the real PodErc20Mintable through its own estimateFee() quote.
import {Test, console2} from "forge-std/Test.sol";
import {Inbox} from "../../../contracts/Inbox.sol";
import {FeeManager} from "../../../contracts/fee/FeeManager.sol";
import {FeeManagerStubBase} from "../../../contracts/fee/FeeManagerStubBase.sol";
import {PriceOracle} from "../../../contracts/fee/PriceOracle.sol";
import {MpcAbiReEncode} from "../../../contracts/MpcAbiReEncode.sol";
import {IInbox} from "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import {PodErc20Mintable} from "@coti-io/coti-contracts/contracts/pod/token/perc20/PodErc20Mintable.sol";
import {ctUint256, ctUint128, itUint256} from "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IMpcStub { function dummy() external; }

contract ShippedConfigQuote is Test {
    Inbox inbox;
    PodErc20Mintable pod;
    address owner = address(0x0FF1CE);
    uint256 constant LOCAL_CHAIN = 11155111; // sepolia
    uint256 constant COTI = 7082400;
    address constant PEER = address(0xC0715DE);
    uint256 constant GP = 2 gwei; // reference floor == DEFAULT_GAS_PRICE

    // scripts/deploy-utils.ts FEE_CONFIG_SEPOLIA_SIDE
    FeeManagerStubBase.FeeConfig SEPOLIA = FeeManagerStubBase.FeeConfig({
        constantFee: 0, gasPerByte: 800, callbackExecutionGas: 100_000, errorLength: 256,
        bufferRatioX10000: 5000, maxMethodCallBytes: 8192, maxExecutionGas: 5_000_000,
        gasPriceMul: 1, gasPriceDiv: 1
    });
    // scripts/deploy-utils.ts FEE_CONFIG_COTI_SIDE (constantFee == maxExecutionGas == PROTOCOL_MAX_EXECUTION_GAS)
    FeeManagerStubBase.FeeConfig COTI_SIDE = FeeManagerStubBase.FeeConfig({
        constantFee: 25_000_000, gasPerByte: 0, callbackExecutionGas: 0, errorLength: 0,
        bufferRatioX10000: 0, maxMethodCallBytes: 8192, maxExecutionGas: 25_000_000,
        gasPriceMul: 1, gasPriceDiv: 1
    });

    function _deploy(FeeManagerStubBase.FeeConfig memory local, FeeManagerStubBase.FeeConfig memory remote) internal { _deployP(local, remote, 3000e18, 5e16); }
    function _deployP(FeeManagerStubBase.FeeConfig memory local, FeeManagerStubBase.FeeConfig memory remote, uint256 lp, uint256 rp) internal {
        // MPC precompile stub from the gist (coti-contracts side) so itUint256 inputs can be validated/onboarded.
        vm.etch(address(0x64), _stubCode());
        MpcAbiReEncode reEnc = new MpcAbiReEncode();
        FeeManager fm = new FeeManager();
        inbox = new Inbox();
        vm.prank(owner);
        inbox.init(owner, LOCAL_CHAIN, address(reEnc), address(fm));
        PriceOracle oracle = new PriceOracle(owner);
        vm.startPrank(owner);
        oracle.setInboxTokens(address(0xA11CE), address(0xB0BB1E));
        oracle.setLocalTokenPriceUSD(lp);
        oracle.setRemoteTokenPriceUSD(rp);
        inbox.setPriceOracle(address(oracle));
        inbox.setGasPriceBounds(0, GP, GP); // pin the reference so only leg arithmetic is under test
        inbox.updateMinFeeConfigs(local, remote);
        vm.stopPrank();
        pod = new PodErc20Mintable(address(this), COTI, address(inbox), PEER, "p", "p");
        vm.deal(address(this), 1000 ether);
        vm.txGasPrice(GP); // estimateFee() quotes at tx.gasprice
    }

    function _stubCode() internal returns (bytes memory) {
        // deploy the gist MockMpcPrecompile via its creation code copied from ffB build artifacts is not available here;
        // fall back to the minimal behaviour PodERC20's send path needs: none (itUint256 is passed through raw).
        return hex"00";
    }

    function _it() internal pure returns (itUint256 memory it) {
        it.ciphertext = ctUint256({ciphertextHigh: ctUint128.wrap(1), ciphertextLow: ctUint128.wrap(2)});
        it.signature = new bytes(65);
    }

    /// Shipped templates as in deploy-utils.ts: the pToken's own quote (constantFee 25M + 300k remote exec) exceeds the
    /// remote maxExecutionGas (25M), so every send funded exactly by estimateFee() reverts FeeGasTooHigh.
    function test_shipped_estimateFee_mint_reverts_FeeGasTooHigh() public {
        _deploy(SEPOLIA, COTI_SIDE);
        (uint256 total, uint256 target, uint256 cb) = pod.estimateFee();
        console2.log("quote total/target/cb wei", total, target, cb);
        vm.expectRevert(abi.encodeWithSelector(FeeManagerStubBase.FeeGasTooHigh.selector, 25_320_000, 25_000_000));
        pod.mint{value: total}(address(0xBEEF), 100, cb);
    }

    /// Same templates: a send that omits the +300k remote execution add-on is accepted -> the add-on is the cause.
    function test_shipped_constantOnlyTargetLeg_accepted_only_with_1to1_prices() public {
        _deployP(SEPOLIA, COTI_SIDE, 1e18, 1e18); // test-style prices: ratio 1 -> exactly 25M units reachable
        (uint256 target, uint256 cb) = inbox.calculateTwoWayFeeRequiredInLocalToken(448, 512, 0, 300_000, GP);
        bytes32 id = pod.mint{value: target + cb}(address(0xBEEF), 100, cb);
        assertTrue(id != bytes32(0), "constant-only target leg accepted at 1:1 prices");
        // but the pToken's own quote (+300k remote exec) still overshoots the cap
        (uint256 total, , uint256 cb2) = pod.estimateFee();
        vm.expectRevert(abi.encodeWithSelector(FeeManagerStubBase.FeeGasTooHigh.selector, 25_300_000, 25_000_000));
        pod.mint{value: total}(address(0xBEEF), 100, cb2);
    }

    /// Realistic prices (ETH $3000, COTI $0.05 -> ratio 60,000): units = floor(k*60000) for k = remote wei / gasPrice.
    /// 25,000,000 is not a multiple of 60,000, so NO payment satisfies min == max == 25M: every k is either
    /// TargetFeeTooLow or FeeGasTooHigh. Sweep k across the boundary to prove there is no admissible value.
    function test_shipped_realisticPrices_noAdmissibleTargetPayment() public {
        _deploy(SEPOLIA, COTI_SIDE);
        (, uint256 cb) = inbox.calculateTwoWayFeeRequiredInLocalToken(448, 512, 0, 300_000, GP);
        for (uint256 k = 400; k <= 430; k++) {
            uint256 targetWei = k * GP;
            (bool ok, bytes memory ret) = address(pod).call{value: targetWei + cb}(
                abi.encodeWithSignature("mint(address,uint256,uint256)", address(0xBEEF), uint256(100), cb)
            );
            assertFalse(ok, "some k was accepted");
            bytes4 sel; assembly { sel := mload(add(ret, 32)) }
            assertTrue(sel == FeeManagerStubBase.TargetFeeTooLow.selector || sel == FeeManagerStubBase.FeeGasTooHigh.selector, "unexpected revert");
        }
    }

    /// Give the target leg headroom (constantFee 20M < maxExec 25M) to isolate the callback-leg size mismatch:
    /// public transfer (544-byte request) funded by estimateFee() succeeds, encrypted transfer (768 bytes) reverts
    /// CallbackFeeTooLow, transferFrom encrypted (864 bytes) reverts too.
    function test_callbackLeg_encryptedTransfer_reverts_CallbackFeeTooLow() public {
        FeeManagerStubBase.FeeConfig memory remote = COTI_SIDE;
        remote.constantFee = 20_000_000;
        _deploy(SEPOLIA, remote);
        (uint256 total, , uint256 cb) = pod.estimateFee();
        bytes32 id = pod.transfer{value: total}(address(0xF00D), 10, cb); // public, 544 bytes
        assertTrue(id != bytes32(0), "public transfer at exact quote accepted");
        // encrypted: 768 bytes -> floor 1.5*(800*768+100000+256*800)=1,378,800 > quoted 1,371,600
        vm.expectRevert(abi.encodeWithSelector(FeeManagerStubBase.CallbackFeeTooLow.selector, 1_371_600));
        pod.transfer{value: total}(address(0xF00D), _it(), cb);
        // auto-fee overload (no cb param) uses the same 512-byte heuristic split
        vm.expectRevert(abi.encodeWithSelector(FeeManagerStubBase.CallbackFeeTooLow.selector, 1_371_600));
        pod.transfer{value: total}(address(0xF00D), _it());
        vm.expectRevert(abi.encodeWithSelector(FeeManagerStubBase.CallbackFeeTooLow.selector, 1_371_600));
        pod.transferFrom{value: total}(address(0xCAFE), address(0xF00D), _it(), cb);
    }

    /// Exact testnet spot prices from scripts/deploy-utils.ts (TESTNET_ETH_USD=2103.41, TESTNET_COTI_USD=0.01272522):
    /// ratio ~165,296.9 -> units jump in steps of ~165k, so 25,000,000 exactly is unreachable for two-way AND one-way
    /// sends. k=151 -> 24,959,832 (TargetFeeTooLow); k=152 -> 25,125,129 (FeeGasTooHigh).
    function test_shipped_testnetPrices_noAdmissiblePayment_twoWay_and_oneWay() public {
        _deployP(SEPOLIA, COTI_SIDE, 2103.41e18, 0.01272522e18);
        (, uint256 cb) = inbox.calculateTwoWayFeeRequiredInLocalToken(448, 512, 0, 300_000, GP);
        IInbox.MpcMethodCall memory mc;
        mc.data = new bytes(100);
        for (uint256 k = 140; k <= 165; k++) {
            (bool ok, bytes memory ret) = address(pod).call{value: k * GP + cb}(
                abi.encodeWithSignature("mint(address,uint256,uint256)", address(0xBEEF), uint256(100), cb)
            );
            assertFalse(ok, "two-way: some k accepted");
            bytes4 sel; assembly { sel := mload(add(ret, 32)) }
            assertTrue(sel == FeeManagerStubBase.TargetFeeTooLow.selector || sel == FeeManagerStubBase.FeeGasTooHigh.selector, "two-way: unexpected revert");
            // one-way (what PrivacyPortalFactory.createPortal uses to register the token on COTI)
            (bool ok1, bytes memory ret1) = address(inbox).call{value: k * GP}(
                abi.encodeWithSelector(inbox.sendOneWayMessage.selector, COTI, PEER, mc, bytes4(0))
            );
            assertFalse(ok1, "one-way: some k accepted");
            bytes4 sel1; assembly { sel1 := mload(add(ret1, 32)) }
            assertTrue(sel1 == FeeManagerStubBase.TargetFeeTooLow.selector || sel1 == FeeManagerStubBase.FeeGasTooHigh.selector, "one-way: unexpected revert");
        }
        // sanity: the boundary really is between k=151 and k=152 (units below / above the single admissible value)
        (uint256 t151,) = _units(151); (uint256 t152,) = _units(152);
        console2.log("units at k=151 / k=152", t151, t152);
        assertLt(t151, 25_000_000); assertGt(t152, 25_000_000);
    }
    function _units(uint256 k) internal pure returns (uint256 u, uint256) {
        u = k * 2103.41e18 / 0.01272522e18; // floor, same as Math.mulDiv(k, lP, rP)
        return (u, 0);
    }
}
