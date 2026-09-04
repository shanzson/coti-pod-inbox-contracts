import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { toFunctionSelector } from "viem";

// Error selectors (viem often can't decode inherited custom-error NAMES through the
// harness ABI, but the raw 4-byte selector in the revert data is deterministic).
const SEL_ONLY_INBOX = toFunctionSelector("OnlyInbox(address)");
const SEL_NOT_REG = toFunctionSelector("TokenNotRegistered(bytes32)");

// Matcher: revert carries this error (by decoded name OR raw selector).
function isErr(sel: string, name: string) {
  return (e: unknown) => {
    const s = String(e).toLowerCase();
    return s.includes(name.toLowerCase()) || s.includes(sel.slice(2).toLowerCase());
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PoC: can an unauthorized actor (not the token owner) burn / transfer someone
// else's tokens via the REAL PodErc20CotiMother functions?
//
// The mother gates every state-changing entry point with onlyRegisteredPTokenMessage:
//   (1) msg.sender must be the configured inbox            -> else OnlyInbox(caller)
//   (2) inbox.inboxMsgSender() = (srcChainId, remotePToken) must be registered
//                                                          -> else TokenNotRegistered(id)
// `from` is a plain argument; the mother does NOT re-authenticate it — it trusts the
// registered source pToken (which sets from = msg.sender / enforces allowance/permit
// on the source chain). This PoC exercises the mother directly.
// ─────────────────────────────────────────────────────────────────────────────

const VICTIM   = "0x1111111111111111111111111111111111111111" as `0x${string}`; // arbitrary non-caller "from"
const PTOKEN   = "0x2222222222222222222222222222222222222222" as `0x${string}`; // a source-chain pToken
const FACTORY  = "0x3333333333333333333333333333333333333333" as `0x${string}`; // an allowlisted factory
const UNREG    = "0x4444444444444444444444444444444444444444" as `0x${string}`; // an UNregistered origin
const AMOUNT   = 100n;
const SRC_CHAIN = 1n;

describe("PodErc20CotiMother — unauthorized burn/transfer PoC", { concurrency: 1 }, async () => {
  const { viem, provider } = await network.connect({ network: "hardhat" });
  const client = await viem.getPublicClient();
  const wallets = await viem.getWalletClients();
  const owner = wallets[0].account.address as `0x${string}`;
  const attacker = wallets[1].account.address as `0x${string}`;
  const c = { public: client, wallet: wallets[0] };

  // Deploy the mock inbox and the REAL mother (owner = test wallet 0).
  const mock = await viem.deployContract("MockInboxForMother", [], { client: c });
  const mother = await viem.deployContract(
    "PodErc20CotiMotherHarness", // constructor-passthrough subclass of the unmodified mother
    [mock.address, owner],
    { client: c }
  );

  // Impersonate the inbox address so the mother's msg.sender == address(inbox).
  await provider.request({ method: "hardhat_impersonateAccount", params: [mock.address] });
  await provider.request({ method: "hardhat_setBalance", params: [mock.address, "0x3635c9adc5dea00000"] }); // 1000 ETH

  const asInbox = { account: mock.address };

  it("T1 — a random EOA (not the inbox) CANNOT call burnPublic: reverts OnlyInbox", async () => {
    await assert.rejects(
      mother.write.burnPublic([VICTIM, AMOUNT], { account: attacker }),
      isErr(SEL_ONLY_INBOX, "OnlyInbox"),
      "expected OnlyInbox revert for a non-inbox caller"
    );
  });

  it("T2 — a random EOA CANNOT call transferPublic: reverts OnlyInbox", async () => {
    await assert.rejects(
      mother.write.transferPublic([VICTIM, attacker, AMOUNT], { account: attacker }),
      isErr(SEL_ONLY_INBOX, "OnlyInbox"),
      "expected OnlyInbox revert for a non-inbox caller"
    );
  });

  it("T3 — an inbox message from an UNREGISTERED origin CANNOT burn: reverts TokenNotRegistered", async () => {
    await mock.write.setContext([SRC_CHAIN, UNREG], { account: owner });
    await assert.rejects(
      mother.write.burnPublic([VICTIM, AMOUNT], asInbox),
      isErr(SEL_NOT_REG, "TokenNotRegistered"),
      "expected TokenNotRegistered for an unregistered source origin"
    );
  });

  it("T4 — unregistered origin CANNOT transferFromAsSpender either: reverts TokenNotRegistered", async () => {
    await mock.write.setContext([SRC_CHAIN, UNREG], { account: owner });
    await assert.rejects(
      // spender, from, to, value(gtUint256 encoded as uint256)
      mother.write.transferFromAsSpender([attacker, VICTIM, attacker, 0n], asInbox),
      isErr(SEL_NOT_REG, "TokenNotRegistered"),
      "expected TokenNotRegistered for an unregistered source origin"
    );
  });

  it("T5 — trust boundary: once a pToken is REGISTERED, the mother stops gating on auth and moves to MPC (from is NOT re-checked)", async () => {
    // Register PTOKEN under (SRC_CHAIN) via an allowlisted factory message.
    await mother.write.setAllowedFactory([SRC_CHAIN, FACTORY, true], { account: owner });
    await mock.write.setContext([SRC_CHAIN, FACTORY], { account: owner });
    await mother.write.registerToken([PTOKEN, "Name", "SYM", 18], asInbox);

    // Sanity: BEFORE registration-context, the same burn is blocked by auth.
    await mock.write.setContext([SRC_CHAIN, UNREG], { account: owner });
    await assert.rejects(
      mother.write.burnPublic([VICTIM, AMOUNT], asInbox),
      isErr(SEL_NOT_REG, "TokenNotRegistered")
    );

    // Now present the message AS the registered pToken, burning VICTIM's tokens.
    await mock.write.setContext([SRC_CHAIN, PTOKEN], { account: owner });
    let err = "";
    try {
      await mother.write.burnPublic([VICTIM, AMOUNT], asInbox);
      err = "NO_REVERT";
    } catch (e) {
      err = String(e);
    }
    // It must NOT be blocked by authorization any more — it passed the modifier and
    // proceeded into the MPC layer (which reverts only because this local node has no
    // MPC precompile). This proves `from` (VICTIM) is never re-authenticated by the mother.
    const low = err.toLowerCase();
    assert.ok(err !== "NO_REVERT", "expected a revert at the MPC layer on a node without the precompile");
    assert.ok(!low.includes(SEL_ONLY_INBOX.slice(2)) && !low.includes("onlyinbox"), "must have passed the inbox check");
    assert.ok(!low.includes(SEL_NOT_REG.slice(2)) && !low.includes("tokennotregistered"), "must have passed the registration check (auth no longer blocks)");
    console.log("   T5 past-auth revert (MPC layer):", err.split("\n").find((l) => l.includes("reverted") || l.includes("revert"))?.trim().slice(0, 150) ?? err.split("\n")[0].slice(0, 150));
  });
});
