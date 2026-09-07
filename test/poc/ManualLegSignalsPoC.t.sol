// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {PoDPriceOracle} from "../../contracts/fee/PoDPriceOracle.sol";
import {ChainlinkLiveOracle} from "../../contracts/fee/chainlink/ChainlinkLiveOracle.sol";

contract MockAgg {
    int256 public answer = 2000e8; uint256 public updatedAt;
    constructor() { updatedAt = block.timestamp; }
    function decimals() external pure returns (uint8) { return 8; }
    function poke(int256 a) external { answer = a; updatedAt = block.timestamp; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, answer, updatedAt, updatedAt, 1); }
}

/// Shipped Sepolia wiring (deploy-utils.ts:222-229, :557-570): ChainlinkLiveOracle with an ETH feed,
/// NO feed for COTI, COTI price written through the cache setter setRemoteTokenPriceUSD.
contract ManualLegSignalsPoC is Test {
    address constant WETH = address(0x1111); address constant COTI = address(0xC071);
    PoDPriceOracle oracle; ChainlinkLiveOracle live; MockAgg ethFeed;
    event CacheRefreshLegFailed(address indexed token, uint256 retainedCachedPrice);

    function setUp() public {
        vm.warp(1_800_000_000);
        ethFeed = new MockAgg();
        live = new ChainlinkLiveOracle(address(this), 86_400);
        live.setFeed(WETH, address(ethFeed));               // COTI: no feed, as shipped
        oracle = new PoDPriceOracle(address(this), address(live), 300);
        oracle.setInboxTokens(WETH, COTI);
        oracle.setRemoteTokenPriceUSD(12_725_220_000_000_000); // COTI $0.01272522 via cache setter
        oracle.refreshCache();
    }

    /// In the healthy steady state, every refresh emits CacheRefreshLegFailed for the COTI leg.
    function test_1_failure_event_fires_on_every_healthy_refresh_for_manual_leg() public {
        for (uint256 i = 1; i <= 3; ++i) {
            vm.warp(vm.getBlockTimestamp() + 301);
            ethFeed.poke(2000e8 + int256(i));
            vm.expectEmit(true, false, false, true, address(oracle));
            emit CacheRefreshLegFailed(COTI, 12_725_220_000_000_000);
            oracle.refreshCache();
        }
        (,,, uint256 remoteLive,, bool remoteLiveOk, uint256 la, uint256 ra,,,, bool remoteManual) = oracle.getOracleHealth();
        console2.log("healthy state: remoteLive =", remoteLive, " remoteLiveOk =", remoteLiveOk);
        console2.log("remoteManual flag =", remoteManual, " (cache-set peg is NOT flagged manual)");
        console2.log("age WETH (s) =", vm.getBlockTimestamp() - la, " age COTI (s) =", vm.getBlockTimestamp() - ra);
        assertFalse(remoteLiveOk, "health surface reports the manual leg as live-not-ok permanently");
        assertFalse(remoteManual, "cache-set peg is invisible to the manual flag");
    }

    /// The only signal that distinguishes 'fine' from 'forgotten' on that leg is priceUpdatedAt.
    function test_2_age_field_is_the_only_discriminating_signal() public {
        vm.warp(vm.getBlockTimestamp() + 45 days);
        ethFeed.poke(2100e8);
        oracle.refreshCache();
        (,,,,,, uint256 la, uint256 ra,,,,) = oracle.getOracleHealth();
        console2.log("after 45 days: age WETH (days) =", (vm.getBlockTimestamp() - la) / 1 days, " age COTI (days) =", (vm.getBlockTimestamp() - ra) / 1 days);
        assertEq((vm.getBlockTimestamp() - ra) / 1 days, 45);
        assertEq((vm.getBlockTimestamp() - la) / 1 days, 0);
    }
}
