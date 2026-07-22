import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };
const TARGET_CHAIN_ID = 1001n;
const GAS_PRICE_WEI = 1_000_000_000n;
const SEND_VALUE_WEI = 2_000_000_000_000_000n;
const PRICE_SCALE_18 = 10n ** 18n;

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

describe("Inbox one-way errorSelector", { concurrency: false, timeout: 600_000 }, () => {
  it("rejects non-zero errorSelector on sendOneWayMessage", async () => {
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

    await assert.rejects(
      () =>
        inbox.write.sendOneWayMessage(
          [TARGET_CHAIN_ID, deployer, minimalMethodCall(), "0xcafebabe"],
          { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
        ),
      /OneWayErrorSelectorNotSupported|0x/
    );

    const okHash = await inbox.write.sendOneWayMessage(
      [TARGET_CHAIN_ID, deployer, minimalMethodCall(), "0x00000000"],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: okHash,
      ...receiptWaitOptions,
    });
    assert.equal(receipt.status, "success");
  });
});
