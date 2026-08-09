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
| `FeeConfig.maxExecutionGas` | `5_000_000` (variable) / `≥ constantFee` (constant-fee legs, e.g. `12_000_000`) |
| `maxReplyMethodCallBytes` | `8192` |

These apply to **constant-fee and variable-fee** templates. `constantFee > 0` does not allow omitting the two max fields. On-chain validation also requires `maxExecutionGas >= constantFee` when constant mode is used.

`FeeConfig` fields and `maxReplyMethodCallBytes` are **`uint32`** (seven fee fields pack into **one storage slot** per local/remote config). Values must stay ≤ `type(uint32).max` (~4.29e9).

## Admin invariants

1. Set peer `maxMethodCallBytes` from measured max-ingestable weight (with execute headroom).
2. Keep local `maxReplyMethodCallBytes` ≤ peer `maxMethodCallBytes`.
3. Change peer ingest max first if raising reply max.
4. Record values in `deployConfig` (testnet/mainnet) as SoT for deploy; use backoffice for live retune.

## In-batch miner reject

Do **not** widen `MinedRequest`. Reject is a contiguous `batchProcessRequests` item whose `methodCall` uses a special encoding:

```text
selector = 0x00000000
datatypes = []
datalens = []
data = abi.encodePacked(0xff, uint8(code), bytes32(reason))  // length 34
```

Build it with the on-chain helper (do not hand-roll):

```solidity
methodCall = inbox.buildMinerRejectMethodCall(rejectionCode, rejectionReason);
```

Keep the real header fields (`requestId`, fees, selectors, `isTwoWay`, …) from the source request / `MessageSent`. Destination stores an **empty** methodCall, emits `RequestRejected`, records `ERROR_CODE_MINER_REJECTED` (3), and for two-way sends a compact system-error callback. `retryFailedRequest` does not apply.

If a normal (non-reject) item is overweight, ingest **reverts** — resubmit that nonce as a reject item.

## Miner policy

Use reject for oversize / structurally unprocessable ingest only — not for execution-gas sizing (use `estimateExecutionGasForMiner`).
