// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MinerBase
/// @notice Ownable registry of addresses allowed to call miner-only inbox functions.
abstract contract MinerBase is Ownable {
    error NotMiner();
    error MinerZeroAddress();
    error AlreadyMiner();
    error NotRegisteredMiner();

    mapping(address => bool) private _miners;

    /// @notice Miner address was registered by the owner.
    event MinerAdded(address miner);
    /// @notice Miner address was revoked by the owner.
    event MinerRemoved(address miner);

    /// @notice Restrict a function to registered miners.
    /// @dev Reverts unless `msg.sender` is a registered miner.
    modifier onlyMiner() {
        if (!_miners[msg.sender]) revert NotMiner();
        _;
    }

    /// @notice Register a miner address.
    /// @param miner Address allowed to mine.
    function addMiner(address miner) external onlyOwner {
        if (miner == address(0)) revert MinerZeroAddress();
        if (_miners[miner]) revert AlreadyMiner();
        _miners[miner] = true;
        emit MinerAdded(miner);
    }

    /// @notice Remove a miner address.
    /// @param miner Address to revoke.
    function removeMiner(address miner) external onlyOwner {
        if (!_miners[miner]) revert NotRegisteredMiner();
        delete _miners[miner];
        emit MinerRemoved(miner);
    }

    /// @notice Whether `miner` is registered.
    /// @param miner Address to query.
    /// @return True if registered.
    function isMiner(address miner) external view returns (bool) {
        return _miners[miner];
    }
}
