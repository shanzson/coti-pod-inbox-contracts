import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

/**
 * Canonical CreateX factory, deployed at the same address on every supported chain
 * (verified present on Sepolia, COTI testnet, and Avalanche Fuji).
 * See https://github.com/pcaversaccio/createx.
 */
export const CREATEX_ADDRESS = getAddress("0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed");


/** Minimal CreateX ABI: CREATE3 deploy (+ optional init) plus the address precompute view. */
export const CREATEX_ABI = [
  {
    type: "function",
    name: "deployCreate3",
    stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "initCode", type: "bytes" },
    ],
    outputs: [{ name: "newContract", type: "address" }],
  },
  {
    type: "function",
    name: "deployCreate3AndInit",
    stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "initCode", type: "bytes" },
      { name: "data", type: "bytes" },
      {
        name: "values",
        type: "tuple",
        components: [
          { name: "constructorAmount", type: "uint256" },
          { name: "initCallAmount", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "newContract", type: "address" }],
  },
  {
    type: "function",
    name: "computeCreate3Address",
    stateMutability: "pure",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "deployer", type: "address" },
    ],
    outputs: [{ name: "computedAddress", type: "address" }],
  },
] as const satisfies Abi;

/**
 * Build the raw 32-byte CreateX salt: `deployer(20) || 0x00 (no cross-chain protection) || entropy(11)`.
 *
 * - First 20 bytes = deployer address => CreateX "permissioned deploy protection" (only this
 *   deployer can use the salt, prevents front-running the address on a fresh chain).
 * - 21st byte = 0x00 => cross-chain redeploy protection DISABLED, so `block.chainid` is NOT mixed
 *   into the guarded salt and the resulting address is identical on every chain.
 * - Last 11 bytes = deterministic entropy derived from the caller-supplied salt `label`
 *   (SoT: `deployConfig.*.yaml` `inboxSalt.label` / `mpcAbiCodecSalt.label` — never hardcode here).
 */
export const buildInboxSalt = (deployer: Address, label: string): Hex => {
  if (!label.trim()) {
    throw new Error("buildInboxSalt: salt label required (from deployConfig, not a code constant)");
  }
  const labelHash = keccak256(toHex(label));
  // First 11 bytes (22 hex chars) of the label hash as entropy.
  const entropy = (`0x${labelHash.slice(2, 2 + 22)}`) as Hex;
  const salt = concatHex([getAddress(deployer), "0x00", entropy]) as Hex;
  if (salt.length !== 66) {
    throw new Error(`buildInboxSalt: expected 32-byte salt, got ${(salt.length - 2) / 2} bytes`);
  }
  return salt;
};

/**
 * Replicate CreateX `_guard` for the permissioned, no-cross-chain-protection case:
 * `guardedSalt = keccak256(abi.encode(deployer, salt))`. This is what CreateX actually uses as
 * the CREATE3 salt, and it is independent of `block.chainid`.
 */
export const computeGuardedSalt = (deployer: Address, salt: Hex): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [getAddress(deployer), salt]
    )
  );

/** Precompute the deterministic Inbox address via a read-only `eth_call` (no transaction). */
export const precomputeCreate3Address = async (
  publicClient: PublicClient,
  deployer: Address,
  salt: Hex
): Promise<Address> => {
  const guardedSalt = computeGuardedSalt(deployer, salt);
  const computed = await publicClient.readContract({
    address: CREATEX_ADDRESS,
    abi: CREATEX_ABI,
    functionName: "computeCreate3Address",
    args: [guardedSalt, CREATEX_ADDRESS],
  });
  return getAddress(computed);
};

/** True if `address` already has deployed bytecode (read-only). */
export const isContractDeployed = async (
  publicClient: PublicClient,
  address: Address
): Promise<boolean> => {
  const code = await publicClient.getCode({ address });
  return Boolean(code && code !== "0x");
};

/** True if CreateX itself is deployed on the connected chain (read-only). */
export const isCreateXAvailable = async (publicClient: PublicClient): Promise<boolean> =>
  isContractDeployed(publicClient, CREATEX_ADDRESS);

export type InboxArtifact = { abi: Abi; bytecode: Hex };

export type DeployInboxDeterministicParams = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  deployer: Address;
  /** Inbox chain id to store; pass `0n` to let the contract use `block.chainid`. */
  chainId: bigint;
  /** Inbox compiled artifact ({ abi, bytecode }). Bytecode must be constructor-arg-free. */
  artifact: InboxArtifact;
  /** Salt label from deployConfig (`inboxSalt.label`). Required — no code default. */
  saltLabel: string;
  /**
   * {MpcAbiReEncode} address for Inbox.init (COTI). Pass zero address on non-MPC chains.
   * Defaults to zero address when omitted.
   */
  mpcAbiReEncode?: Address;
};

export type DeployInboxDeterministicResult = {
  address: Address;
  /** Predicted CREATE3 address (always set). */
  predictedAddress: Address;
  /** Tx hash when a deploy was sent; undefined when the address was already deployed. */
  txHash?: Hex;
  alreadyDeployed: boolean;
};

export type DeployCreate3Params = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  deployer: Address;
  /** Creation bytecode (no Solidity library placeholders). */
  bytecode: Hex;
  /** Salt label from deployConfig. Required — no code default. */
  saltLabel: string;
};

/**
 * Deterministically deploy arbitrary initCode via CreateX `deployCreate3` (no post-deploy init call).
 * Used for storage-free helpers such as {MpcAbiReEncode} that have no initializer.
 */
export const deployCreate3Deterministic = async (
  params: DeployCreate3Params
): Promise<DeployInboxDeterministicResult> => {
  const { publicClient, walletClient, deployer, bytecode, saltLabel } = params;

  if (!(await isCreateXAvailable(publicClient))) {
    throw new Error(
      `CreateX not found at ${CREATEX_ADDRESS} on this chain; cannot deploy deterministically.`
    );
  }

  const salt = buildInboxSalt(deployer, saltLabel);
  const predictedAddress = await precomputeCreate3Address(publicClient, deployer, salt);

  if (await isContractDeployed(publicClient, predictedAddress)) {
    return { address: predictedAddress, predictedAddress, alreadyDeployed: true };
  }

  const { request, result } = await publicClient.simulateContract({
    account: deployer,
    address: CREATEX_ADDRESS,
    abi: CREATEX_ABI,
    functionName: "deployCreate3",
    args: [salt, bytecode],
  });

  const simulated = getAddress(result as Address);
  if (simulated !== predictedAddress) {
    throw new Error(
      `CreateX address mismatch: precomputed ${predictedAddress} but simulation returned ${simulated}`
    );
  }

  const txHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 300_000, pollingInterval: 2_000 });

  return { address: predictedAddress, predictedAddress, txHash, alreadyDeployed: false };
};

/**
 * Deterministically deploy the Inbox via CreateX `deployCreate3AndInit`, calling
 * {Inbox.init}(deployer, chainId) atomically in the same transaction.
 *
 * Network discipline: precomputes the address and checks for existing code first; simulates the
 * deploy via `eth_call` before sending; sends exactly one transaction (or none if already deployed).
 *
 * Caller must pass fully linked Inbox bytecode (no unresolved library placeholders).
 */
export const deployInboxDeterministic = async (
  params: DeployInboxDeterministicParams
): Promise<DeployInboxDeterministicResult> => {
  const { publicClient, walletClient, deployer, chainId, artifact, saltLabel, mpcAbiReEncode } =
    params;

  if (!(await isCreateXAvailable(publicClient))) {
    throw new Error(
      `CreateX not found at ${CREATEX_ADDRESS} on this chain; cannot deploy deterministically.`
    );
  }

  if (artifact.bytecode.includes("_")) {
    throw new Error(
      "deployInboxDeterministic: Inbox bytecode still has library placeholders"
    );
  }

  const salt = buildInboxSalt(deployer, saltLabel);
  const predictedAddress = await precomputeCreate3Address(publicClient, deployer, salt);

  if (await isContractDeployed(publicClient, predictedAddress)) {
    return { address: predictedAddress, predictedAddress, alreadyDeployed: true };
  }

  const initData = encodeFunctionData({
    abi: artifact.abi,
    functionName: "init",
    args: [deployer, chainId, mpcAbiReEncode ?? ("0x0000000000000000000000000000000000000000" as Address)],
  });

  // Simulate first (read-only): catches reverts and confirms the returned address matches.
  const { request, result } = await publicClient.simulateContract({
    account: deployer,
    address: CREATEX_ADDRESS,
    abi: CREATEX_ABI,
    functionName: "deployCreate3AndInit",
    args: [salt, artifact.bytecode, initData, { constructorAmount: 0n, initCallAmount: 0n }],
  });

  const simulated = getAddress(result as Address);
  if (simulated !== predictedAddress) {
    throw new Error(
      `CreateX address mismatch: precomputed ${predictedAddress} but simulation returned ${simulated}`
    );
  }

  const txHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 300_000, pollingInterval: 2_000 });

  return { address: predictedAddress, predictedAddress, txHash, alreadyDeployed: false };
};
