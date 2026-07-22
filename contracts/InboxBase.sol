// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "./fee/InboxFeeManager.sol";
import "./IInbox.sol";
import "./mpccodec/MpcAbiCodec.sol";

/// @title InboxBase
/// @notice Core inbox: outbound requests, inbound execution context, responses, errors, and MPC calldata encoding.
/// @dev Mixed with {InboxFeeManager}. Subcontracts add miner and ownership behavior.
contract InboxBase is IInbox, InboxFeeManager {
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

    uint64 internal constant ERROR_CODE_EXECUTION_FAILED = 1;
    uint64 internal constant ERROR_CODE_ENCODE_FAILED = 2;

    /// @notice Placeholder `originalSender` for Inbox-generated system-error return legs (not a real contract).
    /// @dev Error callbacks must not require `inboxMsgSender()` to equal the COTI peer; use {onlyInbox} +
    ///      {inboxErrorType()} / non-zero {inboxSourceRequestId} (set only by {raise} / system-error delivery).
    ///      System payload: {ErrorData} (`errorCode`, `message`). Attribution via {SYSTEM_SENDER}. Not retryable.
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
    event IncomingResponseReceived(bytes32 indexed requestId, bytes32 indexed sourceRequestId);

    /// @notice Request execution or encoding failed.
    event ErrorReceived(bytes32 indexed requestId, uint64 errorCode, bytes errorMessage);

    /// @notice Encode/system failure automatically raised an error callback to the source chain.
    /// @dev Payload is {ErrorData}; not eligible for {retryFailedRequest}.
    event SystemErrorRaised(bytes32 indexed requestId, uint64 errorCode, bytes payload);

    /// @notice Emitted after executing an incoming request. Values are gas units (same basis as `Request.targetFee`).
    /// @param gasUsed Gas used by the subcall (approximate).
    /// @param gasRemainingApprox Remaining gas budget from `targetFee` after the subcall (floored at zero).
    event FeeExecutionSettled(bytes32 indexed requestId, uint256 gasUsed, uint256 gasRemainingApprox);

    /// @dev One-time base initializer. Sets `chainId` and trips the init guard.
    /// @param _chainId This chain's ID; pass `0` to use `block.chainid`.
    function _initInboxBase(uint256 _chainId) internal {
        require(!_initialized, "Inbox: initialized");
        _initialized = true;
        chainId = _chainId == 0 ? block.chainid : _chainId;
    }

    /// @inheritdoc IInbox
    function sendTwoWayMessage(
        uint256 targetChainId,
        address targetContract,
        MpcMethodCall calldata methodCall,
        bytes4 callbackSelector,
        bytes4 errorSelector,
        uint256 callbackFeeLocalWei
    ) external payable virtual returns (bytes32 requestId) {
        uint256 dataSize = abi.encode(methodCall).length;
        (uint256 targetFeeGas, uint256 callerFeeGas) =
            validateAndPrepareTwoWayFees(dataSize, msg.value, callbackFeeLocalWei);
        requestId = _sendTwoWayMessage(
            targetChainId, targetContract, methodCall, callbackSelector, errorSelector, targetFeeGas, callerFeeGas
        );
        // Best-effort: must not revert a paid send (EIP-150 63/64 can OOG nested refresh under tight gas).
        try priceOracle.refreshCache() {} catch {}
    }

    /// @inheritdoc IInbox
    function sendOneWayMessage(
        uint256 targetChainId,
        address targetContract,
        MpcMethodCall calldata methodCall,
        bytes4 errorSelector
    ) external payable returns (bytes32 requestId) {
        if (errorSelector != bytes4(0)) {
            revert OneWayErrorSelectorNotSupported(errorSelector);
        }
        uint256 dataSize = abi.encode(methodCall).length;
        uint256 targetFeeGas = validateAndPrepareOneWayFees(dataSize, msg.value);
        requestId = _sendOneWayMessage(
            targetChainId, targetContract, methodCall, bytes4(0), bytes32(0), targetFeeGas, 0, msg.sender
        );
        // Best-effort: must not revert a paid send (EIP-150 63/64 can OOG nested refresh under tight gas).
        try priceOracle.refreshCache() {} catch {}
    }

    /// @inheritdoc IInbox
    function respond(bytes memory data) external {
        ExecutionContext memory currentContext = _currentContext;
        require(currentContext.requestId != bytes32(0), "Inbox: no active message");
        require(currentContext.remoteChainId != 0, "Inbox: no active message");

        bytes32 incomingRequestId = currentContext.requestId;
        require(inboxResponses[incomingRequestId].responseRequestId == bytes32(0), "Inbox: reply already sent");

        Request storage incomingRequest = incomingRequests[incomingRequestId];
        require(incomingRequest.requestId != bytes32(0), "Inbox: request not found");
        require(msg.sender == incomingRequest.targetContract, "Inbox: only target can reply");

        MpcMethodCall memory responseMethodCall = MpcMethodCall({
            selector: bytes4(0),
            data: abi.encodeWithSelector(incomingRequest.callbackSelector, data),
            datatypes: new bytes8[](0),
            datalens: new bytes32[](0)
        });

        address originalSenderContract = incomingRequest.originalSender;
        require(originalSenderContract != address(0), "Inbox: original sender not found");

        bytes32 responseRequestId = _sendOneWayMessage(
            currentContext.remoteChainId,
            originalSenderContract,
            responseMethodCall,
            incomingRequest.errorSelector,
            incomingRequestId,
            incomingRequest.callerFee,
            0,
            msg.sender
        );

        inboxResponses[incomingRequestId] = Response({responseRequestId: responseRequestId, response: data});

        emit ResponseReceived(incomingRequestId, data);
    }

    /// @inheritdoc IInbox
    function raise(bytes memory data) external {
        ExecutionContext memory currentContext = _currentContext;
        require(currentContext.requestId != bytes32(0), "Inbox: no active message");
        require(currentContext.remoteChainId != 0, "Inbox: no active message");

        bytes32 incomingRequestId = currentContext.requestId;
        require(inboxResponses[incomingRequestId].responseRequestId == bytes32(0), "Inbox: reply already sent");

        Request storage incomingRequest = incomingRequests[incomingRequestId];
        require(incomingRequest.requestId != bytes32(0), "Inbox: request not found");
        require(msg.sender == incomingRequest.targetContract, "Inbox: only target can reply");
        require(incomingRequest.errorSelector != bytes4(0), "Inbox: no error handler");

        MpcMethodCall memory errorMethodCall = MpcMethodCall({
            selector: bytes4(0),
            data: abi.encodeWithSelector(incomingRequest.errorSelector, data),
            datatypes: new bytes8[](0),
            datalens: new bytes32[](0)
        });

        address originalSenderContract = incomingRequest.originalSender;
        require(originalSenderContract != address(0), "Inbox: original sender not found");

        bytes32 outboundRequestId = _sendOneWayMessage(
            currentContext.remoteChainId,
            originalSenderContract,
            errorMethodCall,
            incomingRequest.errorSelector,
            incomingRequestId,
            incomingRequest.callerFee,
            0,
            msg.sender
        );

        inboxResponses[incomingRequestId] = Response({responseRequestId: outboundRequestId, response: data});

        emit RaiseReceived(incomingRequestId, data);
    }

    /// @inheritdoc IInbox
    /// @dev Returns the stored `errorMessage` bytes as-is. For execution failures (code 1) that is the
    ///      first ≤{InboxMiner.MAX_ERROR_RETURN_DATA} bytes of returndata (POD-02). Decode in the client.
    function getOutboxError(bytes32 requestId) external view returns (uint256 code, bytes memory data) {
        Error memory err = errors[requestId];
        require(err.requestId != bytes32(0), "Inbox: error not found");
        return (err.errorCode, err.errorMessage);
    }

    /// @inheritdoc IInbox
    function getInboxResponse(bytes32 requestId) external view returns (bytes memory) {
        Response memory response = inboxResponses[requestId];
        require(response.responseRequestId != bytes32(0), "Inbox: response not found");
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
        require(_currentContext.remoteChainId != 0, "Inbox: no active message");
        require(_currentContext.requestId != bytes32(0), "Inbox: no active message");

        return (_currentContext.remoteChainId, _currentContext.remoteContract);
    }

    /// @inheritdoc IInbox
    function inboxRequestId() external view returns (bytes32) {
        require(_currentContext.requestId != bytes32(0), "Inbox: no active message");
        return _currentContext.requestId;
    }

    /// @inheritdoc IInbox
    function inboxSourceRequestId() external view returns (bytes32) {
        require(_currentContext.requestId != bytes32(0), "Inbox: no active message");
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

    /// @dev Exposed for try/catch around {_encodeMethodCall}; self-call only.
    function _encodeMethodCallExternal(MpcMethodCall calldata methodCall) external returns (bytes memory) {
        require(msg.sender == address(this), "Inbox: only self");
        return _encodeMethodCall(methodCall);
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
        require(targetChainId != chainId, "Inbox: cannot send to same chain");
        require(targetContract != address(0), "Inbox: invalid target contract");
        require(requestSender != address(0), "Inbox: invalid request sender");

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
        return requestId;
    }

    /// @dev Auto-deliver a system-error payload on the same `errorSelector(bytes)` path as {raise}.
    ///      Source handlers branch with {inboxErrorType()} ({SystemError} vs {Exception}).
    function _sendSystemErrorCallback(Request storage incomingRequest, bytes memory encodeErr) internal {
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

        bytes memory errorMessage = encodeErr.length == 0
            ? abi.encodePacked("Inbox: encodeMethodCall failed")
            : encodeErr;
        bytes memory payload = abi.encode(ERROR_CODE_ENCODE_FAILED, errorMessage);

        MpcMethodCall memory errorMethodCall = MpcMethodCall({
            selector: bytes4(0),
            data: abi.encodeWithSelector(incomingRequest.errorSelector, payload),
            datatypes: new bytes8[](0),
            datalens: new bytes32[](0)
        });

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
        emit SystemErrorRaised(incomingRequest.requestId, ERROR_CODE_ENCODE_FAILED, payload);
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
        require(sourceChainId <= type(uint64).max, "Inbox: sourceChainId too large");
        require(targetChainId <= type(uint64).max, "Inbox: targetChainId too large");
        require(nonce <= type(uint128).max, "Inbox: nonce too large");
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

    /// @dev Raw calldata passthrough if selector is zero; otherwise MPC re-encode via {MpcAbiCodec}.
    function _encodeMethodCall(MpcMethodCall memory methodCall) internal returns (bytes memory) {
        if (methodCall.selector == bytes4(0)) {
            require(methodCall.datatypes.length == 0, "Inbox: raw call has datatypes");
            require(methodCall.datalens.length == 0, "Inbox: raw call has datalens");
            return methodCall.data;
        }

        IInbox.MpcMethodCall memory codecCall = IInbox.MpcMethodCall({
            selector: methodCall.selector,
            data: methodCall.data,
            datatypes: methodCall.datatypes,
            datalens: methodCall.datalens
        });

        return MpcAbiCodec.reEncodeWithGt(codecCall);
    }

    /// @dev Non-reverting encode wrapper for inbound execution.
    function _safeEncodeMethodCall(MpcMethodCall memory methodCall)
        internal
        returns (bool ok, bytes memory callData, bytes memory err)
    {
        if (methodCall.selector == bytes4(0)) {
            if (methodCall.datatypes.length != 0) {
                return (false, new bytes(0), abi.encodeWithSignature("Error(string)", "Inbox: raw call has datatypes"));
            }
            if (methodCall.datalens.length != 0) {
                return (false, new bytes(0), abi.encodeWithSignature("Error(string)", "Inbox: raw call has datalens"));
            }
            return (true, methodCall.data, new bytes(0));
        }
        try this._encodeMethodCallExternal(methodCall) returns (bytes memory data) {
            return (true, data, new bytes(0));
        } catch (bytes memory reason) {
            return (false, new bytes(0), reason);
        }
    }

    /// @dev Records an encode failure and emits {ErrorReceived}.
    function _recordEncodeError(bytes32 requestId, bytes memory encodeErr) internal {
        bytes memory errorMessage = encodeErr.length == 0
            ? abi.encodePacked("Inbox: encodeMethodCall failed")
            : encodeErr;
        Error memory err = Error({
            requestId: requestId,
            errorCode: ERROR_CODE_ENCODE_FAILED,
            errorMessage: errorMessage
        });
        errors[requestId] = err;
        emit ErrorReceived(requestId, ERROR_CODE_ENCODE_FAILED, errorMessage);
    }
}
