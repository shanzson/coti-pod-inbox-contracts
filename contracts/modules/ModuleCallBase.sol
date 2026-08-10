// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ModuleCallBase
/// @notice Holds module addresses and generic DELEGATECALL / STATICCALL helpers.
/// @dev Reusable when estimate/execute/etc. are extracted later. Fee-specific code only
///      passes {feeManager} into {_delegateModule} / {_staticModule}.
abstract contract ModuleCallBase {
    /// @notice Deployed {FeeManager} implementation (DELEGATECALL target). Apps still call Inbox.
    address public feeManager;

    /// @notice Module address was zero when a call was required.
    error ModuleNotConfigured(address module);

    /// @dev DELEGATECALL into `module` with `callData`; bubbles revert data. `address(this)` stays the Inbox.
    function _delegateModule(address module, bytes memory callData) internal returns (bytes memory) {
        if (module == address(0)) revert ModuleNotConfigured(module);
        (bool success, bytes memory returndata) = module.delegatecall(callData);
        if (!success) {
            _bubbleRevert(returndata);
        }
        return returndata;
    }

    /// @dev STATICCALL into `module` with `callData`; bubbles revert data.
    /// @notice Do not use for Inbox fee-state getters — STATICCALL runs in the module's storage context.
    function _staticModule(address module, bytes memory callData) internal view returns (bytes memory) {
        if (module == address(0)) revert ModuleNotConfigured(module);
        (bool success, bytes memory returndata) = module.staticcall(callData);
        if (!success) {
            _bubbleRevert(returndata);
        }
        return returndata;
    }

    function _bubbleRevert(bytes memory returndata) private pure {
        if (returndata.length == 0) revert();
        assembly ("memory-safe") {
            revert(add(returndata, 0x20), mload(returndata))
        }
    }
}
