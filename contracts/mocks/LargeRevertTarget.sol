// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title LargeRevertTarget
/// @notice Reverts with controllable payload shapes to exercise inbox returndata capping + getOutboxError.
contract LargeRevertTarget {
    error CustomBoom(uint256 code, string hint);

    /// @notice Revert with `size` zero-bytes of returndata (raw revert, no Error(string)).
    function boom(uint256 size) external pure {
        assembly {
            let ptr := mload(0x40)
            mstore(0x40, add(ptr, size))
            revert(ptr, size)
        }
    }

    /// @notice Standard `Error(string)` revert with an exact message.
    function boomErrorString(string calldata reason) external pure {
        revert(reason);
    }

    /// @notice `Error(string)` built from `fill` repeated `n` times (for size-boundary tests).
    function boomErrorStringRepeated(bytes1 fill, uint256 n) external pure {
        bytes memory payload = new bytes(n);
        for (uint256 i = 0; i < n; ) {
            payload[i] = fill;
            unchecked {
                ++i;
            }
        }
        revert(string(payload));
    }

    /// @notice Bare `revert()` — empty returndata.
    function boomEmpty() external pure {
        assembly {
            revert(0, 0)
        }
    }

    /// @notice Panic(0x01) via `assert(false)`.
    function boomPanic() external pure {
        assert(false);
    }

    /// @notice Custom error with a readable hint string.
    function boomCustom(uint256 code, string calldata hint) external pure {
        revert CustomBoom(code, hint);
    }

    /// @notice No-op success path for a subsequent contiguous nonce.
    function ok() external pure returns (bool) {
        return true;
    }
}
