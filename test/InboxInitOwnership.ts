import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { deployTestInbox, mpcAbiReEncodeOf } from "../scripts/deploy-test-inbox.js";

const PLACEHOLDER_OWNER = "0x0000000000000000000000000000000000000001";

describe("Inbox init ownership", { concurrency: false, timeout: 120_000 }, () => {
  it("constructor leaves placeholder owner until init; init transfers to admin", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, {
      client: { public: publicClient, wallet },
    });

    const before = (await inbox.read.owner()) as `0x${string}`;
    assert.equal(before.toLowerCase(), PLACEHOLDER_OWNER);

    await inbox.write.init([deployer, 1000n, mpcAbiReEncodeOf(inbox)], { account: deployer });

    const after = (await inbox.read.owner()) as `0x${string}`;
    assert.equal(after.toLowerCase(), deployer.toLowerCase());
    assert.notEqual(after.toLowerCase(), PLACEHOLDER_OWNER);
  });
});
