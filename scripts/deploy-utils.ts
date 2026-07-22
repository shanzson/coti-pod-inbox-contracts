import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { defineChain, parseUnits, zeroAddress, createPublicClient, http, type PublicClient, type WalletClient } from "viem";
import { oracleTokensForChain } from "./oracle-tokens.js";
import {
  deployInboxDeterministic as deployInboxViaCreateX,
  type DeployInboxDeterministicResult,
  type InboxArtifact,
} from "./createx.js";
import { MANUAL_USD_PEG_18, usdcUnderlyingForChain } from "./oracle-pegs.js";

/** Etherscan requires the full solc commit suffix; Hardhat build-info may omit it. */
export const patchBuildInfoSolcLongVersion = (longVersion = "0.8.28+commit.7893614a") => {
  const dir = path.resolve(process.cwd(), "artifacts/build-info");
  if (!fsSync.existsSync(dir)) return;
  for (const file of fsSync.readdirSync(dir)) {
    if (!file.endsWith(".json") || file.endsWith(".output.json")) continue;
    const p = path.join(dir, file);
    const json = JSON.parse(fsSync.readFileSync(p, "utf8"));
    if (json.solcLongVersion === "0.8.28") {
      json.solcLongVersion = longVersion;
      fsSync.writeFileSync(p, JSON.stringify(json));
    }
  }
};

/** Await mining so the next `write` does not reuse a nonce still pending on COTI (replacement transaction underpriced). */
export const waitMined = async (publicClient: unknown, hash: `0x${string}`) => {
  const receipt = await (publicClient as PublicClient).waitForTransactionReceipt({
    hash,
    timeout: 300_000,
    pollingInterval: 2_000,
  });
  if (receipt.status !== "success") {
    throw new Error(`Transaction ${hash} reverted (status=${receipt.status})`);
  }
  return receipt;
};

/** Enough gas for `PriceOracle` admin price sets on COTI (large uint256 args can underestimate). */
export const COTI_ADMIN_WRITE_GAS = 500_000n;

/** COTI testnet faucet (Discord bot: `testnet <address>`). */
export const COTI_TESTNET_FAUCET_HINT =
  "https://docs.coti.io/coti-documentation/build-on-coti/tools/remix-plugin (Discord faucet: testnet <address>)";

type GasPreflightParams = {
  publicClient: PublicClient;
  account: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  label?: string;
};

/**
 * Fail fast before a COTI write when the signer cannot afford gas.
 * COTI RPC often reports this as `gas required exceeds allowance (<n>)` where `<n>` ≈ balance / gasPrice.
 */
export const ensureGasFunds = async (params: GasPreflightParams): Promise<bigint> => {
  const gas = await params.publicClient.estimateGas({
    account: params.account,
    to: params.to,
    data: params.data,
  });
  const gasPrice = await params.publicClient.getGasPrice();
  const balance = await params.publicClient.getBalance({ address: params.account });
  const cost = gas * gasPrice;
  if (balance < cost) {
    const who = params.label ?? params.account;
    throw new Error(
      `Insufficient native balance for gas on ${who}: ` +
        `balance=${balance} wei, need≈${cost} wei (${gas} gas × ${gasPrice} gasPrice). ` +
        `Fund the account on COTI testnet. ${COTI_TESTNET_FAUCET_HINT}`
    );
  }
  return gas + gas / 5n;
};

/** Args for {PodUser.configure} when the inbox was already set in the constructor (`inbox_ == address(0)` skips inbox). */
export const podConfigureKeepInbox = (
  mpcExecutor: `0x${string}`,
  cotiChainId: bigint
): readonly [`0x${string}`, `0x${string}`, bigint] => [zeroAddress, mpcExecutor, cotiChainId];

type DeploymentLogEntry = {
  contract: string;
  address: `0x${string}`;
  chainId: number;
  network: string;
};

const logPath = path.resolve(process.cwd(), "deployment.log");
const deployConfigPath = path.resolve(process.cwd(), "deployConfig.json");

/** Fee template as stored in deployConfig.json (string|number for JSON safety with large values). */
export type FeeConfigJson = {
  constantFee: string | number;
  gasPerByte: string | number;
  callbackExecutionGas: string | number;
  errorLength: string | number;
  bufferRatioX10000: string | number;
};

type DeployConfig = {
  chains: Record<
    string,
    {
      inbox?: string;
      cotiExecutor?: string;
      priceOracle?: string;
      /** Min-fee templates for this chain's inbox (local = this chain, remote = paired chain). */
      feeConfig?: { local: FeeConfigJson; remote: FeeConfigJson };
    }
  >;
};

/** Fixed testnet spot prices (USD per whole 18‑decimal native token). Used as {PriceOracle} 18‑decimal fixed values. */
export const TESTNET_ETH_USD = "2103.41";
/** COTI spot (USD). Source: CoinGecko `coti` ~2026-06-01; refresh before relying on the COTI/AVAX ratio. */
export const TESTNET_COTI_USD = "0.01272522";
/** AVAX spot (USD) for Fuji oracle legs. Source: CoinGecko `avalanche-2` ~2026-06-01; refresh as needed. */
export const TESTNET_AVAX_USD = "8.81";

/** Avalanche Fuji chain id (source-side, paired with COTI testnet). */
export const AVALANCHE_FUJI_CHAIN_ID = 43113;

/** USD per 1 whole token (18 decimals), matching {PriceOracle.PRICE_SCALE}. */
export const usdPerWholeToken18 = (usdWholeToken: string): bigint => parseUnits(usdWholeToken, 18);

/** @deprecated Use {@link usdPerWholeToken18}. Kept for tests and scripts that still import the old name. */
export const usdPerTokenWeiX128 = (usdWholeToken: string): bigint => usdPerWholeToken18(usdWholeToken);

export type OracleUsdLegs = { localUsd18: bigint; remoteUsd18: bigint };

/** @deprecated Use {@link oracleUsdPricesForChain} */
export type OracleLegs = OracleUsdLegs;

/**
 * Local = this chain's native token; remote = the paired chain's native token.
 * Sepolia / local Hardhat: local ETH, remote COTI. COTI testnet: local COTI, remote ETH.
 */
export const oracleUsdPricesForChain = (chainId: number): OracleUsdLegs => {
  const eth = usdPerWholeToken18(TESTNET_ETH_USD);
  const coti = usdPerWholeToken18(TESTNET_COTI_USD);
  const avax = usdPerWholeToken18(TESTNET_AVAX_USD);
  const cotiTestnetId = Number(process.env.COTI_TESTNET_CHAIN_ID || "7082400");
  if (chainId === 11155111 || chainId === 31337) {
    return { localUsd18: eth, remoteUsd18: coti };
  }
  if (chainId === AVALANCHE_FUJI_CHAIN_ID) {
    return { localUsd18: avax, remoteUsd18: coti };
  }
  if (chainId === cotiTestnetId) {
    return { localUsd18: coti, remoteUsd18: eth };
  }
  throw new Error(
    `Unsupported chainId ${chainId} for testnet oracle legs. ` +
      `Use Sepolia (11155111), Avalanche Fuji (${AVALANCHE_FUJI_CHAIN_ID}), ` +
      `COTI testnet (${cotiTestnetId}), or local (31337), ` +
      `or set COTI_TESTNET_CHAIN_ID to match this network.`
  );
};

/** @deprecated Use {@link oracleUsdPricesForChain} */
export const oracleLegsForChain = (chainId: number): OracleUsdLegs => oracleUsdPricesForChain(chainId);

/** Chainlink Data Feed addresses (verify at https://docs.chain.link/data-feeds/price-feeds/addresses). */
export const CHAINLINK_FEEDS = {
  /** Sepolia ETH/USD */
  sepoliaEthUsd: "0x694AA1769357215DE4FAC081bf1f309aDC325306" as const,
  /** Ethereum mainnet ETH/USD */
  mainnetEthUsd: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const,
  /** Avalanche Fuji AVAX/USD (Chainlink EACAggregatorProxy). */
  fujiAvaxUsd: "0x5498BB86BC934c8D34FDA08E81D444153d0D06aD" as const,
  /** Avalanche mainnet AVAX/USD */
  mainnetAvaxUsd: "0x0A77230d17318075983913bC2145DB16C7366156" as const,
} as const;

export type ChainlinkFeedConfig = {
  localFeed: `0x${string}`;
  remoteFeed: `0x${string}`;
  /** Which leg uses manual admin price (COTI — no Chainlink feed). */
  manualLeg: "local" | "remote" | "both";
  maxStalenessSeconds: bigint;
  fetchIntervalSeconds: bigint;
};

/**
 * Chainlink feed wiring per chain. Zero feed = manual-only leg (COTI or cross-chain ETH on COTI).
 * Local = this chain native; remote = paired chain native.
 */
export const chainlinkFeedsForChain = (chainId: number): ChainlinkFeedConfig => {
  const cotiTestnetId = Number(process.env.COTI_TESTNET_CHAIN_ID || "7082400");
  const testnetStaleness = 86_400n;
  const mainnetStaleness = 3_600n;
  const fetchInterval = 300n;

  if (chainId === 31337) {
    // Local Hardhat has no Sepolia Chainlink bytecode — both legs must be manual.
    return {
      localFeed: zeroAddress,
      remoteFeed: zeroAddress,
      manualLeg: "both",
      maxStalenessSeconds: testnetStaleness,
      fetchIntervalSeconds: fetchInterval,
    };
  }
  if (chainId === 11155111) {
    return {
      localFeed: CHAINLINK_FEEDS.sepoliaEthUsd,
      remoteFeed: zeroAddress,
      manualLeg: "remote",
      maxStalenessSeconds: testnetStaleness,
      fetchIntervalSeconds: fetchInterval,
    };
  }
  if (chainId === AVALANCHE_FUJI_CHAIN_ID) {
    return {
      localFeed: CHAINLINK_FEEDS.fujiAvaxUsd,
      remoteFeed: zeroAddress,
      manualLeg: "remote",
      maxStalenessSeconds: testnetStaleness,
      fetchIntervalSeconds: fetchInterval,
    };
  }
  if (chainId === cotiTestnetId) {
    return {
      localFeed: zeroAddress,
      remoteFeed: zeroAddress,
      manualLeg: "both",
      maxStalenessSeconds: testnetStaleness,
      fetchIntervalSeconds: fetchInterval,
    };
  }
  if (chainId === 1) {
    return {
      localFeed: CHAINLINK_FEEDS.mainnetEthUsd,
      remoteFeed: zeroAddress,
      manualLeg: "remote",
      maxStalenessSeconds: mainnetStaleness,
      fetchIntervalSeconds: fetchInterval,
    };
  }
  if (chainId === 43_114) {
    return {
      localFeed: CHAINLINK_FEEDS.mainnetAvaxUsd,
      remoteFeed: zeroAddress,
      manualLeg: "remote",
      maxStalenessSeconds: mainnetStaleness,
      fetchIntervalSeconds: fetchInterval,
    };
  }
  throw new Error(
    `Unsupported chainId ${chainId} for Chainlink feeds. ` +
      `Use Sepolia (11155111), Fuji (${AVALANCHE_FUJI_CHAIN_ID}), COTI testnet (${cotiTestnetId}), ` +
      `Ethereum (1), Avalanche (43114), or local (31337).`
  );
};

/**
 * Sepolia-side fee template (variable minimum): `constantFee == 0` and all template fields non-zero.
 * Used as **local** on Sepolia and as **remote** on COTI when paired with {@link FEE_CONFIG_COTI_SIDE}.
 */
export const FEE_CONFIG_SEPOLIA_SIDE = {
  constantFee: 0n,
  gasPerByte: 10n,
  callbackExecutionGas: 100_000n,
  errorLength: 300n,
  bufferRatioX10000: 5000n,
} as const;

/**
 * COTI-side fee template (constant minimum gas units): `constantFee > 0` and other fields zero.
 * Used as **remote** on Sepolia and as **local** on COTI when paired with {@link FEE_CONFIG_SEPOLIA_SIDE}.
 */
export const FEE_CONFIG_COTI_SIDE = {
  constantFee: 12_000_000n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

export type FeeConfigTuple = {
  constantFee: bigint;
  gasPerByte: bigint;
  callbackExecutionGas: bigint;
  errorLength: bigint;
  bufferRatioX10000: bigint;
};

/** Convert a deployConfig.json fee template into an on-chain `FeeConfig` tuple. */
export const feeConfigTupleFromJson = (j: FeeConfigJson): FeeConfigTuple => ({
  constantFee: BigInt(j.constantFee),
  gasPerByte: BigInt(j.gasPerByte),
  callbackExecutionGas: BigInt(j.callbackExecutionGas),
  errorLength: BigInt(j.errorLength),
  bufferRatioX10000: BigInt(j.bufferRatioX10000),
});

/** Convert an on-chain `FeeConfig` tuple into a JSON-safe deployConfig.json template. */
export const feeConfigTupleToJson = (t: FeeConfigTuple): FeeConfigJson => ({
  constantFee: t.constantFee.toString(),
  gasPerByte: t.gasPerByte.toString(),
  callbackExecutionGas: t.callbackExecutionGas.toString(),
  errorLength: t.errorLength.toString(),
  bufferRatioX10000: t.bufferRatioX10000.toString(),
});

/**
 * Minimum fee templates for this inbox: **local** = this chain's native leg, **remote** = the paired chain's leg.
 * Sepolia: local ETH (variable), remote COTI (constant). COTI: local COTI (constant), remote ETH (variable).
 */
export const testnetMinFeeConfigsForChain = (chainId: number): { local: FeeConfigTuple; remote: FeeConfigTuple } => {
  const cotiTestnetId = Number(process.env.COTI_TESTNET_CHAIN_ID || "7082400");
  if (chainId === 11155111 || chainId === 31337 || chainId === AVALANCHE_FUJI_CHAIN_ID) {
    return { local: { ...FEE_CONFIG_SEPOLIA_SIDE }, remote: { ...FEE_CONFIG_COTI_SIDE } };
  }
  if (chainId === cotiTestnetId) {
    return { local: { ...FEE_CONFIG_COTI_SIDE }, remote: { ...FEE_CONFIG_SEPOLIA_SIDE } };
  }
  throw new Error(
    `Unsupported chainId ${chainId} for testnet fee configs. ` +
      `Use Sepolia (11155111), Avalanche Fuji (${AVALANCHE_FUJI_CHAIN_ID}), ` +
      `COTI testnet (${cotiTestnetId}), or local (31337), ` +
      `or set COTI_TESTNET_CHAIN_ID to match this network.`
  );
};

/**
 * Min-fee templates for `chainId`, sourced from `deployConfig.json` `chains[id].feeConfig`
 * when present, otherwise the built-in {@link testnetMinFeeConfigsForChain} defaults.
 * This makes `deployConfig.json` the single source of truth for deployed fee parameters.
 */
export const readFeeConfigForChain = async (
  chainId: number
): Promise<{ local: FeeConfigTuple; remote: FeeConfigTuple }> => {
  try {
    const cfg = await readDeployConfig();
    const fc = cfg.chains?.[String(chainId)]?.feeConfig;
    if (fc?.local && fc?.remote) {
      return { local: feeConfigTupleFromJson(fc.local), remote: feeConfigTupleFromJson(fc.remote) };
    }
  } catch {
    // Missing/unreadable config — fall back to built-in defaults below.
  }
  return testnetMinFeeConfigsForChain(chainId);
};

/** True for Sepolia, Avalanche Fuji, local Hardhat, or COTI testnet (same IDs as {@link testnetMinFeeConfigsForChain}). */
export const isTestnetSepoliaCotiPairChain = (chainId: number): boolean => {
  const cotiTestnetId = Number(process.env.COTI_TESTNET_CHAIN_ID || "7082400");
  return (
    chainId === 11155111 ||
    chainId === 31337 ||
    chainId === AVALANCHE_FUJI_CHAIN_ID ||
    chainId === cotiTestnetId
  );
};

/** Address that will sign txs for this wallet (must match constructor `initialOwner` for oracle admin calls). */
export const resolveDeployerAddress = async (walletClient: WalletClient): Promise<`0x${string}`> => {
  const fromAccount = walletClient.account?.address;
  if (fromAccount) {
    return fromAccount;
  }
  const addresses = await walletClient.getAddresses();
  const first = addresses[0];
  if (!first) {
    throw new Error("resolveDeployerAddress: wallet has no accounts");
  }
  return first;
};

/** Pick the wallet account that matches `required` (mother owner, factory owner, etc.). */
export const resolveWalletAccount = async (
  walletClient: WalletClient,
  required: `0x${string}`
): Promise<`0x${string}`> => {
  if (walletClient.account?.address?.toLowerCase() === required.toLowerCase()) {
    return walletClient.account.address;
  }
  const addresses = await walletClient.getAddresses();
  const match = addresses.find((a) => a.toLowerCase() === required.toLowerCase());
  if (match) return match;
  throw new Error(
    `Wallet has no private key for ${required}. ` +
      `Set COTI_TESTNET_PRIVATE_KEY (or PRIVATE_KEY) to the contract owner's key.`
  );
};

type DeployOracleParams = {
  viem: any;
  publicClient: unknown;
  walletClient: WalletClient;
  chainId: number;
};

/**
 * Deploys `PriceOracle` and sets local/remote 18‑decimal USD prices from {@link oracleUsdPricesForChain}
 * (ETH/COTI spot from {@link TESTNET_ETH_USD} / {@link TESTNET_COTI_USD}). Does not touch an inbox.
 */
export const deployTestnetPriceOracle = async (params: DeployOracleParams) => {
  const { viem, publicClient, walletClient, chainId } = params;
  const deployer = await resolveDeployerAddress(walletClient);
  const writeOpts = { account: deployer, gas: COTI_ADMIN_WRITE_GAS };
  const { localUsd18, remoteUsd18 } = oracleUsdPricesForChain(chainId);

  const oracle = await viem.deployContract("PriceOracle", [deployer], {
    client: { public: publicClient, wallet: walletClient },
    account: deployer,
  });

  const { localToken, remoteToken } = oracleTokensForChain(chainId);
  const h0 = await oracle.write.setInboxTokens([localToken, remoteToken], writeOpts);
  await waitMined(publicClient, h0);

  const h1 = await oracle.write.setLocalTokenPriceUSD([localUsd18], writeOpts);
  await waitMined(publicClient, h1);
  const h2 = await oracle.write.setRemoteTokenPriceUSD([remoteUsd18], writeOpts);
  await waitMined(publicClient, h2);

  let localStored = await oracle.read.getLocalTokenPriceUSD();
  let remoteStored = await oracle.read.getRemoteTokenPriceUSD();
  if (localStored === 0n) {
    const h = await oracle.write.setLocalTokenPriceUSD([localUsd18], writeOpts);
    await waitMined(publicClient, h);
    localStored = await oracle.read.getLocalTokenPriceUSD();
  }
  if (remoteStored === 0n) {
    const h = await oracle.write.setRemoteTokenPriceUSD([remoteUsd18], writeOpts);
    await waitMined(publicClient, h);
    remoteStored = await oracle.read.getRemoteTokenPriceUSD();
  }
  if (localStored === 0n || remoteStored === 0n) {
    throw new Error(
      `PriceOracle legs not persisted (local=${localStored} remote=${remoteStored} chainId=${chainId})`
    );
  }

  return oracle as { address: `0x${string}`; read: { getPricesUSD: () => Promise<readonly [bigint, bigint]> } };
};

type ChainlinkOracleContract = {
  address: `0x${string}`;
  read: { getPricesUSD: () => Promise<readonly [bigint, bigint]> };
  write: {
    setInboxTokens: (
      args: [`0x${string}`, `0x${string}`],
      options?: { account: `0x${string}`; gas?: bigint }
    ) => Promise<`0x${string}`>;
    setLocalTokenPriceUSD: (args: [bigint], options?: { account: `0x${string}`; gas?: bigint }) => Promise<`0x${string}`>;
    setRemoteTokenPriceUSD: (args: [bigint], options?: { account: `0x${string}`; gas?: bigint }) => Promise<`0x${string}`>;
    refreshCache: (args: [], options?: { account: `0x${string}` }) => Promise<`0x${string}`>;
    setTokenPriceUSD: (
      args: [`0x${string}`, bigint],
      options?: { account: `0x${string}`; gas?: bigint }
    ) => Promise<`0x${string}`>;
  };
};

/**
 * Deploys {ChainlinkLiveOracle} + {PoDPriceOracle}, seeds feeds and manual legs.
 */
export const deployChainlinkPriceOracle = async (params: DeployOracleParams): Promise<ChainlinkOracleContract> => {
  const { viem, publicClient, walletClient, chainId } = params;
  const deployer = await resolveDeployerAddress(walletClient);
  const writeOpts = { account: deployer, gas: COTI_ADMIN_WRITE_GAS };
  const feeds = chainlinkFeedsForChain(chainId);
  const { localUsd18, remoteUsd18 } = oracleUsdPricesForChain(chainId);

  const { localToken, remoteToken, portalNative: _portalNative } = oracleTokensForChain(chainId);

  const liveAdapter = await viem.deployContract(
    "ChainlinkLiveOracle",
    [deployer, feeds.maxStalenessSeconds],
    { client: { public: publicClient, wallet: walletClient }, account: deployer }
  );
  if (feeds.localFeed !== zeroAddress) {
    const h = await liveAdapter.write.setFeed([localToken, feeds.localFeed], writeOpts);
    await waitMined(publicClient, h);
  }
  if (feeds.remoteFeed !== zeroAddress) {
    const h = await liveAdapter.write.setFeed([remoteToken, feeds.remoteFeed], writeOpts);
    await waitMined(publicClient, h);
  }

  const oracle = (await viem.deployContract(
    "PoDPriceOracle",
    [deployer, liveAdapter.address, feeds.fetchIntervalSeconds],
    { client: { public: publicClient, wallet: walletClient }, account: deployer }
  )) as ChainlinkOracleContract;

  {
    const h = await oracle.write.setInboxTokens([localToken, remoteToken], writeOpts);
    await waitMined(publicClient, h);
  }

  if (feeds.manualLeg === "local" || feeds.manualLeg === "both") {
    const h = await oracle.write.setLocalTokenPriceUSD([localUsd18], writeOpts);
    await waitMined(publicClient, h);
  }
  if (feeds.manualLeg === "remote" || feeds.manualLeg === "both") {
    const h = await oracle.write.setRemoteTokenPriceUSD([remoteUsd18], writeOpts);
    await waitMined(publicClient, h);
  }

  if (feeds.localFeed !== zeroAddress || feeds.remoteFeed !== zeroAddress) {
    const h = await oracle.write.refreshCache([], writeOpts);
    await waitMined(publicClient, h);
  }

  const [localStored, remoteStored] = await oracle.read.getPricesUSD();
  if (localStored === 0n || remoteStored === 0n) {
    throw new Error(
      `PoDPriceOracle legs not seeded (local=${localStored} remote=${remoteStored} chainId=${chainId})`
    );
  }

  const usdc = await seedUsdcManualPeg({ oracle, chainId, publicClient, writeOpts });
  if (usdc) {
    console.log(`[deployChainlinkPriceOracle] USDC manual $1 peg set for ${usdc}`);
  }

  return oracle;
};

/** Set manual $1 USD peg for canonical USDC on this chain (no Chainlink USDC/USD feed). */
export const seedUsdcManualPeg = async (params: {
  oracle: ChainlinkOracleContract;
  chainId: number;
  publicClient: unknown;
  writeOpts: { account: `0x${string}`; gas?: bigint };
}): Promise<`0x${string}` | undefined> => {
  const usdc = usdcUnderlyingForChain(params.chainId);
  if (!usdc) {
    return undefined;
  }
  const hash = await params.oracle.write.setTokenPriceUSD([usdc, MANUAL_USD_PEG_18], params.writeOpts);
  await waitMined(params.publicClient, hash);
  return usdc;
};

/**
 * Sets {@link InboxMiner.updateMinFeeConfigs} for the Sepolia↔COTI testnet pair (local = this chain, remote = paired chain).
 * Fee values come from `deployConfig.json` via {@link readFeeConfigForChain} (built-in defaults if unset).
 */
export const configureTestnetInboxMinFees = async (params: {
  inbox: {
    write: {
      updateMinFeeConfigs: (args: [FeeConfigTuple, FeeConfigTuple], options?: { account: `0x${string}` }) => Promise<`0x${string}`>;
    };
  };
  publicClient: unknown;
  walletClient: WalletClient;
  chainId: number;
}) => {
  const { local, remote } = await readFeeConfigForChain(params.chainId);
  const deployer = await resolveDeployerAddress(params.walletClient);
  const writeOpts = { account: deployer } as const;
  const hash = await params.inbox.write.updateMinFeeConfigs([local, remote], writeOpts);
  await waitMined(params.publicClient, hash);
};

/**
 * Deploys plain `PriceOracle`, seeds ETH/COTI legs from {@link oracleUsdPricesForChain}, and points the inbox at it.
 * Uses the same signer address for deploy and writes so `priceAdmin` (set in constructor) matches `msg.sender`.
 */
export const deployAndWireTestnetPriceOracle = async (
  params: DeployOracleParams & {
    inbox: {
      address: `0x${string}`;
      write: { setPriceOracle: (args: [`0x${string}`], options?: { account?: `0x${string}` }) => Promise<unknown> };
    };
  }
) => {
  const { walletClient, inbox } = params;
  const deployer = await resolveDeployerAddress(walletClient);
  const writeOpts = { account: deployer } as const;
  const oracle = await deployTestnetPriceOracle(params);
  const h = (await inbox.write.setPriceOracle([oracle.address], writeOpts)) as `0x${string}`;
  await waitMined(params.publicClient, h);
  return oracle;
};

/** Load the compiled `Inbox` artifact (abi + constructor-arg-free creation bytecode) from disk. */
export const readInboxArtifact = async (): Promise<InboxArtifact> => {
  const artifactPath = path.resolve(process.cwd(), "artifacts/contracts/Inbox.sol/Inbox.json");
  const raw = await fs.readFile(artifactPath, "utf8");
  const json = JSON.parse(raw) as { abi: InboxArtifact["abi"]; bytecode?: string };
  if (!json.bytecode || !json.bytecode.startsWith("0x")) {
    throw new Error("readInboxArtifact: missing/invalid bytecode (run `npx hardhat compile` first)");
  }
  return { abi: json.abi, bytecode: json.bytecode as `0x${string}` };
};

/**
 * Deploy the Inbox deterministically via CreateX `deployCreate3AndInit` (same address on every
 * chain) and return a viem contract instance bound to the deterministic address. `init` runs
 * atomically with `chainId = block.chainid` and `owner = deployer`. Idempotent: if code already
 * exists at the precomputed address, no transaction is sent.
 */
export const deployDeterministicInbox = async (params: {
  viem: {
    getContractAt: (
      name: string,
      address: `0x${string}`,
      opts: { client: { public: unknown; wallet: unknown } }
    ) => Promise<any>;
  };
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Salt label driving the deterministic address family; defaults to the createx constant. */
  saltLabel?: string;
}): Promise<DeployInboxDeterministicResult & { inbox: any; deployer: `0x${string}` }> => {
  const deployer = await resolveDeployerAddress(params.walletClient);
  const artifact = await readInboxArtifact();
  const result = await deployInboxViaCreateX({
    publicClient: params.publicClient,
    walletClient: params.walletClient,
    deployer,
    chainId: 0n,
    artifact,
    saltLabel: params.saltLabel,
  });
  const inbox = await params.viem.getContractAt("Inbox", result.address, {
    client: { public: params.publicClient, wallet: params.walletClient },
  });
  return { ...result, inbox, deployer };
};

/** Register `miner` on the inbox only if not already registered (idempotent; avoids reverts/wasted gas). */
export const ensureMinerRegistered = async (params: {
  inbox: {
    read: { isMiner: (args: [`0x${string}`]) => Promise<boolean> };
    write: { addMiner: (args: [`0x${string}`], opts?: { account: `0x${string}` }) => Promise<`0x${string}`> };
  };
  miner: `0x${string}`;
  publicClient: unknown;
  walletClient: WalletClient;
}): Promise<boolean> => {
  if (await params.inbox.read.isMiner([params.miner])) {
    return false;
  }
  const deployer = await resolveDeployerAddress(params.walletClient);
  const hash = await params.inbox.write.addMiner([params.miner], { account: deployer });
  await waitMined(params.publicClient, hash);
  return true;
};

export const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const optionalEnv = (key: string): string | undefined => process.env[key];

export const asAddress = (value: string, key: string): `0x${string}` => {
  if (!value.startsWith("0x") || value.length !== 42) {
    throw new Error(`Invalid ${key} address: ${value}`);
  }
  return value as `0x${string}`;
};

export const appendDeploymentLog = async (entry: DeploymentLogEntry) => {
  const payload = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  await fs.appendFile(logPath, `${JSON.stringify(payload)}\n`, "utf8");
};

export const readDeployConfig = async (): Promise<DeployConfig> => {
  const raw = await fs.readFile(deployConfigPath, "utf8");
  return JSON.parse(raw) as DeployConfig;
};

export const getChainConfig = (config: DeployConfig, chainId: number, label: string) => {
  const chainConfig = config.chains?.[String(chainId)];
  if (!chainConfig) {
    throw new Error(`Missing deploy config for chainId ${chainId} (${label}).`);
  }
  return chainConfig;
};

const resolveRpcUrl = (chainId: number) => {
  if (chainId === 7082400 && process.env.COTI_TESTNET_RPC_URL) {
    return process.env.COTI_TESTNET_RPC_URL;
  }
  if (chainId === 11155111 && process.env.SEPOLIA_RPC_URL) {
    return process.env.SEPOLIA_RPC_URL;
  }
  if (chainId === AVALANCHE_FUJI_CHAIN_ID) {
    return process.env.AVALANCHE_FUJI_RPC_URL ?? "https://avalanche-fuji-c-chain-rpc.publicnode.com";
  }
  if (process.env.RPC_URL) {
    return process.env.RPC_URL;
  }
  return "http://127.0.0.1:8545";
};

/** Read-only client for a chain other than the one currently connected in deploy-cli. */
export const createPublicClientForChain = (chainId: number): PublicClient => {
  const rpcUrl = resolveRpcUrl(chainId);
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
  });
  return createPublicClient({ chain, transport: http(rpcUrl) });
};

export const getViemClients = async (
  viem: {
    getPublicClient: (config?: { chain?: any }) => Promise<any>;
    getWalletClients: (config?: { chain?: any }) => Promise<any[]>;
  },
  provider: { request: (args: { method: string }) => Promise<unknown> },
  networkName?: string
) => {
  const chainId = Number(await provider.request({ method: "eth_chainId" }));
  const rpcUrl = resolveRpcUrl(chainId);
  const chain = defineChain({
    id: chainId,
    name: networkName ?? `chain-${chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
  });

  const publicClient = await viem.getPublicClient({ chain });
  const [walletClient] = await viem.getWalletClients({ chain });

  return { chainId, chainName: chain.name, publicClient, walletClient };
};
