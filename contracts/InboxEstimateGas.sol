// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInboxMiner.sol";

import "./InboxBase.sol";
import "./lib/MinerRejectLib.sol";

/// @title InboxEstimateGas
/// @notice Estimate-mode layer on {InboxBase}: reply-size tracking + {estimateExecutionGasForMiner}.
/// @dev Sits between {InboxBase} and {InboxMiner}. While estimating, reply creates are tagged and their
///      payload weights accumulate for {IInboxMiner.ExecutionGasEstimate}. The estimate call always
///      reverts before commit. {InboxMiner} supplies {_runEstimateIncomingExecution}.
abstract contract InboxEstimateGas is InboxBase {
    bool private _estimating;
    /// @dev 0 = none, 1 = respond outbound, 2 = raise / system-error outbound.
    uint8 private _estimateReplyKind;
    uint256 private _estimateResponseDataSize;
    uint256 private _estimateErrorDataSize;

    uint8 private constant _REPLY_NONE = 0;
    uint8 private constant _REPLY_RESPONSE = 1;
    uint8 private constant _REPLY_ERROR = 2;

    function _isEstimating() internal view override returns (bool) {
        return _estimating;
    }

    /// @dev True when events / durable log side-effects should run (not during estimate).
    function _shouldEmit() internal view override returns (bool) {
        return !_estimating;
    }

    function _enterEstimateMode() private {
        _estimating = true;
        _estimateReplyKind = _REPLY_NONE;
        _estimateResponseDataSize = 0;
        _estimateErrorDataSize = 0;
    }

    function _exitEstimateMode() private {
        _estimating = false;
    }

    /// @dev Tag the next outbound create as respond (`isError=false`) or raise/system-error.
    function _tagEstimateOutboundReply(bool isError) internal override {
        if (!_estimating) {
            return;
        }
        _estimateReplyKind = isError ? _REPLY_ERROR : _REPLY_RESPONSE;
    }

    /// @dev If a reply was tagged, add its payload weight to the matching accumulator.
    function _accumulateEstimateOutboundIfTagged(uint256 weight) internal override {
        if (!_estimating || _estimateReplyKind == _REPLY_NONE) {
            return;
        }
        if (_estimateReplyKind == _REPLY_RESPONSE) {
            _estimateResponseDataSize += weight;
        } else {
            _estimateErrorDataSize += weight;
        }
        _estimateReplyKind = _REPLY_NONE;
    }

    /// @dev Shared mine/estimate/retry path implemented by {InboxMiner}.
    function _runEstimateIncomingExecution(
        Request storage incomingRequest,
        uint256 sourceChainId,
        uint256 maxUserGas
    ) internal virtual returns (uint256 gasUsed);

    /// @dev Always-revert estimate body. Public entry is {InboxMiner.estimateExecutionGasForMiner}.
    function _estimateExecutionGasForMiner(
        uint256 sourceChainId,
        IInboxMiner.MinedRequest calldata mined,
        uint256 maxUserGas
    ) internal {
        if (_isEstimating() || _currentContext.requestId != bytes32(0)) {
            revert IInboxMiner.EstimateBusy();
        }
        if (sourceChainId == chainId) {
            revert IInboxMiner.SourceChainIsThisChain(chainId);
        }

        bytes32 requestId = mined.requestId;
        (uint256 minedChainId, uint256 minedTargetChainId,) = _unpackRequestId(requestId);
        if (minedChainId != sourceChainId) {
            revert IInboxMiner.RequestSourceChainMismatch(requestId, sourceChainId, minedChainId);
        }
        if (minedTargetChainId != chainId) {
            revert IInboxMiner.RequestTargetChainMismatch(requestId, chainId, minedTargetChainId);
        }
        if (mined.sourceContract == address(0)) revert InvalidSourceContract();
        if (mined.targetContract == address(0)) revert InvalidTargetContract();

        (bool isReject,,) = MinerRejectLib.parse(mined.methodCall);
        if (isReject) {
            revert IInboxMiner.EstimateRejectNotExecutable();
        }

        FeeConfig memory localCaps = _localMinFeeConfigMem();
        uint256 weight = MinerRejectLib.structuralSize(mined.methodCall);
        if (weight > localCaps.maxMethodCallBytes) {
            revert MethodCallTooLarge(weight, localCaps.maxMethodCallBytes);
        }
        if (mined.targetFee > localCaps.maxExecutionGas) {
            revert FeeGasTooHigh(mined.targetFee, localCaps.maxExecutionGas);
        }
        if (mined.callerFee > localCaps.maxExecutionGas) {
            revert FeeGasTooHigh(mined.callerFee, localCaps.maxExecutionGas);
        }

        _enterEstimateMode();

        incomingRequests[requestId] = Request({
            requestId: requestId,
            targetChainId: sourceChainId,
            targetContract: mined.targetContract,
            methodCall: mined.methodCall,
            callerContract: mined.sourceContract,
            originalSender: mined.sourceContract,
            timestamp: uint64(block.timestamp),
            callbackSelector: mined.callbackSelector,
            errorSelector: mined.errorSelector,
            isTwoWay: mined.isTwoWay,
            executed: false,
            sourceRequestId: mined.sourceRequestId,
            targetFee: mined.targetFee,
            callerFee: mined.callerFee
        });

        uint256 gasUsed = _runEstimateIncomingExecution(incomingRequests[requestId], sourceChainId, maxUserGas);

        uint256 responseDataSize = _estimateResponseDataSize;
        uint256 errorDataSize = _estimateErrorDataSize;
        _exitEstimateMode();
        revert IInboxMiner.ExecutionGasEstimate(gasUsed, responseDataSize, errorDataSize);
    }
}
