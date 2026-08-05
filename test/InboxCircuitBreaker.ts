import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployLinkedInbox, mpcAbiReEncodeOf } from "../scripts/deploy-inbox-linked.js";

describe("Inbox circuit breaker and oracle guards", { concurrency: 1 }, async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const deployer = wallet.account.address as `0x${string}`;

  let inbox: any;

  before(async function () {
    inbox = await deployLinkedInbox(viem, {
      client: { public: publicClient, wallet },
    });
    await inbox.write.init([deployer, 0n, mpcAbiReEncodeOf(inbox)], { account: deployer });
    await inbox.write.addMiner([deployer], { account: deployer });
  });

  it("batchProcessRequests reverts while message processing is paused", async function () {
    await inbox.write.setMessageProcessingPaused([true], { account: deployer });
    await assert.rejects(
      inbox.write.batchProcessRequests([11155111n, []], { account: deployer }),
      /MessageProcessingPaused/
    );
    await inbox.write.setMessageProcessingPaused([false], { account: deployer });
  });

  it("sendTwoWayMessage reverts with OracleNotConfigured when oracle unset", async function () {
    await assert.rejects(
      inbox.write.sendTwoWayMessage(
        [
          999n,
          deployer,
          { selector: "0x00000000", data: "0x", datatypes: [], datalens: [] },
          "0x00000000",
          "0x00000000",
          1n,
        ],
        { account: deployer, value: 1_000_000n }
      ),
      /OracleNotConfigured/
    );
  });

  it("sendTwoWayMessage reverts with OraclePriceZero when remote price is zero", async function () {
    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([10n ** 18n], { account: deployer });
    await assert.rejects(
      inbox.write.setPriceOracle([oracle.address], { account: deployer }),
      /OraclePriceZero/
    );
  });
});
