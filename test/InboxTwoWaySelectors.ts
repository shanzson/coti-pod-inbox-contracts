import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";

const GAS_PRICE_WEI = 1_000_000_000n;
const SEND_VALUE_WEI = 5_000_000_000_000_000n;
const PRICE_SCALE_18 = 10n ** 18n;

const FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
  maxMethodCallBytes: 8192n,
  maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n,
  gasPriceDiv: 1n,
} as const;

const methodCall = {
  selector: "0x00000000" as const,
  data: "0x" as const,
  datatypes: [] as const,
  datalens: [] as const,
};

describe("two-way selector requirements", {
  concurrency: false,
  timeout: 300_000,
}, () => {
  const setup = async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;
    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, 1000n, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], { account: deployer });
    await inbox.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });
    await inbox.write.setGasPriceBounds([0n, GAS_PRICE_WEI, GAS_PRICE_WEI], { account: deployer });
    return { inbox, deployer };
  };

  it("rejects zero callbackSelector", async () => {
    const { inbox, deployer } = await setup();
    await assert.rejects(
      () =>
        inbox.write.sendTwoWayMessage(
          [1001n, deployer, methodCall, "0x00000000", "0x87654321", SEND_VALUE_WEI / 2n],
          { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
        ),
      /InvalidTwoWaySelectors/
    );
  });

  it("rejects zero errorSelector", async () => {
    const { inbox, deployer } = await setup();
    await assert.rejects(
      () =>
        inbox.write.sendTwoWayMessage(
          [1001n, deployer, methodCall, "0x12345678", "0x00000000", SEND_VALUE_WEI / 2n],
          { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
        ),
      /InvalidTwoWaySelectors/
    );
  });

  it("rejects equal callback and error selectors", async () => {
    const { inbox, deployer } = await setup();
    await assert.rejects(
      () =>
        inbox.write.sendTwoWayMessage(
          [1001n, deployer, methodCall, "0x12345678", "0x12345678", SEND_VALUE_WEI / 2n],
          { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
        ),
      /InvalidTwoWaySelectors/
    );
  });
});
