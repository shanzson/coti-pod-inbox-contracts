import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };
const TARGET_CHAIN_ID = 1001n;
const PRICE_SCALE_18 = 10n ** 18n;
const SEND_VALUE_WEI = 2_000_000_000_000_000n; // 0.002 ether

const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

const minimalMethodCall = () => ({
  selector: "0x00000000" as `0x${string}`,
  data: "0x" as `0x${string}`,
  datatypes: [] as `0x${string}`[],
  datalens: [] as `0x${string}`[],
});

describe("Inbox POD-07 reference gas price", { concurrency: false, timeout: 600_000 }, () => {
  async function deployReadyInbox() {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await viem.deployContract("Inbox", [], {
      client: { public: publicClient, wallet },
    });
    await inbox.write.init([deployer, 1000n], { account: deployer });
    await inbox.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], {
      account: deployer,
    });

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });

    return { inbox, publicClient, deployer };
  }

  it("caps reference gas via maxGasPriceWei so high tips do not inflate targetFee", async () => {
    const { inbox, publicClient, deployer } = await deployReadyInbox();

    // Cap reference gas at 1 gwei so a 100 gwei tip cannot buy a larger gas budget.
    const CAP = 1_000_000_000n;
    await inbox.write.setGasPriceBounds([0n, CAP, CAP], { account: deployer });

    const highTip = 100_000_000_000n;
    const hash = await inbox.write.sendOneWayMessage(
      [TARGET_CHAIN_ID, deployer, minimalMethodCall(), "0x00000000"],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: highTip }
    );
    await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });

    const outbound = (await inbox.read.getRequests([TARGET_CHAIN_ID, 0n, 1n])) as any[];
    const targetFee = outbound[0].targetFee as bigint;
    // At 1:1 prices: targetFee ~= SEND_VALUE / CAP
    const expected = SEND_VALUE_WEI / CAP;
    assert.equal(targetFee, expected);

    assert.equal(await inbox.read.minGasPriceWei(), CAP);
    assert.equal(await inbox.read.maxGasPriceWei(), CAP);
    assert.equal(await inbox.read.minPriorityFeeWei(), 0n);
  });

  it("rejects zero minGasPriceWei and max < min", async () => {
    const { inbox, deployer } = await deployReadyInbox();
    await assert.rejects(
      () => inbox.write.setGasPriceBounds([0n, 0n, 0n], { account: deployer }),
      /GasPriceBoundsInvalid|0x/
    );
    await assert.rejects(
      () => inbox.write.setGasPriceBounds([0n, 2n, 1n], { account: deployer }),
      /GasPriceBoundsInvalid|0x/
    );
  });
});
