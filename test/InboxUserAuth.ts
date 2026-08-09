import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, toBytes, zeroAddress, zeroHash } from "viem";

describe("InboxUser auth modifiers", { concurrency: false, timeout: 120_000 }, () => {
  const asInbox = async (params: {
    viem: any;
    publicClient: any;
    mockAddress: `0x${string}`;
    harnessAddress: `0x${string}`;
  }) => {
    await params.publicClient.request({
      method: "hardhat_impersonateAccount",
      params: [params.mockAddress],
    });
    await params.publicClient.request({
      method: "hardhat_setBalance",
      params: [params.mockAddress, "0x1000000000000000000"],
    });
    const mockWallet = await params.viem.getWalletClient(params.mockAddress);
    return params.viem.getContractAt("InboxUserHarness", params.harnessAddress, {
      client: { public: params.publicClient, wallet: mockWallet },
    });
  };

  it("onlyInboxPeer accepts trusted remote and rejects others", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const mock = await viem.deployContract("MockInboxAuth", [], {
      client: { public: publicClient, wallet },
    });
    const harness = await viem.deployContract("InboxUserHarness", [mock.address], {
      client: { public: publicClient, wallet },
    });

    const peer = getAddress(`0x${"11".repeat(20)}`);
    const other = getAddress(`0x${"22".repeat(20)}`);
    await harness.write.setPeer([11155111n, peer], { account: deployer });
    await mock.write.setContext([11155111n, peer, zeroHash], { account: deployer });

    const harnessAsInbox = await asInbox({
      viem,
      publicClient,
      mockAddress: mock.address,
      harnessAddress: harness.address,
    });

    await harnessAsInbox.write.peerEntry([], { account: mock.address });
    assert.equal(await harness.read.peerHits(), 1n);

    await mock.write.setContext([11155111n, other, zeroHash], { account: deployer });
    await assert.rejects(
      () => harnessAsInbox.write.peerEntry([], { account: mock.address }),
      /UntrustedPeer|revert/i
    );
  });

  it("onlyInboxReturnLeg requires non-zero source request id", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const mock = await viem.deployContract("MockInboxAuth", [], {
      client: { public: publicClient, wallet },
    });
    const harness = await viem.deployContract("InboxUserHarness", [mock.address], {
      client: { public: publicClient, wallet },
    });

    const harnessAsInbox = await asInbox({
      viem,
      publicClient,
      mockAddress: mock.address,
      harnessAddress: harness.address,
    });

    await mock.write.setContext([1n, zeroAddress, zeroHash], { account: deployer });
    await assert.rejects(
      () => harnessAsInbox.write.returnLegEntry([], { account: mock.address }),
      /NotLinkedReturnLeg|revert/i
    );

    const linked = keccak256(toBytes("linked-return"));
    await mock.write.setContext([1n, zeroAddress, linked], { account: deployer });
    await harnessAsInbox.write.returnLegEntry([], { account: mock.address });
    assert.equal(await harness.read.returnLegHits(), 1n);
  });
});
