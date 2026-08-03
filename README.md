# COTI PoD Inbox Contracts

Cross-chain **inbox** implementation for the COTI PoD stack: message routing, miner, fee manager, and oracle adapters.

Shared PoD APIs (`IInbox`, `InboxUser`, `MpcAbiCodec`, fee/oracle interfaces, `PodNetworkConstants`) live in
**[@coti-io/coti-contracts](https://github.com/coti-io/coti-contracts)** under `contracts/pod/` — this package
depends on that library and must not re-vendor those files.

dApp contracts (Privacy Portal, pERC20, PodLib, examples) also live in **coti-contracts**.

Integration tests, deploy orchestration, and the multi-repo dev workspace live in
**[pod-ecosystem-integration](https://github.com/coti-io/pod-ecosystem-integration)**.

## Layout

| Path | Purpose |
|------|---------|
| `contracts/Inbox.sol` | Production inbox (miner + access control) |
| `contracts/InboxBase.sol` | Core send/receive/request storage |
| `contracts/InboxMiner.sol` | Batch miner for incoming requests |
| `contracts/fee/` | Fee manager and price oracle **implementations** |
| `@coti-io/coti-contracts/contracts/pod/...` | Shared interfaces / `MpcAbiCodec` / `InboxUser` (npm dep) |

## Shared APIs

Import from the dependency, for example:

```solidity
import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import "@coti-io/coti-contracts/contracts/pod/mpccodec/MpcAbiCodec.sol";
```

Local multi-repo installs use `"@coti-io/coti-contracts": "file:../coti-contracts"`.
`npm run check:no-vendored-pod-apis` fails if retired duplicate paths reappear under `contracts/`.

## Develop

```bash
npm install
npm run check:no-vendored-pod-apis
npx hardhat compile
npm run test:inbox-events
npm run test:inbox-fee
```

For full-stack work (inbox + dApps + E2E tests), open the **pod-ecosystem-integration** workspace.

## Networks

See `hardhat.config.ts` — Sepolia, Avalanche Fuji, COTI testnet, and local `chain1`/`chain2` simulators for multichain tests.
