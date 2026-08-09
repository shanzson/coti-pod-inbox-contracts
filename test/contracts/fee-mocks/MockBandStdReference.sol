// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@coti-io/coti-contracts/contracts/oracle/IStdReference.sol";

/// @title MockBandStdReference
/// @notice Test double for Band StdReference.
contract MockBandStdReference is IStdReference {
    mapping(bytes32 => uint256) public rates;
    uint256 public updatedAt;

    function setRate(string memory base, string memory quote, uint256 rate) external {
        rates[keccak256(abi.encodePacked(base, quote))] = rate;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 timestamp) external {
        updatedAt = timestamp;
    }

    function getReferenceData(string memory base, string memory quote)
        external
        view
        override
        returns (ReferenceData memory)
    {
        uint256 rate = rates[keccak256(abi.encodePacked(base, quote))];
        return ReferenceData(rate, updatedAt, updatedAt);
    }

    function getReferenceDataBulk(string[] memory bases, string[] memory quotes)
        external
        view
        override
        returns (ReferenceData[] memory data)
    {
        uint256 len = bases.length;
        data = new ReferenceData[](len);
        for (uint256 i = 0; i < len; ++i) {
            uint256 rate = rates[keccak256(abi.encodePacked(bases[i], quotes[i]))];
            data[i] = ReferenceData(rate, updatedAt, updatedAt);
        }
    }
}
