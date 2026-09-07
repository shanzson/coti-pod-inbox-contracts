// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {Inbox} from "../../contracts/Inbox.sol";
import {FeeManager} from "../../contracts/fee/FeeManager.sol";
import {FeeManagerStubBase} from "../../contracts/fee/FeeManagerStubBase.sol";
import {MpcAbiReEncode} from "../../contracts/MpcAbiReEncode.sol";
import {PoDPriceOracle} from "../../contracts/fee/PoDPriceOracle.sol";
import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// PoC: the fee path prices sends off cachedPriceUSD with no age check. priceUpdatedAt is written but
/// never read by FeeManager._validatedOraclePrices (FeeManager.sol:245-258) or PriceOracle.getPricesUSD (:160).
/// Direction modelled: COTI (local, sender pays in COTI) -> ETH chain (remote, gas bought in ETH).
contract StalePricePoC is Test {
    uint256 constant SRC = 7082400; uint256 constant DST = 11155111;
    uint256 constant GP = 2 gwei;
    uint256 constant ETH_USD = 2000e18;
    uint256 constant FEE = 1000e18; // 1000 COTI
    address user = makeAddr("user");
    address constant COTI = address(0xC071); address constant WETH = address(0x1111);
    Inbox source; PoDPriceOracle oracle;

    function _var() internal pure returns (FeeManagerStubBase.FeeConfig memory f) {
        f = FeeManagerStubBase.FeeConfig({constantFee: 0, gasPerByte: 800, callbackExecutionGas: 100_000, errorLength: 256,
            bufferRatioX10000: 5000, maxMethodCallBytes: 8192, maxExecutionGas: 5_000_000, gasPriceMul: 1, gasPriceDiv: 1});
    }
    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = new PoDPriceOracle(address(this), address(0), 300); // no live adapter: COTI leg is a manual peg
        oracle.setInboxTokens(COTI, WETH);
        oracle.setLocalTokenPriceUSD(12e15);   // COTI $0.012
        oracle.setRemoteTokenPriceUSD(ETH_USD);
        source = new Inbox();
        source.init(address(this), SRC, address(new MpcAbiReEncode()), address(new FeeManager()));
        source.updateMinFeeConfigs(_var(), _var());
        source.setPriceOracle(address(oracle)); source.setGasPriceBounds(0, GP, GP);
        vm.deal(user, 1e6 ether); vm.txGasPrice(GP);
    }
    function _mc() internal pure returns (IInbox.MpcMethodCall memory m) {
        m = IInbox.MpcMethodCall({selector: bytes4(0), data: "", datatypes: new bytes8[](0), datalens: new bytes32[](0)});
    }
    function _send() internal returns (bool ok, uint256 units, bytes memory err) {
        vm.prank(user, user);
        (ok, err) = address(source).call{value: FEE}(abi.encodeCall(IInbox.sendOneWayMessage, (DST, address(0xBEEF), _mc(), bytes4(0))));
        if (ok) { uint256 n = source.getRequestsLen(DST); units = source.getRequests(DST, n - 1, 1)[0].targetFee; }
    }

    function test_1_units_bought_scale_with_cached_coti_price() public {
        uint256[3] memory p = [uint256(12e15), 8e15, 1e15]; // $0.012 stale-high, $0.008 true, $0.001 stale-low
        for (uint256 i; i < 3; ++i) {
            oracle.setLocalTokenPriceUSD(p[i]);
            (bool ok, uint256 units, bytes memory err) = _send();
            uint256 v; if (!ok) assembly { v := mload(add(err, 36)) }
            console2.log("COTI price (1e18):", p[i], ok ? "-> remote gas units bought:" : "-> REVERT TargetFeeTooLow, units:", ok ? units : v);
        }
    }

    function test_2_hundred_day_old_price_still_prices_sends() public {
        (,, uint256 la, uint256 ra,) = oracle.getPricesUSDWithMeta();
        vm.warp(block.timestamp + 100 days);
        oracle.refreshCache(); // no adapter -> live pull returns 0 -> cache retained (PriceOracle.sol:155-156)
        (uint256 lp, uint256 rp, uint256 la2, uint256 ra2,) = oracle.getPricesUSDWithMeta();
        console2.log("age of local price (days):", (block.timestamp - la2) / 1 days, " remote:", (block.timestamp - ra2) / 1 days);
        assertEq(la, la2); assertEq(ra, ra2); assertEq(lp, 12e15); assertEq(rp, ETH_USD);
        (bool ok, uint256 units,) = _send();
        console2.log("send after 100 days ok:", ok, " units:", units);
        assertTrue(ok, "no staleness guard anywhere on the fee path");
        assertEq(units, 3_000_000);
    }

    function test_3_refresh_happens_after_validation() public {
        // InboxBase.sol:205-206: fee is validated first, refreshCache() runs afterwards in a try/catch.
        // So even the send that triggers a refresh is priced at the pre-refresh cache.
        (bool ok, uint256 units,) = _send();
        assertTrue(ok); assertEq(units, 3_000_000);
    }
}
