// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Thin constructor-passthrough subclasses of the UNMODIFIED coti-contracts code. Hardhat emits no
// deployable artifact for contracts that live only in node_modules, so each real contract used by the
// PoCs is re-exposed here. No logic, storage or override is added anywhere in this file.

import "@coti-io/coti-contracts/contracts/pod/privacy/PrivacyPortal.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/PrivacyPortalFactory.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/PortalFeeOracle.sol";
import "@coti-io/coti-contracts/contracts/pod/token/perc20/PodErc20MintableInitializable.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/mocks/MockERC20.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/mocks/MockFeeOnTransferERC20.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/mocks/MockWrappedNative.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/mocks/RejectEthReceiver.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/mocks/MockPodErc20MintableForPortal.sol";
import "@coti-io/coti-contracts/contracts/pod/privacy/mocks/MockPodERC20ForPortal.sol";

/// @dev Real portal implementation (cloned by the real factory).
contract PrivacyPortalHarness is PrivacyPortal {}

/// @dev Real pToken clone implementation (cloned by the real factory).
contract PodErc20MintableInitializableHarness is PodErc20MintableInitializable {}

/// @dev Real factory.
contract PrivacyPortalFactoryHarness is PrivacyPortalFactory {
    constructor(
        address initialOwner,
        address inbox_,
        uint256 cotiChainId_,
        address cotiMotherContract_,
        address podTokenImplementation_,
        address portalImplementation_,
        address feeRecipient_,
        address rescueRecipient_,
        address nativeToken_,
        address priceOracle_,
        uint256 dFixed,
        uint256 dBps,
        uint256 dMax,
        uint256 wFixed,
        uint256 wBps,
        uint256 wMax
    )
        PrivacyPortalFactory(
            initialOwner,
            inbox_,
            cotiChainId_,
            cotiMotherContract_,
            podTokenImplementation_,
            portalImplementation_,
            feeRecipient_,
            rescueRecipient_,
            nativeToken_,
            priceOracle_,
            dFixed,
            dBps,
            dMax,
            wFixed,
            wBps,
            wMax
        )
    {}
}

/// @dev Real testnet/manual oracle shipped in the repo.
contract PortalFeeOracleHarness is PortalFeeOracle {
    constructor(address initialOwner) PortalFeeOracle(initialOwner) {}
}

// ---- repo test mocks, re-exposed unchanged ----

contract MockERC20Harness is MockERC20 {
    constructor(string memory n, string memory s, uint8 d) MockERC20(n, s, d) {}
}

contract MockFeeOnTransferERC20Harness is MockFeeOnTransferERC20 {
    constructor(string memory n, string memory s, uint8 d, uint256 feeBps_) MockFeeOnTransferERC20(n, s, d, feeBps_) {}
}

contract MockWrappedNativeHarness is MockWrappedNative {
    constructor() MockWrappedNative("Wrapped Native", "WNATIVE") {}
}

contract RejectEthReceiverHarness is RejectEthReceiver {}

contract MockPodErc20MintableForPortalHarness is MockPodErc20MintableForPortal {}

contract MockPodERC20ForPortalHarness is MockPodERC20ForPortal {}

// ---- PoC-only helper contracts (not part of the audited code) ----

/// @dev ERC20 with an issuer-side blocklist (USDC-style): transfers to/from a blocked account revert.
///      Used to show a withdrawal recipient that becomes unpayable AFTER the withdrawal was requested.
contract IssuerBlocklistERC20 is ERC20 {
    uint8 private immutable _decimals;
    mapping(address => bool) public blocked;

    error IssuerBlocked(address account);

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from]) revert IssuerBlocked(from);
        if (blocked[to]) revert IssuerBlocked(to);
        super._update(from, to, value);
    }
}
