// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
// Verifier test: does a stale (but non-zero) oracle cache change the gas units a sender receives when the
// sender quotes on-chain from the same cache?  And what happens when the fee is sized from a *different* price?
import {Test, console2} from "forge-std/Test.sol";
import {Inbox} from "../../../contracts/Inbox.sol";
import {FeeManager} from "../../../contracts/fee/FeeManager.sol";
import {FeeManagerStubBase} from "../../../contracts/fee/FeeManagerStubBase.sol";
import {PoDPriceOracle} from "../../../contracts/fee/PoDPriceOracle.sol";
import {MpcAbiReEncode} from "../../../contracts/MpcAbiReEncode.sol";
import {IInbox} from "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import {IPodPriceOracle} from "@coti-io/coti-contracts/contracts/pod/privacy/IPodPriceOracle.sol";

/// Adapter that can be switched between live and dead (returns 0 = stale/failed per IPodPriceOracle contract).
contract SwitchableAdapter is IPodPriceOracle {
    mapping(address => uint256) public p; bool public dead;
    function set(address t, uint256 v) external { p[t] = v; }
    function kill(bool d) external { dead = d; }
    function getLivePrice(address t) external view returns (uint256) { return dead ? 0 : p[t]; }
    function getLivePrices(address a, address b) external view returns (uint256, uint256) { return dead ? (0, 0) : (p[a], p[b]); }
}

contract StalePriceCancellation is Test {
    Inbox inbox; PoDPriceOracle oracle; SwitchableAdapter feed;
    address owner = address(0x0FF1CE); address sender = address(0xA99);
    address LOCAL = address(0xA11CE); address REMOTE = address(0xB0BB1E);
    uint256 constant CHAIN = 11155111; uint256 constant COTI = 7082400; uint256 constant GP = 2 gwei;
    bytes4 constant CB = 0xAABBCCDD; bytes4 constant ERR = 0x11223344;

    FeeManagerStubBase.FeeConfig LOCALCFG = FeeManagerStubBase.FeeConfig({
        constantFee: 0, gasPerByte: 800, callbackExecutionGas: 100_000, errorLength: 256,
        bufferRatioX10000: 5000, maxMethodCallBytes: 8192, maxExecutionGas: 5_000_000, gasPriceMul: 1, gasPriceDiv: 1 });
    // COTI-side template with headroom (constant 20M < cap 25M) so the band is not degenerate
    FeeManagerStubBase.FeeConfig REMOTECFG = FeeManagerStubBase.FeeConfig({
        constantFee: 20_000_000, gasPerByte: 0, callbackExecutionGas: 0, errorLength: 0,
        bufferRatioX10000: 0, maxMethodCallBytes: 8192, maxExecutionGas: 25_000_000, gasPriceMul: 1, gasPriceDiv: 1 });

    function setUp() public {
        inbox = new Inbox();
        vm.prank(owner);
        inbox.init(owner, CHAIN, address(new MpcAbiReEncode()), address(new FeeManager()));
        feed = new SwitchableAdapter();
        feed.set(LOCAL, 3000e18); feed.set(REMOTE, 5e16); // ETH $3000, COTI $0.05
        oracle = new PoDPriceOracle(owner, address(feed), 300);
        vm.startPrank(owner);
        oracle.setInboxTokens(LOCAL, REMOTE);
        oracle.refreshCache(); // populate cache from the live feed
        inbox.setPriceOracle(address(oracle));
        inbox.setGasPriceBounds(0, GP, GP); // pin the reference gas price so only prices matter
        inbox.updateMinFeeConfigs(LOCALCFG, REMOTECFG);
        vm.stopPrank();
        vm.deal(sender, 1000 ether);
        vm.txGasPrice(GP);
    }

    function _mc() internal pure returns (IInbox.MpcMethodCall memory m) { m.data = new bytes(200); }

    function _send(uint256 targetWei, uint256 cbWei) internal returns (bool ok, bytes memory ret) {
        vm.prank(sender);
        (ok, ret) = address(inbox).call{value: targetWei + cbWei}(
            abi.encodeWithSelector(inbox.sendTwoWayMessage.selector, COTI, address(0xB0B), _mc(), CB, ERR, cbWei));
    }

    /// 1. Feed dies, 100 days pass, refresh keeps the old price (fail-open). A sender quoting on-chain from that
    ///    stale cache is ACCEPTED and receives exactly the quoted gas units — staleness cancels in the round trip.
    function test_staleCache_onChainQuote_unitsUnchanged() public {
        uint256 size = abi.encode(_mc()).length;
        (uint256 tFresh, uint256 cFresh) = inbox.calculateTwoWayFeeRequiredInLocalToken(size, size, 300_000, 0, GP);

        feed.kill(true);
        vm.warp(block.timestamp + 100 days);
        oracle.refreshCache(); // zero pull -> CacheRefreshLegFailed, previous value retained
        (,, uint256 lAt, uint256 rAt,) = oracle.getPricesUSDWithMeta();
        assertGt(block.timestamp - lAt, 99 days); assertGt(block.timestamp - rAt, 99 days);

        (uint256 tStale, uint256 cStale) = inbox.calculateTwoWayFeeRequiredInLocalToken(size, size, 300_000, 0, GP);
        assertEq(tStale, tFresh, "quote unchanged: same cache, same wei");
        (bool ok, bytes memory ret) = _send(tStale, cStale);
        assertTrue(ok, string(abi.encodePacked("stale-cache send rejected: ", ret)));
        bytes32 id = inbox.getRequestId(CHAIN, COTI, 1);
        uint256 units = inbox.getRequest(id).targetFee;
        console2.log("quoted target wei / units bought (100-day-stale cache)", tStale, units);
        assertGe(units, 20_000_000 + 300_000, "units >= quoted budget");
        assertLe(units, 25_000_000);
    }

    /// 2. Same stale cache; the fee is sized from a FRESHER price instead (what an off-chain quoter does).
    ///    Real COTI now 4x cheaper -> sender pays 1/4 -> TargetFeeTooLow. Real COTI 4x dearer -> FeeGasTooHigh.
    function test_staleCache_feeSizedFromFreshPrice_rejectsBothWays() public {
        uint256 size = abi.encode(_mc()).length;
        (uint256 tWei, uint256 cWei) = inbox.calculateTwoWayFeeRequiredInLocalToken(size, size, 300_000, 0, GP);
        feed.kill(true); vm.warp(block.timestamp + 100 days); oracle.refreshCache();

        (bool ok1, bytes memory r1) = _send(tWei / 4, cWei); // sender believes COTI is 4x cheaper than cache
        assertFalse(ok1); assertEq(bytes4(r1), FeeManagerStubBase.TargetFeeTooLow.selector, "cheaper reality -> TargetFeeTooLow");
        (bool ok2, bytes memory r2) = _send(tWei * 4, cWei); // sender believes COTI is 4x dearer than cache
        assertFalse(ok2); assertEq(bytes4(r2), FeeManagerStubBase.FeeGasTooHigh.selector, "dearer reality -> FeeGasTooHigh");
    }

    /// 3. What staleness DOES change: the wei charged for the same units. Cache says COTI $0.05; if the true price
    ///    is $0.20 the sender pays 1/4 of fair value (miner absorbs); if $0.0125 the sender pays 4x fair value.
    function test_staleCache_weiScalesWithRatio_unitsDoNot() public {
        uint256 size = abi.encode(_mc()).length;
        (uint256 tCache,) = inbox.calculateTwoWayFeeRequiredInLocalToken(size, size, 300_000, 0, GP);
        // repoint the cache to the alternative "true" prices to read what a fresh cache would have charged
        vm.startPrank(owner);
        oracle.setRemoteTokenPriceUSD(20e16);  (uint256 tDear,) = inbox.calculateTwoWayFeeRequiredInLocalToken(size, size, 300_000, 0, GP);
        oracle.setRemoteTokenPriceUSD(125e14); (uint256 tCheap,) = inbox.calculateTwoWayFeeRequiredInLocalToken(size, size, 300_000, 0, GP);
        vm.stopPrank();
        console2.log("wei for 20.3M units at COTI $0.05 / $0.20 / $0.0125:", tCache, tDear, tCheap);
        assertApproxEqRel(tDear, tCache * 4, 1e16); assertApproxEqRel(tCheap, tCache / 4, 1e16); // 1% tolerance: ceil rounding
    }
}
