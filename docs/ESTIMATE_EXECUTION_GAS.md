# estimateExecutionGasForMiner

Public always-revert preflight for destination execution (miner `eth_call` or dapp UX).

Implemented in [`InboxEstimateGas.sol`](../contracts/InboxEstimateGas.sol) (`_estimateExecutionGasForMiner`); public entry on `InboxMiner` for {IInboxMiner}.

## Call

```text
estimateExecutionGasForMiner(sourceChainId, mined, maxUserGas)
```

Always reverts with:

```solidity
error ExecutionGasEstimate(uint256 gasUsed, uint256 responseDataSize, uint256 errorDataSize);
```

| Field | Meaning |
|---|---|
| `gasUsed` | Gas consumed by the user subcall only |
| `responseDataSize` | Payload weight of `respond()` outbound methodCall (`0` if none) |
| `errorDataSize` | Payload weight of `raise()` / system-error outbound (`0` if none) |

**How you know there was a response:** `responseDataSize > 0`. Normal `sendOneWay`/`sendTwoWay` from the target are **not** included.

## Safety

- Intended for `eth_call`. A real tx also reverts → no lasting storage or events.
- While estimating, inbox skips emits and tags reply creates via `_estimateReplyKind`.
- Nested `call{gas: stipend}` with `ESTIMATE_OUTER_RESERVE` so adaptive burn cannot OOG before the revert encode.

`stipend = min(maxUserGas, executionBudget(targetFee), gasleft() - ESTIMATE_OUTER_RESERVE)`.

Prepaid `targetFee` already includes `gasPriceMul`/`gasPriceDiv` from create time — do not apply mul/div again when interpreting the estimate.

## Parsing `ExecutionGasEstimate` (miner / UX)

1. `eth_call` `estimateExecutionGasForMiner(...)`.
2. Decode the revert as `ExecutionGasEstimate(gasUsed, responseDataSize, errorDataSize)`.
3. Mine gas ≈ `gasUsed + reply-create overhead + POST_CALL_GAS_RESERVE + pad`; compare to prepaid `_localRequestExecutionBudget(targetFee)`.
4. If systematically under/over vs prepaid budget → retune `gasPriceMul`/`gasPriceDiv` (or buffers), not a second mul inside the estimator.

## Miner batch gas planning (CMS / PEI)

Shared algorithm (TypeScript SoT: `pod-ecosystem-integration/scripts/inbox-mine-gas.ts`;
Python port: `contract-manager-service/app/modules/pod-inbox-relay/mine_gas.py`):

1. Per pending request: call `estimateExecutionGasForMiner` → `gasUsed`.
2. Apply configurable user-gas buffer (BPS + absolute).
3. Project per-request cost = buffered user gas + reply overhead + fixed overheads + `POST_CALL_GAS_RESERVE`.
4. Greedy-pack requests while projected sum ≤ `maxBatchGas`.
5. `eth_estimateGas` the encoded `batchProcessRequests` tx.
6. `gasLimit = max(projectedBatchGas, eth_estimateGas)` — projection floors estimateGas griefing; eth_estimateGas covers real outer costs.

Do not re-apply `gasPriceMul`/`gasPriceDiv` when interpreting estimates (prepaid `targetFee` already includes skew).

## gasPriceMul / gasPriceDiv (ops runbook)

Packed on `FeeConfig` (`uint16` + `uint16`, still one storage slot with the seven `uint32`s). Default `1/1` is **Hardhat-only**; live L1↔COTI lanes must ship a measured non-identity remote ratio (H-02).

On wei→gas for each leg (configs already in memory → **no extra SLOAD**):

```text
gasUnits = mulDiv(gasUnits, gasPriceMul, gasPriceDiv)
```

**Direction (remote template):** `mul/div ≈ g_local / g_remote` where `g` is FeeManager’s reference gas (baseFee or `tx.gasprice`, clamped to `gasPriceBounds`).

Break-even remote gas from local wei is `N = W · P_L / (P_R · g_R)`. Without skew the code uses `g_L` in the denominator, so identity mul/div over-grants when `g_R > g_L` (classic ~20× COTI→Sepolia under-collection).

| Observed | Remote template tweak |
|---|---|
| Remote gas ~10× dearer (`g_R ≈ 10 · g_L`) | `mul=1, div=10` → smaller `targetFee` gas units from same wei (payer must send more wei for the same remote budget) |
| Remote gas ~half as dear (`g_R ≈ 0.5 · g_L`) | `mul=2, div=1` |

- Do **not** bury cross-chain gas-price skew only in `gasPerByte` — use mul/div so size pricing stays honest.
- Inverse (`* div / mul`, ceil) in `calculateTwoWayFeeRequiredInLocalToken` so UI prepaid estimates match submit.
- `maxExecutionGas` still caps post-skew budgets; constant-fee legs keep `maxExecutionGas >= constantFee`.
- Estimator stipend uses prepaid `targetFee` **as-is** — do not re-apply mul/div (would double-count).
- PEI deploy refuses remote `mul == div` on non-Hardhat chains unless `allowGasPriceSkewOneToOne` is set.

### Measuring and retuning (H-02)

Reproducible helper (PEI):

```bash
node scripts/measure-gas-price-skew.mjs
```

Method:

1. Read `eth_gasPrice` and latest `baseFeePerGas` on local and remote RPCs.
2. Compute FeeManager-like reference `g = max(baseFee or gasPrice, minGasPriceWei)` (and clamp to `maxGasPriceWei` if set).
3. Set **remote** `gasPriceMul/Div ≈ g_local / g_remote` with ~10% margin favoring miner coverage (shrink further when remote is dearer).
4. Optionally compare a known two-way / mine receipt: prepaid local wei vs remote `gasUsed × remote gas price × oracle USD` and retune if PnL drifts.
5. Record ratios in `deployConfig*.yaml` (`chains.<id>.feeConfig.remote`) and `LIVE_LANE_REMOTE_GAS_PRICE_SKEW` in `scripts/deploy-utils.ts`.

**Shipped ratios (2026-08-16 samples + floor-aware AVAX mainnet):**

| Lane (create chain → remote) | remote mul/div | Notes |
|---|---|---|
| Sepolia → COTI testnet | `5/1` | Testnet floors often equalize at 2 gwei; keep representative L1→COTI skew for when markets diverge |
| Fuji → COTI testnet | `13/1` | Mirrors AVAX mainnet floor 25 gwei vs COTI 2 gwei |
| COTI testnet → Sepolia | `1/5` | Inverse of Sepolia→COTI |
| Ethereum → COTI mainnet | `5/1` | Retune via measure script when baseFee stays above mins |
| Avalanche → COTI mainnet | `13/1` | From `minGasPriceWei` 25 gwei / 2 gwei |
| COTI mainnet → L1 | `1/10` | Covers ETH~5 and AVAX~13 with margin |

Retune when lane PnL or `measure-gas-price-skew.mjs` drifts materially; keep Hardhat `31337` at `1/1`.