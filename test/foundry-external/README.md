# External-PoC verification workspace (Foundry)

Supporting material for `audit/external-findings-verification-20260907.md`: the files needed to re-run the
external auditor's Foundry PoCs (gist `kuldeep23907/a7f659352f240ca9e67f49ed3c8c3220` @ `7aa7524c`) against
this repo and `coti-contracts`, plus two verifier-written tests.

| File | Purpose |
|---|---|
| `foundry.scopeA.toml` | Workspace config for the Inbox repo (shanghai, via-IR, runs=1, as `hardhat.config.ts`). Replace `<SCRATCH>` and the `solc` path. |
| `foundry.scopeB.toml` | Workspace config for `coti-contracts` (paris, via-IR, runs=1). |
| `harness/B11Harness.sol` | Harness the gist's `B11_TryDecodeWrap.t.sol` imports but does not ship: exposes `InboxBase._safeEncodeMethodCall` behind a raw-returning echo module. |
| `verifier/ShippedConfigQuote.t.sol` | Cross-repo test on the real `Inbox`+`FeeManager`+`PriceOracle`+`PodErc20Mintable` with the fee templates from `scripts/deploy-utils.ts`. Proves the single-admissible-target-gas defect (report §6) and finding #7's `CallbackFeeTooLow` on encrypted transfers funded by `estimateFee()`. Lives in workspace A. |
| `verifier/MsgSizeProbe.t.sol` | Measures `abi.encode(methodCall).length` of real `PodERC20` sends (mint 448, public transfer 544, encrypted transfer 768, encrypted transferFrom 864, syncBalances(10) 704 bytes). Lives in workspace B. |

Layout expected by the gist tests: `<ws>/contracts` (copy of the repo's `contracts/`), `<ws>/test/foundry/*.t.sol`,
`<ws>/test/foundry/mocks/*.sol` (gist mocks, Scope B only), `<ws>/test/foundry/harness/B11Harness.sol` (Scope A),
`<ws>/test/foundry/verifier/*.t.sol`. In Scope B also copy the gist's
`P14F3_PortalAccountingRescue.invariant.t.sol` to `test/foundry/PortalAccounting.invariant.t.sol` (imported under that
name) and delete `contracts/disperse` (pinned `=0.8.20`). Run `forge test -vv`; in Scope B add
`--no-match-path 'contracts/mocks/**'` to skip the repo's own precompile-dependent mock test contracts.

Results at the time of writing: Scope A 108/108 pass; Scope B 77 pass + the 2 invariants the auditor designed to fail
(`P14` fee rewrite, `rescueERC20` solvency leak). Logs in `audit/external-findings-verification/`.
