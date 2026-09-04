// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal stand-in for the COTI Inbox used to drive the REAL PodErc20CotiMother in a PoC.
/// @dev Implements only the selectors the mother invokes: inboxMsgSender / respond / raise.
///      The mother's onlyRegisteredPTokenMessage / onlyRegisteredFactoryMessage modifiers require
///      msg.sender == address(inbox); tests impersonate THIS contract's address to satisfy that,
///      while this contract answers inboxMsgSender() with a test-controlled (chainId, sender).
contract MockInboxForMother {
    uint256 public ctxChainId;
    address public ctxSender;

    function setContext(uint256 chainId_, address sender_) external {
        ctxChainId = chainId_;
        ctxSender = sender_;
    }

    function inboxMsgSender() external view returns (uint256, address) {
        return (ctxChainId, ctxSender);
    }

    // Success-path callbacks; never reached by the auth-revert tests, no-op for the past-auth test.
    function respond(bytes memory) external {}
    function raise(bytes memory) external {}
}
