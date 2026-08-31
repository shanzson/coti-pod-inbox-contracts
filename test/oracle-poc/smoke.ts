import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const SCALE = 10n ** 18n;
const LOCAL = "0x000000000000000000000000000000000000000a" as `0x${string}`;
const REMOTE = "0x000000000000000000000000000000000000000b" as `0x${string}`;

// Smoke test: proves the isolated oracle harness compiles the real contracts/fee
// stack and can deploy + call it under the WASM solc.
describe("oracle-poc smoke", { concurrency: 1 }, async () => {
  const { viem } = await network.connect({ network: "hardhat" });
  const client = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;
  const c = { public: client, wallet };

  it("deploys PoDPriceOracle + Chainlink adapter and refreshes cache", async () => {
    const feed = await viem.deployContract("MockChainlinkAggregator", [8, 2500_00000000n], { client: c });
    const adapter = await viem.deployContract("ChainlinkLiveOracle", [owner, 3600n], { client: c });
    await adapter.write.setFeed([LOCAL, feed.address], { account: owner });
    const oracle = await viem.deployContract("PoDPriceOracle", [owner, adapter.address, 0n], { client: c });
    await oracle.write.setInboxTokens([LOCAL, REMOTE], { account: owner });
    await oracle.write.setRemoteTokenPriceUSD([SCALE / 100n], { account: owner }); // $0.01 remote
    await oracle.write.refreshCache([]);

    const [localPrice, remotePrice] = await oracle.read.getPricesUSD();
    assert.equal(localPrice, 2500n * SCALE, "local leg should be $2500 (18-dec)");
    assert.equal(remotePrice, SCALE / 100n, "remote leg should be $0.01 (18-dec)");
  });
});
