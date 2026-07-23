import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { TESTNET_COTI_USD, TESTNET_ETH_USD, usdPerWholeToken18 } from "../scripts/deploy-utils.js";

const packBand = (s: string): `0x${string}` => {
  const b = Buffer.alloc(32);
  for (let i = 0; i < s.length && i < 32; i++) b[i] = s.charCodeAt(i);
  return `0x${b.toString("hex")}` as `0x${string}`;
};

const ETH_8 = 2103_41000000n;
const SCALE = 10n ** 18n;
const BAND_ETH = usdPerWholeToken18("2200");

describe("PoDPriceOracle", { concurrency: 1 }, async () => {
  const { viem } = await network.connect({ network: "hardhat" });
  const client = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;
  const c = { public: client, wallet };
  const { localToken, remoteToken } = oracleTokensForChain(31337);

  async function deploy(adapter: "chainlink" | "band", ethFeed?: `0x${string}`) {
    let live: `0x${string}`;
    if (adapter === "band") {
      const band = await viem.deployContract("MockBandStdReference", [], { client: c });
      const ad = await viem.deployContract("BandLiveOracle", [owner, band.address, 3600n], { client: c });
      await ad.write.setFeed([localToken, packBand("ETH"), packBand("USDC")], { account: owner });
      await band.write.setRate(["ETH", "USDC", BAND_ETH], { account: owner });
      live = ad.address;
    } else {
      const ad = await viem.deployContract("ChainlinkLiveOracle", [owner, 3600n], { client: c });
      if (ethFeed) await ad.write.setFeed([localToken, ethFeed], { account: owner });
      live = ad.address;
    }
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, live, 0n], { client: c });
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: owner });
    return { oracle, live };
  }

  it("cached vs live diverge after feed update", async () => {
    const feed = await viem.deployContract("MockChainlinkAggregator", [8, ETH_8], { client: c });
    const { oracle } = await deploy("chainlink", feed.address);
    await oracle.write.setRemoteTokenPriceUSD([usdPerWholeToken18(TESTNET_COTI_USD)], { account: owner });
    await oracle.write.refreshCache([]);
    const cached = await oracle.read.getCachedPrice([localToken]);
    await feed.write.setAnswer([3000_00000000n], { account: owner });
    assert.equal(cached, usdPerWholeToken18(TESTNET_ETH_USD));
    assert.equal(await oracle.read.getLivePrice([localToken]), usdPerWholeToken18("3000"));
  });

  it("getLivePrices: manual collateral + Band native", async () => {
    const usdc = "0x00000000000000000000000000000000000000c1" as `0x${string}`;
    const { oracle } = await deploy("band");
    await oracle.write.setTokenPriceUSD([usdc, SCALE], { account: owner });
    const [native, col] = await oracle.read.getLivePrices([localToken, usdc]);
    assert.equal(native, BAND_ETH);
    assert.equal(col, SCALE);
  });

  it("clearTokenPriceUSD removes manual peg so live adapter resumes", async () => {
    const { oracle } = await deploy("band");
    await oracle.write.setTokenPriceUSD([localToken, SCALE], { account: owner });
    assert.equal(await oracle.read.getLivePrice([localToken]), SCALE);

    await assert.rejects(
      () => oracle.write.setTokenPriceUSD([localToken, 0n], { account: owner }),
      /ZeroUsdPrice|reverted/
    );

    await oracle.write.clearTokenPriceUSD([localToken], { account: owner });
    assert.equal(await oracle.read.manualPrices([localToken]), 0n);
    assert.equal(await oracle.read.getLivePrice([localToken]), BAND_ETH);
  });

  it("refreshCache respects staleness and fetch interval", async () => {
    const feed = await viem.deployContract("MockChainlinkAggregator", [8, ETH_8], { client: c });
    const ad = await viem.deployContract("ChainlinkLiveOracle", [owner, 60n], { client: c });
    await ad.write.setFeed([localToken, feed.address], { account: owner });
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, ad.address, 3600n], { client: c });
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: owner });
    await oracle.write.setRemoteTokenPriceUSD([usdPerWholeToken18(TESTNET_COTI_USD)], { account: owner });
    await oracle.write.refreshCache([]);
    const first = await oracle.read.getLocalTokenPriceUSD();
    await feed.write.setAnswer([2500_00000000n], { account: owner });
    await feed.write.setUpdatedAt([1n], { account: owner });
    await oracle.write.refreshCache([]);
    assert.equal(await oracle.read.getLocalTokenPriceUSD(), first);
  });

  it("refreshCache updates both legs and has no single-token overload", async () => {
    const feed = await viem.deployContract("MockChainlinkAggregator", [8, ETH_8], { client: c });
    const { oracle } = await deploy("chainlink", feed.address);
    await oracle.write.setRemoteTokenPriceUSD([usdPerWholeToken18(TESTNET_COTI_USD)], { account: owner });
    await oracle.write.refreshCache([]);
    assert.equal(await oracle.read.getLocalTokenPriceUSD(), usdPerWholeToken18(TESTNET_ETH_USD));
    assert.equal(await oracle.read.getRemoteTokenPriceUSD(), usdPerWholeToken18(TESTNET_COTI_USD));
    const hasSingleLeg = oracle.abi.some(
      (x: { type?: string; name?: string; inputs?: { type: string }[] }) =>
        x.type === "function" &&
        x.name === "refreshCache" &&
        Array.isArray(x.inputs) &&
        x.inputs.length === 1
    );
    assert.equal(hasSingleLeg, false, "single-leg refreshCache(address) must be removed (POD-05)");
  });
});
