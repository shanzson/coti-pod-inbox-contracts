/**
 * Deploy Inbox + {MpcAbiReEncode} + {FeeManager} for Hardhat / EDR unit tests (no CreateX).
 * Not a solc "library link" — helpers are normal CREATE contracts passed into Inbox.init.
 */

type DeployOpts = Record<string, unknown> & {
  client?: {
    public?: unknown;
    wallet?: { account?: { address: `0x${string}` } };
  };
};

type ViemLike = {
  deployContract: (name: string, args: unknown[], opts?: DeployOpts) => Promise<any>;
};

type HelperBag = { mpcAbiReEncode: `0x${string}`; feeManager: `0x${string}` };

const helpersByKey = new WeakMap<object, Promise<HelperBag>>();

/** Deploy (or reuse) {MpcAbiReEncode} + {FeeManager}, then deploy Inbox. */
export const deployTestInbox = async (
  viem: ViemLike,
  opts?: DeployOpts
): Promise<any & HelperBag> => {
  const walletKey = (opts?.client?.wallet ?? viem) as object;
  let helpersPromise = helpersByKey.get(walletKey);
  if (!helpersPromise) {
    helpersPromise = (async () => {
      const [codec, fee] = await Promise.all([
        viem.deployContract("MpcAbiReEncode", [], opts),
        viem.deployContract("FeeManager", [], opts),
      ]);
      return {
        mpcAbiReEncode: codec.address as `0x${string}`,
        feeManager: fee.address as `0x${string}`,
      };
    })();
    helpersByKey.set(walletKey, helpersPromise);
  }
  const helpers = await helpersPromise;
  const inbox = await viem.deployContract("Inbox", [], opts);
  Object.defineProperty(inbox, "mpcAbiReEncode", {
    value: helpers.mpcAbiReEncode,
    enumerable: true,
  });
  Object.defineProperty(inbox, "feeManager", {
    value: helpers.feeManager,
    enumerable: true,
  });
  return inbox as any;
};

/** Address of the shared test {MpcAbiReEncode} for a prior {deployTestInbox} call. */
export const mpcAbiReEncodeOf = (inbox: { mpcAbiReEncode?: `0x${string}` }): `0x${string}` => {
  const addr = inbox.mpcAbiReEncode;
  if (!addr) throw new Error("mpcAbiReEncodeOf: missing address (deploy via deployTestInbox)");
  return addr;
};

/** Address of the shared test {FeeManager} for a prior {deployTestInbox} call. */
export const feeManagerOf = (inbox: { feeManager?: `0x${string}` }): `0x${string}` => {
  const addr = inbox.feeManager;
  if (!addr) throw new Error("feeManagerOf: missing address (deploy via deployTestInbox)");
  return addr;
};

/** Convenience: `[owner, chainId, mpcAbiReEncode, feeManager]` for Inbox.init. */
export const inboxInitArgs = (
  inbox: { mpcAbiReEncode?: `0x${string}`; feeManager?: `0x${string}` },
  owner: `0x${string}`,
  chainId: bigint
): [`0x${string}`, bigint, `0x${string}`, `0x${string}`] => [
  owner,
  chainId,
  mpcAbiReEncodeOf(inbox),
  feeManagerOf(inbox),
];
