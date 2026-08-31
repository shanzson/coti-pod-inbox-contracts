import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
// PoCs for the CHAINED findings of audit/ORACLE_SECURITY_ANALYSIS.md
//   C-1  — permissionless refresh + gate-advance pins a stale ratio for a whole interval
//   C-2  — zeroed leg bricks sends (OraclePriceZero) while getCachedPrice reads green
//   C-3  — a "portal" manual peg is promoted into the inbox fee basis on the next refresh
//   C-4  — maxStaleness==0 + dead feed: the cache re-adopts the stale answer across refreshes
//   BB3  — a failed live pull still advances lastFetchTimestamp (gate shuts with no update)
// ─────────────────────────────────────────────────────────────────────────────

const SCALE = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const COTI = "0x000000000000000000000000000000000000C071" as `0x${string}`;
const ETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" as `0x${string}`;

const FEE_SEPOLIA = {
  constantFee: 0n,
  gasPerByte: 800n,
  callbackExecutionGas: 100_000n,
  errorLength: 256n,
  bufferRatioX10000: 5000n,
  maxMethodCallBytes: 8192n,
  maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n,
  gasPriceDiv: 1n,
} as const;
const FEE_COTI = {
  constantFee: 25_000_000n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
  maxMethodCallBytes: 8192n,
  maxExecutionGas: 25_000_000n,
  gasPriceMul: 1n,
  gasPriceDiv: 1n,
} as const;

describe("oracle-poc chained findings", { concurrency: 1 }, async () => {
  const { viem, provider } = await network.connect({ network: "hardhat" });
  const client = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;
  const c = { public: client, wallet };

  async function timeTravel(seconds: number) {
    await provider.request({ method: "evm_increaseTime", params: [seconds] });
    await provider.request({ method: "evm_mine", params: [] });
  }

  async function deployFeeManager(
    oracleAddr: `0x${string}`,
    G: bigint,
    localCfg: typeof FEE_SEPOLIA | typeof FEE_COTI,
    remoteCfg: typeof FEE_SEPOLIA | typeof FEE_COTI
  ) {
    const fm = await viem.deployContract("FeeManager", [], { client: c });
    await fm.write.setPriceOracle([oracleAddr], { account: owner });
    await fm.write.setGasPriceBounds([0n, G, G], { account: owner });
    await fm.write.updateMinFeeConfigs([localCfg, remoteCfg], { account: owner });
    return fm;
  }

  async function oneWayTargetGas(fmAddr: `0x${string}`, fmAbi: any, dataSize: bigint, totalFee: bigint) {
    const { result } = await client.simulateContract({
      address: fmAddr,
      abi: fmAbi,
      functionName: "validateAndPrepareOneWayFees",
      args: [dataSize, totalFee],
      account: owner,
      value: 0n,
    });
    return result as bigint;
  }

  // ── C-1 ─────────────────────────────────────────────────────────────────
  it("C-1: the first refresh after the gate opens pins the ratio for the whole fetchInterval", async () => {
    const feed = await viem.deployContract("MockChainlinkAggregator", [8, 2000_00000000n], { client: c }); // $2000
    const adapter = await viem.deployContract("ChainlinkLiveOracle", [owner, 86_400n], { client: c });
    await adapter.write.setFeed([ETH, feed.address], { account: owner });
    // fetchInterval = 300 s (shipped value).
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, adapter.address, 300n], { client: c });
    await oracle.write.setInboxTokens([ETH, COTI], { account: owner });
    await oracle.write.setRemoteTokenPriceUSD([(127n * SCALE) / 10000n], { account: owner }); // COTI 0.0127

    // First refresh pins ETH at $2000 and shuts the gate.
    await oracle.write.refreshCache([]);
    const [pinned] = await oracle.read.getPricesUSD();
    assert.equal(pinned, 2000n * SCALE);
    assert.equal(await oracle.read.fetchGateOpen(), false, "gate shut after the first refresh");

    // The live feed moves to $3000, but the pinned cache cannot be updated inside the interval.
    await feed.write.setAnswer([3000_00000000n], { account: owner });
    assert.equal(await oracle.read.getLivePrice([ETH]), 3000n * SCALE, "live price moved to $3000");
    // Anyone calling refreshCache during the window is a no-op (permissionless, but gated).
    await oracle.write.refreshCache([]);
    const [stillPinned] = await oracle.read.getPricesUSD();
    assert.equal(stillPinned, 2000n * SCALE, "cache still pinned at $2000 despite live $3000");

    // Only once the interval elapses can the new value be adopted.
    await timeTravel(301);
    assert.equal(await oracle.read.fetchGateOpen(), true);
    await oracle.write.refreshCache([]);
    const [adopted] = await oracle.read.getPricesUSD();
    assert.equal(adopted, 3000n * SCALE, "new value adopted only after the gate re-opens");
  });

  // ── C-2 ─────────────────────────────────────────────────────────────────
  it("C-2: a zeroed leg bricks the fee path (OraclePriceZero) while getCachedPrice reads green", async () => {
    const G = 2_000_000_000n;
    // COTI inbox: local = COTI, remote = ETH.
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, ZERO, 0n], { client: c });
    await oracle.write.setInboxTokens([COTI, ETH], { account: owner });
    await oracle.write.setLocalTokenPriceUSD([(127n * SCALE) / 10000n], { account: owner }); // COTI 0.0127
    await oracle.write.setRemoteTokenPriceUSD([2000n * SCALE], { account: owner }); // ETH 2000
    const fm = await deployFeeManager(oracle.address, G, FEE_COTI, FEE_SEPOLIA);
    const totalFee = 1000n * SCALE;

    // Baseline: sends work.
    assert.equal(await oneWayTargetGas(fm.address, fm.abi, 0n, totalFee), 3_175_000n);

    // t0: the remote (ETH) leg is zeroed (peg clear / token rotation).
    await oracle.write.clearTokenPriceUSD([ETH], { account: owner });
    const [, remoteZeroed] = await oracle.read.getPricesUSD();
    assert.equal(remoteZeroed, 0n);
    await assert.rejects(
      () => oneWayTargetGas(fm.address, fm.abi, 0n, totalFee),
      /OraclePriceZero/,
      "every send now reverts OraclePriceZero"
    );

    // t0+30s: ops reach for the natural-looking token-addressed setter.
    await oracle.write.setTokenPriceUSD([ETH, 2500n * SCALE], { account: owner });

    // THE MIRAGE (simultaneous):
    //   dashboard/ops read is GREEN (manual fallback)…
    assert.equal(await oracle.read.getCachedPrice([ETH]), 2500n * SCALE, "getCachedPrice reads green ($2500)");
    //   …but the fee path is still BRICKED (getPricesUSD reads cachedPriceUSD == 0).
    const [, remoteStillZero] = await oracle.read.getPricesUSD();
    assert.equal(remoteStillZero, 0n, "fee read still zero");
    await assert.rejects(
      () => oneWayTargetGas(fm.address, fm.abi, 0n, totalFee),
      /OraclePriceZero/,
      "sends still revert while the dashboard says healthy"
    );

    // The real fix writes the cache directly.
    await oracle.write.setRemoteTokenPriceUSD([2500n * SCALE], { account: owner });
    assert.equal(await oneWayTargetGas(fm.address, fm.abi, 0n, totalFee), 2_540_000n); // mulDiv(5e11,0.0127e18,2500e18)
  });

  // ── C-3 ─────────────────────────────────────────────────────────────────
  it("C-3: a portal-only setTokenPriceUSD peg is promoted into the inbox fee basis on the next refresh", async () => {
    const G = 2_000_000_000n;
    // COTI inbox: local = COTI (variable-fee leg for a meaningful budget), remote = ETH.
    // No configured live adapter, gate open (fetchInterval 0).
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, ZERO, 0n], { client: c });
    await oracle.write.setInboxTokens([COTI, ETH], { account: owner });
    await oracle.write.setLocalTokenPriceUSD([(127n * SCALE) / 10000n], { account: owner }); // COTI 0.0127
    await oracle.write.setRemoteTokenPriceUSD([2000n * SCALE], { account: owner }); // ETH 2000
    const fm = await deployFeeManager(oracle.address, G, FEE_COTI, FEE_SEPOLIA);
    const totalFee = 1000n * SCALE;

    const budgetBefore = await oneWayTargetGas(fm.address, fm.abi, 0n, totalFee);
    assert.equal(budgetBefore, 3_175_000n);

    // Admin sets a manual peg "just for the portal quote"; the inbox fee is unchanged (looks isolated).
    await oracle.write.setTokenPriceUSD([COTI, 2n * SCALE / 100n], { account: owner }); // 0.02
    assert.equal(await oracle.read.getLocalTokenPriceUSD(), (127n * SCALE) / 10000n, "fee basis unchanged pre-refresh");
    assert.equal(await oneWayTargetGas(fm.address, fm.abi, 0n, totalFee), 3_175_000n);

    // Anyone calls refreshCache → the manual peg is copied into the inbox cache.
    await oracle.write.refreshCache([]);
    assert.equal(await oracle.read.getLocalTokenPriceUSD(), 2n * SCALE / 100n, "manual peg promoted to fee basis");
    const budgetAfter = await oneWayTargetGas(fm.address, fm.abi, 0n, totalFee);
    assert.equal(budgetAfter, 5_000_000n, "budget jumped 3.175M → 5.0M (+57%) in one permissionless block");
  });

  // ── C-4 ─────────────────────────────────────────────────────────────────
  it("C-4: maxStaleness==0 + a dead feed — the cache re-adopts the stale answer across refreshes", async () => {
    const NORMALIZED = 2103_41000000n * 10n ** 10n; // $2103.41 → 18 decimals
    const feed = await viem.deployContract("MockChainlinkAggregator", [8, 2103_41000000n], { client: c });
    const adapter = await viem.deployContract("ChainlinkLiveOracle", [owner, 0n], { client: c }); // maxStaleness == 0
    await adapter.write.setFeed([ETH, feed.address], { account: owner });
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, adapter.address, 0n], { client: c });
    await oracle.write.setInboxTokens([ETH, COTI], { account: owner });
    await oracle.write.setRemoteTokenPriceUSD([(127n * SCALE) / 10000n], { account: owner });

    await oracle.write.refreshCache([]);
    assert.equal(await oracle.read.getLocalTokenPriceUSD(), NORMALIZED);
    const t0 = await oracle.read.priceUpdatedAt([ETH]);

    // The feed dies: updatedAt frozen 10 days in the past, answer never changes again.
    const frozenAt = (await client.getBlock()).timestamp - 10n * 86400n;
    await feed.write.setUpdatedAt([frozenAt], { account: owner });

    // Refresh #2 (a day later): the dead value is RE-ADOPTED, and priceUpdatedAt falsely advances.
    await timeTravel(86400);
    await oracle.write.refreshCache([]);
    assert.equal(await oracle.read.getLocalTokenPriceUSD(), NORMALIZED, "dead value re-adopted");
    const t1 = await oracle.read.priceUpdatedAt([ETH]);
    assert.ok(t1 > t0, "priceUpdatedAt advanced despite the feed being frozen");

    // Refresh #3 (another day later): still re-adopted.
    await timeTravel(86400);
    await oracle.write.refreshCache([]);
    assert.equal(await oracle.read.getLocalTokenPriceUSD(), NORMALIZED);
    const t2 = await oracle.read.priceUpdatedAt([ETH]);
    assert.ok(t2 > t1);

    // The feed is now ~12 days stale, yet the oracle's own metadata claims it is fresh (~now) — no guard.
    const nowTs = (await client.getBlock()).timestamp;
    assert.ok(nowTs - frozenAt >= 12n * 86400n, "underlying feed is >=12 days stale");
    assert.ok(nowTs - t2 < 5n, "oracle metadata claims the cached price is fresh");
  });

  // ── BB3 ───────────────────────────────────────────────────────────────────
  it("BB3: a failed live pull advances lastFetchTimestamp and retains the stale cache (gate shuts)", async () => {
    const feed = await viem.deployContract("MockChainlinkAggregator", [8, 2000_00000000n], { client: c });
    const adapter = await viem.deployContract("ChainlinkLiveOracle", [owner, 3600n], { client: c });
    await adapter.write.setFeed([ETH, feed.address], { account: owner });
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, adapter.address, 300n], { client: c });
    await oracle.write.setInboxTokens([ETH, COTI], { account: owner });
    await oracle.write.setRemoteTokenPriceUSD([(127n * SCALE) / 10000n], { account: owner });

    await oracle.write.refreshCache([]);
    const meta1 = await oracle.read.getPricesUSDWithMeta(); // [local, remote, localUpdatedAt, remoteUpdatedAt, lastFetch]
    assert.equal(meta1[0], 2000n * SCALE);
    const localUpdated1 = meta1[2];
    const lastFetch1 = meta1[4];

    // Open the gate, then make the live pull return 0 (feed reports a non-positive answer).
    await timeTravel(301);
    assert.equal(await oracle.read.fetchGateOpen(), true);
    await feed.write.setAnswer([0n], { account: owner }); // getLivePrice(ETH) → 0

    await oracle.write.refreshCache([]);
    const meta2 = await oracle.read.getPricesUSDWithMeta();
    assert.equal(meta2[0], 2000n * SCALE, "stale cache retained on the failed pull (BB4)");
    assert.equal(meta2[2], localUpdated1, "localUpdatedAt NOT advanced — no genuine update happened");
    assert.ok(meta2[4] > lastFetch1, "lastFetchTimestamp DID advance on the failed pull (BB3)");
    assert.equal(await oracle.read.fetchGateOpen(), false, "gate shut for another interval despite no update");
  });
});
