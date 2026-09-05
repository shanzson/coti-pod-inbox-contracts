// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

interface IPodErc20Callbacks {
    function transferCallback(bytes memory data) external;
    function transferError(bytes memory data) external;
}

/// @notice Inbox stand-in used to drive the REAL PodErc20MintableInitializable + PrivacyPortal + PrivacyPortalFactory.
/// @dev Faithful to the real inbox where it matters for the PoCs:
///      * request ids use the REAL packing (coti-pod-inbox-contracts InboxBase._packRequestId: src<<192 | target<<128 | nonce)
///        and the REAL per-target nonce (`++_requestNonce[target]`, i.e. the first id of a fresh instance is nonce 1,
///        InboxBase.sol:507). The inbox address is NOT part of the id.
///      * callbacks are delivered by THIS contract calling the pToken, so `msg.sender == inbox` for
///        InboxUser.onlyInboxPeer / onlyInboxReturnLeg without any impersonation.
///      * context views (inboxMsgSender / inboxSourceRequestId / inboxErrorType) are set for the duration of a delivery.
contract MockInboxForPortal {
    address public constant SYSTEM_SENDER = address(uint160(uint256(keccak256("POD_INBOX_SYSTEM_SENDER"))));

    struct Sent {
        uint256 targetChainId;
        address targetContract;
        address caller;
        bytes4 callbackSelector;
        bytes4 errorSelector;
        uint256 value;
        uint256 callbackFeeLocalWei;
        bool twoWay;
    }

    mapping(uint256 => uint256) private _requestNonce;
    mapping(bytes32 => Sent) public sent;
    bytes32 public lastRequestId;
    uint256 public sentCount;

    // Active delivery context.
    uint256 private _ctxChainId;
    address private _ctxSender;
    bytes32 private _ctxRequestId;
    bytes32 private _ctxSourceRequestId;
    IInbox.InboxErrorType private _ctxErrType;

    receive() external payable {}

    // ---- sends (same id scheme as the real inbox) ----

    function sendTwoWayMessage(
        uint256 targetChainId,
        address targetContract,
        IInbox.MpcMethodCall calldata,
        bytes4 callbackSelector,
        bytes4 errorSelector,
        uint256 callbackFeeLocalWei
    ) external payable returns (bytes32 requestId) {
        uint256 nonce = ++_requestNonce[targetChainId];
        requestId = _packRequestId(block.chainid, targetChainId, nonce);
        sent[requestId] = Sent(targetChainId, targetContract, msg.sender, callbackSelector, errorSelector, msg.value, callbackFeeLocalWei, true);
        lastRequestId = requestId;
        sentCount += 1;
    }

    function sendOneWayMessage(
        uint256 targetChainId,
        address targetContract,
        IInbox.MpcMethodCall calldata,
        bytes4
    ) external payable returns (bytes32 requestId) {
        uint256 nonce = ++_requestNonce[targetChainId];
        requestId = _packRequestId(block.chainid, targetChainId, nonce);
        sent[requestId] = Sent(targetChainId, targetContract, msg.sender, bytes4(0), bytes4(0), msg.value, 0, false);
        lastRequestId = requestId;
        sentCount += 1;
    }

    function getRequestId(uint256 sourceChainId, uint256 targetChainId, uint256 nonce) external pure returns (bytes32) {
        return _packRequestId(sourceChainId, targetChainId, nonce);
    }

    function requestNonce(uint256 targetChainId) external view returns (uint256) {
        return _requestNonce[targetChainId];
    }

    // ---- IInboxFeeManager surface used by PodERC20.estimateFee ----

    function calculateTwoWayFeeRequiredInLocalToken(uint256, uint256, uint256, uint256, uint256)
        external
        pure
        returns (uint256 targetFeeLocalWei, uint256 callerFeeLocalWei)
    {
        return (900, 100);
    }

    // ---- context views read by InboxUser / PodERC20 ----

    function inboxMsgSender() external view returns (uint256, address) {
        return (_ctxChainId, _ctxSender);
    }

    function inboxRequestId() external view returns (bytes32) {
        return _ctxRequestId;
    }

    function inboxSourceRequestId() external view returns (bytes32) {
        return _ctxSourceRequestId;
    }

    function inboxErrorType() external view returns (IInbox.InboxErrorType) {
        return _ctxErrType;
    }

    // ---- deliveries (this contract is msg.sender for the pToken) ----

    /// @notice Deliver a COTI success callback for a transfer/mint/burn request (`transferCallback`).
    /// @dev Payload layout is exactly what PodERC20.transferCallback decodes; ciphertexts are zero here
    ///      because no PoC asserts on balance ciphertexts.
    function deliverTransferSuccess(
        address pToken,
        uint256 cotiChainId,
        address cotiSide,
        bytes32 sourceRequestId,
        address from,
        address to,
        uint256 nonce
    ) external {
        ctUint256 memory zero;
        bytes memory data = abi.encode(from, zero, zero, to, zero, zero, nonce);
        _setCtx(cotiChainId, cotiSide, sourceRequestId, IInbox.InboxErrorType.NotErrorContext);
        IPodErc20Callbacks(pToken).transferCallback(data);
        _clearCtx();
    }

    /// @notice Deliver an Inbox SYSTEM error return leg (`transferError` with ErrorData payload).
    function deliverSystemError(
        address pToken,
        uint256 cotiChainId,
        bytes32 sourceRequestId,
        uint64 errorCode,
        bytes calldata message
    ) external {
        _setCtx(cotiChainId, SYSTEM_SENDER, sourceRequestId, IInbox.InboxErrorType.SystemError);
        IPodErc20Callbacks(pToken).transferError(abi.encode(errorCode, message));
        _clearCtx();
    }

    /// @notice Deliver an app `raise` return leg (`transferError` with (from, to, errorMsg) payload).
    function deliverRaise(
        address pToken,
        uint256 cotiChainId,
        address cotiSide,
        bytes32 sourceRequestId,
        address from,
        address to,
        bytes calldata errorMsg
    ) external {
        _setCtx(cotiChainId, cotiSide, sourceRequestId, IInbox.InboxErrorType.Exception);
        IPodErc20Callbacks(pToken).transferError(abi.encode(from, to, errorMsg));
        _clearCtx();
    }

    function _setCtx(uint256 chainId_, address sender_, bytes32 sourceRequestId, IInbox.InboxErrorType errType) private {
        _ctxChainId = chainId_;
        _ctxSender = sender_;
        _ctxRequestId = keccak256(abi.encode("return-leg", sourceRequestId, sentCount));
        _ctxSourceRequestId = sourceRequestId;
        _ctxErrType = errType;
    }

    function _clearCtx() private {
        _ctxChainId = 0;
        _ctxSender = address(0);
        _ctxRequestId = bytes32(0);
        _ctxSourceRequestId = bytes32(0);
        _ctxErrType = IInbox.InboxErrorType.NotErrorContext;
    }

    function _packRequestId(uint256 sourceChainId, uint256 targetChainId, uint256 nonce) private pure returns (bytes32) {
        return bytes32(
            (uint256(uint64(sourceChainId)) << 192) | (uint256(uint64(targetChainId)) << 128) | uint256(uint128(nonce))
        );
    }
}
