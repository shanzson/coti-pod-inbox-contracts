# Size caps, reply max, and in-batch miner reject

**Audience:** Inbox operators / deployers.  
**User-facing overview** (payload weight, defaults, app checklist): [how-poa-fees-work.md — Maximum method-call size](https://github.com/coti-io/documentation/blob/main/privacy-on-demand/how-poa-fees-work.md#maximum-method-call-size-apps-must-respect-this).

## Payload weight (admission metric)

Hard caps use **payload weight**, not ABI encode length and not “calldata size”:

```text
weight = data.length + datatypes.length * 32 + datalens.length * 32
```

Fee metering may still use `abi.encode(methodCall).length`. A message can be under the weight cap and still owe fees on a larger encode size.

Admin UI / runbooks should label fields as **“max method-call payload weight (bytes)”** and show this formula.

Reply legs (`respond` / `raise`) use the same weight units via `maxReplyMethodCallBytes`, so a destination contract cannot mint an oversized return message that the source lane cannot ingest.

## Defaults

| Knob | Default |
|---|---|
| `FeeConfig.maxMethodCallBytes` | `8192` |
| `FeeConfig.maxExecutionGas` | `5_000_000` (variable) / `≥ constantFee` (constant-fee legs; ship floor = priced execution + max-size ingest) |
| `maxReplyMethodCallBytes` | `8192` |

These apply to **constant-fee and variable-fee** templates. `constantFee > 0` does not allow omitting the two max fields. On-chain validation also requires `maxExecutionGas >= constantFee` when constant mode is used.

`FeeConfig` fields and `maxReplyMethodCallBytes` are **`uint32`** (seven fee fields pack into **one storage slot** per local/remote config). Values must stay ≤ `type(uint32).max` (~4.29e9).

## Constant-fee worst-case floor (deploy checklist)

Flat `constantFee` is intentional once payload size and execution gas are **hard-capped**. Before shipping or retuning a constant-fee template:

1. Take the deploy schedule’s **priced execution** gas units and **measured ingest gas per payload-weight byte**.
2. Compute `floor = pricedExecution + maxMethodCallBytes × ingestGasPerByte` (optional buffer via `bufferRatioX10000` on the floor helper).
3. Set `constantFee ≥ floor`, then set `maxExecutionGas ≥ constantFee` (usually equal).
4. Record both values in `deployConfig` / fee templates. Deploy helpers **assert** this inequality and refuse to apply underpriced constant-fee configs.

Subsidy vs margin above the floor is an operator policy choice; shipping below the floor is not.

## Admin invariants

1. Set peer `maxMethodCallBytes` from measured max-ingestable weight (with execute headroom).
2. Keep local `maxReplyMethodCallBytes` ≤ peer `maxMethodCallBytes`.
3. Change peer ingest max first if raising reply max.
4. Record values in `deployConfig` (testnet/mainnet) as SoT for deploy; use backoffice for live retune.

## In-batch miner reject

Do **not** widen `MinedRequest`. Reject is a contiguous `batchProcessRequests` item that requires **both**:

1. `targetContract == address(0)` (miner-only; user sends never use zero target)
2. Sentinel `methodCall` encoding:

```text
selector = 0x00000000
datatypes = []
datalens = []
data = abi.encodePacked(0xff, uint8(code), bytes32(reason))  // length 34
```

A nonzero `targetContract` **never** takes the reject path, even if `methodCall` matches the sentinel (PF-L1: avoids raw `0xff||…` collision spoofing `ERROR_CODE_MINER_REJECTED`). Zero target without a valid sentinel reverts `InvalidTargetContract`.

Build the methodCall with the on-chain helper (do not hand-roll):

```solidity
methodCall = rejectTools.buildMinerRejectMethodCall(rejectionCode, rejectionReason);
// mined.targetContract = address(0);
```

Keep the real header fields (`requestId`, fees, selectors, `isTwoWay`, …) from the source request / `MessageSent`. Destination stores an **empty** methodCall, emits `RequestRejected`, records `ERROR_CODE_MINER_REJECTED` (3), and for two-way sends a compact system-error callback. `retryFailedRequest` does not apply.

If a normal (non-reject) item is overweight, ingest **reverts** — resubmit that nonce as a reject item (`targetContract=0` + sentinel).

## Miner policy

Use reject for oversize / structurally unprocessable ingest only — not for execution-gas sizing (use `estimateExecutionGasForMiner`).
