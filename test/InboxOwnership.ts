import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { deployTestInbox, mpcAbiReEncodeOf } from "../scripts/deploy-test-inbox.js";

describe("Inbox ownership controls", { concurrency: false, timeout: 300_000 }, () => {
  it("renounceOwnership reverts; transferOwnership is two-step", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [ownerWallet, otherWallet] = await viem.getWalletClients();
    const owner = ownerWallet.account.address as `0x${string}`;
    const other = otherWallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, {
      client: { public: publicClient, wallet: ownerWallet },
    });
    await inbox.write.init([owner, 1000n, mpcAbiReEncodeOf(inbox)], { account: owner });

    await assert.rejects(
      () => inbox.write.renounceOwnership({ account: owner }),
      /revert/i
    );

    await inbox.write.transferOwnership([other], { account: owner });
    assert.equal((await inbox.read.owner()).toLowerCase(), owner.toLowerCase());
    assert.equal((await inbox.read.pendingOwner()).toLowerCase(), other.toLowerCase());

    await inbox.write.acceptOwnership({ account: other });
    assert.equal((await inbox.read.owner()).toLowerCase(), other.toLowerCase());
  });
});
