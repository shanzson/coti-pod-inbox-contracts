// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PodErc20MintableFixed.sol";

/// @title PodErc20MintableInitializable
/// @notice Clone-friendly {PodErc20Mintable}; the implementation constructor locks the implementation instance.
/// @dev Usual deploy path is {PrivacyPortalFactory.createPortal} (clone + initialize in one tx).
///      Split deploy-then-initialize is unsafe: an attacker can front-run `initialize` on an uninitialized clone.
///
///      Why not OpenZeppelin {Initializable}?
///      Inheriting OZ {Initializable} (plus `initializer` / `_disableInitializers`) pushes deployed bytecode over the
///      EIP-170 create limit (24_576 bytes) even with `viaIR` and `optimizer.runs = 1`. This token is a one-shot
///      EIP-1167 clone, not an upgradeable proxy, so we do not need OZ's versioned `reinitializer` path.
///      Instead: the implementation constructor runs {PodErc20Mintable} and sets {_podERC20Initialized} /
///      {_mintableInitialized}; clones skip the constructor and call {initialize} once, which is gated by those
///      same flags (re-init reverts with {PodERC20AlreadyInitialized} / {PodErc20MintableAlreadyInitialized}).
contract PodErc20MintableInitializableFixed is PodErc20MintableFixed {
    /// @notice Lock the implementation instance with placeholder values.
    constructor() PodErc20MintableFixed(address(1), 1, address(1), address(1), "IMPLEMENTATION", "IMPL") {}

    /// @notice Initialize a mintable source-chain pToken clone.
    /// @param _minter Address allowed to mint (the paired {PrivacyPortal}; rotatable later via {setMinter}).
    /// @param _owner Ownable admin allowed to {configure} inbox / COTI peer and {setMinter}; factory passes `address(this)`.
    /// @param _cotiChainId COTI chain id for remote MPC execution.
    /// @param _inbox Source-chain inbox.
    /// @param _cotiSideContract COTI-side pToken ledger.
    /// @param _name Token name.
    /// @param _symbol Token symbol.
    /// @param _decimals Token decimals.
    function initialize(
        address _minter,
        address _owner,
        uint256 _cotiChainId,
        address _inbox,
        address _cotiSideContract,
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    ) external {
        if (_owner == address(0)) {
            revert PodERC20InvalidInitialization();
        }
        // Reverts with PodERC20AlreadyInitialized / PodErc20MintableAlreadyInitialized on the
        // implementation (constructor already ran) or on a second call to a clone.
        _initializePodErc20Mintable(_minter, _cotiChainId, _inbox, _cotiSideContract, _name, _symbol, _decimals);
        _transferOwnership(_owner);
    }
}
