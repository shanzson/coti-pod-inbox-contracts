import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters } from "viem";
import { network } from "hardhat";
import {
  TESTNET_COTI_USD,
  TESTNET_ETH_USD,
  usdPerWholeToken18,
} from "../scripts/deploy-utils.js";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

/** Same as `mpc-test-utils.receiptWaitOptions` — avoid importing full mpc-test-utils (coti-ethers, etc.) in this file. */
const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const logStep = (message: string) => {
  console.log(`[mpc-test] ${message}`);
};

/** Human-readable USD from `getPricesUSD()` (18-dec fixed); rounds to `fracDigits` places. */
function formatUsdDisplay(value: bigint, fracDigits = 6): string {
  const W = 10n ** 18n;
  const intPart = value / W;
  const rem = value % W;
  const q = 10n ** BigInt(18 - fracDigits);
  const frac = (rem + q / 2n) / q;
  if (frac === 0n) return String(intPart);
  const fracStr = frac.toString().padStart(fracDigits, "0").replace(/0+$/, "");
  return `${intPart}.${fracStr}`;
}

type ParsedRequest = {
  requestId: `0x${string}`;
  targetFee: bigint;
  callerFee: bigint;
};

/** Same idea as `getTupleField` in mpc-test-utils (viem may return named object or tuple array). */
const tupleField = (v: unknown, key: string, index: number) => {
  if (v === null || v === undefined || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown> & unknown[];
  return (o as Record<string, unknown>)[key] ?? (Array.isArray(o) ? o[index] : undefined);
};

async function getRequestParsed(inbox: any, requestId: `0x${string}`): Promise<ParsedRequest> {
  const raw = await inbox.read.requests([requestId]);
  return {
    requestId: tupleField(raw, "requestId", 0) as `0x${string}`,
    targetFee: (tupleField(raw, "targetFee", 12) as bigint | undefined) ?? 0n,
    callerFee: (tupleField(raw, "callerFee", 13) as bigint | undefined) ?? 0n,
  };
}

/** Same numeric value as `PriceOracle.PRICE_SCALE`; use when local and remote USD quotes are equal. */
const PRICE_SCALE_18 = 10n ** 18n;

/** Remote leg minimum gas units (constant template). */
const REMOTE_MIN_GAS_UNITS = 18_000_000n;

/** Local leg template (non-constant). */
const LOCAL_TEMPLATE = {
  constantFee: 0n,
  gasPerByte: 10n,
  callbackExecutionGas: 100_000n,
  errorLength: 300n,
  bufferRatioX10000: 20_000n,
} as const;

/**
 * Fixed tx gas price so wei→gas conversions match assertions exactly.
 * Amounts are derived from min gas units: `validateAndPrepareTwoWayFees` compares **gas units**
 * (`wei / gasPrice`) to templates — e.g. 0.002 ETH @ 25 gwei is only 80_000 gas units, below a
 * typical local template minimum (~315k for this payload), so we use exact template/constant mins.
 */
const TX_GAS_PRICE_WEI = 25_000_000_000n;

function expectedTemplateMinGasUnits(
  dataSize: bigint,
  cfg: { constantFee: bigint; gasPerByte: bigint; callbackExecutionGas: bigint; errorLength: bigint; bufferRatioX10000: bigint }
): bigint {
  if (cfg.constantFee > 0n) return cfg.constantFee;
  const base =
    dataSize * cfg.gasPerByte + cfg.callbackExecutionGas + cfg.errorLength * cfg.gasPerByte;
  return (base * (10_000n + cfg.bufferRatioX10000)) / 10_000n;
}

/** Mirrors `abi.encode(methodCall).length` used in `validateAndPrepareTwoWayFees`. */
function mpcMethodCallAbiEncodedLength(methodCall: {
  selector: `0x${string}`;
  data: `0x${string}`;
  datatypes: readonly `0x${string}`[];
  datalens: readonly `0x${string}`[];
}): bigint {
  const hex = encodeAbiParameters(
    [
      { type: "bytes4", name: "selector" },
      { type: "bytes", name: "data" },
      { type: "bytes8[]", name: "datatypes" },
      { type: "bytes32[]", name: "datalens" },
    ],
    [methodCall.selector, methodCall.data, [...methodCall.datatypes], [...methodCall.datalens]]
  );
  return BigInt((hex.length - 2) / 2);
}

function minimalMethodCall() {
  return {
    selector: "0x00000000" as `0x${string}`,
    data: "0x" as `0x${string}`,
    datatypes: [] as `0x${string}`[],
    datalens: [] as `0x${string}`[],
  };
}

/** Lower bound from TS `encodeAbiParameters` length (may be a few bytes under Solidity `abi.encode`). */
const LOCAL_TEMPLATE_MIN_GAS_UNITS = expectedTemplateMinGasUnits(
  mpcMethodCallAbiEncodedLength(minimalMethodCall()),
  LOCAL_TEMPLATE
);

/**
 * Buffer so on-chain `expectedMinFee(abi.encode(methodCall).length, LOCAL_TEMPLATE)` is met for
 * both the callback leg (test 1) and the remote template leg (test 2).
 */
const TEMPLATE_MIN_HEADROOM_GAS_UNITS = 2500n;

const LOCAL_TEMPLATE_MIN_GAS_UNITS_EFFECTIVE =
  LOCAL_TEMPLATE_MIN_GAS_UNITS + TEMPLATE_MIN_HEADROOM_GAS_UNITS;

/**
 * One total: remote constant min (18M) + effective local template min (same `dataSize` both legs).
 * Test 1: callback = effective local min wei; remote = 18M gas units.
 * Test 2: callback = 18M gas units; remote = effective local min wei.
 */
const TWO_WAY_TOTAL_WEI =
  (REMOTE_MIN_GAS_UNITS + LOCAL_TEMPLATE_MIN_GAS_UNITS_EFFECTIVE) * TX_GAS_PRICE_WEI;

const CALLBACK_WEI_LOCAL_TEMPLATE = LOCAL_TEMPLATE_MIN_GAS_UNITS_EFFECTIVE * TX_GAS_PRICE_WEI;
const CALLBACK_WEI_LOCAL_CONSTANT = REMOTE_MIN_GAS_UNITS * TX_GAS_PRICE_WEI;

/** Callback set so `remoteWei/gasPrice` is `REMOTE_MIN_GAS_UNITS - 1` when local and remote oracle prices match (`TargetFeeTooLow`). */
const CALLBACK_WEI_REMOTE_LEG_TOO_SMALL =
  TWO_WAY_TOTAL_WEI - (REMOTE_MIN_GAS_UNITS - 1n) * TX_GAS_PRICE_WEI;

/**
 * `validateAndPrepareTwoWayFees` uses `tx.gasprice`. After the tx is mined, use the receipt’s
 * `effectiveGasPrice` (EIP-1559) or the signed tx’s `gasPrice` (legacy) so expected gas units match chain behavior.
 */
function gasPriceWeiFromMinedTx(
  receipt: { effectiveGasPrice?: bigint },
  tx: { gasPrice?: bigint; maxFeePerGas?: bigint }
): bigint {
  if (receipt.effectiveGasPrice && receipt.effectiveGasPrice > 0n) return receipt.effectiveGasPrice;
  if (tx.gasPrice && tx.gasPrice > 0n) return tx.gasPrice;
  if (tx.maxFeePerGas && tx.maxFeePerGas > 0n) return tx.maxFeePerGas;
  return TX_GAS_PRICE_WEI;
}

describe(
  "Inbox fee: configs + two-way submit (Hardhat)",
  { concurrency: false, timeout: 600_000 },
  function () {
    type Ctx = {
      viem: any;
      publicClient: any;
      wallet: any;
      deployer: `0x${string}`;
    };
    let ctxPromise: Promise<Ctx> | undefined;
    const getCtx = async (): Promise<Ctx> => {
      if (ctxPromise === undefined) {
        ctxPromise = (async () => {
          logStep("Connecting to Hardhat (network.connect)…");
          const { viem } = await network.connect({ network: "hardhat" });
          const publicClient = await viem.getPublicClient();
          const [wallet] = await viem.getWalletClients();
          const deployer = wallet.account.address as `0x${string}`;
          logStep("Hardhat ready; deployer = " + deployer);
          return { viem, publicClient, wallet, deployer };
        })();
      }
      return ctxPromise;
    };

    /** `PriceOracle.PRICE_SCALE`-style 18-decimal USD prices; both legs set explicitly per test. */
    const deployInboxAndOracle = async (prices: { localUsd18: bigint; remoteUsd18: bigint }) => {
      const { localUsd18, remoteUsd18 } = prices;
      const { viem, publicClient, wallet, deployer } = await getCtx();
      logStep("Deploy Inbox + PriceOracle (owner = deployer)");
      const inbox = await viem.deployContract("Inbox", [], {
        client: { public: publicClient, wallet },
      });
      await inbox.write.init([deployer, 0n], { account: deployer });
      const oracle = await viem.deployContract("PriceOracle", [deployer], {
        client: { public: publicClient, wallet },
      });
      const w = { account: deployer } as const;
      const { localToken, remoteToken } = oracleTokensForChain(31337);
      await oracle.write.setInboxTokens([localToken, remoteToken], w);
      logStep(`PriceOracle: setLocalTokenPriceUSD(${localUsd18}) setRemoteTokenPriceUSD(${remoteUsd18})`);
      await oracle.write.setLocalTokenPriceUSD([localUsd18], w);
      await oracle.write.setRemoteTokenPriceUSD([remoteUsd18], w);
      const [localUsd, remoteUsd] = await oracle.read.getPricesUSD();
      logStep(`getPricesUSD(): local=${formatUsdDisplay(localUsd)} remote=${formatUsdDisplay(remoteUsd)} USD`);
      await inbox.write.setPriceOracle([oracle.address], w);
      // Pin fee→gas conversion to the same gas price the suite uses for assertions (POD-07).
      await inbox.write.setGasPriceBounds([0n, TX_GAS_PRICE_WEI, TX_GAS_PRICE_WEI], w);
      return { inbox, oracle, deployer, publicClient };
    };

    const remoteConstantOnly = {
      constantFee: REMOTE_MIN_GAS_UNITS,
      gasPerByte: 0n,
      callbackExecutionGas: 0n,
      errorLength: 0n,
      bufferRatioX10000: 10_000n,
    };

    it(
      "remote constant 18M + local template: min wei split for template + 18M constant; check targetFee/callerFee",
      { timeout: 300_000 },
      async () => {
      const { inbox, deployer, publicClient } = await deployInboxAndOracle({
        localUsd18: PRICE_SCALE_18,
        remoteUsd18: PRICE_SCALE_18,
      });
      logStep("updateMinFeeConfigs: local=template, remote=constant 18_000_000");
      await inbox.write.updateMinFeeConfigs([{ ...LOCAL_TEMPLATE }, { ...remoteConstantOnly }], {
        account: deployer,
      });

      const methodCall = minimalMethodCall();
      const dataSize = mpcMethodCallAbiEncodedLength(methodCall);
      logStep(`dataSize (bytes) = ${dataSize}`);

      const txHash = await inbox.write.sendTwoWayMessage(
        [
          999n,
          deployer,
          methodCall,
          "0xdeadbeef",
          "0xcafebabe",
          CALLBACK_WEI_LOCAL_TEMPLATE,
        ],
        {
          account: deployer,
          value: TWO_WAY_TOTAL_WEI,
          gasPrice: TX_GAS_PRICE_WEI,
        }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
      const tx = await publicClient.getTransaction({ hash: txHash });
      const gp = gasPriceWeiFromMinedTx(receipt, tx);
      logStep(`mined tx effective gas price (wei) used for expectations: ${gp}`);

      const len = await inbox.read.getRequestsLen([999n]);
      assert.equal(len, 1n);
      const batch = await inbox.read.getRequests([999n, 0n, 1n]);
      const requestId = batch[0].requestId as `0x${string}`;
      const req = await getRequestParsed(inbox, requestId);

      const expectedCallerGas = CALLBACK_WEI_LOCAL_TEMPLATE / gp;
      const remoteWei1 = TWO_WAY_TOTAL_WEI - CALLBACK_WEI_LOCAL_TEMPLATE;
      const expectedTargetGas = remoteWei1 / gp;

      logStep(`expected targetFee (gas) = ${expectedTargetGas}, callerFee (gas) = ${expectedCallerGas}`);
      logStep(`stored   targetFee = ${req.targetFee}, callerFee = ${req.callerFee}`);

      assert.equal(req.targetFee, expectedTargetGas);
      assert.equal(req.callerFee, expectedCallerGas);

      const localMin = expectedTemplateMinGasUnits(dataSize, LOCAL_TEMPLATE);
      assert.ok(
        expectedCallerGas >= localMin,
        `caller gas ${expectedCallerGas} must meet local template min ${localMin}`
      );
      assert.ok(
        expectedTargetGas >= REMOTE_MIN_GAS_UNITS,
        `target gas ${expectedTargetGas} must meet remote constant ${REMOTE_MIN_GAS_UNITS} (+ headroom)`
      );
    }
    );

    it(
      "reversed: local constant 18M + remote template (same template shape)",
      { timeout: 300_000 },
      async () => {
      const { inbox, deployer, publicClient } = await deployInboxAndOracle({
        localUsd18: PRICE_SCALE_18,
        remoteUsd18: PRICE_SCALE_18,
      });
      logStep("updateMinFeeConfigs: local=constant 18_000_000, remote=local template fields");
      await inbox.write.updateMinFeeConfigs(
        [{ ...remoteConstantOnly }, { ...LOCAL_TEMPLATE }],
        { account: deployer }
      );

      const methodCall = minimalMethodCall();
      const dataSize = mpcMethodCallAbiEncodedLength(methodCall);
      const remoteMin = expectedTemplateMinGasUnits(dataSize, LOCAL_TEMPLATE);

      const txHash = await inbox.write.sendTwoWayMessage(
        [998n, deployer, methodCall, "0xdeadbeef", "0xcafebabe", CALLBACK_WEI_LOCAL_CONSTANT],
        { account: deployer, value: TWO_WAY_TOTAL_WEI, gasPrice: TX_GAS_PRICE_WEI }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
      const tx = await publicClient.getTransaction({ hash: txHash });
      const gp = gasPriceWeiFromMinedTx(receipt, tx);

      const batch2 = await inbox.read.getRequests([998n, 0n, 1n]);
      const req = await getRequestParsed(inbox, batch2[0].requestId as `0x${string}`);

      const expectedCallerGas = CALLBACK_WEI_LOCAL_CONSTANT / gp;
      const remoteWei2 = TWO_WAY_TOTAL_WEI - CALLBACK_WEI_LOCAL_CONSTANT;
      const expectedTargetGas = remoteWei2 / gp;

      assert.equal(req.callerFee, expectedCallerGas);
      assert.equal(req.targetFee, expectedTargetGas);
      assert.ok(expectedCallerGas >= REMOTE_MIN_GAS_UNITS, "callback leg must satisfy local constant min");
      assert.ok(
        expectedTargetGas >= remoteMin,
        "remote leg must satisfy remote template min (incl. headroom vs viem length)"
      );
      logStep(`reversed case ok: targetFee=${req.targetFee} callerFee=${req.callerFee}`);
    }
    );

    it(
      "edge cases: fee validation reverts",
      { timeout: 300_000 },
      async () => {
      const { inbox, deployer } = await deployInboxAndOracle({
        localUsd18: PRICE_SCALE_18,
        remoteUsd18: PRICE_SCALE_18,
      });
      await inbox.write.updateMinFeeConfigs([{ ...LOCAL_TEMPLATE }, { ...remoteConstantOnly }], {
        account: deployer,
      });

      const m = minimalMethodCall();
      const args = [888n, deployer, m, "0xdeadbeef", "0xcafebabe"] as const;

      await assert.rejects(async () => {
        await inbox.write.sendTwoWayMessage([...args, CALLBACK_WEI_LOCAL_TEMPLATE], {
          account: deployer,
          value: 0n,
          gasPrice: TX_GAS_PRICE_WEI,
        });
      });
      logStep("reject: total value 0 → reverts");

      await assert.rejects(async () => {
        await inbox.write.sendTwoWayMessage([...args, 0n], {
          account: deployer,
          value: TWO_WAY_TOTAL_WEI,
          gasPrice: TX_GAS_PRICE_WEI,
        });
      });
      logStep("reject: callback 0 → reverts");

      await assert.rejects(async () => {
        await inbox.write.sendTwoWayMessage([...args, TWO_WAY_TOTAL_WEI + 1n], {
          account: deployer,
          value: TWO_WAY_TOTAL_WEI,
          gasPrice: TX_GAS_PRICE_WEI,
        });
      });
      logStep("reject: callback > total → reverts");

      await assert.rejects(async () => {
        await inbox.write.sendTwoWayMessage([...args, 1n], {
          account: deployer,
          value: TWO_WAY_TOTAL_WEI,
          gasPrice: TX_GAS_PRICE_WEI,
        });
      });
      logStep("reject: 1 wei callback → reverts (caller gas units / min fee)");

      await assert.rejects(async () => {
        await inbox.write.sendTwoWayMessage([...args, CALLBACK_WEI_REMOTE_LEG_TOO_SMALL], {
          account: deployer,
          value: TWO_WAY_TOTAL_WEI,
          gasPrice: TX_GAS_PRICE_WEI,
        });
      });
      logStep("reject: remote leg too small for constant 18M min → reverts");

      await assert.rejects(async () => {
        await inbox.write.updateMinFeeConfigs(
          [{ ...LOCAL_TEMPLATE, gasPerByte: 0n }, { ...remoteConstantOnly }],
          { account: deployer }
        );
      });
      logStep("reject: invalid local template (gasPerByte 0) → reverts");
    }
    );

    it(
      "calculateTwoWayFeeRequiredInLocalToken (dataSize 20, exec gas 200k): tx fees match helper (ETH local / COTI remote)",
      { timeout: 300_000 },
      async () => {
        const localTokenPriceUsd18 = usdPerWholeToken18(TESTNET_ETH_USD);
        const remoteTokenPriceUsd18 = usdPerWholeToken18(TESTNET_COTI_USD);
        const { inbox, deployer, publicClient } = await deployInboxAndOracle({
          localUsd18: localTokenPriceUsd18,
          remoteUsd18: remoteTokenPriceUsd18,
        });
        const DATA_SIZE_HINT = 20n;
        const EXEC_GAS = 200_000n;
        const gp = TX_GAS_PRICE_WEI;

        await inbox.write.updateMinFeeConfigs([{ ...LOCAL_TEMPLATE }, { ...remoteConstantOnly }], {
          account: deployer,
        });

        const [targetWeiEst, callerWeiEst] = await inbox.read.calculateTwoWayFeeRequiredInLocalToken([
          DATA_SIZE_HINT,
          DATA_SIZE_HINT,
          EXEC_GAS,
          EXEC_GAS,
          gp,
        ]);

        const minLocalGasForHint = expectedTemplateMinGasUnits(DATA_SIZE_HINT, LOCAL_TEMPLATE);
        const remoteGasRequired = REMOTE_MIN_GAS_UNITS + EXEC_GAS;
        const targetGasLocalUnits =
          (remoteGasRequired * remoteTokenPriceUsd18 + localTokenPriceUsd18 - 1n) /
          localTokenPriceUsd18;
        const expectedCallerWei = (minLocalGasForHint + EXEC_GAS) * gp;
        const expectedTargetWei = targetGasLocalUnits * gp;
        assert.equal(callerWeiEst, expectedCallerWei, "local leg = (expectedMinFee(20) + 200k exec gas) * gasPrice");
        assert.equal(targetWeiEst, expectedTargetWei, "remote leg in local wei = (remote min + exec gas) scaled by oracle ratio");

        logStep(
          `calculateTwoWayFeeRequiredInLocalToken(${DATA_SIZE_HINT}, ${DATA_SIZE_HINT}, ${EXEC_GAS}, ${EXEC_GAS}, gp) → ` +
            `targetWei=${targetWeiEst} callerWei=${callerWeiEst}`
        );
        logStep(
          `expected from templates: targetWei=${expectedTargetWei} (= ${remoteGasRequired} gas @ gp × remote/local), ` +
            `callerWei=${expectedCallerWei} (= (${minLocalGasForHint} + ${EXEC_GAS}) gas @ gp)`
        );

        const methodCall = minimalMethodCall();
        const onChainDataSize = mpcMethodCallAbiEncodedLength(methodCall);
        logStep(
          `sendTwoWayMessage uses abi.encode(methodCall).length = ${onChainDataSize} bytes; ` +
            `min caller gas units must be ≤ ${minLocalGasForHint + EXEC_GAS} (hint path uses size ${DATA_SIZE_HINT})`
        );
        const minCallerForActualPayload = expectedTemplateMinGasUnits(onChainDataSize, LOCAL_TEMPLATE);
        assert.ok(
          minLocalGasForHint + EXEC_GAS >= minCallerForActualPayload,
          "caller budget from size-20 hint covers template min for actual minimal payload"
        );

        const totalWei = targetWeiEst + callerWeiEst;

        const txHash = await inbox.write.sendTwoWayMessage(
          [
            777n,
            deployer,
            methodCall,
            "0xdeadbeef",
            "0xcafebabe",
            callerWeiEst,
          ],
          {
            account: deployer,
            value: totalWei,
            gasPrice: gp,
          }
        );
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
        const tx = await publicClient.getTransaction({ hash: txHash });
        const gpMined = gasPriceWeiFromMinedTx(receipt, tx);
        logStep(`mined effective gas price (wei) = ${gpMined}`);

        const batch = await inbox.read.getRequests([777n, 0n, 1n]);
        const req = await getRequestParsed(inbox, batch[0].requestId as `0x${string}`);

        const expectedCallerGas = callerWeiEst / gpMined;
        const remoteWeiLocal = totalWei - callerWeiEst;
        // On-chain: targetGasRemoteUnits = (remoteWei * localPrice / remotePrice) / gasPrice — not remoteWei/gp alone.
        const expectedTargetGas =
          (remoteWeiLocal * localTokenPriceUsd18) / remoteTokenPriceUsd18 / gpMined;
        logStep(`stored targetFee (gas units)=${req.targetFee} callerFee (gas units)=${req.callerFee}`);
        logStep(`expected targetFee=${expectedTargetGas} callerFee=${expectedCallerGas}`);

        assert.equal(req.targetFee, expectedTargetGas);
        assert.equal(req.callerFee, expectedCallerGas);
        assert.ok(req.targetFee >= REMOTE_MIN_GAS_UNITS, "remote gas units must satisfy remote constant min");
        assert.equal(req.callerFee, minLocalGasForHint + EXEC_GAS);
      }
    );
  }
);
