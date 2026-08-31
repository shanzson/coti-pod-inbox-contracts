import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
// PoCs for the DIRECT findings of audit/ORACLE_SECURITY_ANALYSIS.md
//   F-1 / Chain 5 — cached fee price never expires; static remote peg mis-sizes gas budget
//   F-2          — setTokenPriceUSD writes manualPrices but the fee read uses cachedPriceUSD
//   F-3          — Chainlink adapter: no circuit breaker, maxStaleness==0 kills time checks,
//                  answeredInRound<roundId rejection
// Every test exercises the REAL contracts/fee stack (PoDPriceOracle, FeeManager,
// ChainlinkLiveOracle) and asserts concrete numbers.
// ─────────────────────────────────────────────────────────────────────────────

const SCALE = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// Inbox leg token addresses (mirror scripts/oracle-tokens.ts).
const COTI = "0x000000000000000000000000000000000000C071" as `0x${string}`;
const ETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" as `0x${string}`;
const TOK = "0x000000000000000000000000000000000000000a" as `0x${string}`;

// Fee templates copied verbatim from scripts/deploy-utils.ts.
// FEE_CONFIG_SEPOLIA_SIDE (variable band, maxExecutionGas 5,000,000).
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
// FEE_CONFIG_COTI_SIDE (constant band, constantFee == maxExecutionGas == 25,000,000).
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

describe("oracle-poc direct findings", { concurrency: 1 }, async () => {
  const { viem, provider } = await network.connect({ network: "hardhat" });
  const client = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;
  const c = { public: client, wallet };

  // Deploy a PoDPriceOracle with manual cached prices on both inbox legs.
  async function deployOracle(
    localTok: `0x${string}`,
    remoteTok: `0x${string}`,
    localUsd: bigint,
    remoteUsd: bigint,
    fetchInterval: bigint = 0n,
    configuredOracle: `0x${string}` = ZERO
  ) {
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, configuredOracle, fetchInterval], {
      client: c,
    });
    await oracle.write.setInboxTokens([localTok, remoteTok], { account: owner });
    await oracle.write.setLocalTokenPriceUSD([localUsd], { account: owner });
    await oracle.write.setRemoteTokenPriceUSD([remoteUsd], { account: owner });
    return oracle;
  }

  // Deploy a standalone FeeManager and wire it to the oracle with a PINNED gas price.
  // setGasPriceBounds(0, G, G) clamps the reference gas price to exactly G regardless of basefee,
  // making targetGasRemoteUnits fully deterministic.
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

  // Read the return value of the payable validateAndPrepareOneWayFees via eth_call simulation.
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

  // ── F-1 / Chain 5 ─────────────────────────────────────────────────────────
  it("F-1: stale price is served with no revert, and mis-sizes the remote gas budget (over-fund)", async () => {
    const G = 2_000_000_000n; // pinned reference gas price (2 gwei)
    const P_ETH = 2000n * SCALE; // remote leg (ETH) $2000
    const P_COTI_STORED = (12n * SCALE) / 1000n; // 0.012 stored peg (stale-high)
    const P_COTI_TRUE = (8n * SCALE) / 1000n; // 0.008 true market (COTI dropped ~33%)

    // COTI inbox: local = COTI (constant band), remote = ETH (variable SEPOLIA band).
    const oracle = await deployOracle(COTI, ETH, P_COTI_STORED, P_ETH, 0n);

    // (a) The fee read serves a stale value forever, with NO staleness revert.
    const [l0, r0] = await oracle.read.getPricesUSD();
    assert.equal(l0, P_COTI_STORED);
    assert.equal(r0, P_ETH);
    await provider.request({ method: "evm_increaseTime", params: [100 * 86400] }); // +100 days
    await provider.request({ method: "evm_mine", params: [] });
    const [l1, r1] = await oracle.read.getPricesUSD(); // does not revert
    assert.equal(l1, P_COTI_STORED, "100-day-old price still served");
    assert.equal(r1, P_ETH);
    const nowTs = (await client.getBlock()).timestamp;
    const cotiUpdatedAt = await oracle.read.priceUpdatedAt([COTI]);
    assert.ok(nowTs - cotiUpdatedAt >= BigInt(100 * 86400), "price is >=100 days stale but still valid");

    // (b) Drive the real FeeManager and compare the gas budget at the stale vs the true price.
    const fm = await deployFeeManager(oracle.address, G, FEE_COTI, FEE_SEPOLIA);
    const totalFee = 1000n * SCALE; // user pays 1000 COTI

    const budgetStale = await oneWayTargetGas(fm.address, fm.abi, 0n, totalFee);
    // Re-peg the COTI leg to its TRUE value and recompute the SAME fee.
    await oracle.write.setLocalTokenPriceUSD([P_COTI_TRUE], { account: owner });
    const budgetTrue = await oneWayTargetGas(fm.address, fm.abi, 0n, totalFee);

    assert.equal(budgetStale, 3_000_000n, "stale peg budgets 3,000,000 remote gas units");
    assert.equal(budgetTrue, 2_000_000n, "true peg budgets 2,000,000 remote gas units");
    // Stale over-funds the miner-fronted remote gas by 1.5x (=1,000,000 free units per message).
    assert.equal(budgetStale * 2n, budgetTrue * 3n, "stale budget is exactly 1.5x the honest budget");
    assert.ok(budgetStale - budgetTrue === 1_000_000n);
  });

  it("F-1 (reverse): a stale-LOW peg under-funds and reverts TargetFeeTooLow (self-inflicted DoS)", async () => {
    const G = 2_000_000_000n;
    const P_ETH = 2000n * SCALE;
    const P_COTI_STORED_LOW = (1n * SCALE) / 1000n; // 0.001 stored (COTI rallied, peg lags low)
    const P_COTI_TRUE = (8n * SCALE) / 1000n; // 0.008 true

    const oracle = await deployOracle(COTI, ETH, P_COTI_STORED_LOW, P_ETH, 0n);
    const fm = await deployFeeManager(oracle.address, G, FEE_COTI, FEE_SEPOLIA);
    const totalFee = 1000n * SCALE;

    // At the stale-low peg the budget is 250,000 < floor 457,200 → revert.
    await assert.rejects(
      () => oneWayTargetGas(fm.address, fm.abi, 0n, totalFee),
      /TargetFeeTooLow/,
      "1000-COTI send reverts under the stale-low peg"
    );
    // The IDENTICAL send succeeds at the true price (budget 2,000,000) — so the stale peg is the cause.
    await oracle.write.setLocalTokenPriceUSD([P_COTI_TRUE], { account: owner });
    const budgetTrue = await oneWayTargetGas(fm.address, fm.abi, 0n, totalFee);
    assert.equal(budgetTrue, 2_000_000n);
  });

  // ── F-2 ───────────────────────────────────────────────────────────────────
  it("F-2: setTokenPriceUSD writes manualPrices but the fee read (getPricesUSD) is unchanged", async () => {
    const G = 2_000_000_000n;
    const P_COTI = 127n * SCALE / 10000n; // 0.0127
    const P_ETH = 2000n * SCALE;

    // COTI inbox: local = COTI, remote = ETH (variable band, so the fee number is meaningful).
    const oracle = await deployOracle(COTI, ETH, P_COTI, P_ETH, 0n);
    const fm = await deployFeeManager(oracle.address, G, FEE_COTI, FEE_SEPOLIA);
    const totalFee = 1000n * SCALE;

    const [, rBefore] = await oracle.read.getPricesUSD();
    const localBefore = await oracle.read.getLocalTokenPriceUSD();
    const budgetBefore = await oneWayTargetGas(fm.address, fm.abi, 0n, totalFee);
    assert.equal(localBefore, P_COTI);
    assert.equal(budgetBefore, 3_175_000n); // mulDiv(5e11, 0.0127e18, 2000e18)

    // Ops "bump the COTI price" with the natural token-addressed setter.
    const NEW = 2n * SCALE / 100n; // 0.02
    await oracle.write.setTokenPriceUSD([COTI, NEW], { account: owner });

    // The manual write landed in manualPrices and is visible to the portal/live surface…
    assert.equal(await oracle.read.manualPrices([COTI]), NEW, "manualPrices updated");
    assert.equal(await oracle.read.getLivePrice([COTI]), NEW, "portal getLivePrice sees the new price");
    // …but the fee read (getPricesUSD / cachedPriceUSD) is UNCHANGED, and getCachedPrice hides it too
    // (it returns the non-zero cache before checking manual).
    assert.equal(await oracle.read.getLocalTokenPriceUSD(), P_COTI, "fee read unchanged");
    assert.equal(await oracle.read.getCachedPrice([COTI]), P_COTI, "getCachedPrice hides the manual write");
    const [, rAfter] = await oracle.read.getPricesUSD();
    assert.equal(rAfter, rBefore);

    // Quiet lane (no refresh): the fee stays stale — identical budget before and after.
    const budgetAfter = await oneWayTargetGas(fm.address, fm.abi, 0n, totalFee);
    assert.equal(budgetAfter, budgetBefore, "no refresh → fee budget unchanged by setTokenPriceUSD");
  });

  // ── F-3 ───────────────────────────────────────────────────────────────────
  it("F-3(a): no min/max circuit-breaker — a clamped floor answer ($10) is accepted", async () => {
    // 8-decimal feed reporting $10 (a floor/clamp value during a flash crash).
    const feed = await viem.deployContract("MockChainlinkAggregator", [8, 10_00000000n], { client: c });
    const adapter = await viem.deployContract("ChainlinkLiveOracle", [owner, 3600n], { client: c });
    await adapter.write.setFeed([TOK, feed.address], { account: owner });
    // The adapter has no minAnswer/maxAnswer knob, so the clamped $10 passes straight through.
    assert.equal(await adapter.read.getLivePrice([TOK]), 10n * SCALE, "$10 clamp accepted (no circuit breaker)");

    // A normal $2500 answer is accepted identically — the adapter never discriminates the clamp.
    await feed.write.setAnswer([2500_00000000n], { account: owner });
    assert.equal(await adapter.read.getLivePrice([TOK]), 2500n * SCALE);

    // The ONLY lower bound is `answer > 0`: even answer==1 ($0.00000001) sails through.
    await feed.write.setAnswer([1n], { account: owner });
    assert.equal(await adapter.read.getLivePrice([TOK]), 1n * 10n ** 10n, "absurd 1-wei answer accepted (no floor)");
  });

  it("F-3(b): maxStaleness==0 disables BOTH the staleness and the future-date checks", async () => {
    const NORMALIZED = 2103_41000000n * 10n ** 10n; // $2103.41 → 18 decimals
    const feed = await viem.deployContract("MockChainlinkAggregator", [8, 2103_41000000n], { client: c });
    const guarded = await viem.deployContract("ChainlinkLiveOracle", [owner, 3600n], { client: c });
    const off = await viem.deployContract("ChainlinkLiveOracle", [owner, 0n], { client: c });
    await guarded.write.setFeed([TOK, feed.address], { account: owner });
    await off.write.setFeed([TOK, feed.address], { account: owner });

    // Stale: updatedAt = 2 days ago.
    let now = (await client.getBlock()).timestamp;
    await feed.write.setUpdatedAt([now - 2n * 86400n], { account: owner });
    assert.equal(await guarded.read.getLivePrice([TOK]), 0n, "guarded adapter rejects a 2-day-old answer");
    assert.equal(await off.read.getLivePrice([TOK]), NORMALIZED, "maxStaleness==0 accepts the 2-day-old answer");

    // Future-dated: updatedAt in the future.
    now = (await client.getBlock()).timestamp;
    await feed.write.setUpdatedAt([now + 100_000n], { account: owner });
    assert.equal(await guarded.read.getLivePrice([TOK]), 0n, "guarded adapter rejects a future-dated answer");
    assert.equal(await off.read.getLivePrice([TOK]), NORMALIZED, "maxStaleness==0 accepts a future-dated answer");
  });

  it("F-3(c): answeredInRound < roundId is rejected; answeredInRound >= roundId is accepted", async () => {
    const feed = await viem.deployContract("MockChainlinkAggregator", [8, 2500_00000000n], { client: c });
    const adapter = await viem.deployContract("ChainlinkLiveOracle", [owner, 3600n], { client: c });
    await adapter.write.setFeed([TOK, feed.address], { account: owner });

    assert.equal(await adapter.read.getLivePrice([TOK]), 2500n * SCALE, "fresh round accepted");
    // Incomplete round: answeredInRound (3) < roundId (5).
    await feed.write.setRound([5n, 3n], { account: owner });
    assert.equal(await adapter.read.getLivePrice([TOK]), 0n, "answeredInRound<roundId rejected");
    // Complete round again.
    await feed.write.setRound([7n, 7n], { account: owner });
    assert.equal(await adapter.read.getLivePrice([TOK]), 2500n * SCALE, "answeredInRound>=roundId accepted");
  });
});
