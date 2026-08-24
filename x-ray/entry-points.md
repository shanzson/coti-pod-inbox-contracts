# Entry Point Map

> COTI PoD Inbox | 29 entry points | 4 permissionless | 8 role-gated | 16 admin-only | 1 initializer

---

## Protocol Flow Paths

### Deployment (Owner)

`Inbox.init()` → `MinerBase.addMiner()` → `InboxMiner.setPriceOracle()` → `PriceOracle.setInboxTokens()`  ◄── both fee legs must be configured before any send validates
                                                                          └─→ `PriceOracle.setPriceAdmin()`

### Oracle Setup (Owner)

`PoDPriceOracle.setConfiguredOracle()` → [`BandLiveOracle.setFeed()` / `ChainlinkLiveOracle.setFeed()`]  ◄── adapter must be wired + feeds configured before `getLivePrice` returns non-zero

### User Send Flow (Source-chain dApp)

`[deployment above]` → `InboxBase.sendTwoWayMessage()` / `sendOneWayMessage()`  ◄── requires prepaid `msg.value` ≥ `expectedMinFee` floor
                                                    └─→ (async, other chain) `InboxMiner.batchProcessRequests()`

### Miner Ingestion Flow (Off-chain Miner)

`[user send above, other chain]` → `InboxMiner.batchProcessRequests()`  ◄── onlyMiner + strict per-source nonce contiguity
                                                    ├─→ target call succeeds → app state updated
                                                    └─→ target call reverts → `errors[requestId]` set → `retryFailedRequest()` eligible

### Recovery Flow (Anyone)

`[batchProcessRequests above, execution failed]` → `InboxMiner.retryFailedRequest()`  ◄── permissionless, caller pays gas

### Application Reply Flow (Target dApp)

`[batchProcessRequests above]` → `InboxBase.respond()` / `InboxBase.raise()`  ◄── only the active `incomingRequest.targetContract` may call

### Fee Maintenance (Anyone)

`PriceOracle.refreshCache()`  ◄── interval-gated by `fetchInterval`; also auto-triggered best-effort after every send

---

## Permissionless

### `InboxBase.sendTwoWayMessage(uint256,address,MpcMethodCall,bytes4,bytes4,uint256)`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable |
| Caller | Source-chain dApp (typically via `InboxUser`) |
| Parameters | `targetChainId` (user-controlled), `targetContract` (user-controlled), `methodCall` (user-controlled), `callbackSelector` (user-controlled), `errorSelector` (user-controlled), `callbackFeeLocalWei` (user-controlled) |
| Call chain | `→ InboxFeeManager.validateAndPrepareTwoWayFees() → PriceOracle.getPricesUSD() → InboxBase._sendTwoWayMessage() → InboxBase._createRequest() → PriceOracle.refreshCache()` (best-effort) |
| State modified | `requests[requestId]`, `_requestNonce[targetChainId]` |
| Value flow | `msg.value` (native) in → held in Inbox balance, not escrowed per-request |
| Reentrancy guard | no (state written before any external call except the best-effort `refreshCache`) |

### `InboxBase.sendOneWayMessage(uint256,address,MpcMethodCall,bytes4)`

| Aspect | Detail |
|--------|--------|
| Visibility | external payable |
| Caller | Source-chain dApp |
| Parameters | `targetChainId` (user-controlled), `targetContract` (user-controlled), `methodCall` (user-controlled), `errorSelector` (user-controlled — must be `bytes4(0)`, else reverts) |
| Call chain | `→ InboxFeeManager.validateAndPrepareOneWayFees() → PriceOracle.getPricesUSD() → InboxBase._sendOneWayMessage() → InboxBase._createRequest() → PriceOracle.refreshCache()` (best-effort) |
| State modified | `requests[requestId]`, `_requestNonce[targetChainId]` |
| Value flow | `msg.value` (native) in → held in Inbox balance |
| Reentrancy guard | no |

### `InboxMiner.retryFailedRequest(bytes32)`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `nonReentrant` |
| Caller | Anyone (caller pays retry gas) |
| Parameters | `requestId` (user-controlled) |
| Call chain | `→ InboxBase._safeEncodeMethodCall() → MpcAbiCodec.reEncodeWithGt() (external lib) → InboxMiner._callWithCappedReturnData() → TargetContract.call{gas}()` (external) |
| State modified | `errors[requestId]` (deleted on success; whole tx reverts on re-encode failure) |
| Value flow | none |
| Reentrancy guard | yes |

### `PriceOracle.refreshCache()`

| Aspect | Detail |
|--------|--------|
| Visibility | public |
| Caller | Anyone |
| Parameters | none |
| Call chain | `→ PriceOracle._refreshInboxCache() → PriceOracle._pullCachedPrice()` (virtual — overridden in `PoDPriceOracle`/`UniswapPriceOracle`) `→ IPodPriceOracle(configuredOracle).getLivePrice()` (`BandLiveOracle`/`ChainlinkLiveOracle`) |
| State modified | `cachedPriceUSD[localToken]`, `cachedPriceUSD[remoteToken]`, `lastFetchTimestamp` |
| Value flow | none |
| Reentrancy guard | no (downstream reads are `view`/`try`-wrapped) |

---

## Role-Gated

### Active target only (`msg.sender == incomingRequest.targetContract`)

#### `InboxBase.respond(bytes)`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | The dApp contract currently the target of the active incoming request |
| Parameters | `data` (app-controlled) |
| Call chain | `→ InboxBase._sendOneWayMessage() → InboxBase._createRequest()` |
| State modified | `inboxResponses[incomingRequestId]` |
| Value flow | none |
| Reentrancy guard | no explicit guard; only reachable from within `batchProcessRequests`'/`retryFailedRequest`'s `nonReentrant` frame |

#### `InboxBase.raise(bytes)`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | The dApp contract currently the target of the active incoming request |
| Parameters | `data` (app-controlled) |
| Call chain | `→ InboxBase._sendOneWayMessage() → InboxBase._createRequest()` |
| State modified | `inboxResponses[incomingRequestId]` |
| Value flow | none |
| Reentrancy guard | no explicit guard; same call-frame restriction as `respond` |

### `onlyMiner`

#### `InboxMiner.batchProcessRequests(uint256,MinedRequest[])`

| Aspect | Detail |
|--------|--------|
| Visibility | external, `nonReentrant` |
| Caller | Registered miner (off-chain relayer) |
| Parameters | `sourceChainId` (miner-provided), `mined[]` (miner-provided — every field, including `sourceContract`, is unverified) |
| Call chain | `→ InboxMiner._executeIncomingRequest() → InboxBase._safeEncodeMethodCall() → MpcAbiCodec.reEncodeWithGt() → InboxMiner._callWithCappedReturnData() → TargetContract.call()` |
| State modified | `incomingRequests[requestId]`, `lastIncomingRequestId[sourceChainId]`, `errors[requestId]`, `requests[originalRequestId].executed` |
| Value flow | none directly; drives target-contract execution that may move value elsewhere |
| Reentrancy guard | yes |

### `onlyPriceAdmin`

#### `PoDPriceOracle.setTokenPriceUSD(address,uint256)`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | `priceAdmin` |
| Parameters | `token`, `priceUsd` (admin-controlled) |
| Call chain | `→ manualPrices[token] = priceUsd` |
| State modified | `manualPrices[token]` |
| Value flow | none |
| Reentrancy guard | n/a |

#### `PoDPriceOracle.clearTokenPriceUSD(address)`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | `priceAdmin` |
| Parameters | `token` |
| Call chain | `→ delete manualPrices[token]` |
| State modified | `manualPrices[token]` |
| Value flow | none |

#### `PriceOracle.setLocalTokenPriceUSD(uint256)` / `setRemoteTokenPriceUSD(uint256)`

| Aspect | Detail |
|--------|--------|
| Visibility | external |
| Caller | `priceAdmin` |
| Parameters | `price` (admin-controlled) |
| Call chain | `→ PriceOracle._setCachedPrice()` |
| State modified | `cachedPriceUSD[localToken \| remoteToken]`, `lastFetchTimestamp` |
| Value flow | none |

### Self-call only

#### `InboxBase._encodeMethodCallExternal(MpcMethodCall)`

External visibility, gated `require(msg.sender == address(this))`. Reachable only via `this.<call>` from `_safeEncodeMethodCall`'s try/catch wrapper — not independently callable by any external account.

---

## Admin-Only

| Contract | Function | Parameters | State Modified |
|----------|----------|------------|----------------|
| `Inbox` | `init(address,uint256)` *(initializer, one-time)* | `initialOwner`, `_chainId` | owner, `chainId` |
| `InboxMiner` | `setMessageProcessingPaused(bool)` | `paused` | `messageProcessingPaused` |
| `InboxMiner` | `setPriceOracle(address)` | `oracle` | `priceOracle` |
| `InboxMiner` | `setGasPriceBounds(uint256,uint256,uint256)` | `minPriorityFeeWei_`, `minGasPriceWei_`, `maxGasPriceWei_` | `minPriorityFeeWei`, `minGasPriceWei`, `maxGasPriceWei` |
| `InboxMiner` | `updateMinFeeConfigs(FeeConfig,FeeConfig)` | `_local`, `_remote` | `localMinFeeConfig`, `remoteMinFeeConfig` |
| `InboxMiner` | `collectFees(address payable)` | `to` | sweeps entire native balance to `to` |
| `MinerBase` | `addMiner(address)` | `miner` | `_miners[miner]` |
| `MinerBase` | `removeMiner(address)` | `miner` | `_miners[miner]` |
| `PoDPriceOracle` | `setConfiguredOracle(address)` | `oracle` | `configuredOracle` |
| `PriceOracle` | `setInboxTokens(address,address)` | `localToken_`, `remoteToken_` | `localToken`, `remoteToken` |
| `PriceOracle` | `setFetchInterval(uint256)` | `secondsBetweenFetches` | `fetchInterval` |
| `PriceOracle` | `setPriceAdmin(address)` | `admin` | `priceAdmin` |
| `BandLiveOracle` | `setBandStdRef(address)` | `ref` | `bandStdRef` |
| `BandLiveOracle` | `setMaxStaleness(uint256)` | `seconds_` | `maxStaleness` |
| `BandLiveOracle` | `setFeed(address,bytes32,bytes32)` | `token`, `bandBase`, `bandQuote` | `feeds[token]` |
| `ChainlinkLiveOracle` | `setMaxStaleness(uint256)` | `seconds_` | `maxStaleness` |
| `ChainlinkLiveOracle` | `setFeed(address,address)` | `token`, `aggregator` | `aggregators[token]` |

`Inbox.init` is a one-time `initializer` — intended to run atomically inside CreateX `deployCreate3AndInit`; a split deploy-then-initialize would reopen a front-running window (the constructor's placeholder owner `address(1)` exists specifically to avoid this).
