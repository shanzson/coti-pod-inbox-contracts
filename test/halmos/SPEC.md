# Formal Verification Specification — coti-pod-inbox-contracts

**Target:** Halmos symbolic execution over the real deployed bytecode (no re-implementations,
except where a contract is abstract and a minimal concrete harness is required).

**Protocol context (whitepaper v2, Apr 2024):** COTI V2 is a confidential EVM L2 (gcEVM,
garbled-circuit MPC). The pod-inbox contracts implement the cross-chain request/response
transport: a *local* chain sends an MPC method call to a *remote* chain and optionally
receives a callback. Users prepay **both legs in the local native token** ($COTI on the
L2 side). The fee model (whitepaper §3.4) is demand-based with protocol-set rules; the
inbox realizes it via per-leg gas templates (`FeeConfig`), an oracle USD price pair, and
a reference gas price. Formal verification focuses on the properties that protect the two
economic parties: the **user** (an honest quote must be accepted, and must buy at least
the gas quoted) and the **protocol/miner** (granted gas budgets must never exceed what
was paid for; message identifiers must never collide).

---

## 0. Notation and machine model

All arithmetic is EVM `uint256` with Solidity ≥0.8 checked semantics: any intermediate
overflow **reverts** (never wraps), except inside OpenZeppelin `Math.mulDiv`, which
computes `floor(a·b/c)` (or `ceil` with `Rounding.Ceil`) with a **512-bit intermediate**
and reverts only when the true result ≥ 2²⁵⁶ or `c = 0`.

- `⌊x⌋`, `⌈x⌉` — floor / ceil over rationals; all program variables are non-negative integers.
- `divUp(a,b) := ⌈a/b⌉ = (a + b − 1) div b` for `b ≥ 1` (integer form used inline in
  `FeeManagerStubBase.sol:178,181` as `(x*d + m − 1)/m` — see L2 for the identity).
- `FeeConfig = (cf, g, cbg, el, br, maxB, maxG, mul, div)` for
  (`constantFee`, `gasPerByte`, `callbackExecutionGas`, `errorLength`,
  `bufferRatioX10000`, `maxMethodCallBytes`, `maxExecutionGas`,
  `gasPriceMul`, `gasPriceDiv`); widths: first seven `uint32`, last two `uint16`.
- `lp, rp` — `localTokenPrice`, `remoteTokenPrice` from `PriceOracle.getPricesUSD()`,
  18-decimal USD per whole token, `lp, rp ≥ 1` enforced (`OraclePriceZero`).
- `P` — gas price in local wei (`gasPrice` argument on the quote side;
  `_referenceGasPrice()` on the validation side).

Three code copies of the min-fee template exist and are claimed identical:
`FeeManager.expectedMinFee` (FeeManager.sol:214), `InboxFeeQuoter._expectedMinFee`
(InboxFeeQuoter.sol:50), `FeeManagerStubBase._expectedMinFeeGasUnits`
(FeeManagerStubBase.sol:265). Define the mathematical function they all claim to compute:

```
E(s, C) := cf                                          if cf > 0
         := ⌊ (s·g + cbg + el·g) · (10000 + br) / 10000 ⌋   otherwise
```

Skew maps (`FeeManager._applyGasPriceSkew`, FeeManager.sol:286 and its inverses in the
quoters):

```
skew⁻¹(x, C) := ⌈ x · div / mul ⌉        (quote side: gas units → billable units)
skew  (x, C) := ⌊ x · mul / div ⌋        (validate side: billable units → gas units)
```

Currency conversion:

```
conv⁻¹(x) := ⌈ x · rp / lp ⌉             (quote: remote gas units → local gas units)
conv  (x) := ⌊ x · lp / rp ⌋             (validate: local gas units → remote gas units)
```

---

## 1. Arithmetic lemmas

Domain note for the mechanical verification: the lemmas are *true* on the full uint256
domain, but symbolic nonlinear division with symbolic divisors drives the solver into
OZ `mulDiv`'s 512-bit Newton-inverse branch (`high ≠ 0`), which Z3 effectively never
closes. The Halmos encodings therefore verify each lemma on domains that keep every
product below 2²⁵⁶ (the `high = 0` fast path) — stated per test — which covers the
entire domain the fee pipeline itself can reach inside its own no-overflow envelope
(P-CFG-NR). Any solver-`unknown` outside that envelope is reported as such, never
claimed proven.

**L1 (floor∘ceil round-trip, the load-bearing lemma).**
For all integers `x ≥ 0`, `m ≥ 1`, `d ≥ 1`:

```
⌊ ⌈x·d/m⌉ · m / d ⌋ ≥ x
```

*Proof sketch:* let `y = ⌈x·d/m⌉`. Then `y ≥ x·d/m`, hence `y·m/d ≥ x`, hence
`⌊y·m/d⌋ ≥ ⌊x⌋ = x` since `x` is an integer. ∎
This single lemma is why an honest quote survives validation for **both** the skew pair
(`m = gasPriceMul`, `d = gasPriceDiv`) and the currency pair (`m = lp`, `d = rp`).

**L2 (inline ceil-div identity).**
For `x, d ≥ 0`, `m ≥ 1`, when `x·d + m − 1 < 2²⁵⁶` (no revert):

```
(x·d + m − 1) div m = ⌈x·d/m⌉ = Math.mulDiv(x, d, m, Ceil)
```

Hence `FeeManagerStubBase`'s inline expressions and `InboxFeeQuoter`'s `mulDiv(…, Ceil)`
agree on the entire non-reverting domain of the inline form; the inline form reverts on a
strictly larger input set (it overflows at `x·d ≈ 2²⁵⁶` where the 512-bit `mulDiv` does not).

**L3 (buffer inflation is inflationary).**
For `u ≥ 0`, `br ≥ 0`: `⌊u·(10000+br)/10000⌋ ≥ u`. In particular `E(s,C) ≥ s·g + cbg + el·g`
in the non-constant branch: the buffer can never *reduce* the raw gas estimate.

**L4 (monotonicity of E).** In the non-constant branch, `E(s, C)` is monotone
non-decreasing in `s` (and in each of `g, cbg, el, br` separately). In the constant branch
it is constant in `s`. Corollary: `s₁ ≤ s₂ ⟹ E(s₁,C) ≤ E(s₂,C)` for every fixed `C`.

**L5 (floor-chain value bound).** For `F, P ≥ 1` and any config/prices:

```
skew(conv(⌊F/P⌋)) · P · rp · div  ≤  F · lp · mul + slack
```

with the precise integer statement verified as:
`skew(conv(⌊F/P⌋)) ≤ (F · lp · mul) / (P · rp · div)` over the rationals, i.e.

```
skew(conv(⌊F/P⌋)) · P · rp · div ≤ F · lp · mul .
```

*Proof sketch:* each of the three operations `⌊F/P⌋`, `conv`, `skew` is of the form
`x ↦ ⌊x·a/b⌋ ≤ x·a/b`; composing the three real-valued upper bounds gives the product
bound, and the integer LHS is ≤ the real LHS. ∎
This is the **protocol-solvency direction**: the remote gas budget granted, priced back
at the reference gas price and oracle prices with skew undone, never exceeds the wei paid.

---

## 2. Verified functions and their contracts (file:line ground truth)

| Code | Math | Notes |
|---|---|---|
| `FeeManager.expectedMinFee(s, C)` (FeeManager.sol:214-225) | `E(s,C)` | public pure |
| `InboxFeeQuoter._expectedMinFee` (InboxFeeQuoter.sol:50-57) | `E(s,C)` | via external quote fn |
| `FeeManagerStubBase._expectedMinFeeGasUnits` (FeeManagerStubBase.sol:265-272) | `E(s,C)` | via view + storage |
| `FeeManager._applyGasPriceSkew(x, C)` (FeeManager.sol:286-292) | `skew(x,C)` | mulDiv floor |
| `FeeManager.localRequestExecutionBudget(F)` (FeeManager.sol:92-99) | see P-BUD | reads local config |
| `FeeManager.validateAndPrepareTwoWayFees` (FeeManager.sol:158-190) | see P-RT2 | payable, storage |
| `FeeManager.validateAndPrepareOneWayFees` (FeeManager.sol:194-211) | see P-RT1 | payable, storage |
| `InboxFeeQuoter.calculateTwoWayFeeRequiredInLocalToken` (InboxFeeQuoter.sol:23-48) | Q below | external pure |
| `FeeManagerStubBase.calculateTwoWayFeeRequiredInLocalToken` (FeeManagerStubBase.sol:151-184) | Q with inline ceil | view + storage + oracle |
| `InboxBase._packRequestId` / `_unpackRequestId` (InboxBase.sol:650-674) | P-PACK | reachable via public `getRequestId` |
| `FeeManager._referenceGasPrice` (FeeManager.sol:227-243) | P-REF | clamp logic |
| `FeeManager._requireValidFeeConfig` (FeeManager.sol:259-284) | P-CFG | admission predicate |

**Quote function Q** (both quoters), inputs
`(C_l, C_r, lp, rp, s_r, s_cb, x_r, x_cb, P)`:

```
t   := E(s_r,  C_r) + x_r                  # remote-leg gas target
c   := E(s_cb, C_l) + x_cb                 # callback-leg gas target
t'  := skew⁻¹(t, C_r) = ⌈t·div_r/mul_r⌉
c'  := skew⁻¹(c, C_l) = ⌈c·div_l/mul_l⌉
T   := conv⁻¹(t') · P = ⌈t'·rp/lp⌉ · P     # targetFeeLocalWei
K   := c' · P                              # callerFeeLocalWei
```

**Validator V** (`validateAndPrepareTwoWayFees(ds, F_tot, F_cb)`), with reference gas
price `P_v`, prices `(lp, rp)`, configs `(C_l, C_r)` from storage:

```
require F_tot ≥ 1, 1 ≤ F_cb ≤ F_tot
cg := skew(⌊F_cb/P_v⌋, C_l)                          # callerGasLocalUnits
tg := skew(conv(⌊(F_tot − F_cb)/P_v⌋), C_r)          # targetGasRemoteUnits
require cg ≥ E(ds, C_l)          else CallbackFeeTooLow
require tg ≥ E(ds, C_r)          else TargetFeeTooLow
return (tg, cg)
```

---

## 3. Properties

### Group A — implementation equivalence

**P-EQ1.** For all inputs on which neither side reverts:
`InboxFeeQuoter.calculateTwoWayFeeRequiredInLocalToken ≡ FeeManagerStubBase.calculateTwoWayFeeRequiredInLocalToken`
(with the stub's storage/oracle populated with the same `C_l, C_r, lp, rp` and identical
scalar args). Domain note: by L2 the stub's inline ceil reverts earlier; equivalence is
asserted conditional on the stub not reverting.

**P-EQ2.** `FeeManager.expectedMinFee(s, C) = E(s, C)` and equals the value implied by
`InboxFeeQuoter` (extracted by calling Q with `x = 0`, `mul = div = 1`, `rp = lp = 1`,
`P = 1`, whereby `K = E(s_cb, C_l)` exactly — see L1/L2 degenerate case: with
`mul = div = 1` both skews are identity; with `rp = lp` conv⁻¹ is identity).

### Group B — quote soundness (user protection)

**P-RT2 (two-way round-trip theorem — the flagship).**
Fix any `C_l, C_r` passing `_requireValidFeeConfig`, any `lp, rp ≥ 1`, any `P ≥ 1`,
any sizes/gas `s_r, s_cb, x_r, x_cb`, and send-time `ds`. Let `(T, K) := Q(...)` and run
`V(ds, T + K, K)` with `P_v = P` and the same configs/prices. Then, **provided**

  (H1) `E(ds, C_l) ≤ E(s_cb, C_l)` (in particular whenever `s_cb ≥ ds`, by L4, or `cf_l > 0`), and
  (H2) `E(ds, C_r) ≤ E(s_r, C_r)` (in particular whenever `s_r ≥ ds`, or `cf_r > 0`), and
  (H3) no intermediate overflow-revert occurs,

the validator **accepts**, and returns budgets covering the quoted work:

```
cg ≥ c = E(s_cb, C_l) + x_cb      and      tg ≥ t = E(s_r, C_r) + x_r .
```

*Proof sketch:* `K = c'·P` divides exactly by `P`, so `⌊K/P⌋ = c' = ⌈c·div_l/mul_l⌉`;
by L1, `cg = ⌊c'·mul_l/div_l⌋ ≥ c ≥ E(s_cb,C_l) ≥ E(ds,C_l)` (H1). For the target leg,
`T + K − K = T = ⌈t'·rp/lp⌉·P`, so `⌊T/P⌋ = ⌈t'·rp/lp⌉`; by L1 (currency pair)
`conv(⌊T/P⌋) ≥ t'`, and floor-mulDiv monotonicity plus L1 (skew pair) give
`tg = skew(conv(⌊T/P⌋)) ≥ skew(t') = ⌊⌈t·div_r/mul_r⌉·mul_r/div_r⌋ ≥ t ≥ E(ds,C_r)` (H2).
Also `T ≥ 1` and `K ≥ 1` need `c ≥ 1` and `t' ≥ 1`: guaranteed since valid configs force
`E ≥ 1` (constant branch: `cf ≥ 1`; non-constant: `gasUnits ≥ cbg ≥ 1`, factor
≥ 10001/10000, floor stays ≥ 1), and skew⁻¹/conv⁻¹ of a positive integer is ≥ 1 —
positivity of the ceil needs the **numerators** positive (`div_r ≥ 1`, `div_l ≥ 1`,
`rp ≥ 1` — all guaranteed by `_requireValidFeeConfig` / `OraclePriceZero`), while
`mul ≥ 1`, `lp ≥ 1` provide well-definedness of the divisions. ∎

**Falsification companion P-RT2-neg:** without H1 (e.g. `s_cb < ds`, `cf_l = 0`) the
validator can revert `CallbackFeeTooLow` on an honestly quoted payment — Halmos is
expected to **produce this counterexample**, documenting the quote/validate size
asymmetry as a real (known) integration hazard, not a spec bug.

**P-RT1 (one-way round-trip).** Same statement restricted to the target leg with
`F_tot = T`, using `validateAndPrepareOneWayFees(ds, T)`; requires only H2, H3.

**P-MONO-V (more money never hurts).** If `V(ds, F_tot, F_cb)` accepts, then for any
`Δ ≥ 0` (no-overflow), `V(ds, F_tot + Δ, F_cb)` accepts, with `tg' ≥ tg` and `cg' = cg`.
*Sketch:* `F_tot − F_cb` increases; `⌊·/P⌋`, `conv`, `skew` are monotone.

### Group C — protocol solvency (miner/protocol protection)

**P-SOLV-T (target leg never oversold).** Whenever `V` accepts:

```
tg · P_v · rp · div_r  ≤  (F_tot − F_cb) · lp · mul_r          (from L5)
```

**P-SOLV-C (callback leg never oversold).** Whenever `V` accepts:

```
cg · P_v · div_l  ≤  F_cb · mul_l .
```

**P-BUD (execution budget bounds).** For `localRequestExecutionBudget(F)`:
`budget ≤ F` always; if `cf_l = 0` then `budget = max(F − el·g, 0)` exactly (no
underflow-revert possible: guarded by the ternary); if `cf_l > 0` then `budget = F`.

### Group D — identifier integrity (message-transport safety)

**P-PACK1 (round-trip).** For `s, t ≤ 2⁶⁴−1`, `n ≤ 2¹²⁸−1`:
`unpack(pack(s,t,n)) = (s,t,n)`.

**P-PACK2 (revert completeness).** `pack(s,t,n)` reverts **iff**
`s > 2⁶⁴−1 ∨ t > 2⁶⁴−1 ∨ n > 2¹²⁸−1` (`SourceChainIdTooLarge` / `TargetChainIdTooLarge`
/ `NonceTooLarge`).

**P-PACK3 (injectivity ⇒ requestId uniqueness).** For in-range tuples,
`pack(s₁,t₁,n₁) = pack(s₂,t₂,n₂) ⟹ (s₁,t₁,n₁) = (s₂,t₂,n₂)`. Combined with the
per-target strictly-increasing nonce (`++_requestNonce[targetChainId]`,
InboxBase.sol:507) this yields global uniqueness of live request ids on a source chain.
(Nonce monotonicity itself is a one-line storage property; verified in the bounded
state-machine suite, not by pure math.)

### Group E — reference gas price and config admission

**P-REF (clamp correctness).** `_referenceGasPrice` returns `p` with:
`p ≥ 1`; if `maxGasPriceWei ≠ 0` and `maxGasPriceWei ≥ effective-min` then
`min' ≤ p ≤ maxGasPriceWei` where `min' = minGasPriceWei` (or `DEFAULT_GAS_PRICE` if 0).
Clamp order note: the code applies the min clamp **before** the max clamp, so when
`maxGasPriceWei < min'` the max wins (`p = maxGasPriceWei`) — asserted as-is, matching
`setGasPriceBounds`'s guarantee `max ≥ min` when both set (GasPriceBoundsInvalid), which
makes the inverted case unreachable under admin-validated storage; the property is
verified in both the unconstrained-storage form and the admin-validated form.
Environment control in Halmos: with `block.basefee = 0` and `tx.gasprice = 0` the
pre-clamp price is `DEFAULT_GAS_PRICE = 2·10⁹`; setting `minGasPriceWei = maxGasPriceWei = P`
forces the return value to exactly `P` for any `P ≥ 1` (this is how P-RT2 pins `P_v = P`).
Edge: for `P > DEFAULT_GAS_PRICE` the min-clamp raises to `P`; for `P ≤ DEFAULT_GAS_PRICE`
the max-clamp lowers to `P`. Both branches verified.

**P-CFG (validated configs give positive, well-defined fee terms).** If `C` passes
`_requireValidFeeConfig` then: `mul, div ≥ 1`; `E(s, C) ≥ 1` for every `s`
(constant branch: `cf ≥ 1`; non-constant: `g, cbg, el, br ≥ 1` so `gasUnits ≥ cbg ≥ 1`,
the factor is ≥ 10001/10000, and the floor stays ≥ 1).

**P-CFG-NR (no-unexpected-revert envelope).** On the bounded domain

```
s ≤ 32768,  x ≤ 25·10⁶,  br ≤ 10⁴,  lp, rp ∈ [1, 10³⁶],  P ∈ [1, 10¹⁵],
g, cbg, el ≤ 2³²−1,  mul, div ∈ [1, 2¹⁶−1]
```

neither quoter reverts. Note the deliberate extra hypothesis `br ≤ 10⁴` (shipped
template: 5000): a *validated* config allows `br` up to 2³²−1 (`_requireValidFeeConfig`
only demands non-zero), and with `br ≈ 2³²` the buffer factor is ≈ 429 497, giving
`E ≈ 2⁸³`; combined with `div = 65535`, `rp/lp = 10³⁶`, `P = 10¹⁵` the final checked
multiplication `targetGasLocalUnits · P` exceeds 2²⁵⁶ and both quoters revert — so the
envelope is **false without the `br` cap** (this is a documented config foot-gun, see
P-CFG-FG below). With `br ≤ 10⁴` the chain is safe end to end, carrying the final `×P`
factor through:
`gasUnits = s·g + cbg + el·g ≤ 2¹⁵·(2³²−1) + (2³²−1) + (2³²−1)² < 2⁶⁴+2⁴⁷ < 2⁶⁵`,
`E ≤ gasUnits·2 < 2⁶⁶`, `t = E + x < 2⁶⁶ + 2²⁵ < 2⁶⁷`, `t′ ≤ ⌈t·div/mul⌉ < 2⁶⁷·2¹⁶ = 2⁸³`,
`t′·rp + lp − 1 < 2⁸³·2¹²⁰ + 2¹²⁰ < 2²⁰⁴` (inline intermediate, no overflow),
`conv⁻¹(t′) < 2²⁰⁴`, and `T = conv⁻¹(t′)·P < 2²⁰⁴·2⁵⁰ = 2²⁵⁴ < 2²⁵⁶`. The callback leg
is strictly smaller (`K < 2⁸³·2⁵⁰ = 2¹³³`).

**P-CFG-FG (falsification companion).** Without the `br ≤ 10⁴` hypothesis Halmos is
expected to produce the overflow counterexample above — documenting that an
admin-validated config can still brick quoting at large-but-in-range prices/gas prices.

### Group F′ — degenerate/unconfigured storage safety

**P-CFG0 (unconfigured storage can never be accepted).** Verified as "unconfigured ⟹
no acceptance" — never as a specific error selector — in **two distinct storage states**:
(a) fully zero-initialized storage: both validators revert at `_validatedOraclePrices`
with `OracleNotConfigured` (FeeManager.sol:250-251) *before* any fee math runs;
(b) partially configured (oracle set, non-zero prices, fee templates still zero):
both validators revert via the `Math.mulDiv(·, ·, 0)` denominator-zero panic inside
`_applyGasPriceSkew` (`gasPriceDiv = 0`). The read-side quote view guards state (b)
explicitly (`FeeConfigInvalid`, FeeManagerStubBase.sol:167-173); `FeeManager` relies on
the panic. No path in either state returns budgets.

**dataSize semantics note (binds H1/H2 to reality).** The send path passes
`dataSize = abi.encode(methodCall).length` into fee validation (InboxBase.sol:197,219),
while admission caps use the different metric
`MinerRejectLib.structuralSize = data.length + 32·(|datatypes| + |datalens|)`
(MinerRejectLib.sol:47-49, used at InboxBase.sol:493). The round-trip hypotheses H1/H2
therefore compare the quote's user-chosen sizes against the **abi-encoded length**, which
strictly exceeds `structuralSize` (encoding adds head/offset/length words). The two
metrics' divergence is documented, not asserted equal.

### Group G — miner-reject sentinel codec

**P-REJ1 (round-trip).** For all `code : uint8`, `reason : bytes32`:
`MinerRejectLib.parse(build(code, reason)) = (true, code, reason)`
(`build` emits `0xff ‖ code ‖ reason`, 34 bytes; `parse` reads `data[0..2)` as bytes and
`mload(data + 34)` for the reason — the assembly offset must align with the 2-byte prefix).

**P-REJ2 (reject-detection soundness).** `parse(mc)` returns `isReject = true` **iff**
`mc.selector = 0 ∧ |datatypes| = 0 ∧ |datalens| = 0 ∧ |data| = 34 ∧ data[0] = 0xff`.
Any other shape yields `(false, 0, 0)` — no false positives that could hijack the
reject-ingest branch (`InboxMiner.sol:80-91`).

**P-SLOT (storage-slot constant integrity).** The hard-coded ERC-7201 slot in
`LibFeeStorage` equals its derivation function: `LibFeeStorage` assembly constant
`= erc7201Slot()` `= keccak256(abi.encode(uint256(keccak256("pod.inbox.fee.v1")) − 1))
& ~bytes32(uint256(0xff))` (LibFeeStorage.sol:39-52). A one-assert test — a mismatch
would silently split the stub getters and the DELEGATECALL module onto different storage.

### Group F — quote overcharge bound (tightness, best-effort)

**P-TIGHT.** Each `⌈·⌉` in Q exceeds its real-valued ideal by < 1 unit, so

```
T ≤ ( (t·div_r/mul_r + 1) · rp/lp + 1 ) · P     and     K ≤ (c·div_l/mul_l + 1) · P
```

verified in integer form as `T·lp·mul_r ≤ (t·div_r + mul_r)·rp·P + lp·mul_r·P` and
`K·mul_l ≤ (c·div_l + mul_l)·P`. This bounds the user's worst-case overpayment to
`< (1 + rp/lp)·P + P` wei on the target leg and `< P` wei on the callback leg
— rounding dust, no compounding overcharge.

### Group H — error-returndata DoS bound (miner-transport safety)

`InboxBase._capErrorReturnData` (InboxBase.sol:779) truncates a `bytes memory` **in place**
to at most `MAX_ERROR_RETURN_DATA = 256` bytes: `if gt(mload(data), 256) { mstore(data, 256) }`.
Failure payloads are written to storage and emitted, so an unbounded one could OOG the miner
tx or wedge the contiguous-nonce queue.

**P-CAP-LEN.** For all `d`: `|capErr(d)| = min(|d|, 256) ≤ 256`.
**P-CAP-PREFIX.** For all `d` and all `i < min(|d|, 256)`: `capErr(d)[i] = d[i]` — the retained
prefix is byte-for-byte the original (covers both the identity case `|d| ≤ 256` and the
truncation case `|d| > 256`). Verified at concrete lengths straddling the strict-`gt` boundary
`{0, 1, 255, 256, 257, 300}` with symbolic content (byte-length is not cheaply symbolic in
Halmos; stated as bounded-completeness, like P-REJ2).

---

## 4. Halmos encoding plan (written only after the math is approved)

- Pure lemmas L1, L2, L5 as symbolic tests on a tiny `MathLemmas` harness that calls OZ
  `Math.mulDiv` — verifying the lemmas as executed by the exact library the code uses.
- Groups A/B/C/E via a `FeeManagerHarness` that **deploys the real `FeeManager`**
  standalone (its ERC-7201 storage is then its own), configures it through its own
  external setters (`updateMinFeeConfigs`, `setGasPriceBounds`, `setPriceOracle` with a
  mock oracle returning symbolic `(lp, rp)`), and calls the real entry points with
  symbolic arguments. `svm.createUint`/`vm.assume` pin the domains stated per property.
- The stub-side quote (P-EQ1) via a minimal concrete subclass of `FeeManagerStubBase`
  with a storage-poking setter, holding the same symbolic config; falls back to
  `InboxFeeQuoter` alone if the abstract surface can't be instantiated cleanly.
- Group D via the public `getRequestId` / `unpackRequestId` surface of a deployable
  Inbox concrete contract (or a minimal `InboxBase` subclass exposing nothing new).
- Group G via a thin wrapper contract exposing the `internal` `MinerRejectLib.build` /
  `.parse` / `.structuralSize` as external functions (libraries with internal functions
  are not directly callable; the wrapper adds no logic). P-REJ2's quantifier over
  `|data|` is checked at bounded lengths that must include at least
  `{0, 1, 2, 33, 34, 35}` plus symbolic content at length 34 — stated as
  bounded-completeness, not a full universal claim.
- Environment pinning for every validator-side test: `vm.fee(0)` and `vm.txGasPrice(0)`
  are set explicitly (not relied on as Halmos defaults) so `_referenceGasPrice` is
  controlled solely through `setGasPriceBounds(0, P, P)`.
- Every property gets: the positive check, plus (where stated) the deliberate
  counterexample probe (P-RT2-neg, P-CFG-FG) marked as an expected-CEX documentation
  test.
- Loops: `--loop 2` suffices (the only loops are in OZ mulDiv shifts — loop-free — and
  payload iteration paths that the pure fee math never touches).
- Build parity: solc `0.8.28`, `viaIR: true`, `optimizer runs: 1`, `evmVersion: shanghai`
  (mirrors hardhat.config.ts so the verified bytecode matches production semantics,
  including the hand-written assembly). Remappings: `@openzeppelin/contracts/` →
  `node_modules/@openzeppelin/contracts/`, `@coti-io/coti-contracts/` →
  `../coti-contracts/` (file-linked dependency).
- Bounded-domain constants come from the shipped deployment templates
  (scripts/deploy-utils.ts): `gasPerByte = 800`, `callbackExecutionGas = 100 000`,
  `errorLength = 256`, `bufferRatioX10000 = 5000`, `maxMethodCallBytes = 8192`,
  `maxExecutionGas ≤ 25 000 000`, `mul = div = 1`, and the COTI-side constant template
  `constantFee = 25 000 000`. Full-symbolic properties use type-width domains.
  P-CFG-NR uses its own §3 domain (full-width `g/cbg/el`, only `br ≤ 10⁴` capped) —
  the template constants seed only the concrete-config test variants, not the envelope.
- P-SOLV-T/C quantify over arbitrary user `F_tot`, which can push the validator's
  `mulDiv` into the 512-bit (`high ≠ 0`) branch without reverting (e.g. `F = 2²³⁰,
  P = 1, lp = 2⁴⁰, rp = 2³⁰`). Their encodings therefore bound **both** the fees and
  the prices explicitly: `F_tot, F_cb ≤ 2¹¹⁹` and `lp, rp ∈ [1, 10³⁶]` (`10³⁶ < 2¹²⁰`).
  Sufficiency: `F_tot·lp·mul_r < 2²⁵⁶` dominates every product in the chain — the
  conversion product `⌊F/P⌋·lp < 2¹¹⁹·2¹²⁰ = 2²³⁹`, the skew product
  `conv(·)·mul_r < 2²³⁹·2¹⁶ = 2²⁵⁵ < 2²⁵⁶` (note the skew's internal product is the
  binding term — a bare `F ≤ 2¹²⁸` bound would NOT suffice), and the caller leg
  `⌊F_cb/P⌋·mul_l < 2¹³⁵`. Every `mulDiv` stays on the `high = 0` fast path; the
  property is claimed proven on that stated domain only (still astronomically beyond
  any real payment: `2¹¹⁹` wei ≈ 6.6·10¹⁷ whole tokens).

### 4a. Mechanization addendum — what actually discharges (concrete-divisor scoping)

§1's domain note assumed that keeping every product under 2²⁵⁶ (OZ mulDiv's `high = 0` fast
path) would suffice for the solver. In practice it does not: a `udiv`/`mulDiv` by a **symbolic
divisor** stays nonlinear and Z3 does not close it, even on the fast path — so the fully-symbolic
encodings of L1–L5, P-EQ1, P-CFGNR, P-TIGHT and the variable-config round-trips (P-RT1/RT2) time
out rather than proving. The mechanized suite therefore pins the divisor-bearing parameters
(`gasPriceMul/Div`, the token prices, the reference gas price) to a **representative concrete
matrix** — `mul=div`, `div=1`, `mul=1`, small `div>mul`/`mul>div`, the `65535:1` extreme, and
moderate price ratios — and keeps each property's **primary variable(s)** (payload size, exec
gas, fee amount, or `req`/`F`) fully symbolic. Every such test is a genuine ∀-proof over its
symbolic dimension for that config; where two divisions are compared (monotonicity, the
quote→validate round-trip) a **dense symbolic window** is used (a complete ∀ over 32–256
consecutive values), sometimes alongside a full-range single-division companion (e.g. L4a
`fee(s) ≥ fee(0)` over all 2³²). Pure revert / observational / subtraction properties (P-CFG0,
P-REF, P-BUD, P-CAP, packing, codec) keep their wide symbolic domains. Bounds are the
empirically-tuned ones that discharge under `halmos.toml`'s per-assertion solver timeout; each is
stated in-code. This trades the SPEC's config-generality for actual machine-checked proofs — the
underlying lemmas remain true on the full domain (§1), and the concrete matrix exercises the
`mul=div`, `div>mul`, `mul>div`, and extreme-ratio rounding regimes that the generality was for.

## 5. Explicitly out of scope

- MPC/garbled-circuit semantics (off-chain, whitepaper §2) — not expressible in EVM FV.
- Oracle price *freshness/correctness* — prices are assumed-symbolic (any `≥ 1` values),
  which is *stronger* than assuming a live feed: properties hold for all prices.
- Full send/mine/callback state-machine with symbolic calldata payloads (delegatecall
  module wiring + dynamic arrays explode path counts); nonce monotonicity is covered as
  a bounded property, the rest remains on the (existing) unit/integration test suite.
