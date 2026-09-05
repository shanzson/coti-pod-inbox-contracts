# PrivacyPortal / PrivacyPortalFactory — executable PoCs

Executable proofs for the 14 findings of `audit/privacy-portal-pashov-ai-audit-report-20260905.md`
(coti-contracts commit `8a0c4928004dac7a6c8d50bde58a022b6912f963`).

**What is real:** `PrivacyPortal`, `PrivacyPortalFactory`, `PodErc20MintableInitializable` (→ `PodErc20Mintable` → `PodERC20`),
`PortalFeeOracle`, `PrivacyPortalFeeLib`, and (for F5) `PodErc20CotiMother` — all imported unmodified from the
symlinked `@coti-io/coti-contracts` checkout through constructor-passthrough harnesses (`contracts/PortalHarnesses.sol`).
The repo's own test mocks (`MockERC20`, `MockFeeOnTransferERC20`, `MockWrappedNative`, `RejectEthReceiver`) are re-used unchanged.

**What is a stand-in:** the source-chain inbox (`contracts/MockInboxForPortal.sol`). It reproduces the real request-id
scheme (`InboxBase._packRequestId`, per-target nonce starting at 1) and delivers callbacks as `msg.sender == inbox`
so `InboxUser.onlyInboxPeer` / `onlyInboxReturnLeg` run for real. `IssuerBlocklistERC20` is a PoC-only USDC-style token.

## Run

```
# native solc 0.8.28 (0.8.28+commit.7893614a) — the wasm build OOMs on this tree under viaIR
export SOLC_NATIVE=/path/to/solc-static-linux
NODE_OPTIONS='--max-old-space-size=8192' npx hardhat --config hardhat.config.portal-poc.ts test \
  test/portal-poc/findings-A.ts test/portal-poc/findings-B.ts
```

`findings-A.ts` covers F1–F7, `findings-B.ts` covers F8–F14. Each `describe` deploys a fresh factory + portal + pToken.
