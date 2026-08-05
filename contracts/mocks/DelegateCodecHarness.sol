// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";
import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import "../MpcAbiReEncode.sol";

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

    /// @notice Build a one-arg IT_UINT64 method call and DELEGATECALL re-encode (MPC identity = this).
    function encodeItUint64ViaDelegate(bytes4 selector, itUint64 memory value)
        external
        returns (bytes memory)
    {
        bytes memory arg = abi.encode(value);
        bytes8[] memory datatypes = new bytes8[](1);
        bytes32[] memory datalens = new bytes32[](1);
        // MpcAbiCodec.MpcDataType.IT_UINT64 == 14
        datatypes[0] = bytes8(uint64(14));
        datalens[0] = bytes32(arg.length);
        IInbox.MpcMethodCall memory methodCall = IInbox.MpcMethodCall({
            selector: selector,
            data: arg,
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
