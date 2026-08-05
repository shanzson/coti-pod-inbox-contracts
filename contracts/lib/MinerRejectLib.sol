// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @title MinerRejectLib
/// @notice Encode/detect the special in-batch miner-reject {IInbox.MpcMethodCall} (no fat payload).
library MinerRejectLib {
    /// @notice First byte of `methodCall.data` for in-batch miner rejects.
    uint8 internal constant SENTINEL = 0xff;
    /// @notice Fixed `methodCall.data` length: sentinel + code + bytes32 reason.
    uint256 internal constant DATA_LENGTH = 34;

    /// @notice Build the special reject methodCall.
    function build(uint8 rejectionCode, bytes32 rejectionReason)
        internal
        pure
        returns (IInbox.MpcMethodCall memory methodCall)
    {
        methodCall.selector = bytes4(0);
        methodCall.datatypes = new bytes8[](0);
        methodCall.datalens = new bytes32[](0);
        methodCall.data = abi.encodePacked(SENTINEL, rejectionCode, rejectionReason);
    }

    /// @notice Whether `methodCall` is the special reject encoding.
    function parse(IInbox.MpcMethodCall memory methodCall)
        internal
        pure
        returns (bool isReject, uint8 rejectionCode, bytes32 rejectionReason)
    {
        if (
            methodCall.selector != bytes4(0) || methodCall.datatypes.length != 0 || methodCall.datalens.length != 0
                || methodCall.data.length != DATA_LENGTH || uint8(methodCall.data[0]) != SENTINEL
        ) {
            return (false, 0, bytes32(0));
        }
        rejectionCode = uint8(methodCall.data[1]);
        bytes memory data = methodCall.data;
        assembly {
            rejectionReason := mload(add(data, 34))
        }
        return (true, rejectionCode, rejectionReason);
    }

    /// @notice Payload weight for admission caps (not ABI encode length).
    function structuralSize(IInbox.MpcMethodCall memory methodCall) internal pure returns (uint256) {
        return methodCall.data.length + (methodCall.datatypes.length * 32) + (methodCall.datalens.length * 32);
    }
}
