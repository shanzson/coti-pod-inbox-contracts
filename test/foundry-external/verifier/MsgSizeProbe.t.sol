// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
// Verifier-written probe (not from the gist): measures abi.encode(methodCall).length of real PodERC20 sends,
// i.e. the `dataSize` FeeManager.validateAndPrepareTwoWayFees uses, versus the 512-byte heuristic
// PodERC20.estimateFee quotes with (FEE_ESTIMATE_*_CALL_SIZE = 512, exec gas 300k each).
import {Test, console2} from "forge-std/Test.sol";
import {PodErc20Mintable} from "../../../contracts/pod/token/perc20/PodErc20Mintable.sol";
import {IInbox} from "../../../contracts/pod/IInbox.sol";
import {ctUint256, ctUint128, itUint256} from "../../../contracts/utils/mpc/MpcCore.sol";
import {MockMpcPrecompile} from "../mocks/MockMpcPrecompile.sol";

contract SizeProbeInbox {
    uint256[] public sizes;
    uint256 public n;
    receive() external payable {}
    function sendTwoWayMessage(uint256, address, IInbox.MpcMethodCall calldata mc, bytes4, bytes4, uint256)
        external payable returns (bytes32 id)
    { sizes.push(abi.encode(mc).length); n++; id = bytes32(n); }
    function sendOneWayMessage(uint256, address, IInbox.MpcMethodCall calldata mc, bytes4)
        external payable returns (bytes32 id)
    { sizes.push(abi.encode(mc).length); n++; id = bytes32(n); }
    function last() external view returns (uint256) { return sizes[sizes.length - 1]; }
}

contract MsgSizeProbe is Test {
    PodErc20Mintable pod;
    SizeProbeInbox inbox;
    function setUp() public {
        vm.etch(address(0x64), address(new MockMpcPrecompile()).code);
        inbox = new SizeProbeInbox();
        pod = new PodErc20Mintable(address(this), 7082400, address(inbox), address(0xC0715DE), "p", "p");
        vm.deal(address(this), 100 ether);
    }
    function _it() internal pure returns (itUint256 memory it) {
        it.ciphertext = ctUint256({ciphertextHigh: ctUint128.wrap(1), ciphertextLow: ctUint128.wrap(2)});
        it.signature = new bytes(65);
    }
    function test_sizes() public {
        pod.mint{value: 2}(address(0xBEEF), 100, 1);
        console2.log("mint(public)         ", inbox.last());
        pod.transfer{value: 2}(address(0xF00D), 10, 1);
        console2.log("transfer(public)     ", inbox.last());
        pod.approve{value: 2}(address(0xF00D), 10, 1);
        console2.log("approve(public)      ", inbox.last());
        pod.burn{value: 2}(5, 1);
        console2.log("burn(public)         ", inbox.last());
        try pod.transfer{value: 2}(address(0xF00D), _it(), 1) {
            console2.log("transfer(itUint256)  ", inbox.last());
        } catch { console2.log("transfer(itUint256) reverted under MPC stub"); }
        try pod.transferFrom{value: 2}(address(this), address(0xF00D), _it(), 1) {
            console2.log("transferFrom(it)     ", inbox.last());
        } catch { console2.log("transferFrom(itUint256) reverted under MPC stub"); }
        address[] memory accts = new address[](10);
        for (uint256 i; i < 10; i++) accts[i] = address(uint160(i + 1));
        try pod.syncBalances{value: 2}(accts, 1) {
            console2.log("syncBalances(10)     ", inbox.last());
        } catch { console2.log("syncBalances reverted"); }
        // Threshold from FeeManager formula at shipped-style config gasPerByte=800, buffer x1.5:
        // honest quote (512-byte legs, +300k exec) is rejected when 300_000 < 1200 * (D - 512)  =>  D > 762.
    }
}
