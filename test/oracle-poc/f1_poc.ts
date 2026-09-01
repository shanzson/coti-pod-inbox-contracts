import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

// ─────────────────────────────────────────────────────────────────────────────
// STANDALONE, VERBOSE PoC for the FIRST finding of audit/ORACLE_SECURITY_ANALYSIS.md
//   F-1 / Chain 5 — the cached fee price never expires; a feed-less static COTI peg
//   mis-sizes the cross-chain gas budget (miner over-fund / user-DoS).
//
// It drives the REAL contracts/fee stack:
//   • PoDPriceOracle  (real getPricesUSD / setLocal|RemoteTokenPriceUSD)
//   • FeeManager      (real validateAndPrepareOneWayFees — deployed standalone; its
//                      ERC-7201 fee slot lives in its own storage, so direct calls
//                      compute exactly what the delegatecalled Inbox would)
// The reference gas price is pinned via setGasPriceBounds(0,G,G) so the only variable
// left is the oracle ratio localPrice/remotePrice. Every number printed below is
// COMPUTED BY THE CONTRACT and read back, not hard-coded by the test.
// ─────────────────────────────────────────────────────────────────────────────

const SCALE = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const COTI = "0x000000000000000000000000000000000000C071" as `0x${string}`; // local leg
const ETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" as `0x${string}`; // remote leg

// Fee templates copied verbatim from scripts/deploy-utils.ts.
const FEE_COTI = { // FEE_CONFIG_COTI_SIDE — constant band, used as LOCAL on the COTI inbox
  constantFee: 25_000_000n, gasPerByte: 0n, callbackExecutionGas: 0n, errorLength: 0n,
  bufferRatioX10000: 0n, maxMethodCallBytes: 8192n, maxExecutionGas: 25_000_000n,
  gasPriceMul: 1n, gasPriceDiv: 1n,
} as const;
const FEE_SEPOLIA = { // FEE_CONFIG_SEPOLIA_SIDE — variable 5M band, used as REMOTE on the COTI inbox
  constantFee: 0n, gasPerByte: 800n, callbackExecutionGas: 100_000n, errorLength: 256n,
  bufferRatioX10000: 5000n, maxMethodCallBytes: 8192n, maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n, gasPriceDiv: 1n,
} as const;

const usd = (n: bigint, d: bigint) => (n * SCALE) / d; // n/d dollars in 18-dp

describe("F-1 PoC — stale/static remote peg mis-sizes the cross-chain gas budget", { concurrency: 1 }, async () => {
  const { viem, provider } = await network.connect({ network: "hardhat" });
  const client = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;
  const c = { public: client, wallet };

  const G = 2_000_000_000n;            // pinned reference gas price = 2 gwei
  const P_ETH = 2000n * SCALE;         // remote leg (ETH) = $2000
  const P_COTI_STALE = usd(12n, 1000n); // stored COTI peg = $0.012 (stale-high: real COTI has fallen)
  const P_COTI_TRUE = usd(8n, 1000n);  // true COTI = $0.008 (~33% below the stored peg)
  const totalFee = 1000n * SCALE;      // user pays 1000 COTI (local token) for a one-way send

  async function deploy(localUsd: bigint) {
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, ZERO, 0n], { client: c });
    await oracle.write.setInboxTokens([COTI, ETH], { account: owner });     // local=COTI, remote=ETH
    await oracle.write.setLocalTokenPriceUSD([localUsd], { account: owner });
    await oracle.write.setRemoteTokenPriceUSD([P_ETH], { account: owner });
    const fm = await viem.deployContract("FeeManager", [], { client: c });
    await fm.write.setPriceOracle([oracle.address], { account: owner });
    await fm.write.setGasPriceBounds([0n, G, G], { account: owner });        // pin gas price to G
    await fm.write.updateMinFeeConfigs([FEE_COTI, FEE_SEPOLIA], { account: owner }); // local=COTI, remote=SEPOLIA
    return { oracle, fm };
  }

  // read the payable validator's return value via eth_call
  async function targetGas(fm: any, totalFeeLocalWei: bigint) {
    const { result } = await client.simulateContract({
      address: fm.address, abi: fm.abi, functionName: "validateAndPrepareOneWayFees",
      args: [0n, totalFeeLocalWei], account: owner, value: 0n,
    });
    return result as bigint;
  }

  it("serves a 100-day-old price with no revert, and over-funds the remote gas budget by 1.5x", async () => {
    const { oracle, fm } = await deploy(P_COTI_STALE);

    // 1) No staleness guard on the fee read: age the chain 100 days, price still served.
    await provider.request({ method: "evm_increaseTime", params: [100 * 86400] });
    await provider.request({ method: "evm_mine", params: [] });
    const [localPrice, remotePrice] = await oracle.read.getPricesUSD();
    const nowTs = (await client.getBlock()).timestamp;
    const ageSec = nowTs - (await oracle.read.priceUpdatedAt([COTI]));
    console.log(`\n[1] getPricesUSD() after ${ageSec / 86400n} days — no revert, no staleness check:`);
    console.log(`    local(COTI)=${localPrice}  remote(ETH)=${remotePrice}`);
    assert.ok(ageSec >= BigInt(100 * 86400), "price is >=100 days stale but still served"); // check BEFORE any re-peg

    // 2) Real FeeManager budget at the STALE peg.
    const budgetStale = await targetGas(fm, totalFee);

    // 3) Re-peg COTI to its TRUE value and recompute the SAME 1000-COTI fee.
    await oracle.write.setLocalTokenPriceUSD([P_COTI_TRUE], { account: owner });
    const budgetTrue = await targetGas(fm, totalFee);

    console.log(`\n[2] Same 1000-COTI fee, real FeeManager.validateAndPrepareOneWayFees:`);
    console.log(`    stored COTI $0.012 (stale) -> targetGasRemoteUnits = ${budgetStale}`);
    console.log(`    true   COTI $0.008         -> targetGasRemoteUnits = ${budgetTrue}`);
    console.log(`    OVER-FUND = ${budgetStale - budgetTrue} remote gas units per message  (ratio ${Number(budgetStale) / Number(budgetTrue)}x)`);
    console.log(`    -> the COTI-side miner is bound to front ${budgetStale - budgetTrue} gas the fee didn't pay for, every message.\n`);

    assert.equal(budgetStale, 3_000_000n);
    assert.equal(budgetTrue, 2_000_000n);
    assert.equal(budgetStale * 2n, budgetTrue * 3n); // exactly 1.5x
    assert.equal(budgetStale - budgetTrue, 1_000_000n);
  });

  it("reverse: a stale-LOW peg under-funds and the identical send reverts TargetFeeTooLow", async () => {
    const { oracle, fm } = await deploy(usd(1n, 1000n)); // stored COTI = $0.001 (peg lags a rally)
    const floor = await fm.read.expectedMinFee([0n, FEE_SEPOLIA]); // remote admission floor
    let fullMsg = "";
    // assert.rejects enforces the specific custom error; the validator captures the full message to print.
    await assert.rejects(
      () => targetGas(fm, totalFee),
      (e: any) => {
        fullMsg = e.message ?? String(e);
        return /TargetFeeTooLow/.test(fullMsg);
      },
      "stale-low peg must revert TargetFeeTooLow"
    );
    const revertLine = (fullMsg.split("\n").find((l) => /TargetFeeTooLow/.test(l)) ?? "reverted").trim();
    console.log(`\n[3] stale-LOW peg $0.001, same 1000-COTI fee:`);
    console.log(`    remote admission floor (expectedMinFee) = ${floor}`);
    console.log(`    validateAndPrepareOneWayFees reverted with: ${revertLine}`);

    // identical send is valid once the peg is corrected to the true price
    await oracle.write.setLocalTokenPriceUSD([P_COTI_TRUE], { account: owner });
    const budgetTrue = await targetGas(fm, totalFee);
    console.log(`    after re-peg to $0.008 -> targetGasRemoteUnits = ${budgetTrue} (send valid)\n`);

    assert.equal(budgetTrue, 2_000_000n);
  });
});
