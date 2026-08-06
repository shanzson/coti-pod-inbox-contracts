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

Packed on `FeeConfig` (`uint16` + `uint16`, still one storage slot with the seven `uint32`s). Default `1/1`.

On wei→gas for each leg (configs already in memory → **no extra SLOAD**):

```text
gasUnits = mulDiv(gasUnits, gasPriceMul, gasPriceDiv)
```

**Direction:** factor approximates `gasPrice_remote / gasPrice_local` on the **remote** template (how local reference wei maps to remote gas units).

| Observed | Remote template tweak |
|---|---|
| Remote gas ~10× dearer | `mul=10, div=1` → larger `targetFee` gas units from same wei |
| Remote gas ~half as dear | `mul=1, div=2` |

- Do **not** bury cross-chain gas-price skew only in `gasPerByte` — use mul/div so size pricing stays honest.
- Inverse (`* div / mul`, ceil) in `calculateTwoWayFeeRequiredInLocalToken` so UI prepaid estimates match submit.
- `maxExecutionGas` still caps post-skew budgets; constant-fee legs keep `maxExecutionGas >= constantFee`.
- Estimator stipend uses prepaid `targetFee` **as-is** — do not re-apply mul/div (would double-count).
