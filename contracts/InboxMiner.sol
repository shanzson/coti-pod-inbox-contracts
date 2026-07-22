// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./IInboxMiner.sol";
import "./InboxBase.sol";
import "./MinerBase.sol";

/// @title InboxMiner
/// @notice Miner-driven inbox: ingest mined payloads, execute targets, and collect fees.
abstract contract InboxMiner is InboxBase, MinerBase, IInboxMiner, ReentrancyGuard {
    /// @notice Max bytes of target returndata retained on failure (prefix only).
    /// @dev Full payload is hashed; storing unbounded returndata can OOG the miner tx and wedge the
    ///      contiguous incoming-nonce queue (POD-02).
    uint256 public constant MAX_ERROR_RETURN_DATA = 256;

    /// @notice Gas reserved after the target subcall so failure accounting can always commit.
    uint256 private constant POST_CALL_GAS_RESERVE = 100_000;

    /// @notice When true, {batchProcessRequests} and {retryFailedRequest} revert (circuit breaker).
    bool public messageProcessingPaused;

    /// @notice Pause or unpause inbound message processing (owner-only emergency stop).
    /// @param paused True to halt {batchProcessRequests} and {retryFailedRequest}.
    function setMessageProcessingPaused(bool paused) external onlyOwner {
        messageProcessingPaused = paused;
        emit MessageProcessingPausedUpdated(paused);
    }

    /// @inheritdoc IInboxMiner
    function batchProcessRequests(uint256 sourceChainId, MinedRequest[] memory mined)
        external
        onlyMiner
        nonReentrant
    {
        if (messageProcessingPaused) {
            revert MessageProcessingPaused();
        }
        if (sourceChainId == chainId) {
            revert SourceChainIsThisChain(chainId);
        }

        uint256 allowedNonce = 1;
        if (lastIncomingRequestId[sourceChainId] != bytes32(0)) {
            (,, allowedNonce) = _unpackRequestId(lastIncomingRequestId[sourceChainId]);
            allowedNonce++;
        }

        for (uint256 i = 0; i < mined.length;) {
            MinedRequest memory minedRequest = mined[i];
            bytes32 requestId = minedRequest.requestId;
            (uint256 minedChainId, uint256 minedTargetChainId, uint256 minedNonce) = _unpackRequestId(requestId);
            if (minedChainId != sourceChainId) {
                revert RequestSourceChainMismatch(requestId, sourceChainId, minedChainId);
            }
            if (minedTargetChainId != chainId) {
                revert RequestTargetChainMismatch(requestId, chainId, minedTargetChainId);
            }
            require(minedNonce == allowedNonce, "Inbox: mined nonces must be contiguous");
            unchecked {
                ++allowedNonce;
            }
            Request storage incomingRequest = incomingRequests[requestId];
            require(incomingRequest.requestId == bytes32(0), "Inbox: request already processed");
            require(minedRequest.sourceContract != address(0), "Inbox: invalid source contract");
            require(minedRequest.targetContract != address(0), "Inbox: invalid target contract");

            Request memory newIncomingRequest = Request({
                requestId: requestId,
                targetChainId: sourceChainId,
                targetContract: minedRequest.targetContract,
                methodCall: minedRequest.methodCall,
                callerContract: minedRequest.sourceContract,
                originalSender: minedRequest.sourceContract,
                timestamp: uint64(block.timestamp),
                callbackSelector: minedRequest.callbackSelector,
                errorSelector: minedRequest.errorSelector,
                isTwoWay: minedRequest.isTwoWay,
                executed: false,
                sourceRequestId: minedRequest.sourceRequestId,
                targetFee: minedRequest.targetFee,
                callerFee: minedRequest.callerFee
            });

            incomingRequests[requestId] = newIncomingRequest;
            (
                bytes4 methodSelector,
                bytes32 methodCallHash,
                uint256 dataLength,
                uint16 datatypeCount,
                uint16 datalenCount
            ) = _methodCallLogData(minedRequest.methodCall);
            emit MessageReceived(
                requestId,
                sourceChainId,
                minedRequest.sourceContract,
                methodSelector,
                methodCallHash,
                dataLength,
                datatypeCount,
                datalenCount
            );

            _executeIncomingRequest(incomingRequest, sourceChainId);

            if (incomingRequest.requestId != bytes32(0) && incomingRequest.sourceRequestId != bytes32(0)
                && !incomingRequest.isTwoWay) {
                bytes32 originalRequestId = incomingRequest.sourceRequestId;
                Request storage originalRequest = requests[originalRequestId];

                if (originalRequest.requestId != bytes32(0) && !originalRequest.executed) {
                    originalRequest.executed = true;
                    emit IncomingResponseReceived(originalRequestId, incomingRequest.requestId);
                }
            }
            unchecked {
                ++i;
            }
        }

        if (mined.length > 0) {
            lastIncomingRequestId[sourceChainId] = mined[mined.length - 1].requestId;
        }
    }

    /// @notice Configure the oracle used for fee conversion.
    /// @param oracle {PriceOracle} address.
    function setPriceOracle(address oracle) external onlyOwner {
        _setPriceOracle(oracle);
    }

    /// @notice Configure reference gas-price bounds for fee→gas conversion.
    /// @param minPriorityFeeWei_ Tip added to `block.basefee` on EIP-1559 chains.
    /// @param minGasPriceWei_ Floor for the reference gas price (must be non-zero).
    /// @param maxGasPriceWei_ Ceiling; zero disables the ceiling.
    function setGasPriceBounds(uint256 minPriorityFeeWei_, uint256 minGasPriceWei_, uint256 maxGasPriceWei_)
        external
        onlyOwner
    {
        _setGasPriceBounds(minPriorityFeeWei_, minGasPriceWei_, maxGasPriceWei_);
    }

    /// @notice Update minimum fee templates for local and remote legs.
    /// @param _local Local leg template.
    /// @param _remote Remote leg template.
    function updateMinFeeConfigs(FeeConfig memory _local, FeeConfig memory _remote) external onlyOwner {
        _updateMinFeeConfigs(_local, _remote);
    }

    /// @inheritdoc IInboxMiner
    function collectFees(address payable to) external onlyOwner {
        _collectFees(to);
    }

    /// @dev Retries a failed request, if the method execution is failed. Caller pays the execution gas so we don't care about the gas limit.
    /// @param requestId The ID of the incoming request to retry.
    function retryFailedRequest(bytes32 requestId) external nonReentrant {
        if (messageProcessingPaused) {
            revert MessageProcessingPaused();
        }
        if (requestId == bytes32(0)) {
            revert RequestIdRequired();
        }
        Request storage incomingRequest = incomingRequests[requestId];
        (uint256 sourceChainId,,) = _unpackRequestId(requestId);
        uint256 errorCode = errors[requestId].errorCode;
        if (!incomingRequest.executed || errorCode != ERROR_CODE_EXECUTION_FAILED) {
            revert RetryFailedRequestNotAFailedRequest();
        }

        _currentContext = ExecutionContext({
            remoteChainId: sourceChainId,
            remoteContract: incomingRequest.originalSender,
            requestId: requestId
        });

        address targetContract = incomingRequest.targetContract;
        (bool encodedOk, bytes memory callData, bytes memory encodeErr) = _safeEncodeMethodCall(
            incomingRequest.methodCall
        );
        if (!encodedOk) {
            // Preserve ERROR_CODE_EXECUTION_FAILED so retry stays eligible (POD-04).
            // Do not overwrite with encode-failed or emit a system callback on this path.
            _currentContext = ExecutionContext({remoteChainId: 0, remoteContract: address(0), requestId: bytes32(0)});
            revert RetryFailedRequestEncodeFailed(encodeErr);
        }

        (bool success, bytes memory returnData) = _callWithCappedReturnData(targetContract, gasleft(), callData);
        _currentContext = ExecutionContext({remoteChainId: 0, remoteContract: address(0), requestId: bytes32(0)});

        if (!success) {
            revert RetryFailedRequestExecutionFailed(returnData);
        }

        delete errors[requestId];
        emit RetryFailedRequestSuccess(requestId);
    }

    /// @dev Executes one mined request: encode calldata, call target with `gas` from `targetFee`, record errors.
    /// @param incomingRequest Storage ref to the incoming request.
    /// @param sourceChainId Chain that sent the request.
    function _executeIncomingRequest(Request storage incomingRequest, uint256 sourceChainId) internal {
        _currentContext = ExecutionContext({
            remoteChainId: sourceChainId,
            remoteContract: incomingRequest.originalSender,
            requestId: incomingRequest.requestId
        });

        address targetContract = incomingRequest.targetContract;
        (bool encodedOk, bytes memory callData, bytes memory encodeErr) = _safeEncodeMethodCall(
            incomingRequest.methodCall
        );

        if (!encodedOk) {
            _recordEncodeError(incomingRequest.requestId, encodeErr);
            _sendSystemErrorCallback(incomingRequest, encodeErr);

            _currentContext = ExecutionContext({remoteChainId: 0, remoteContract: address(0), requestId: bytes32(0)});

            incomingRequest.executed = true;
            return;
        }

        uint256 targetGasBudget = _localRequestExecutionBudget(incomingRequest.targetFee);
        // Leave headroom so capping returndata and writing storage cannot OOG the outer tx.
        uint256 gasForCall = gasleft();
        if (gasForCall > POST_CALL_GAS_RESERVE) {
            unchecked {
                gasForCall -= POST_CALL_GAS_RESERVE;
            }
        }
        if (targetGasBudget < gasForCall) {
            gasForCall = targetGasBudget;
        }

        uint256 gasBeforeSubcall = gasleft();
        (bool success, bytes memory returnData) = _callWithCappedReturnData(targetContract, gasForCall, callData);

        uint256 gasUsed = gasBeforeSubcall - gasleft();
        uint256 gasRemainingApprox = targetGasBudget > gasUsed ? targetGasBudget - gasUsed : 0;
        emit FeeExecutionSettled(incomingRequest.requestId, gasUsed, gasRemainingApprox);

        _currentContext = ExecutionContext({remoteChainId: 0, remoteContract: address(0), requestId: bytes32(0)});

        incomingRequest.executed = true;

        if (!success) {
            bytes32 rid = incomingRequest.requestId;
            errors[rid] = Error({
                requestId: rid,
                errorCode: ERROR_CODE_EXECUTION_FAILED,
                errorMessage: returnData
            });
            emit ErrorReceived(rid, ERROR_CODE_EXECUTION_FAILED, returnData);
        }
    }

    /// @dev Low-level call that never retains more than {MAX_ERROR_RETURN_DATA} bytes of returndata.
    ///      On failure, `returnData` is `abi.encode(uint256 fullLength, bytes prefix)` where `fullLength`
    ///      is `returndatasize()` (may exceed the stored prefix) and `prefix` is the first ≤256 bytes.
    function _callWithCappedReturnData(address target, uint256 gasBudget, bytes memory callData)
        private
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

        uint256 copyLen = fullLength > MAX_ERROR_RETURN_DATA ? MAX_ERROR_RETURN_DATA : fullLength;
        bytes memory prefix = new bytes(copyLen);
        assembly {
            returndatacopy(add(prefix, 32), 0, copyLen)
        }
        // fullLength alone is enough metadata; hash(prefix) is redundant while prefix is stored.
        returnData = abi.encode(fullLength, prefix);
    }
}
