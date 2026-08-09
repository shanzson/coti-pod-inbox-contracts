// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @notice Test double: {reEncodeWithGt} always reverts with a large returndata blob.
contract LargeRevertMpcAbiReEncode {
    uint256 public constant REVERT_SIZE = 1024;

    function reEncodeWithGt(IInbox.MpcMethodCall calldata) external pure returns (bytes memory) {
        bytes memory huge = new bytes(REVERT_SIZE);
        assembly {
            let p := add(huge, 32)
            for { let i := 0 } lt(i, 1024) { i := add(i, 32) } {
                mstore(add(p, i), not(0))
            }
            revert(add(huge, 32), 1024)
        }
    }
}
