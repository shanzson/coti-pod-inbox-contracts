# Oracle / Price-Feed Security Analysis — PoD Inbox

**Scope:** the oracle / price-feed subsystem only, and how the Inbox fee path consumes it:

- `contracts/fee/PriceOracle.sol` — base cached USD oracle
- `contracts/fee/PoDPriceOracle.sol` — manual pegs + live-adapter fallback
- `contracts/fee/chainlink/*` — `ChainlinkLiveOracle`, `ChainlinkPriceReader`, `ChainlinkFeedLib`, `AggregatorV3Interface`
- `contracts/fee/band/*` — `BandLiveOracle`, `BandPriceReader`, `BandFeedLib`
- `contracts/fee/ILivePriceMetaReader.sol`
- Consumers: `contracts/fee/FeeManager.sol`, `contracts/fee/FeeManagerStubBase.sol`, `contracts/fee/LibFeeStorage.sol`, `contracts/InboxBase.sol`, `contracts/InboxMiner.sol`
- Shipped configuration: `scripts/deploy-utils.ts`, `scripts/deploy-oracle.ts`

**Method:** two independent AI review agents were run in a self-paced loop until each converged (a full pass produced no new verified issue). One agent hunted **direct** Critical/High/Medium defects; the other hunted **attack chains** — sequences where individually small weaknesses compose into a bigger one. Every finding below was traced from an external entry point and verified line-by-line against the current code; production-config claims were re-verified against the deploy scripts. The direct agent ran 4 passes + a convergence sweep; the chain agent ran 5 passes. Their results cross-corroborate.

**Style note:** written in plain language with a one-line real-world analogy per finding, in the spirit of a Zokyo report. Each finding gives a concrete worked example with numbers.

---

## Executive summary

The fee path is deliberately **fail-open**: oracle prices only *size the cross-chain gas budget*; they never move user principal directly, and the sole on-chain guard is "revert if a leg price is exactly zero" (`OraclePriceZero`). Calibrated honestly against that design:

- **No Critical** and **no attacker can inject or forge a price** — `refreshCache()` only ever pulls the honest live/manual value, and no permissionless path can zero the cache.
- **One High (qualified)** exists on the shipped configuration: a *standing, attacker-harvestable* cross-chain gas subsidy caused by the COTI price leg being a hand-maintained constant with **no maximum-age check anywhere on the fee path** (Finding 1 / Chain 5). It is "qualified" because it is fee-only, capped per message, and admin-correctable — impact is High, likelihood is config-and-monitoring dependent.
- **Three Mediums** in the "sustained wrong fee / operator footgun / integration hardening" class.
- **Five attack chains**, of which two reach High on the shipped config.

The single most valuable fix, which breaks a link present in almost every finding below, is a **maximum-age (staleness) check on the fee-path price read**. Today the code *tracks* price ages (`priceUpdatedAt`, `lastFetchTimestamp`) but **never enforces them on-chain** — the freshness metadata is decorative from the contract's point of view.

### Severity roll-call

| ID | Title | Severity (shipped config) |
|----|-------|---------------------------|
| **F-1** | Cached fee price never expires; static COTI peg → cross-chain gas subsidy / user DoS | **High** (qualified: fee-only, capped, admin-correctable) |
| **F-2** | Two manual-price setters with different consumers; `setTokenPriceUSD` never reaches the fee path | Medium |
| **F-3** | Chainlink adapter: no circuit-breaker bound, `maxStaleness==0` disables all time checks, deprecated `answeredInRound` | Medium |
| **C-1** | Permissionless refresh + gate-advance + no fee-path staleness → stale ratio pinned for a whole interval | Medium (shipped) / High (one config change) |
| **C-2** | Zeroed leg + no self-heal + manual-price mirage → sends brick while dashboard reads green | **High** (shipped, COTI inbox) |
| **C-3** | Portal manual peg silently contaminates the inbox fee basis on the next refresh | Medium |
| **C-4** | Dead/stale feed value used with no on-chain guard (`maxStaleness==0`, dying feed, or L2 with no sequencer feed) | Medium (→ High on L2) |
| I-1…I-4 | Informational (exotic decimals, Band USDC peg, Band bulk-vs-single, read-then-refresh) | Low / Info |

> **Direct vs. chained:** F-1/F-2/F-3 are the *direct* findings. C-1…C-4 are the *chains*. They overlap on purpose — e.g. **C-5 (the shipped High) is the chained realization of F-1**, so it is written up as Chain 5 in Part 2 and referenced from F-1.

---

## How the oracle system works (30-second version)

The Inbox charges a fee in the **local** chain's token but has to buy execution gas on the **remote** chain. To convert between them it needs two USD prices: the local token's and the remote token's. Those prices live in a cache (`cachedPriceUSD[localToken]`, `cachedPriceUSD[remoteToken]`) inside `PriceOracle`.

- The cache is refreshed by `refreshCache()`, which pulls fresh numbers from a live adapter (Chainlink or Band) or a manually-set value. **Anyone** can call `refreshCache()`, and the Inbox itself calls it *after* every send.
- When it computes a fee, the Inbox reads the cache through `getPricesUSD()` and plugs the two prices into:

  `remoteGasBudget ≈ (feePaid / gasPrice) × localPrice / remotePrice`

  The remote miner is then contractually bound to make that much gas available on the remote chain (`InboxMiner._computeUserCallGas` fronts gas up to `targetFee`).

The important structural fact: **the fee read checks only that each price is non-zero. It never checks that the price is recent.** Everything below flows from that, combined with the fact that on the shipped deployment the COTI token has *no live feed at all* — its price is a constant typed into the deploy script (`TESTNET_COTI_USD = "0.01272522"`, `deploy-utils.ts:134`).

---

# Part 1 — Direct findings

## F-1 — The cached fee price never expires; a frozen feed or the static COTI peg pins a wrong price and mis-sizes the cross-chain gas budget

- **Severity:** **High (qualified)** — High impact (a standing, repeatable, attacker-harvestable economic drain), reduced by being fee-only, capped per message, and admin-correctable. (The two review agents landed at "High, medium-confidence" and "Medium, borderline High" respectively; the honest synthesis is *High impact × medium likelihood*.)
- **Affected code:**
  - `contracts/fee/PriceOracle.sol:160-162` — `getPricesUSD()` returns `cachedPriceUSD[...]` with **no age check**.
  - `contracts/fee/FeeManager.sol:245-257` — `_validatedOraclePrices()` rejects only `price == 0`.
  - `contracts/fee/FeeManagerStubBase.sol:161-162` — the on-Inbox quoter reads the cache the same way.
  - `contracts/fee/PriceOracle.sol:146-157` — `_refreshLeg()` **retains the previous cached value** when a live pull returns 0, with no upper bound on how old that value may be.
  - `contracts/fee/PriceOracle.sol:128-143` — `_refreshInboxCache()` sets `lastFetchTimestamp = block.timestamp` **before** pulling and **even when both legs fail**, so a failed refresh still shuts the interval gate.
  - `contracts/fee/PriceOracle.sol:32, 165-183` — `priceUpdatedAt` / `getPricesUSDWithMeta()` exist but are read only off-chain, never enforced.
  - Shipped wiring: `scripts/deploy-utils.ts:134` (`TESTNET_COTI_USD`), `:222-265` (`manualLeg: "remote"`/`"both"`) — the COTI leg is a static hand-entered constant with **no feed** on any configured chain.

- **What's wrong (plain English):**
  The Inbox sizes every cross-chain fee from two cached USD prices, and **nothing on the fee path checks that those prices are still current.** Two things turn that into a real problem:

  1. **The adapter's `maxStaleness` only blocks *writing* a stale value — it never *expires* an already-cached one.** If a Chainlink feed freezes, the adapter returns "not ok / 0", `_refreshLeg()` keeps the last good price, and every later fee quote keeps using that frozen number forever. Configuring `maxStaleness` correctly does not help the fee path at all.
  2. **The COTI (remote) leg is a static constant.** COTI has no Chainlink feed, so the deploy scripts set its price once and never refresh it from a market source. Its "staleness" is effectively infinite by construction — it only changes when an admin remembers to re-enter it. Because `remoteGasBudget ∝ localPrice / remotePrice`, a drifted COTI price directly distorts the gas budget the miner is bound to spend.

  The failed-refresh handling makes the stale window **longer**: because `lastFetchTimestamp` advances even on a failed pull, one refresh "running" (successfully or not) shuts the gate for another `fetchInterval` (300 s shipped). And the monitoring story is booby-trapped — `_refreshInboxCache` emits `CacheRefreshed(local, localPrice, remote, remotePrice)` with plausible non-zero numbers **even when neither leg updated**, and on the shipped config the feed-less COTI leg fires `CacheRefreshLegFailed` on *every* refresh by design, training operators to treat that failure event as normal noise.

- **Worked example (the shipped COTI → Ethereum lane — the strongest realization):**
  On the COTI inbox both legs are static manual pegs (`manualLeg: "both"`), and the **remote (Ethereum) fee template is the variable 5,000,000-gas band** (`FEE_CONFIG_SEPOLIA_SIDE`). So the ratio genuinely scales the remote gas budget.
  - Stored pegs on COTI's oracle: `P_COTI = $0.0127`, `P_ETH = $2500`.
  - COTI then falls to a real `$0.00847` (a ~33% drop). Nobody re-pegs (there is no feed to do it automatically).
  - Stored ratio `P_COTI/P_ETH = 0.0127/2500`. True ratio `= 0.00847/2500`. Stored is **1.5×** the truth.
  - An attacker sends COTI → Ethereum, paying just enough COTI to buy the max `targetGasRemoteUnits = 5,000,000` at the *stored* ratio.
  - The Ethereum miner is bound to front up to **5,000,000** ETH gas units — but the COTI actually paid is, at true prices, only worth `5,000,000 / 1.5 ≈ 3,333,333` units.
  - **Result:** ~**1.67M ETH gas units (≈33%) are subsidized on every message.** At 20 gwei / ETH $2500 that is ≈ **$83 of free Ethereum execution per message**, harvestable in volume, for as long as the COTI peg lags the market — which, for a hand-updated small-cap price, can be days or weeks. The drift is **time-unbounded** (no keeper can correct a feed-less leg), which makes it worse than the interval-bounded pin in Chain 1.
  - **Reverse direction (user harm):** if COTI instead *rallies* above the stored peg, the same fee buys too few remote units → borderline sends revert `TargetFeeTooLow` (self-inflicted denial of service) and everyone else overpays.

  Same mechanism via a **frozen Chainlink feed** on a source chain: ETH feed freezes at `$2600` while ETH really trades `$2000`; after `maxStaleness` the pull fails and the cache is *pinned* at the stale `$2600`; `localPrice` is now 30% high and every fee is mis-sized until the feed recovers **and** a refresh lands.

- **Layman analogy:** A currency booth prices every transaction off an exchange-rate card taped to the wall. One rate (COTI) is never updated; another (a frozen feed) freezes when the clerk calls in sick. The booth keeps charging last month's rate — and whoever notices the rate is stale in their favor simply keeps trading through it.

- **Impact:** Sustained mis-pricing of the remote gas budget. In the dangerous direction (remote price stale-high) the miner is bound to over-deliver remote gas versus the fee actually collected — a repeatable, permissionless economic drain, capped per message by the remote `maxExecutionGas` (5M on the COTI→ETH lane) but unbounded in aggregate. In the other direction, users overpay or hit `TargetFeeTooLow` (soft DoS). No principal is stolen and an admin can re-peg, which is why it is a *qualified* High rather than Critical.

- **Note on the other shipped direction (Ethereum → COTI):** here the remote template is the **constant** 25M COTI band (`constantFee == maxExecutionGas == 25M`). A constant band pins `targetFee` at exactly 25M regardless of price, which *defangs* the subsidy in this direction and instead expresses the problem as under-collection / unsendable lanes — overlapping the already-known "degenerate fee band" issue (pashov PoC-04). See the cross-cutting note in Part 2.

- **Novel vs. known:** This is the **unimplemented half of POD-05** from the in-repo audit. POD-05's single-leg-refresh vector was fixed (refresh now does both legs, no `refreshCache(address)` overload), but its other two recommendations — *a maximum cache-age check* and *do not advance the gate on a failed pull* — were **never implemented**. Verified against current code.

- **Recommendation:**
  1. Add a max-age check to the fee read: have `getPricesUSD()` / `_validatedOraclePrices` revert or fall back when `block.timestamp - priceUpdatedAt[leg] > maxFeePriceAge`. Keep the fail-open behavior only up to a bounded age, not forever.
  2. Move `lastFetchTimestamp = block.timestamp` to run **only after at least one leg actually updates**, so a total-failure refresh does not shut the gate.
  3. For the COTI leg specifically: wire a real feed/TWAP, **or** enforce an on-chain "manual price max age" plus a max-deviation bound so a forgotten manual value cannot price fees indefinitely. (Note: the max-age check in (1) is *necessary but not sufficient* for the manual-peg case, because a manual peg has no genuine market `updatedAt` — a deviation bound or a feed is also needed.)

- **Confidence:** High that the mechanism exists (no fee-path age check, static manual COTI leg, ratio scaling — all verified in code and deploy scripts). Medium that the profitable direction is realized in practice (depends on COTI drifting above its stored peg and monitoring being absent).

---

## F-2 — Two manual-price setters with different consumers: `setTokenPriceUSD` never feeds the Inbox fee path, and the "smart" `getCachedPrice` fallback is dead code for fees

- **Severity:** Medium (operator footgun; no privilege escalation)
- **Affected code:**
  - `contracts/fee/PoDPriceOracle.sol:86-95` — `setTokenPriceUSD()` writes `manualPrices[token]` only.
  - `contracts/fee/PoDPriceOracle.sol:38-53` — `getCachedPrice()` override *does* fall back to `manualPrices`…
  - `contracts/fee/PriceOracle.sol:160-162` — …but `getPricesUSD()` (the actual fee read) is **not overridden** and reads `cachedPriceUSD` directly, bypassing that fallback.
  - `contracts/fee/FeeManager.sol:253`, `contracts/fee/FeeManagerStubBase.sol:161` — both fee consumers call `getPricesUSD()`, never `getCachedPrice()`.
  - `contracts/fee/PriceOracle.sol:221-228` — the setters that *do* feed fees are `setLocalTokenPriceUSD` / `setRemoteTokenPriceUSD` (they write `cachedPriceUSD`).

- **What's wrong (plain English):**
  There are two "set a manual price" functions that look interchangeable but write to two different mappings read by two different consumers:
  - `setTokenPriceUSD(token, price)` → `manualPrices` → used by the **portal** surface and by `refreshCache` as a fallback.
  - `setLocalTokenPriceUSD` / `setRemoteTokenPriceUSD(price)` → `cachedPriceUSD` → used by the **Inbox fee** path.

  The Inbox fee path reads *only* `cachedPriceUSD`. So an operator who "updates the COTI price" with `setTokenPriceUSD(cotiToken, newPrice)` — the natural, token-addressed setter — changes nothing the fee path can see until a later `refreshCache()` happens to copy the manual value into the cache. The clever `getCachedPrice()` override exists, but nothing on the fee path calls it, so it is effectively dead for fees.

- **Worked example:**
  1. Oracle healthy: `cachedPriceUSD[COTI] = $0.0127`, sends work.
  2. COTI rallies; the runbook says "bump the COTI price." Ops call `setTokenPriceUSD(cotiAddr, 0.02e18)` (it takes a token address, so it looks right).
  3. `manualPrices[COTI] = 0.02e18`, but `cachedPriceUSD[COTI]` is still `0.0127e18`. **Fees keep using the old price.**
  4. A quick sanity read of `getCachedPrice(COTI)` still returns `0.0127e18` (it returns the non-zero cache *before* checking manual), so the mistake is hidden.
  5. On a busy lane it self-heals within one `fetchInterval` (the post-send `refreshCache` copies the manual value in). On a **quiet lane with no sends, the update never lands** — fees stay wrong indefinitely.

- **Layman analogy:** Two wall switches, both labeled "kitchen." One controls the light the guests actually see (`cachedPriceUSD`); the other controls a pantry bulb (`manualPrices`) that only reaches the guests after someone opens the pantry door (a refresh). Flip the wrong one and your guests sit in the dark while you're certain you turned the light on.

- **Impact:** Silent stale/incorrect fee pricing after a well-intentioned manual update, worst on low-traffic lanes; operator confusion during incident response. Bounded to fee mis-sizing (same downstream effects as F-1). Admin-triggered and recoverable → Medium.

- **Recommendation:** Make the two agree. Either (a) have `getPricesUSD()` use the same manual fallback as `getCachedPrice()`, or (b) have `setTokenPriceUSD` on a configured inbox leg also write `cachedPriceUSD` (and emit a clear event), or (c) revert if `setTokenPriceUSD` is called with a `localToken`/`remoteToken` address unless the caller also updates the cache. At minimum, rename/document so it cannot be mistaken for the inbox-leg setter.

- **Confidence:** High on the mechanism (verified `getPricesUSD` is not overridden and both fee consumers call it); Medium on severity (busy lanes self-heal; setup mistakes are loud because `setPriceOracle` re-validates).

---

## F-3 — Chainlink adapter omits the circuit-breaker (min/max answer) check, `maxStaleness == 0` silently disables *all* time checks, and it relies on the deprecated `answeredInRound`

- **Severity:** Medium (Low for the currently-shipped L1 set; rises on an L2 or if `maxStaleness` is ever set to 0)
- **Affected code:**
  - `contracts/fee/chainlink/ChainlinkFeedLib.sol:18-53` — value/round checks are only `answer <= 0 || answeredInRound < roundId`; **no min/max-answer bound, no L2 sequencer-uptime check.**
  - `contracts/fee/chainlink/ChainlinkFeedLib.sol:34-38, 77-81` — the staleness **and** future-date checks are both wrapped in `if (maxStaleness != 0)`, so `maxStaleness == 0` disables *every* time sanity check, including accepting a future-dated `updatedAt`.
  - `contracts/fee/chainlink/ChainlinkLiveOracle.sol:12-16, 30-33` — `setMaxStaleness(0)` is a one-call footgun; the NatSpec itself concedes "Prefer a non-zero value in production."

- **What's wrong (plain English):**
  Chainlink aggregators have a built-in floor/ceiling (`minAnswer`/`maxAnswer`). During an extreme move a feed can report the *bound* instead of the true price (this is what happened in the Venus/LUNA incident). This adapter never checks for that, so during a flash crash it would ingest the clamped price as if real. It also switches off its own staleness and future-date guards entirely when `maxStaleness` is 0, and it gates validity on `answeredInRound < roundId`, a field Chainlink has deprecated on modern OCR feeds.

  For this repo the impact is capped today because (a) the shipped scripts set `maxStaleness` to 3600 s / 86400 s (non-zero), (b) none of the configured chains (Ethereum L1, Avalanche C-chain, Sepolia, Fuji) are L2s with a sequencer-uptime feed, and (c) it feeds only fees. The meaningful residual is the missing circuit-breaker bound and the `maxStaleness=0` footgun on a reusable adapter.

- **Worked example (circuit breaker):** ETH/USD aggregator has `minAnswer = $10`. A violent wick / oracle malfunction makes the feed report the floor `$10` for a few rounds (fresh `updatedAt`, positive answer — it passes every check this adapter makes). The adapter normalizes `$10` and the cache accepts it. `localPrice` is now `10e18` instead of `~2500e18` — 250× too low → every fee in that window either reverts `TargetFeeTooLow` (soft DoS) or is grossly under-budgeted on the remote leg. The fail-open cache then keeps that `$10` until the feed recovers *and* a refresh lands.

- **Layman analogy:** A thermostat that trusts a thermometer even when it is obviously pegged at its lowest mark — so on the coldest day it reports "10°" and sets the whole building's heating from that wrong reading.

- **Impact:** Transient but potentially severe fee mis-sizing during a feed anomaly, plus a silent removal of *all* time protection if an admin ever sets `maxStaleness = 0`. Deployment-dependent → Medium with an explicit "Low today / higher on L2" caveat.

- **Recommendation:** Read and enforce `minAnswer`/`maxAnswer` (reject answers at/through the bound); add an L2 sequencer-uptime gate (no-op when the sequencer feed is unset) before any L2 deployment; reject `setMaxStaleness(0)` (or floor it); and drop reliance on `answeredInRound` in favor of `answer > 0` + `updatedAt` freshness.

- **Confidence:** High that the checks are absent; Medium on severity given the shipped chains and non-zero configured `maxStaleness`.

---

## Lower-severity / informational (verified, not inflated)

- **I-1 — `_normalizeTo18` can floor an answer to 0 for exotic decimals.** `ChainlinkFeedLib.sol:98-114`. For a feed with `decimals` in 19–36 and an absurdly tiny answer, `mulDiv(answer, 1e18, 10**decimals)` rounds to 0 → treated as failure. Real USD feeds use 8 or 18 decimals, so unreachable in practice. Informational.
- **I-2 — Band "USD" quote defaults to "USDC" (peg dependency).** `BandLiveOracle.sol:12-16, 50-57`. A configured "USD" price actually settles against USDC; a USDC depeg mis-prices the leg. Documented in NatSpec, operator-controlled, fee-only. Low/Info.
- **I-3 — Band bulk vs. single read path.** Validation logic (rate ≠ 0, older-of-two-timestamps staleness) is identical between `getReferenceDataBulk` and single `getReferenceData`, so they diverge only if Band itself returns inconsistent single-vs-bulk data in one block — an upstream property, not a bug here. Informational.
- **I-4 — Read-then-refresh ordering.** `InboxBase.sol:204, 225`. Sends compute fees from the *pre-refresh* cache and refresh afterward. Known pashov Low; confirmed still present. No manipulation vector (refresh only pulls the honest price).
- **Adjacent (outside strict oracle scope) — gas-price parity assumption.** `FeeManager.sol:181, 207`. The formula uses the *local* reference `gasPrice` as a stand-in for the *remote* chain's gas price. The USD cross-conversion is correct, but it implicitly assumes both chains' native-wei gas prices are equal; where the remote chain's gas price materially exceeds the local reference, the miner is under-reimbursed (another subsidy vector). This is a fee-model question, flagged for the FeeManager review rather than counted as an oracle finding.

---

# Part 2 — Chained findings

Each chain is composed of individually low/medium (or by-design) behaviors that were verified line-by-line. The value is the *composition*.

**Building blocks (all verified):**

| # | Behavior | Location |
|---|----------|----------|
| BB1 | Fee read (`getPricesUSD`) has **no staleness/max-age** check; only guard is `price != 0`. | `PriceOracle.sol:160-162`; `FeeManager.sol:245-257` |
| BB2 | `refreshCache()` is **permissionless**; Inbox calls it best-effort **after** fee computation (read-then-refresh). | `PriceOracle.sol:124`; `InboxBase.sol:199-204, 220-225` |
| BB3 | Refresh sets `lastFetchTimestamp` **before** pulling and **even when both legs fail**, shutting the gate for a full interval. | `PriceOracle.sol:128-143, 251-256` |
| BB4 | `_refreshLeg` **retains** the previous cache when a pull returns 0. | `PriceOracle.sol:146-157` |
| BB5 | Fee path reads `cachedPriceUSD` directly; `setTokenPriceUSD` writes `manualPrices` (bypassed) but a later refresh copies it in. | `PoDPriceOracle.sol:38-53, 86-95, 146-159` |
| BB6 | `setInboxTokens()` zeroes a replaced leg's cache; no validation, no gate reset. | `PriceOracle.sol:88-108` |
| BB7/BB8 | Adapters return 0 on many conditions; `maxStaleness==0` disables the age check; no min/max bound; no sequencer feed. | `ChainlinkFeedLib.sol:19-52`; `BandFeedLib.sol:21-44` |
| BB9 | Remote gas budget scales with `localPrice/remotePrice`; miner fronts gas up to `targetFee`. | `FeeManager.sol:181, 207`; `InboxMiner.sol:352-360` |

### [HIGH — shipped] Chain 5 — COTI→EVM manual-peg drift → attacker-harvestable Ethereum-gas subsidy

*(This is the chained realization of **F-1**; it is the single shipped-config lane with a genuine, attacker-profitable subsidy.)*

- **Links:** shipped variable-remote-band config (`FEE_CONFIG_SEPOLIA_SIDE`, 5M, on the COTI→EVM direction) + `refreshCache` being a **no-op** on a feed-less leg (`PoDPriceOracle.sol:150-159`, `ChainlinkLiveOracle.sol:65-69`) + **BB1** (no fee-path staleness) + **BB9** (ratio scales miner-fronted gas).
- **How they compose:** On the COTI inbox both legs are static manual pegs, so no keeper can ever correct them (`refreshCache` pulls the manual value or 0 — it never discovers a market price). The COTI→Ethereum lane has a *variable* 5M remote band, so the price ratio really does scale the Ethereum gas the miner must front. When real COTI drifts below its stale peg, every COTI→EVM send over-funds Ethereum execution by the drift %; an attacker harvests it in volume, and the drift is **time-unbounded**.
- **Worked example / analogy / numbers:** identical to F-1's worked example (≈33% drift → ≈$83 subsidized Ethereum gas per max message).
- **Severity:** High (shipped). **Confidence:** Medium (depends on COTI drifting above its stored peg and monitoring being absent).
- **Fix:** F-1's recommendations — a fee-path max-age check is necessary but **not sufficient** here (manual pegs have no real `updatedAt`); add a live COTI feed or an on-chain max-deviation bound.

### [HIGH — shipped, COTI inbox] Chain 2 — Zeroed leg + no self-heal + manual-price mirage → sends brick while the dashboard reads green

- **Links:** **BB6** (a zeroed leg) + **BB1** (`OraclePriceZero` reverts every send) + **BB2 ordering** (the self-heal `refreshCache` runs *after* the fee check that reverts, so it never executes) + **BB5** (`setTokenPriceUSD` doesn't reach the fee path, but `getCachedPrice` reads green via the manual fallback).
- **How they compose:** A leg goes to 0 (token rotation, peg clear, or a feed returning 0 with an empty prior cache). Sends now revert. The system is *designed* to self-heal by refreshing on every send — but the refresh sits after the fee check, so a bricked inbox can never refresh itself out of the hole. Ops reach for the natural-looking `setTokenPriceUSD(leg, price)`, which writes a different mapping than the fee path reads, so sends keep reverting — yet `getCachedPrice(leg)` now returns that manual value, so **the dashboard says healthy while the inbox is dead.**
- **Worked example (shipped COTI inbox, both legs manual):**
  - `t0`: `clearTokenPriceUSD(ETH)` (or `setInboxTokens`) → `cachedPriceUSD[ETH] = 0`; gate still shut for ~290 s.
  - `t0+1s`: any COTI→EVM send → `getPricesUSD = (0, cotiPeg)` → **revert `OraclePriceZero`**; the `try refreshCache()` line is never reached. All sends down.
  - `t0+30s`: ops call `setTokenPriceUSD(ETH, 2500e18)`. `getCachedPrice(ETH)` now returns `2500e18` (manual fallback) → **dashboard green**.
  - `t0+31s`: send → `getPricesUSD` still `(0, cotiPeg)` → **still reverts.** Real fix: `setRemoteTokenPriceUSD` (writes the cache immediately) or a direct `refreshCache()` after the gate opens — but on a feed-less COTI leg even `refreshCache` only works because `_livePrice` returns the *manual* value.
- **Layman analogy:** The fuel gauge reads full because someone filled a spare can in the trunk — but the engine drinks from the tank, which is still empty, so the car keeps stalling while the dashboard insists everything's fine.
- **Severity:** High (liveness outage + active operator deception). Recoverable → not Critical. **Confidence:** High (pure control-flow facts). Trigger is owner reconfiguration (unlucky-ops), but the self-unhealable and deceptive-dashboard properties are pure code behavior.
- **Fix:** Make the fee read and the ops view agree (one source of truth), or have `setInboxTokens` reject a config that leaves a leg at 0 unless a price is supplied in the same tx and reset `lastFetchTimestamp = 0`.

### [MEDIUM] Chain 1 — Permissionless refresh + gate-advance + no fee-path staleness → a stale ratio pinned for a whole interval

- **Links:** **BB2** + **BB3** + **BB1** + **BB9**.
- **How they compose:** The cache is a snapshot. Whoever calls `refreshCache` first after the gate opens *chooses the snapshot and freezes it for 300 s* — nobody can correct it in that window, and the fee code never asks "is this old?". On a lane with a live feed leg, an attacker waits for the feed to print a favorable value, front-runs the honest keeper to pin it, and fires sends for the next 5 minutes.
- **Shipped-config severity — Medium (honest re-rating):** the lanes that *have* a live feed (Sepolia/mainnet/Avax, live on the **local** leg) pair it with the **constant** 25M COTI remote band, so pinning the local price cannot over-fund a single-point band — it only under-collects local fee or pushes the degenerate band out of reach (a DoS overlapping the known PoC-04). Chain 1 becomes **High only on a one-config-change lane** (a variable remote band + a live leg, reachable via the supported per-chain `deployConfig.json` fee override, a non-COTI remote leg, or simply fixing the degenerate band). There is also an **unlucky-ops twin:** even an honest keeper leaves every send between the 5-minute refreshes mispriced by real drift.
- **Fix:** the fee-path max-age check (breaks BB1); set `lastFetchTimestamp` only after a successful pull (breaks BB3). **Confidence:** Medium (mechanism verified; profit direction is config-dependent).

### [MEDIUM] Chain 3 — Portal manual peg silently contaminates the inbox fee basis on the next refresh

- **Links:** **BB5** + **BB2** + **BB4**.
- **How they compose:** `manualPrices` looks like a portal-only knob (it feeds the `IPodPriceOracle` surface). But the inbox refresh path pulls `_pullCachedPrice → _livePrice`, which *prefers* `manualPrices`. So a peg an admin sets "just for the portal" gets silently promoted into the inbox fee basis the next time **anyone** calls `refreshCache` — and an attacker can pick that block to align with their own sends.
- **Worked example:** inbox COTI peg `0.0127`; admin sets `setTokenPriceUSD(COTI, 0.02e18)` for a portal quote (inbox fees unchanged, so it looks isolated); later an attacker calls `refreshCache()` → `_refreshLeg(COTI)` copies `0.02e18` into `cachedPriceUSD` → **inbox remote price jumps +57% in one block**, timed by the attacker.
- **Layman analogy:** You change the price on the shop's sidewalk chalkboard (the portal), not knowing a night-shift robot copies it onto the cash register (the inbox) at a moment a stranger gets to choose.
- **Severity:** Medium. **Confidence:** High (coupling) / Medium (impact). **Fix:** don't let refresh source from `manualPrices` (refresh only from the configured feed), keeping `manualPrices` portal-only.

### [MEDIUM → HIGH on L2] Chain 4 — Dead/stale feed value used with no on-chain guard

- **Links:** **BB7/BB8** + **BB4** + **BB3** + **BB1**.
- **How they compose:** two flavors — (a) `maxStaleness == 0` (operator opts out of age checks) lets a feed that stops updating return its last answer forever; the adapter accepts it, the cache stores it, every send uses it; (b) a transient 0 at the refresh instant makes the cache **retain** the old value *and* the gate closes for a full interval, locking it in.
- **Worked example (`maxStaleness == 0`):** ETH aggregator's last good round `$2103`; operator set `maxStaleness = 0`; two days later the aggregator is deprecated and still returns `$2103` with a 2-day-old timestamp; the age check is off, so every send prices ETH at `$2103` while it really trades `$1500` — a persistent ~40% mispricing invisible to the fee path.
- **Layman analogy:** The wall clock stopped at noon; because nobody is allowed to ask "is this clock still ticking?", every appointment is scheduled against a time that stopped being true days ago.
- **Severity:** Medium (rises to High on an L2 with no sequencer check, or with `maxStaleness==0`). Shipped chains are L1s, which lowers the sequencer angle today. **Fix:** reject `setMaxStaleness(0)`; add the fee-path max-age check; add a sequencer-uptime gate for L2 targets.

### Cross-cutting note — the degenerate COTI fee band colors Chains 1 & 5

`FEE_CONFIG_COTI_SIDE` ships with `constantFee == maxExecutionGas == 25,000,000` (`deploy-utils.ts:392-403`). With a constant remote template, a send must hit `targetGasRemoteUnits` **exactly** 25M (floor `expectedMinFee == 25M` meets ceiling `FeeGasTooHigh > 25M`), while the reachable values jump in steps of ~165,000, stepping over the single legal point — so shipped **source→COTI** sends are largely unsendable by construction (the known PoC-04 "degenerate fee band"). This is out of pure oracle scope, but it matters here: it *mutes* Chain 1's over-fund direction into under-collection/DoS on the source lanes, and whichever way operators fix the band into a real `[min, max]` range, Chain 1's clean miner-subsidy form switches on immediately.

---

## The one fix that does the most

Add an **on-chain maximum-age check to the fee-path price read** (`getPricesUSD` / `_validatedOraclePrices` vs. `priceUpdatedAt`). It is a link (BB1) in **every** chain above and neutralizes the "pin and coast" and "use a dead feed" mechanics — a stale snapshot could then only be *refreshed*, never *used*. It also makes the freshness metadata the contracts already track (`priceUpdatedAt`, `lastFetchTimestamp`) actually load-bearing instead of decorative.

Two caveats: (1) for the **manual COTI leg** (F-1 / Chain 5) a max-age check is necessary but not sufficient — a manual peg has no genuine market `updatedAt`, so pair it with a live feed or an on-chain max-deviation bound; (2) also stop `lastFetchTimestamp` from advancing on a failed pull, so a bad snapshot is not protected for a full interval.

---

## Appendix — verification method & convergence

- **Two looping AI agents**, run independently to convergence: a *direct-findings* agent (4 passes + a convergence sweep, final verdict "converged, no new findings") and a *chained-findings* agent (5 passes, final verdict "converged, no further chains"). Each pass = brainstorm → trace every candidate from an external entry point → adversarial self-review → re-sweep.
- **Independent orchestrator verification** confirmed the load-bearing facts directly in code and deploy scripts: no staleness check on the fee path; `getPricesUSD` not overridden in `PoDPriceOracle`; no min/max-answer bound and no sequencer feed; `TESTNET_COTI_USD` constant with `manualLeg` "remote"/"both"; `FEE_CONFIG_COTI_SIDE` constant 25M band vs. `FEE_CONFIG_SEPOLIA_SIDE` variable 5M band; miner fronts gas up to `targetFee` via `_localRequestExecutionBudget` → `_computeUserCallGas`.
- **Honesty notes:** no Critical was found or manufactured; the system's fail-open, fee-only design and the impossibility of an attacker injecting or zeroing a price genuinely defang the paths that would otherwise reach Critical. The strongest finding (F-1 / Chain 5) is a *qualified* High: High impact, medium likelihood, admin-correctable. Where the two agents disagreed on labeling it ("High, medium-confidence" vs. "Medium, borderline High"), that disagreement is reported rather than smoothed over.
