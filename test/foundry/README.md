# Foundry PoC — direct calls to `FeeManager`

A single Foundry suite that answers a security question raised against the fee
subsystem:

> `FeeManager` has **no access control** on any of its state-changing functions
> (`updateMinFeeConfigs`, `setPriceOracle`, `setGasPriceBounds`,
> `setMaxReplyMethodCallBytes`, `setMaxMessageLife`, `collectFees`,
> `ensureDefaults`). What happens if a user calls the deployed `FeeManager`
> **directly** instead of going through the Inbox? Can it break the intended
> behaviour, or turn bad for the protocol?

The production suite runs under Hardhat (see the repo root). This PoC is written
in Foundry because the interesting property is a *storage-context* one
(DELEGATECALL vs a direct CALL), which `vm.load` lets us assert on directly.

## Files

| File | Role |
| ---- | ---- |
| `FeeManagerDirectCall.t.sol` | The PoC. Deploys the real `FeeManager` + `PriceOracle` and probes every direct-call vector. |
| `InboxFeeHost.sol` | A minimal, faithful stand-in for the Inbox's fee surface. It reuses the **production** `FeeManagerStubBase` (hence the real `ModuleCallBase` DELEGATECALL wiring and the real ERC-7201 slot); only the thin `onlyOwner` Inbox wrapper is re-implemented, so `Inbox.sol` + the `coti-contracts` sibling package are not needed to compile. |

## Findings (all asserted by the suite)

1. **SAFE — config cannot be corrupted.** Direct admin calls are unauthenticated
   and *succeed*, but under a direct CALL `address(this)` is the implementation,
   so `LibFeeStorage.get()` writes the `pod.inbox.fee.v1` slot on the
   *implementation's own* storage — which no Inbox ever reads (all fee getters
   read the slot locally on the Inbox; the fee path only ever `_delegateModule`s
   in, never `_staticModule`s). `vm.load` shows the Inbox slot untouched and the
   Inbox keeps validating fees against its own config.
2. **SAFE — fees cannot be drained.** `collectFees` sends `address(this).balance`.
   Called directly it moves only the implementation's balance (normally `0`); the
   Inbox's collected fees are reachable only through the Inbox's `onlyOwner`
   `collectFees`, which DELEGATECALLs and therefore moves the *Inbox's* balance.
3. **LOW / INFORMATIONAL — the implementation is a permissionless wallet.**
   `localRequestExecutionBudget` is a live `payable` entrypoint that keeps any
   value sent to it, and `collectFees` is unauthenticated, so **ETH mistakenly
   sent to the `FeeManager` implementation address can be swept by anyone.** This
   only ever touches funds misdirected *to the implementation* — never Inbox /
   protocol / other-user funds.
4. **SAFE — validation moves no value.** The `validate*` entrypoints revert on a
   fresh implementation (`OracleNotConfigured`) and are pure computation + reverts
   regardless, so they cannot be used to extract anything.

**Bottom line:** the missing access control on `FeeManager` is safe *by design* —
DELEGATECALL storage isolation confines every direct call to the throwaway
implementation contract. The only real-world caution is operational: treat the
`FeeManager` implementation address as unable to custody funds (finding 3).

## Running it

This repo is primarily a Hardhat/npm project, so `node_modules/` (for
OpenZeppelin) and `lib/` (for `forge-std`) are git-ignored. One-time setup:

```bash
# 1) Foundry (forge). If foundryup's download host is blocked, grab the release
#    tarball from github.com/foundry-rs/foundry/releases and put the binaries on PATH.
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 2) OpenZeppelin contracts (the fee contracts import @openzeppelin/contracts).
npm install

# 3) forge-std (test harness).
forge install foundry-rs/forge-std   # or: git clone --depth 1 --branch v1.9.7 \
                                     #     https://github.com/foundry-rs/forge-std lib/forge-std

# 4) Run the PoC (‑vv prints the per-finding VERDICT lines).
forge test -vv
```

`foundry.toml` scopes `forge` to `test/foundry` only, so it compiles just this
PoC plus the fee contracts it imports — never `Inbox.sol` / the MPC codec. It
pins `solc 0.8.28`, `evm_version = shanghai`, and `via_ir = true` to match
`hardhat.config.ts`.
