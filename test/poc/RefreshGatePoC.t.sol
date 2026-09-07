// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {PoDPriceOracle} from "../../contracts/fee/PoDPriceOracle.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/IPodPriceOracle.sol";

/// Adapter stub whose answer can be switched between "down" (0) and a live price.
contract FlakyAdapter is IPodPriceOracle {
    uint256 public answer;
    function set(uint256 a) external { answer = a; }
    function getLivePrice(address) external view returns (uint256) { return answer; }
    function getLivePrices(address, address) external view returns (uint256, uint256) { return (answer, answer); }
}

/// PoC: _refreshInboxCache advances lastFetchTimestamp BEFORE pulling (PriceOracle.sol:132), so a refresh in
/// which every leg failed still shuts the interval gate for fetchInterval seconds.
contract RefreshGatePoC is Test {
    address constant WETH = address(0x1111); address constant COTI = address(0xC071);
    uint256 constant INTERVAL = 300;
    PoDPriceOracle oracle; FlakyAdapter feed;

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new FlakyAdapter();
        oracle = new PoDPriceOracle(address(this), address(feed), INTERVAL);
        oracle.setInboxTokens(WETH, COTI);
        oracle.setTokenPriceUSD(COTI, 12e15);          // manual peg leg (no feed), as deployed
        feed.set(2000e18); oracle.refreshCache();       // healthy first refresh: WETH = $2000
        (uint256 lp,,,,) = oracle.getPricesUSDWithMeta(); assertEq(lp, 2000e18);
    }

    function test_failed_refresh_still_shuts_the_gate() public {
        // NB: read the clock via the cheatcode; under via-IR two block.timestamp reads in one call are folded.
        uint256 t0 = vm.getBlockTimestamp() + INTERVAL + 1;
        vm.warp(t0);
        feed.set(0);                                     // feed goes stale/down: adapter returns 0
        oracle.refreshCache();                           // both legs: WETH fails, COTI manual "succeeds"
        assertEq(oracle.lastFetchTimestamp(), t0, "gate shut even though the live leg failed");

        vm.warp(t0 + 10);
        feed.set(2100e18);                               // feed recovers 10 s later
        oracle.refreshCache();
        (uint256 lp,, uint256 la,,) = oracle.getPricesUSDWithMeta();
        console2.log("10s after recovery: WETH cached =", lp, " gateOpen =", oracle.fetchGateOpen());
        assertEq(lp, 2000e18, "recovered price NOT picked up: gate is closed");

        vm.warp(t0 + INTERVAL);
        oracle.refreshCache();
        (lp,, la,,) = oracle.getPricesUSDWithMeta();
        console2.log("at interval boundary: WETH cached =", lp);
        assertEq(lp, 2100e18, "picked up only after the full interval");
    }

    function test_manual_peg_is_restamped_on_every_refresh() public {
        (, , , uint256 ra0,) = oracle.getPricesUSDWithMeta();
        vm.warp(vm.getBlockTimestamp() + 30 days);
        oracle.refreshCache();
        (, uint256 rp, , uint256 ra1,) = oracle.getPricesUSDWithMeta();
        console2.log("COTI manual peg: value", rp, " updatedAt moved forward by (days):", (ra1 - ra0) / 1 days);
        assertEq(ra1, vm.getBlockTimestamp(), "manualPrices leg looks freshly updated although nobody re-verified it");
    }
}
