// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {Inbox} from "../../contracts/Inbox.sol";
import {InboxBase} from "../../contracts/InboxBase.sol";
import {FeeManager} from "../../contracts/fee/FeeManager.sol";
import {FeeManagerStubBase} from "../../contracts/fee/FeeManagerStubBase.sol";
import {MpcAbiReEncode} from "../../contracts/MpcAbiReEncode.sol";
import {PriceOracle} from "../../contracts/fee/PriceOracle.sol";
import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// PoC: shipped COTI-side template has constantFee == maxExecutionGas == 25_000_000 (deploy-utils.ts).
/// On the EVM side that template is the REMOTE config, so targetGasRemoteUnits = floor(k * L / P) must
/// land on exactly 25_000_000 to pass both the floor (FeeManager.sol:187) and the ceiling (InboxBase.sol:497).
/// Run: FOUNDRY_TEST=test/poc forge test --match-contract DegenerateBandPoC -vv
contract DegenerateBandPoC is Test {
    uint256 constant SRC = 11155111; // Sepolia side (local = variable template)
    uint256 constant DST = 7082400;  // COTI side   (remote = constant template)
    uint256 constant GP = 1 gwei;
    uint32 constant MAXG = 25_000_000;

    address user = makeAddr("user");
    Inbox source;
    PriceOracle oracle;

    function _sepoliaSide() internal pure returns (FeeManagerStubBase.FeeConfig memory f) {
        f = FeeManagerStubBase.FeeConfig({constantFee: 0, gasPerByte: 800, callbackExecutionGas: 100_000, errorLength: 256,
            bufferRatioX10000: 5000, maxMethodCallBytes: 8192, maxExecutionGas: 5_000_000, gasPriceMul: 1, gasPriceDiv: 1});
    }
    function _cotiSide(uint32 constantFee) internal pure returns (FeeManagerStubBase.FeeConfig memory f) {
        f = FeeManagerStubBase.FeeConfig({constantFee: constantFee, gasPerByte: 0, callbackExecutionGas: 0, errorLength: 0,
            bufferRatioX10000: 0, maxMethodCallBytes: 8192, maxExecutionGas: MAXG, gasPriceMul: 1, gasPriceDiv: 1});
    }

    function setUp() public {
        oracle = new PriceOracle(address(this));
        oracle.setInboxTokens(address(0x1111), address(0xC071));
        _prices(1e18, 1e18);
        source = new Inbox();
        source.init(address(this), SRC, address(new MpcAbiReEncode()), address(new FeeManager()));
        source.updateMinFeeConfigs(_sepoliaSide(), _cotiSide(MAXG)); // shipped: remote constantFee == maxExecutionGas
        source.setPriceOracle(address(oracle));
        source.setGasPriceBounds(0, GP, GP);
        vm.deal(user, 1000 ether);
        vm.txGasPrice(GP);
    }

    function _prices(uint256 ethUsd, uint256 cotiUsd) internal { oracle.setLocalTokenPriceUSD(ethUsd); oracle.setRemoteTokenPriceUSD(cotiUsd); }

    function _mc() internal pure returns (IInbox.MpcMethodCall memory m) {
        m = IInbox.MpcMethodCall({selector: bytes4(0), data: "", datatypes: new bytes8[](0), datalens: new bytes32[](0)});
    }

    function _trySend(uint256 value) internal returns (bool ok, bytes memory err) {
        vm.prank(user, user);
        (ok, err) = address(source).call{value: value}(abi.encodeCall(IInbox.sendOneWayMessage, (DST, address(0xBEEF), _mc(), bytes4(0))));
    }

    function _decode(bytes memory err) internal pure returns (string memory) {
        bytes4 s = bytes4(err);
        uint256 v; assembly { v := mload(add(err, 36)) }
        if (s == FeeManager.TargetFeeTooLow.selector) return string.concat("TargetFeeTooLow(", vm.toString(v), ")");
        if (s == FeeManager.FeeGasTooHigh.selector) return string.concat("FeeGasTooHigh(", vm.toString(v), ")");
        return vm.toString(s);
    }

    /// Realistic ETH/COTI prices: the protocol's own quote reverts, and no msg.value threads the band.
    function test_shipped_config_realistic_prices_unreachable() public {
        _prices(3000e18, 5e16); // ETH $3000, COTI $0.05  => L/P = 60_000 gas-unit step per k
        (uint256 quoted,) = source.calculateTwoWayFeeRequiredInLocalToken(0, 0, 0, 0, GP);
        (bool ok, bytes memory err) = _trySend(quoted);
        console2.log("quoter says targetFee wei =", quoted, "k =", quoted / GP);
        console2.log("send with quoted fee ok?", ok, _decode(err));
        assertFalse(ok, "quoted fee must be usable");

        // Sweep k around 25_000_000 * P / L = 416.67 : 416 undershoots, 417 overshoots.
        for (uint256 k = 414; k <= 419; ++k) {
            (bool okk, bytes memory e) = _trySend(k * GP);
            console2.log("k =", k, okk ? "OK" : _decode(e));
            assertFalse(okk);
        }
    }

    /// Equal prices (what the unit tests use) hide the defect: step = 1, exact hit is trivial.
    function test_shipped_config_equal_prices_works() public {
        _prices(1e18, 1e18);
        (uint256 quoted,) = source.calculateTwoWayFeeRequiredInLocalToken(0, 0, 0, 0, GP);
        (bool ok, bytes memory err) = _trySend(quoted);
        console2.log("equal prices: quoted k =", quoted / GP, ok ? "OK" : _decode(err));
        assertTrue(ok);
    }

    /// Fix: give the band width (constantFee < maxExecutionGas). Quote passes at realistic prices.
    function test_fixed_config_band_has_width() public {
        source.updateMinFeeConfigs(_sepoliaSide(), _cotiSide(20_000_000));
        _prices(3000e18, 5e16);
        (uint256 quoted,) = source.calculateTwoWayFeeRequiredInLocalToken(0, 0, 0, 0, GP);
        (bool ok, bytes memory err) = _trySend(quoted);
        console2.log("fixed: quoted k =", quoted / GP, ok ? "OK" : _decode(err));
        assertTrue(ok);
        // and a much larger price ratio (ETH $10k, COTI $0.01 => step 1e6) still fits inside a 5M band
        _prices(10_000e18, 1e16);
        (quoted,) = source.calculateTwoWayFeeRequiredInLocalToken(0, 0, 0, 0, GP);
        (ok, err) = _trySend(quoted);
        console2.log("fixed @ ratio 1e6: quoted k =", quoted / GP, ok ? "OK" : _decode(err));
        assertTrue(ok);
    }

    /// The project's OWN shipped testnet prices (deploy-utils.ts:132-134), paired with the shipped
    /// COTI-side template (deploy-utils.ts:392-403, installed as `remote` at :450).
    function test_shipped_prices_from_deploy_utils_unreachable() public {
        _prices(2103_410000000000000000, 12725220000000000); // ETH $2103.41 / COTI $0.01272522
        (uint256 quoted,) = source.calculateTwoWayFeeRequiredInLocalToken(0, 0, 0, 0, GP);
        (bool ok, bytes memory err) = _trySend(quoted);
        console2.log("quoter k =", quoted / GP, ok ? "OK" : _decode(err));
        assertFalse(ok);
        for (uint256 k = 150; k <= 153; ++k) {
            (bool okk, bytes memory e) = _trySend(k * GP);
            console2.log("k =", k, okk ? "OK" : _decode(e));
            assertFalse(okk);
        }
    }
}
