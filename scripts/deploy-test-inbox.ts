/**
 * Deploy Inbox + {MpcAbiReEncode} for Hardhat / EDR unit tests (no CreateX).
 * Not a solc "library link" — re-encode is a normal CREATE contract passed into Inbox.init.
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

const codecByKey = new WeakMap<object, Promise<`0x${string}`>>();

/** Deploy (or reuse) {MpcAbiReEncode}, then deploy Inbox. */
export const deployTestInbox = async (
  viem: ViemLike,
  opts?: DeployOpts
): Promise<any & { mpcAbiReEncode: `0x${string}` }> => {
  const walletKey = (opts?.client?.wallet ?? viem) as object;
  let codecPromise = codecByKey.get(walletKey);
  if (!codecPromise) {
    codecPromise = (async () => {
      const codec = await viem.deployContract("MpcAbiReEncode", [], opts);
      return codec.address as `0x${string}`;
    })();
    codecByKey.set(walletKey, codecPromise);
  }
  const mpcAbiReEncode = await codecPromise;
  const inbox = await viem.deployContract("Inbox", [], opts);
  Object.defineProperty(inbox, "mpcAbiReEncode", {
    value: mpcAbiReEncode,
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
