// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FeeManagerStubBase} from "../../../contracts/fee/FeeManagerStubBase.sol";
import {LibFeeStorage} from "../../../contracts/fee/LibFeeStorage.sol";
import {PriceOracle} from "../../../contracts/fee/PriceOracle.sol";
import {MinerRejectLib} from "../../../contracts/lib/MinerRejectLib.sol";
import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";

/// @dev Oracle stand-in satisfying the only call the fee paths make. Prices are set by
///      tests (symbolic values allowed); no logic of its own.
contract MockPriceOracle {
    uint256 public localPrice;
    uint256 public remotePrice;

    function setPrices(uint256 localPrice_, uint256 remotePrice_) external {
        localPrice = localPrice_;
        remotePrice = remotePrice_;
    }

    function getPricesUSD() external view returns (uint256, uint256) {
        return (localPrice, remotePrice);
    }

    /// @dev InboxBase's send paths call this best-effort; harmless no-op here.
    function refreshCache() external {}
}

/// @dev Minimal concrete subclass so the REAL FeeManagerStubBase.calculateTwoWayFeeRequiredInLocalToken
///      (with its inline ceil math) is deployable. Setters only poke the ERC-7201 storage the
///      view reads; no production logic is duplicated.
contract StubQuoteHarness is FeeManagerStubBase {
    function setConfigs(LibFeeStorage.FeeConfig calldata localMin, LibFeeStorage.FeeConfig calldata remoteMin)
        external
    {
        LibFeeStorage.Layout storage $ = LibFeeStorage.get();
        $.localMinFeeConfig = localMin;
        $.remoteMinFeeConfig = remoteMin;
    }

    function setOracle(address oracle) external {
        LibFeeStorage.get().priceOracle = PriceOracle(oracle);
    }
}

/// @dev Libraries with internal functions are not callable from tests; this wrapper adds
///      zero logic (spec §4, Group G provision).
contract RejectCodecWrapper {
    function build(uint8 code, bytes32 reason) external pure returns (IInbox.MpcMethodCall memory) {
        return MinerRejectLib.build(code, reason);
    }

    function parse(IInbox.MpcMethodCall memory mc) external pure returns (bool, uint8, bytes32) {
        return MinerRejectLib.parse(mc);
    }

    function structuralSize(IInbox.MpcMethodCall memory mc) external pure returns (uint256) {
        return MinerRejectLib.structuralSize(mc);
    }

    function storedSlotConstant() external pure returns (bytes32) {
        return LibFeeStorage.STORAGE_SLOT;
    }

    function derivedSlot() external pure returns (bytes32) {
        return LibFeeStorage.erc7201Slot();
    }
}
