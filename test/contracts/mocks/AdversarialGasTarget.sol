// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @title AdversarialGasTarget — gas-estimation edge cases for miner sizing tests.
/// @dev Modes try to under/over-state cost vs naive `eth_estimateGas` / prepaid stipends.
contract AdversarialGasTarget {
    IInbox public immutable inbox;

    enum Mode {
        FixedBurn,
        FixedBurnRespond,
        FixedBurnRaise,
        /// @dev Cheap when `gasleft()` is low (estimateGas binary search), expensive when high (real mine).
        EstimateGasGrief,
        RevertAfterBurn,
        EmptySuccess
    }

    Mode public mode;
    uint256 public burnGas;
    uint256 public griefThreshold;
    bytes public replyPayload;

    constructor(IInbox inbox_) {
        inbox = inbox_;
    }

    function configure(
        Mode mode_,
        uint256 burnGas_,
        uint256 griefThreshold_,
        bytes calldata replyPayload_
    ) external {
        mode = mode_;
        burnGas = burnGas_;
        griefThreshold = griefThreshold_;
        replyPayload = replyPayload_;
    }

    function entry(bytes calldata) external {
        Mode m = mode;
        if (m == Mode.EmptySuccess) {
            return;
        }
        if (m == Mode.EstimateGasGrief) {
            if (gasleft() > griefThreshold) {
                _burn(burnGas);
            }
            return;
        }
        _burn(burnGas);
        if (m == Mode.FixedBurnRespond) {
            inbox.respond(replyPayload);
            return;
        }
        if (m == Mode.FixedBurnRaise) {
            inbox.raise(replyPayload);
            return;
        }
        if (m == Mode.RevertAfterBurn) {
            revert("AdversarialGasTarget: forced revert");
        }
    }

    function _burn(uint256 target) private {
        uint256 start = gasleft();
        while (target > 0 && start > gasleft() && start - gasleft() < target && gasleft() > 40_000) {
            // burn
        }
    }
}
