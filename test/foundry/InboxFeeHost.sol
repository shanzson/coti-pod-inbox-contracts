// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../contracts/fee/FeeManagerStubBase.sol";

/// @title InboxFeeHost
/// @notice Minimal, faithful stand-in for the Inbox's fee surface, used only by the
///         FeeManager direct-call PoC (`FeeManagerDirectCall.t.sol`).
/// @dev Reuses the PRODUCTION {FeeManagerStubBase} (and therefore the real {ModuleCallBase}
///      DELEGATECALL wiring and the real ERC-7201 {LibFeeStorage} slot). The ONLY thing this
///      contract re-implements is the thin Inbox wrapper that the production {InboxMiner}
///      provides: an owner, the `onlyOwner` overrides on the admin stubs, and a way to fund /
///      inspect the "collected fees" balance. That wrapper is exactly the trust boundary the
///      PoC probes, so modelling it (rather than pulling in Inbox.sol plus the coti-contracts
///      sibling package) keeps the test self-contained without weakening what it proves.
///
///      Every admin write and every validate/budget call still routes through
///      `_delegateModule(feeManager, ...)`, so `address(this)` stays this host and fee state is
///      read/written at the host's own `pod.inbox.fee.v1` slot — identical to how a real Inbox
///      delegatecalls the shared {FeeManager} implementation.
contract InboxFeeHost is FeeManagerStubBase {
    /// @notice Admin allowed to mutate fee state (mirrors {Ownable} owner on the real Inbox).
    address public owner;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param feeManagerImpl Deployed {FeeManager} implementation (shared DELEGATECALL target).
    constructor(address feeManagerImpl) {
        feeManager = feeManagerImpl; // ModuleCallBase.feeManager
        owner = msg.sender;
        // Mirror a freshly-initialized Inbox: apply storage defaults once (writes to THIS host).
        _ensureFeeDefaults();
    }

    // ── onlyOwner admin overrides (mirror contracts/InboxMiner.sol) ─────────────
    // Each `super.*` call lands in FeeManagerStubBase, which DELEGATECALLs FeeManager.

    function setPriceOracle(address oracle) public override onlyOwner {
        super.setPriceOracle(oracle);
    }

    function setGasPriceBounds(uint256 minPriorityFeeWei_, uint256 minGasPriceWei_, uint256 maxGasPriceWei_)
        public
        override
        onlyOwner
    {
        super.setGasPriceBounds(minPriorityFeeWei_, minGasPriceWei_, maxGasPriceWei_);
    }

    function updateMinFeeConfigs(FeeConfig memory _local, FeeConfig memory _remote) public override onlyOwner {
        super.updateMinFeeConfigs(_local, _remote);
    }

    function setMaxReplyMethodCallBytes(uint32 maxBytes) public override onlyOwner {
        super.setMaxReplyMethodCallBytes(maxBytes);
    }

    function setMaxMessageLife(uint32 lifeSeconds) public override onlyOwner {
        super.setMaxMessageLife(lifeSeconds);
    }

    function collectFees(address payable to) public override onlyOwner {
        super.collectFees(to);
    }

    // ── Send-path helpers (internal on the real Inbox; exposed here to exercise them) ──

    /// @notice Runs the real one-way validation via DELEGATECALL into {FeeManager}.
    function validateOneWay(uint256 dataSize, uint256 totalFeeLocalWei)
        external
        payable
        returns (uint256 targetGasRemoteUnits)
    {
        return _validateAndPrepareOneWayFees(dataSize, totalFeeLocalWei);
    }

    /// @notice Runs the real two-way validation via DELEGATECALL into {FeeManager}.
    function validateTwoWay(uint256 dataSize, uint256 totalFeeLocalWei, uint256 callbackFeeLocalWei)
        external
        payable
        returns (uint256 targetGasRemoteUnits, uint256 callerGasLocalUnits)
    {
        return _validateAndPrepareTwoWayFees(dataSize, totalFeeLocalWei, callbackFeeLocalWei);
    }

    /// @notice Accept "collected fees" so the PoC can prove they cannot be swept by direct calls.
    receive() external payable {}
}
