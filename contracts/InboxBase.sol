// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "./fee/FeeManagerStubBase.sol";
import "./lib/MinerRejectLib.sol";
import "./MpcAbiReEncode.sol";
import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @title InboxBase
/// @notice Core inbox: outbound requests, inbound execution context, responses, errors, and MPC calldata encoding.
/// @dev Fee API via {FeeManagerStubBase} (DELEGATECALL to {FeeManager}). {InboxEstimateGas} extends this.
contract InboxBase is IInbox, FeeManagerStubBase {
    using MinerRejectLib for MpcMethodCall;
    /// @notice This chain's ID (deploy-time; may differ from `block.chainid` when `_chainId` is non-zero).
    uint256 public chainId;

    /// @notice Outbound requests by request id. The id encodes both source and target chain ids,
    /// so it is globally unique even though nonces are tracked per target chain.
    mapping(bytes32 => Request) public requests;
    /// @notice Responses sent for incoming request ids.
    mapping(bytes32 => Response) public inboxResponses;
    /// @notice Execution or encoding errors by request id.
    mapping(bytes32 => Error) public errors;
    /// @notice Incoming requests mined from remote chains, by request id (id encodes the source chain).
    mapping(bytes32 => Request) public incomingRequests;
    /// @notice Last contiguous incoming request id processed for each source chain.
    mapping(uint256 => bytes32) public lastIncomingRequestId;

    ExecutionContext internal _currentContext;
    /// @notice Per-target outbound nonce: `targetChainId => number of requests sent to that chain`.
    /// @dev Per-target so the sequence each target receives is contiguous (1,2,3,...) even when this
    /// chain sends to several targets, which is what the miner's contiguity guard relies on.
    mapping(uint256 => uint256) internal _requestNonce;

    /// @dev One-time initialization guard for {_initInboxBase}.
    bool private _initialized;

    error AlreadyInitialized();
    error NoActiveMessage();
    error InvalidSourceContract();
    error ReplyAlreadySent();
    error RequestNotFound();
    error OnlyTargetCanReply();
    error OriginalSenderNotFound();
    error NoErrorHandler();
    /// @notice {respond}/{raise} called while executing a one-way incoming request.
    error NotTwoWayMessage();
    /// @notice {respond} called but the incoming request has no `callbackSelector`.
    error NoCallbackHandler();
    /// @notice Return leg requested but prepaid `callerFee` is zero (nothing to fund the callback).
    error ZeroCallbackBudget();
    /// @notice Two-way send requires distinct non-zero `callbackSelector` and `errorSelector`.
    error InvalidTwoWaySelectors();
    error ErrorNotFound();
    error ResponseNotFound();
    error CannotSendToSameChain();
    error InvalidTargetContract();
    error InvalidRequestSender();
    error SourceChainIdTooLarge();
    error TargetChainIdTooLarge();
    error NonceTooLarge();
    error RawCallHasDatatypes();
    error RawCallHasDatalens();
    error MpcAbiReEncodeRequired();
    /// @notice Circuit breaker: outbound sends / inbound processing are paused.
    error MessageProcessingPaused();

    /// @notice Storage-free re-encode helper; Inbox DELEGATECALLs it (COTI). Zero on non-MPC chains.
    address public mpcAbiReEncode;

    /// @notice When true, outbound sends and inbound processing revert (circuit breaker).
    bool public messageProcessingPaused;

    /// @dev Overridden by {InboxEstimateGas} while an estimate is in flight.
    function _isEstimating() internal view virtual returns (bool) {
        return false;
    }

    /// @dev Overridden by {InboxEstimateGas} to suppress events during estimate.
    function _shouldEmit() internal view virtual returns (bool) {
        return true;
    }

    /// @dev Overridden by {InboxEstimateGas} to attribute respond/raise sizes during estimate.
    function _tagEstimateOutboundReply(bool) internal virtual {}

    /// @dev Overridden by {InboxEstimateGas} to accumulate tagged reply payload weight.
    function _accumulateEstimateOutboundIfTagged(uint256) internal virtual {}

    uint64 internal constant ERROR_CODE_EXECUTION_FAILED = 1;
    uint64 internal constant ERROR_CODE_ENCODE_FAILED = 2;
    /// @notice Miner rejected an inbound nonce via the special reject {MpcMethodCall} encoding.
    uint64 internal constant ERROR_CODE_MINER_REJECTED = 3;
    /// @notice Incoming request exceeded {maxMessageLife} while still execution-failed; terminalized on retry.
    uint64 internal constant ERROR_CODE_EXPIRED = 4;

    /// @notice Max bytes retained for execution or encode failure payloads (prefix only).
    /// @dev Unbounded returndata/encode reasons can OOG miner txs and wedge the contiguous nonce queue.
    uint256 public constant MAX_ERROR_RETURN_DATA = 256;

    /// @notice Placeholder `originalSender` for Inbox-generated system-error return legs (not a real contract).
    /// @dev Error callbacks must not require `inboxMsgSender()` to equal the COTI peer; use
    ///      {InboxUser.onlyInboxReturnLeg} (or transport `onlyInbox` + non-zero {inboxSourceRequestId})
    ///      and {inboxErrorType()}. System payload: {ErrorData}. Attribution via {SYSTEM_SENDER}.
    ///      Prefer {InboxUser.onlyInboxPeer} for success / peer entrypoints. Not retryable.
    address public constant SYSTEM_SENDER = address(uint160(uint256(keccak256("POD_INBOX_SYSTEM_SENDER"))));

    /// @notice Outbound cross-chain request was created.
    /// @dev Payload bytes are stored in {requests}; logs carry only compact metadata for gas efficiency.
    event MessageSent(
        bytes32 indexed requestId,
        uint256 indexed targetChainId,
        address indexed targetContract,
        bytes4 methodSelector,
        bytes32 methodCallHash,
        uint256 dataLength,
        uint16 datatypeCount,
        uint16 datalenCount,
        bytes4 callbackSelector,
        bytes4 errorSelector
    );

    /// @notice Incoming cross-chain request was accepted for execution.
    /// @dev Payload bytes are stored in {incomingRequests}; logs carry only compact metadata for gas efficiency.
    event MessageReceived(
        bytes32 indexed requestId,
        uint256 indexed sourceChainId,
        address indexed sourceContract,
        bytes4 methodSelector,
        bytes32 methodCallHash,
        uint256 dataLength,
        uint16 datatypeCount,
        uint16 datalenCount
    );

    /// @notice Target replied to an incoming request and a response request was created.
    event ResponseReceived(bytes32 indexed requestId, bytes response);

    /// @notice Target raised an application error for an incoming request.
    event RaiseReceived(bytes32 indexed incomingRequestId, bytes errorPayload);

    /// @notice Linked one-way return/error leg was received for an original outbound request.
    /// @dev Marks the original request `executed`. This means the return leg was ingested—not that the
    ///      application callback succeeded. Check return-leg `errors` / retries before treating it as final.
    ///      Prefer {ReturnLegCallbackSucceeded} for first-mine callback success (not emitted on retry recovery;
    ///      see that event's NatSpec and {RetryFailedRequestSuccess}).
    event IncomingResponseReceived(bytes32 indexed requestId, bytes32 indexed sourceRequestId);

    /// @notice Return-leg target call completed without recording an execution/encode error.
    /// @dev Emitted after {IncomingResponseReceived} only on the initial mine when the callback/error handler
    ///      subcall succeeded. Not emitted on a later successful {retryFailedRequest} — that path clears the
    ///      error and emits {RetryFailedRequestSuccess} instead. Indexers that need recovered return legs must
    ///      also watch that event (or empty `errors`). {IncomingResponseReceived} consumers are unchanged.
    event ReturnLegCallbackSucceeded(bytes32 indexed requestId, bytes32 indexed returnLegRequestId);

    /// @notice Request execution or encoding failed.
    event ErrorReceived(bytes32 indexed requestId, uint64 errorCode, bytes errorMessage);

    /// @notice Encode/system failure automatically raised an error callback to the source chain.
    /// @dev Payload is {ErrorData}; not eligible for {retryFailedRequest}.
    event SystemErrorRaised(bytes32 indexed requestId, uint64 errorCode, bytes payload);

    /// @notice Emitted after executing an incoming request. Values are gas units (same basis as `Request.targetFee`).
    /// @param gasUsed Gas used by the subcall (approximate).
    /// @param gasRemainingApprox Remaining gas budget from `targetFee` after the subcall (floored at zero).
    event FeeExecutionSettled(bytes32 indexed requestId, uint256 gasUsed, uint256 gasRemainingApprox);

    /// @dev One-time base initializer. Sets `chainId`, helpers, fee defaults, and trips the init guard.
    /// @param _chainId This chain's ID; pass `0` to use `block.chainid`.
    /// @param _mpcAbiReEncode COTI re-encode contract (`address(0)` on non-MPC chains).
    /// @param _feeManager Deployed {FeeManager} (required; DELEGATECALL target for fee logic).
    function _initInboxBase(uint256 _chainId, address _mpcAbiReEncode, address _feeManager) internal {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        chainId = _chainId == 0 ? block.chainid : _chainId;
        mpcAbiReEncode = _mpcAbiReEncode;
        if (_feeManager == address(0)) revert ModuleNotConfigured(_feeManager);
        feeManager = _feeManager;
        _ensureFeeDefaults();
    }

    /// @inheritdoc IInbox
    /// @dev `targetChainId` is not allowlisted — integrators must pass a supported PoD lane id.
    ///      Wrong ids strand fees on an unroutable lane (user footgun, not an attacker-introduced risk).
    function sendTwoWayMessage(
        uint256 targetChainId,
        address targetContract,
        MpcMethodCall calldata methodCall,
        bytes4 callbackSelector,
        bytes4 errorSelector,
        uint256 callbackFeeLocalWei
    ) external payable virtual returns (bytes32 requestId) {
        if (messageProcessingPaused) revert MessageProcessingPaused();
        if (callbackSelector == bytes4(0) || errorSelector == bytes4(0) || callbackSelector == errorSelector) {
            revert InvalidTwoWaySelectors();
        }
        uint256 dataSize = abi.encode(methodCall).length;
        (uint256 targetFeeGas, uint256 callerFeeGas) =
            _validateAndPrepareTwoWayFees(dataSize, msg.value, callbackFeeLocalWei);
        requestId = _sendTwoWayMessage(
            targetChainId, targetContract, methodCall, callbackSelector, errorSelector, targetFeeGas, callerFeeGas
        );
        // Best-effort: must not revert a paid send (EIP-150 63/64 can OOG nested refresh under tight gas).
        try priceOracle().refreshCache() {} catch {}
    }

    /// @inheritdoc IInbox
    /// @dev `targetChainId` is not allowlisted — see {sendTwoWayMessage}.
    function sendOneWayMessage(
        uint256 targetChainId,
        address targetContract,
        MpcMethodCall calldata methodCall,
        bytes4 errorSelector
    ) external payable returns (bytes32 requestId) {
        if (messageProcessingPaused) revert MessageProcessingPaused();
        if (errorSelector != bytes4(0)) {
            revert OneWayErrorSelectorNotSupported(errorSelector);
        }
        uint256 dataSize = abi.encode(methodCall).length;
        uint256 targetFeeGas = _validateAndPrepareOneWayFees(dataSize, msg.value);
        requestId = _sendOneWayMessage(
            targetChainId, targetContract, methodCall, bytes4(0), bytes32(0), targetFeeGas, 0, msg.sender
        );
        // Best-effort: must not revert a paid send (EIP-150 63/64 can OOG nested refresh under tight gas).
        try priceOracle().refreshCache() {} catch {}
    }

    /// @inheritdoc IInbox
    /// @dev Requires a two-way incoming request with a non-zero `callbackSelector`.
    function respond(bytes memory data) external {
        _reply(false, data);
    }

    /// @inheritdoc IInbox
    /// @dev Requires a two-way incoming request with a non-zero `errorSelector`.
    function raise(bytes memory data) external {
        _reply(true, data);
    }

    /// @dev Shared respond/raise path. `isRaise` selects errorSelector vs callbackSelector.
    function _reply(bool isRaise, bytes memory data) private {
        ExecutionContext memory currentContext = _currentContext;
        if (currentContext.requestId == bytes32(0) || currentContext.remoteChainId == 0) {
            revert NoActiveMessage();
        }

        bytes32 incomingRequestId = currentContext.requestId;
        if (inboxResponses[incomingRequestId].responseRequestId != bytes32(0)) {
            revert ReplyAlreadySent();
        }

        Request storage incomingRequest = incomingRequests[incomingRequestId];
        if (incomingRequest.requestId == bytes32(0)) revert RequestNotFound();
        if (msg.sender != incomingRequest.targetContract) revert OnlyTargetCanReply();
        if (!incomingRequest.isTwoWay) revert NotTwoWayMessage();
        if (incomingRequest.callerFee == 0) revert ZeroCallbackBudget();
        if (isRaise && incomingRequest.errorSelector == bytes4(0)) revert NoErrorHandler();
        if (!isRaise && incomingRequest.callbackSelector == bytes4(0)) revert NoCallbackHandler();

        bytes4 replySelector = isRaise ? incomingRequest.errorSelector : incomingRequest.callbackSelector;
        MpcMethodCall memory replyMethodCall = MpcMethodCall({
            selector: bytes4(0),
            data: abi.encodeWithSelector(replySelector, data),
            datatypes: new bytes8[](0),
            datalens: new bytes32[](0)
        });
        _requireReplyMethodCallBounded(replyMethodCall);

        address originalSenderContract = incomingRequest.originalSender;
        if (originalSenderContract == address(0)) revert OriginalSenderNotFound();

        _tagEstimateOutboundReply(isRaise);
        bytes32 outboundRequestId = _sendOneWayMessage(
            currentContext.remoteChainId,
            originalSenderContract,
            replyMethodCall,
            incomingRequest.errorSelector,
            incomingRequestId,
            incomingRequest.callerFee,
            0,
            msg.sender
        );

        inboxResponses[incomingRequestId] = Response({responseRequestId: outboundRequestId, response: data});

        if (_shouldEmit()) {
            if (isRaise) emit RaiseReceived(incomingRequestId, data);
            else emit ResponseReceived(incomingRequestId, data);
        }
    }

    /// @inheritdoc IInbox
    /// @dev Returns the stored `errorMessage` bytes as-is. For execution/encode failures that is the
    ///      first ≤{MAX_ERROR_RETURN_DATA} bytes of the failure payload. Decode in the client.
    function getOutboxError(bytes32 requestId) external view returns (uint256 code, bytes memory data) {
        Error memory err = errors[requestId];
        if (err.requestId == bytes32(0)) revert ErrorNotFound();
        return (err.errorCode, err.errorMessage);
    }

    /// @inheritdoc IInbox
    function getInboxResponse(bytes32 requestId) external view returns (bytes memory) {
        Response memory response = inboxResponses[requestId];
        if (response.responseRequestId == bytes32(0)) revert ResponseNotFound();
        return response.response;
    }

    /// @inheritdoc IInbox
    function getRequests(uint256 targetChainId, uint256 from, uint256 len)
        external
        view
        returns (Request[] memory)
    {
        if (len == 0) {
            return new Request[](0);
        }

        uint256 total = _requestNonce[targetChainId];
        if (total == 0 || from >= total) {
            return new Request[](0);
        }

        uint256 remaining = total - from;
        uint256 actualLen = len > remaining ? remaining : len;
        Request[] memory result = new Request[](actualLen);
        uint256 localChainId = chainId;

        for (uint256 i = 0; i < actualLen;) {
            uint256 nonce = from + i + 1;
            bytes32 requestId = _packRequestId(localChainId, targetChainId, nonce);
            result[i] = requests[requestId];
            unchecked {
                ++i;
            }
        }

        return result;
    }

    /// @inheritdoc IInbox
    function getRequestsLen(uint256 targetChainId) external view returns (uint256) {
        return _requestNonce[targetChainId];
    }

    /// @inheritdoc IInbox
    function getRequest(bytes32 requestId) external view returns (Request memory) {
        return requests[requestId];
    }

    /// @inheritdoc IInbox
    function getIncomingRequest(bytes32 requestId) external view returns (Request memory) {
        return incomingRequests[requestId];
    }

    /// @inheritdoc IInbox
    function inboxMsgSender() external view returns (uint256 chainId_, address contractAddress) {
        if (_currentContext.remoteChainId == 0 || _currentContext.requestId == bytes32(0)) revert NoActiveMessage();

        return (_currentContext.remoteChainId, _currentContext.remoteContract);
    }

    /// @inheritdoc IInbox
    function inboxRequestId() external view returns (bytes32) {
        if (_currentContext.requestId == bytes32(0)) revert NoActiveMessage();
        return _currentContext.requestId;
    }

    /// @inheritdoc IInbox
    function inboxSourceRequestId() external view returns (bytes32) {
        if (_currentContext.requestId == bytes32(0)) revert NoActiveMessage();
        return incomingRequests[_currentContext.requestId].sourceRequestId;
    }

    /// @inheritdoc IInbox
    function inboxErrorType() external view returns (InboxErrorType) {
        bytes32 requestId = _currentContext.requestId;
        if (requestId == bytes32(0) || _currentContext.remoteChainId == 0) {
            return InboxErrorType.NotErrorContext;
        }

        Request storage incoming = incomingRequests[requestId];
        if (incoming.requestId == bytes32(0)) {
            return InboxErrorType.NotErrorContext;
        }

        // System-error return legs are attributed to {SYSTEM_SENDER}, not the COTI target.
        if (incoming.originalSender == SYSTEM_SENDER) {
            return InboxErrorType.SystemError;
        }

        bytes32 sourceRequestId = incoming.sourceRequestId;
        if (sourceRequestId == bytes32(0)) {
            return InboxErrorType.NotErrorContext;
        }

        Request storage original = requests[sourceRequestId];
        if (original.requestId == bytes32(0) || original.errorSelector == bytes4(0)) {
            return InboxErrorType.NotErrorContext;
        }

        // Linked return leg for a request that registered an error handler (app `raise`).
        // Only Inbox creates linked legs (`raise` / `respond` / system-error); public sends use `sourceRequestId = 0`.
        return InboxErrorType.Exception;
    }

    /// @inheritdoc IInbox
    function getRequestId(uint256 sourceChainId, uint256 targetChainId, uint256 nonce)
        external
        pure
        returns (bytes32)
    {
        return _packRequestId(sourceChainId, targetChainId, nonce);
    }

    /// @inheritdoc IInbox
    function unpackRequestId(bytes32 requestId)
        external
        pure
        returns (uint256 sourceChainId, uint256 targetChainId, uint256 nonce)
    {
        return _unpackRequestId(requestId);
    }

    /// @dev Creates a two-way outbound request.
    function _sendTwoWayMessage(
        uint256 targetChainId,
        address targetContract,
        MpcMethodCall memory methodCall,
        bytes4 callbackSelector,
        bytes4 errorSelector,
        uint256 targetFeeGas,
        uint256 callerFeeGas
    ) internal returns (bytes32) {
        return _createRequest(
            targetChainId,
            targetContract,
            methodCall,
            callbackSelector,
            errorSelector,
            true,
            bytes32(0),
            targetFeeGas,
            callerFeeGas,
            msg.sender
        );
    }

    /// @dev Creates a one-way outbound request (including responses/errors).
    /// @param requestSender Attributed sender stored as `originalSender` / `callerContract`
    ///        (normally `msg.sender`; {SYSTEM_SENDER} for Inbox system-error return legs).
    function _sendOneWayMessage(
        uint256 targetChainId,
        address targetContract,
        MpcMethodCall memory methodCall,
        bytes4 errorSelector,
        bytes32 sourceRequestId,
        uint256 targetFeeGas,
        uint256 callerFeeGas,
        address requestSender
    ) internal returns (bytes32) {
        return _createRequest(
            targetChainId,
            targetContract,
            methodCall,
            bytes4(0),
            errorSelector,
            false,
            sourceRequestId,
            targetFeeGas,
            callerFeeGas,
            requestSender
        );
    }

    /// @dev Creates and stores a request and emits {MessageSent}.
    function _createRequest(
        uint256 targetChainId,
        address targetContract,
        MpcMethodCall memory methodCall,
        bytes4 callbackSelector,
        bytes4 errorSelector,
        bool isTwoWay,
        bytes32 sourceRequestId,
        uint256 targetFeeGas,
        uint256 callerFeeGas,
        address requestSender
    ) internal returns (bytes32) {
        if (targetChainId == chainId) revert CannotSendToSameChain();
        if (targetContract == address(0)) revert InvalidTargetContract();
        if (requestSender == address(0)) revert InvalidRequestSender();

        FeeConfig memory remoteMax = _remoteMinFeeConfigMem();
        uint256 weight = MinerRejectLib.structuralSize(methodCall);
        if (weight > remoteMax.maxMethodCallBytes) {
            revert MethodCallTooLarge(weight, remoteMax.maxMethodCallBytes);
        }
        if (targetFeeGas > remoteMax.maxExecutionGas) {
            revert FeeGasTooHigh(targetFeeGas, remoteMax.maxExecutionGas);
        }
        FeeConfig memory localMax = _localMinFeeConfigMem();
        if (callerFeeGas > localMax.maxExecutionGas) {
            revert FeeGasTooHigh(callerFeeGas, localMax.maxExecutionGas);
        }

        _accumulateEstimateOutboundIfTagged(weight);

        uint256 nonce = ++_requestNonce[targetChainId];

        bytes32 requestId = _packRequestId(chainId, targetChainId, nonce);

        Request memory request = Request({
            requestId: requestId,
            targetChainId: targetChainId,
            targetContract: targetContract,
            methodCall: methodCall,
            callerContract: requestSender,
            originalSender: requestSender,
            timestamp: uint64(block.timestamp),
            callbackSelector: callbackSelector,
            errorSelector: errorSelector,
            isTwoWay: isTwoWay,
            executed: false,
            sourceRequestId: sourceRequestId,
            targetFee: targetFeeGas,
            callerFee: callerFeeGas
        });

        requests[requestId] = request;

        if (_shouldEmit()) {
            (
                bytes4 methodSelector,
                bytes32 methodCallHash,
                uint256 dataLength,
                uint16 datatypeCount,
                uint16 datalenCount
            ) = _methodCallLogData(methodCall);
            emit MessageSent(
                requestId,
                targetChainId,
                targetContract,
                methodSelector,
                methodCallHash,
                dataLength,
                datatypeCount,
                datalenCount,
                callbackSelector,
                errorSelector
            );
        }
        return requestId;
    }

    /// @dev Auto-deliver a system-error payload on the same `errorSelector(bytes)` path as {raise}.
    ///      Source handlers branch with {inboxErrorType()} ({SystemError} vs {Exception}).
    function _sendSystemErrorCallback(Request storage incomingRequest, bytes memory encodeErr) internal {
        bytes memory errorMessage = encodeErr.length == 0
            ? abi.encodePacked("enc")
            : encodeErr;
        _sendSystemErrorCallbackWithCode(incomingRequest, ERROR_CODE_ENCODE_FAILED, errorMessage);
    }

    /// @dev System-error return leg with an explicit error code (encode failure, miner reject, …).
    ///      When `callerFee` is zero (typical one-way), records a local {SystemErrorRaised} only — no outbound.
    function _sendSystemErrorCallbackWithCode(
        Request storage incomingRequest,
        uint64 errorCode,
        bytes memory errorMessage
    ) internal {
        if (incomingRequest.errorSelector == bytes4(0)) {
            return;
        }
        if (inboxResponses[incomingRequest.requestId].responseRequestId != bytes32(0)) {
            return;
        }

        address sourceApp = incomingRequest.originalSender;
        if (sourceApp == address(0)) {
            return;
        }

        bytes memory payload = abi.encode(errorCode, errorMessage);

        // No prepaid callback budget → surface locally; do not burn a zero-gas return-leg nonce.
        if (incomingRequest.callerFee == 0) {
            if (_shouldEmit()) {
                emit SystemErrorRaised(incomingRequest.requestId, errorCode, payload);
            }
            return;
        }

        MpcMethodCall memory errorMethodCall = MpcMethodCall({
            selector: bytes4(0),
            data: abi.encodeWithSelector(incomingRequest.errorSelector, payload),
            datatypes: new bytes8[](0),
            datalens: new bytes32[](0)
        });

        _tagEstimateOutboundReply(true);
        // Attribute to {SYSTEM_SENDER}, not the intended COTI target (do not impersonate the peer).
        bytes32 outboundRequestId = _sendOneWayMessage(
            incomingRequest.targetChainId,
            sourceApp,
            errorMethodCall,
            incomingRequest.errorSelector,
            incomingRequest.requestId,
            incomingRequest.callerFee,
            0,
            SYSTEM_SENDER
        );

        inboxResponses[incomingRequest.requestId] =
            Response({responseRequestId: outboundRequestId, response: payload});
        if (_shouldEmit()) {
            emit SystemErrorRaised(incomingRequest.requestId, errorCode, payload);
        }
    }

    /// @dev Enforce {maxReplyMethodCallBytes} on respond/raise return legs.
    function _requireReplyMethodCallBounded(MpcMethodCall memory methodCall) internal view {
        uint256 weight = MinerRejectLib.structuralSize(methodCall);
        uint256 maxBytes = maxReplyMethodCallBytes();
        if (weight > maxBytes) {
            revert ResponseOutOfBounds(weight, maxBytes);
        }
    }

    /// @dev Compact log metadata for {MessageSent} and {MessageReceived}.
    function _methodCallLogData(MpcMethodCall memory methodCall)
        internal
        pure
        returns (
            bytes4 methodSelector,
            bytes32 methodCallHash,
            uint256 dataLength,
            uint16 datatypeCount,
            uint16 datalenCount
        )
    {
        methodSelector = methodCall.selector;
        methodCallHash = keccak256(abi.encode(methodCall));
        dataLength = methodCall.data.length;
        datatypeCount = uint16(methodCall.datatypes.length);
        datalenCount = uint16(methodCall.datalens.length);
    }

    /// @dev Packs source chain id (64 bits), target chain id (64 bits) and nonce (128 bits) into a
    /// `bytes32` request id. Encoding both chain ids makes the id globally unique and lets either
    /// side recover its routing from the id alone.
    function _packRequestId(uint256 sourceChainId, uint256 targetChainId, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        if (sourceChainId > type(uint64).max) revert SourceChainIdTooLarge();
        if (targetChainId > type(uint64).max) revert TargetChainIdTooLarge();
        if (nonce > type(uint128).max) revert NonceTooLarge();
        return bytes32(
            (uint256(uint64(sourceChainId)) << 192) | (uint256(uint64(targetChainId)) << 128)
                | uint256(uint128(nonce))
        );
    }

    /// @dev Unpacks a request id from {_packRequestId} into source chain id, target chain id and nonce.
    function _unpackRequestId(bytes32 requestId)
        internal
        pure
        returns (uint256 sourceChainId, uint256 targetChainId, uint256 nonce)
    {
        uint256 packed = uint256(requestId);
        sourceChainId = uint256(uint64(packed >> 192));
        targetChainId = uint256(uint64(packed >> 128));
        nonce = uint256(uint128(packed));
    }

    /// @dev Raw calldata passthrough if selector is zero; otherwise DELEGATECALL {MpcAbiReEncode}.
    function _encodeMethodCall(MpcMethodCall memory methodCall) internal returns (bytes memory) {
        if (methodCall.selector == bytes4(0)) {
            if (methodCall.datatypes.length != 0) revert RawCallHasDatatypes();
            if (methodCall.datalens.length != 0) revert RawCallHasDatalens();
            return methodCall.data;
        }
        return _delegateReEncodeWithGt(methodCall);
    }

    /// @dev Non-reverting encode wrapper for inbound execution.
    function _safeEncodeMethodCall(MpcMethodCall memory methodCall)
        internal
        returns (bool ok, bytes memory callData, bytes memory err)
    {
        if (methodCall.selector == bytes4(0)) {
            if (methodCall.datatypes.length != 0) {
                return (false, new bytes(0), abi.encodeWithSignature("Error(string)", "dt"));
            }
            if (methodCall.datalens.length != 0) {
                return (false, new bytes(0), abi.encodeWithSignature("Error(string)", "dl"));
            }
            return (true, methodCall.data, new bytes(0));
        }
        address target = mpcAbiReEncode;
        if (target == address(0)) {
            return (false, new bytes(0), abi.encodeWithSelector(MpcAbiReEncodeRequired.selector));
        }
        (bool success, bytes memory ret) = target.delegatecall(
            abi.encodeWithSelector(MpcAbiReEncode.reEncodeWithGt.selector, methodCall)
        );
        if (!success) {
            return (false, new bytes(0), ret);
        }
        // abi.decode can revert on malformed returndata; assembly decode keeps the batch path non-reverting
        // without an external try/catch helper (create-size).
        (bool decodedOk, bytes memory decoded) = _tryDecodeAbiBytes(ret);
        if (!decodedOk) {
            return (false, new bytes(0), ret);
        }
        return (true, decoded, new bytes(0));
    }

    /// @dev Non-reverting `abi.decode(ret, (bytes))` for re-encode returndata.
    ///      Returns a pointer into `ret` (no copy) when layout is the standard `abi.encode(bytes)` shape.
    function _tryDecodeAbiBytes(bytes memory ret) private pure returns (bool ok, bytes memory decoded) {
        assembly ("memory-safe") {
            let retLen := mload(ret)
            // Need offset + length words.
            if gt(retLen, 0x3f) {
                let dataPtr := add(ret, 0x20)
                // Standard abi.encode(bytes) uses offset 0x20; reject other layouts to keep this tiny.
                if eq(mload(dataPtr), 0x20) {
                    let len := mload(add(dataPtr, 0x20))
                    // Content must fit (ignore ABI right-padding).
                    if iszero(gt(add(0x40, len), retLen)) {
                        ok := 1
                        // `bytes` memory layout is length || data — already at offset 0x20 of the payload.
                        decoded := add(dataPtr, 0x20)
                    }
                }
            }
        }
    }

    function _delegateReEncodeWithGt(MpcMethodCall memory methodCall) private returns (bytes memory) {
        address target = mpcAbiReEncode;
        if (target == address(0)) revert MpcAbiReEncodeRequired();
        (bool success, bytes memory ret) = target.delegatecall(
            abi.encodeWithSelector(MpcAbiReEncode.reEncodeWithGt.selector, methodCall)
        );
        if (!success) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        return abi.decode(ret, (bytes));
    }

    /// @dev Records an encode failure and emits {ErrorReceived}.
    ///      `encodeErr` is truncated to {MAX_ERROR_RETURN_DATA} (same bound as execution returndata).
    /// @return errorMessage Capped payload stored/emitted (also for system error callbacks).
    function _recordEncodeError(bytes32 requestId, bytes memory encodeErr)
        internal
        returns (bytes memory errorMessage)
    {
        errorMessage = _capErrorReturnData(
            encodeErr.length == 0 ? abi.encodePacked("enc") : encodeErr
        );
        Error memory err = Error({
            requestId: requestId,
            errorCode: ERROR_CODE_ENCODE_FAILED,
            errorMessage: errorMessage
        });
        errors[requestId] = err;
        if (_shouldEmit()) {
            emit ErrorReceived(requestId, ERROR_CODE_ENCODE_FAILED, errorMessage);
        }
    }

    /// @dev Prefix-truncate `data` to at most {MAX_ERROR_RETURN_DATA} bytes.
    ///      Mutates `data` length in place (no copy) — safe for temporary encode/call failure buffers.
    ///      Execution failures must use {_callWithCappedReturnData} so returndata is never fully materialized.
    function _capErrorReturnData(bytes memory data) internal pure returns (bytes memory) {
        uint256 maxLen = MAX_ERROR_RETURN_DATA;
        assembly {
            if gt(mload(data), maxLen) { mstore(data, maxLen) }
        }
        return data;
    }

    /// @dev Low-level call that never retains more than {MAX_ERROR_RETURN_DATA} bytes of returndata.
    ///      On failure, `returnData` is the first ≤256 bytes (same bound as {_capErrorReturnData}).
    function _callWithCappedReturnData(address target, uint256 gasBudget, bytes memory callData)
        internal
        returns (bool success, bytes memory returnData)
    {
        uint256 fullLength;
        assembly {
            let dataPtr := add(callData, 32)
            let dataLen := mload(callData)
            success := call(gasBudget, target, 0, dataPtr, dataLen, 0, 0)
            fullLength := returndatasize()
        }

        if (success) {
            return (true, new bytes(0));
        }

        // Cap at copy time — do not load full returndata then {_capErrorReturnData}.
        uint256 copyLen = fullLength > MAX_ERROR_RETURN_DATA ? MAX_ERROR_RETURN_DATA : fullLength;
        returnData = new bytes(copyLen);
        assembly {
            returndatacopy(add(returnData, 32), 0, copyLen)
        }
    }
}
