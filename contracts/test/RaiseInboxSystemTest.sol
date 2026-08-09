// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import "@coti-io/coti-contracts/contracts/pod/InboxUser.sol";

/// @title RaiseInboxTestCoti
/// @notice System test: COTI target that forwards `triggerRaise` to {IInbox.raise}.
contract RaiseInboxTestCoti is InboxUser {
    constructor(address inboxAddress) {
        setInbox(inboxAddress);
    }

    /// @notice Register the Sepolia source peer allowed to invoke {triggerRaise}.
    function setTrustedRemote(uint256 chainId, address peer) external {
        _setTrustedRemote(chainId, peer);
    }

    function triggerRaise(bytes calldata errorPayload) external onlyInboxPeer {
        inbox.raise(errorPayload);
    }
}

/// @title RaiseInboxTestSepolia
/// @notice System test: source chain contract that invokes COTI `triggerRaise` and records error callbacks.
contract RaiseInboxTestSepolia is InboxUser {
    bytes4 private constant TRIGGER_RAISE = bytes4(keccak256("triggerRaise(bytes)"));

    uint256 public immutable cotiChainId;
    address public immutable cotiRaiseContract;

    bool public raiseErrorCalled;
    bytes public lastRaiseErrorPayload;
    /// @notice Value of {IInbox.inboxSourceRequestId} when {onRaiseError} ran (must match COTI incoming id for `raise`).
    bytes32 public lastErrorSourceRequestId;

    error ExpectedRaisePathNotSuccess();

    constructor(address inboxAddress, uint256 cotiChainId_, address cotiRaiseContract_) {
        setInbox(inboxAddress);
        cotiChainId = cotiChainId_;
        cotiRaiseContract = cotiRaiseContract_;
        _setTrustedRemote(cotiChainId_, cotiRaiseContract_);
    }

    receive() external payable {}

    function onSuccess(bytes calldata) external view onlyInboxReturnLeg {
        revert ExpectedRaisePathNotSuccess();
    }

    function onRaiseError(bytes calldata payload) external onlyInboxReturnLeg {
        raiseErrorCalled = true;
        lastRaiseErrorPayload = payload;
        lastErrorSourceRequestId = inbox.inboxSourceRequestId();
    }

    /// @notice Full calldata for `RaiseInboxTestCoti.triggerRaise(bytes)`.
    /// @param callbackFeeLocalWei Caller-estimated wei reserved for the callback leg; total payment is `msg.value`.
    function startRaiseRoundTrip(bytes calldata raisePayload, uint256 callbackFeeLocalWei) external payable {
        bytes memory data = abi.encodeWithSelector(TRIGGER_RAISE, raisePayload);
        IInbox.MpcMethodCall memory methodCall = IInbox.MpcMethodCall({
            selector: bytes4(0),
            data: data,
            datatypes: new bytes8[](0),
            datalens: new bytes32[](0)
        });
        require(callbackFeeLocalWei >= 1, "RaiseInboxTestSepolia: callback fee min");
        require(callbackFeeLocalWei <= msg.value, "RaiseInboxTestSepolia: callback exceeds msg.value");
        require(address(this).balance >= msg.value, "RaiseInboxTestSepolia: inbox fee");
        IInbox(inbox).sendTwoWayMessage{value: msg.value}(
            cotiChainId,
            cotiRaiseContract,
            methodCall,
            this.onSuccess.selector,
            this.onRaiseError.selector,
            callbackFeeLocalWei
        );
    }
}
