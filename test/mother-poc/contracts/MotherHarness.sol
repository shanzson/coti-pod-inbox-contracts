// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/token/perc20/cotiside/PodErc20CotiMother.sol";

/// @notice Constructor-passthrough subclass of the UNMODIFIED PodErc20CotiMother.
/// @dev Adds no state and no logic — it only re-exposes the constructor so Hardhat emits a
///      deployable artifact (npm-imported contracts get none). Every burn/transfer/registerToken
///      entry point, modifier, and error is inherited verbatim, so the PoC exercises the real mother.
contract PodErc20CotiMotherHarness is PodErc20CotiMother {
    constructor(address inbox_, address owner_) PodErc20CotiMother(inbox_, owner_) {}
}
