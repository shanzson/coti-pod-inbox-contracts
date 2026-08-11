// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import "../../../contracts/MpcAbiReEncode.sol";

/// @title DelegateCodecHarness
/// @notice Minimal DELEGATECALL wrapper for COTI testnet proof of {MpcAbiReEncode}.
contract DelegateCodecHarness {
    address public immutable codec;
    bytes public lastEncoded;

    constructor(address codec_) {
        codec = codec_;
    }

    /// @notice DELEGATECALL {MpcAbiReEncode.reEncodeWithGt} so `address(this)` is this harness.
    function encodeViaDelegate(IInbox.MpcMethodCall memory methodCall) external returns (bytes memory) {
        return _encodeViaDelegate(methodCall);
    }

    /// @notice Encode a single dynamic/static arg with an explicit datatype word (test guards).
    function encodeOneArgViaDelegate(bytes4 selector, bytes calldata argData, bytes8 dataType)
        external
        returns (bytes memory)
    {
        bytes8[] memory datatypes = new bytes8[](1);
        bytes32[] memory datalens = new bytes32[](1);
        datatypes[0] = dataType;
        datalens[0] = bytes32(argData.length);
        IInbox.MpcMethodCall memory methodCall = IInbox.MpcMethodCall({
            selector: selector,
            data: argData,
            datatypes: datatypes,
            datalens: datalens
        });
        return _encodeViaDelegate(methodCall);
    }

    function _encodeViaDelegate(IInbox.MpcMethodCall memory methodCall) private returns (bytes memory encoded) {
        (bool success, bytes memory ret) = codec.delegatecall(
            abi.encodeWithSelector(MpcAbiReEncode.reEncodeWithGt.selector, methodCall)
        );
        if (!success) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        encoded = abi.decode(ret, (bytes));
        lastEncoded = encoded;
    }
}
