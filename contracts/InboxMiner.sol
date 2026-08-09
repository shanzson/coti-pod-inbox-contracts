// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "@coti-io/coti-contracts/contracts/pod/IInboxMiner.sol";
import "./InboxEstimateGas.sol";
import "./MinerBase.sol";
import "./lib/MinerRejectLib.sol";

/// @title InboxMiner
/// @notice Miner-driven inbox: ingest mined payloads, execute targets, and collect fees.
/// @dev Inherits {InboxEstimateGas} for {estimateExecutionGasForMiner} and estimate-mode hooks.
abstract contract InboxMiner is InboxEstimateGas, MinerBase, IInboxMiner, ReentrancyGuard {
    error NoncesNotContiguous();
    error RequestAlreadyProcessed();

    using MinerRejectLib for IInbox.MpcMethodCall;
    /// @notice Gas reserved after the target subcall so failure accounting can always commit.
    uint256 private constant POST_CALL_GAS_RESERVE = 100_000;

    /// @notice Gas reserved after an estimate subcall so {ExecutionGasEstimate} can always encode.
    uint256 private constant ESTIMATE_OUTER_RESERVE = 150_000;

    /// @notice Pause or unpause messaging (owner-only emergency stop).
    /// @param paused True to halt outbound sends, {batchProcessRequests}, and {retryFailedRequest}.
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

        FeeConfig memory localCaps = localMinFeeConfig;
        uint256 maxMethodCallBytes = localCaps.maxMethodCallBytes;
        uint256 maxExecutionGas = localCaps.maxExecutionGas;

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
            if (minedNonce != allowedNonce) revert NoncesNotContiguous();
            unchecked {
                ++allowedNonce;
            }
            Request storage incomingRequest = incomingRequests[requestId];
            if (incomingRequest.requestId != bytes32(0)) revert RequestAlreadyProcessed();
            if (minedRequest.sourceContract == address(0)) revert InvalidSourceContract();
            if (minedRequest.targetContract == address(0)) revert InvalidTargetContract();

            (bool isReject, uint8 rejectionCode, bytes32 rejectionReason) =
                MinerRejectLib.parse(minedRequest.methodCall);

            if (isReject) {
                _ingestMinerReject(
                    incomingRequest,
                    minedRequest,
                    sourceChainId,
                    requestId,
                    rejectionCode,
                    rejectionReason
                );
            } else {
                uint256 weight = MinerRejectLib.structuralSize(minedRequest.methodCall);
                if (weight > maxMethodCallBytes) {
                    revert MethodCallTooLarge(weight, maxMethodCallBytes);
                }
                if (minedRequest.targetFee > maxExecutionGas) {
                    revert FeeGasTooHigh(minedRequest.targetFee, maxExecutionGas);
                }
                if (minedRequest.callerFee > maxExecutionGas) {
                    revert FeeGasTooHigh(minedRequest.callerFee, maxExecutionGas);
                }

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
                        if (errors[incomingRequest.requestId].requestId == bytes32(0)) {
                            emit ReturnLegCallbackSucceeded(originalRequestId, incomingRequest.requestId);
                        }
                    }
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

    /// @dev Contiguous reject: store header only (empty methodCall), emit, system-error if two-way.
    function _ingestMinerReject(
        Request storage incomingRequest,
        MinedRequest memory minedRequest,
        uint256 sourceChainId,
        bytes32 requestId,
        uint8 rejectionCode,
        bytes32 rejectionReason
    ) private {
        MpcMethodCall memory emptyCall = MpcMethodCall({
            selector: bytes4(0),
            data: new bytes(0),
            datatypes: new bytes8[](0),
            datalens: new bytes32[](0)
        });

        incomingRequests[requestId] = Request({
            requestId: requestId,
            targetChainId: sourceChainId,
            targetContract: minedRequest.targetContract,
            methodCall: emptyCall,
            callerContract: minedRequest.sourceContract,
            originalSender: minedRequest.sourceContract,
            timestamp: uint64(block.timestamp),
            callbackSelector: minedRequest.callbackSelector,
            errorSelector: minedRequest.errorSelector,
            isTwoWay: minedRequest.isTwoWay,
            executed: true,
            sourceRequestId: minedRequest.sourceRequestId,
            targetFee: minedRequest.targetFee,
            callerFee: minedRequest.callerFee
        });

        bytes memory reasonBytes = abi.encodePacked(rejectionReason);
        errors[requestId] = Error({
            requestId: requestId,
            errorCode: ERROR_CODE_MINER_REJECTED,
            errorMessage: reasonBytes
        });
        emit RequestRejected(requestId, rejectionCode, rejectionReason);
        emit ErrorReceived(requestId, ERROR_CODE_MINER_REJECTED, reasonBytes);

        if (minedRequest.isTwoWay) {
            _sendSystemErrorCallbackWithCode(incomingRequest, ERROR_CODE_MINER_REJECTED, reasonBytes);
        }

        if (incomingRequest.sourceRequestId != bytes32(0) && !incomingRequest.isTwoWay) {
            bytes32 originalRequestId = incomingRequest.sourceRequestId;
            Request storage originalRequest = requests[originalRequestId];
            if (originalRequest.requestId != bytes32(0) && !originalRequest.executed) {
                originalRequest.executed = true;
                emit IncomingResponseReceived(originalRequestId, incomingRequest.requestId);
            }
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

    /// @notice Set the respond/raise payload-weight cap (same units as {FeeConfig.maxMethodCallBytes}).
    function setMaxReplyMethodCallBytes(uint32 maxBytes) external onlyOwner {
        _setMaxReplyMethodCallBytes(maxBytes);
    }

    /// @notice Set max age (seconds) from dest ingest before execution-failed requests terminalize on retry.
    /// @param lifeSeconds `0` disables the lifetime check.
    function setMaxMessageLife(uint32 lifeSeconds) external onlyOwner {
        maxMessageLife = lifeSeconds;
    }

    enum IncomingExecKind {
        Mine,
        Estimate,
        Retry
    }

    /// @inheritdoc InboxEstimateGas
    function _runEstimateIncomingExecution(
        Request storage incomingRequest,
        uint256 sourceChainId,
        uint256 maxUserGas
    ) internal override returns (uint256 gasUsed) {
        return _runIncomingExecution(incomingRequest, sourceChainId, IncomingExecKind.Estimate, maxUserGas);
    }

    /// @inheritdoc IInboxMiner
    /// @dev Body in {InboxEstimateGas._estimateExecutionGasForMiner}.
    function estimateExecutionGasForMiner(
        uint256 sourceChainId,
        MinedRequest calldata mined,
        uint256 maxUserGas
    ) external override {
        _estimateExecutionGasForMiner(sourceChainId, mined, maxUserGas);
    }

    /// @inheritdoc IInboxMiner
    function collectFees(address payable to) external onlyOwner {
        _collectFees(to);
    }

    /// @dev Retries a failed request, if the method execution is failed. Caller pays the execution gas so we don't care about the gas limit.
    ///      If {maxMessageLife} has elapsed since dest ingest, terminalizes instead (system-error return when funded).
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
        uint32 life = maxMessageLife;
        if (life != 0 && block.timestamp > uint256(incomingRequest.timestamp) + uint256(life)) {
            errors[requestId].errorCode = ERROR_CODE_EXPIRED;
            _sendSystemErrorCallbackWithCode(incomingRequest, ERROR_CODE_EXPIRED, "ttl");
            return;
        }

        _runIncomingExecution(incomingRequest, sourceChainId, IncomingExecKind.Retry, 0);
    }

    /// @dev Executes one mined request: encode calldata, call target with `gas` from `targetFee`, record errors.
    function _executeIncomingRequest(Request storage incomingRequest, uint256 sourceChainId) internal {
        _runIncomingExecution(incomingRequest, sourceChainId, IncomingExecKind.Mine, 0);
    }

    /// @dev Shared mine / estimate / retry execution path.
    function _runIncomingExecution(
        Request storage incomingRequest,
        uint256 sourceChainId,
        IncomingExecKind kind,
        uint256 maxUserGas
    ) private returns (uint256 gasUsed) {
        _currentContext = ExecutionContext({
            remoteChainId: sourceChainId,
            remoteContract: incomingRequest.originalSender,
            requestId: incomingRequest.requestId
        });

        address targetContract = incomingRequest.targetContract;
        (bool encodedOk, bytes memory callData, bytes memory encodeErr) =
            _safeEncodeMethodCall(incomingRequest.methodCall);

        if (!encodedOk) {
            if (kind == IncomingExecKind.Retry) {
                // Preserve ERROR_CODE_EXECUTION_FAILED so retry stays eligible.
                _clearExecutionContext();
                revert RetryFailedRequestEncodeFailed(_capErrorReturnData(encodeErr));
            }
            bytes memory cappedEncodeErr = _capErrorReturnData(encodeErr);
            _recordEncodeError(incomingRequest.requestId, cappedEncodeErr);
            _sendSystemErrorCallback(incomingRequest, cappedEncodeErr);
            _clearExecutionContext();
            incomingRequest.executed = true;
            return 0;
        }

        uint256 gasForCall;
        uint256 targetGasBudget = _localRequestExecutionBudget(incomingRequest.targetFee);
        if (kind == IncomingExecKind.Retry) {
            gasForCall = gasleft();
        } else {
            uint256 outerReserve =
                kind == IncomingExecKind.Estimate ? ESTIMATE_OUTER_RESERVE : POST_CALL_GAS_RESERVE;
            gasForCall = _computeUserCallGas(targetGasBudget, outerReserve, maxUserGas);
        }

        uint256 gasBeforeSubcall = gasleft();
        (bool success, bytes memory returnData) =
            _callWithCappedReturnData(targetContract, gasForCall, callData);
        gasUsed = gasBeforeSubcall - gasleft();

        if (kind == IncomingExecKind.Retry) {
            _clearExecutionContext();
            if (!success) {
                revert RetryFailedRequestExecutionFailed(returnData);
            }
            delete errors[incomingRequest.requestId];
            emit RetryFailedRequestSuccess(incomingRequest.requestId);
            return gasUsed;
        }

        uint256 gasRemainingApprox = targetGasBudget > gasUsed ? targetGasBudget - gasUsed : 0;
        if (_shouldEmit()) {
            emit FeeExecutionSettled(incomingRequest.requestId, gasUsed, gasRemainingApprox);
        }

        _clearExecutionContext();
        incomingRequest.executed = true;

        if (!success) {
            bytes32 rid = incomingRequest.requestId;
            errors[rid] = Error({
                requestId: rid,
                errorCode: ERROR_CODE_EXECUTION_FAILED,
                errorMessage: returnData
            });
            if (_shouldEmit()) {
                emit ErrorReceived(rid, ERROR_CODE_EXECUTION_FAILED, returnData);
            }
        }
    }

    function _clearExecutionContext() private {
        _currentContext = ExecutionContext({remoteChainId: 0, remoteContract: address(0), requestId: bytes32(0)});
    }

    /// @dev Cap user subcall gas by prepaid budget, outer reserve, and optional maxUserGas (0 = uncapped).
    function _computeUserCallGas(uint256 targetGasBudget, uint256 outerReserve, uint256 maxUserGas)
        private
        view
        returns (uint256 gasForCall)
    {
        gasForCall = gasleft();
        if (gasForCall > outerReserve) {
            unchecked {
                gasForCall -= outerReserve;
            }
        }
        if (targetGasBudget < gasForCall) {
            gasForCall = targetGasBudget;
        }
        if (maxUserGas != 0 && maxUserGas < gasForCall) {
            gasForCall = maxUserGas;
        }
    }

    /// @dev Low-level call that never retains more than {MAX_ERROR_RETURN_DATA} bytes of returndata.
    ///      On failure, `returnData` is the first ≤256 bytes of returndata.
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
        returnData = new bytes(copyLen);
        assembly {
            returndatacopy(add(returnData, 32), 0, copyLen)
        }
    }
}
