import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL verification for C-2.
// The report claims a zeroed leg bricks sends WHILE "the dashboard reads green".
// chains.ts proves that via getCachedPrice() (the portal-style read) returning the
// manual fallback. This test checks the CONTRACT'S PURPOSE-BUILT OPS SURFACE,
// getOracleHealth() (PoDPriceOracle:112-142, NatSpec "Ops / health-bot surface"),
// in the identical scenario — to test whether the "active operator deception"
// is real for a monitor using the intended surface.
// ─────────────────────────────────────────────────────────────────────────────

const SCALE = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const COTI = "0x000000000000000000000000000000000000C071" as `0x${string}`;
const ETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" as `0x${string}`;

describe("verify C-2: getOracleHealth is NOT deceived by the mirage", { concurrency: 1 }, async () => {
  const { viem } = await network.connect({ network: "hardhat" });
  const client = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;
  const c = { public: client, wallet };

  it("getCachedPrice reads green but getOracleHealth exposes remoteCached==0", async () => {
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, ZERO, 0n], { client: c });
    await oracle.write.setInboxTokens([COTI, ETH], { account: owner });
    await oracle.write.setLocalTokenPriceUSD([(127n * SCALE) / 10000n], { account: owner }); // COTI 0.0127
    await oracle.write.setRemoteTokenPriceUSD([2000n * SCALE], { account: owner }); // ETH 2000

    // Zero the remote (ETH) leg, then ops set the "wrong" token-addressed setter.
    await oracle.write.clearTokenPriceUSD([ETH], { account: owner });
    await oracle.write.setTokenPriceUSD([ETH, 2500n * SCALE], { account: owner });

    // The chains.ts mirage read: getCachedPrice returns the manual fallback (green).
    assert.equal(await oracle.read.getCachedPrice([ETH]), 2500n * SCALE, "getCachedPrice reads green");
    // …but the actual fee-path read is still zero.
    const [, feeRemote] = await oracle.read.getPricesUSD();
    assert.equal(feeRemote, 0n, "fee path still zero");

    // THE ADVERSARIAL POINT: the purpose-built ops surface exposes the fee-path cache
    // (remoteCached) SEPARATELY from live/manual — so a monitor on getOracleHealth is NOT deceived.
    const h = (await oracle.read.getOracleHealth()) as readonly bigint[] & readonly boolean[];
    // getOracleHealth returns: (localCached, remoteCached, localLive, remoteLive,
    //   localLiveOk, remoteLiveOk, localUpdatedAt, remoteUpdatedAt, lastFetch, gateOpen, localManual, remoteManual)
    const remoteCached = h[1] as bigint;
    const remoteLive = h[3] as bigint;
    const remoteLiveOk = h[5] as unknown as boolean;
    const remoteManual = h[11] as unknown as boolean;

    assert.equal(remoteCached, 0n, "getOracleHealth EXPOSES the zeroed fee-path cache (remoteCached==0)");
    assert.equal(remoteLive, 2500n * SCALE, "live/manual shown separately");
    assert.equal(remoteLiveOk, true);
    assert.equal(remoteManual, true, "and flags the value is only a manual peg, not a real cache write");
    // Conclusion: the "dashboard reads green" claim only holds for tooling that reads getCachedPrice.
    // The contract's intended health surface reports remoteCached==0, i.e. the fee path is dead.
  });
});
