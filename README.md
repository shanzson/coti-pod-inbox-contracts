# COTI PoD Inbox Contracts

Cross-chain **inbox** implementation for the COTI PoD stack: message routing, miner, fee manager, and oracle adapters.

Shared PoD APIs (`IInbox`, `InboxUser`, `MpcAbiCodec`, fee/oracle interfaces, `PodNetworkConstants`) and
**`MpcCore`** live in **[@coti-io/coti-contracts](https://github.com/coti-io/coti-contracts)** — this package
depends on that library via `file:../coti-contracts` (local monorepo) and must not re-vendor or symlink those files.

dApp contracts (Privacy Portal, pERC20, PodLib, examples) also live in **coti-contracts**.

Integration tests, deploy orchestration, and the multi-repo dev workspace live in
**[pod-ecosystem-integration](https://github.com/coti-io/pod-ecosystem-integration)**.

## Layout

| Path | Purpose |
|------|---------|
| `contracts/Inbox.sol` | Production inbox (miner + access control) |
| `contracts/InboxBase.sol` | Core send/receive/request storage |
| `contracts/InboxEstimateGas.sol` | Estimate-mode layer + `_estimateExecutionGasForMiner` |
| `contracts/InboxMiner.sol` | Batch miner / retry / `estimateExecutionGasForMiner` entry |
| `contracts/MpcAbiReEncode.sol` | COTI DELEGATECALL target: it-* → gt-* re-encode |
| `contracts/fee/` | Fee manager and price oracle **implementations** |
| `@coti-io/coti-contracts/contracts/pod/...` | Shared interfaces / `MpcAbiCodec` builders / `InboxUser` (npm dep) |

## Shared APIs

Import from the dependency, for example:

```solidity
import "@coti-io/coti-contracts/contracts/pod/IInbox.sol";
import "@coti-io/coti-contracts/contracts/pod/mpccodec/MpcAbiCodec.sol";
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";
```

Local monorepo / PEI-style layout uses `"@coti-io/coti-contracts": "file:../coti-contracts"`. CI (`.github/workflows/ci.yml`) checks out `coti-io/coti-contracts` as a sibling so that `file:` path resolves on GitHub Actions.

## Develop

```bash
# Expect ../coti-contracts (clone coti-io/coti-contracts next to this repo)
npm install
npx hardhat compile
npm test                 # batched Hardhat (8GB heap) — preferred locally + CI
npm run test:all         # single-process full suite
npm run test:inbox-events
npm run test:inbox-fee
npm run check:bytecode-size
```

Hardhat suites use `NODE_OPTIONS=--max-old-space-size=8192` to avoid Node OOM during compile/test.
Default `npm test` runs **batched** processes (`test:batched`) because a single mega-process can flake under memory pressure; use `test:all` only when you intentionally want one runner.

GitHub Actions (`.github/workflows/ci.yml`) compiles, checks bytecode size, and runs `npm test`. On push to `main`, if secret `PEI_DISPATCH_PAT` is set, it `repository_dispatch`es `pod-contracts-changed` to **pod-ecosystem-integration** so ecosystem in-mem/sim jobs re-run against this SHA.

**CI/CD secrets and how to create them:** see the canonical guide in PEI — [docs/CI-CD.md](https://github.com/coti-io/pod-ecosystem-integration/blob/main/docs/CI-CD.md) (this repo only needs `PEI_DISPATCH_PAT`).

For full-stack work (inbox + dApps + E2E tests), open the **pod-ecosystem-integration** workspace.

## Deploy / init

Inbox creation bytecode is chain-identical: the constructor sets a placeholder `Ownable(address(1))` owner and takes no arguments so CREATE3 addresses stay stable. Production deploys **must** use CreateX `deployCreate3AndInit` (or an equivalent atomic path) so `{init}` runs in the same transaction as creation—there is no safe split deploy-then-init window, and `_disableInitializers()` is intentionally **not** used because this contract *is* the live instance. Deploy helpers assert `owner() != address(1)` after init.

## Networks

See `hardhat.config.ts` — Sepolia, Avalanche Fuji, COTI testnet, and local `chain1`/`chain2` simulators for multichain tests.
