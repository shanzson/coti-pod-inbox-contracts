import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { toFunctionSelector } from "viem";

// Error selectors (viem often can't decode inherited custom-error NAMES through the
// harness ABI, but the raw 4-byte selector in the revert data is deterministic).
const SEL_ONLY_INBOX = toFunctionSelector("OnlyInbox(address)");
const SEL_NOT_REG = toFunctionSelector("TokenNotRegistered(bytes32)");
// Selectors added by the coverage-extension tests (T6+).
const SEL_FACTORY_NOT_ALLOWED = toFunctionSelector("FactoryNotAllowed(uint256,address)");
const SEL_OWNABLE_UNAUTH = toFunctionSelector("OwnableUnauthorizedAccount(address)");
const SEL_OWNER_MINT_UNSUPPORTED = toFunctionSelector("OwnerMintNotSupported()");

// Matcher: revert carries this error (by decoded name OR raw selector).
function isErr(sel: string, name: string) {
  return (e: unknown) => {
    const s = String(e).toLowerCase();
    return s.includes(name.toLowerCase()) || s.includes(sel.slice(2).toLowerCase());
  };
}

// Run a write and return the revert string (or "NO_REVERT" if it did not revert).
async function callErr(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "NO_REVERT";
  } catch (e) {
    return String(e);
  }
}

// Assert a call passed BOTH auth checks (inbox transport + registration) and only
// reverted deeper, at the MPC precompile layer (this local node has none). This is
// the documented signal that authorization was satisfied and the namespace resolved.
function assertPastAuth(err: string, label: string) {
  const low = err.toLowerCase();
  assert.ok(err !== "NO_REVERT", `${label}: expected a revert at the MPC layer on a node without the precompile`);
  assert.ok(
    !low.includes(SEL_ONLY_INBOX.slice(2).toLowerCase()) && !low.includes("onlyinbox"),
    `${label}: must have passed the inbox transport check`
  );
  assert.ok(
    !low.includes(SEL_NOT_REG.slice(2).toLowerCase()) && !low.includes("tokennotregistered"),
    `${label}: must have passed the registration check (auth no longer blocks)`
  );
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
// Cross-namespace fixtures (all-digit => no EIP-55 checksum ambiguity).
const TOKEN_A  = "0x5555555555555555555555555555555555555555" as `0x${string}`; // registered token A
const TOKEN_B  = "0x6666666666666666666666666666666666666666" as `0x${string}`; // registered token B
const TOKEN_C  = "0x7777777777777777777777777777777777777777" as `0x${string}`; // sibling of A on same chain, UNregistered
const RECIP    = "0x8888888888888888888888888888888888888888" as `0x${string}`; // arbitrary mint/approve target
const AMOUNT   = 100n;
const SRC_CHAIN = 1n;
const OTHER_CHAIN = 2n;

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

  // ───────────────────────────────────────────────────────────────────────────
  // COVERAGE EXTENSION (T6+): functions the original 3-entry-point PoC never touched.
  // ───────────────────────────────────────────────────────────────────────────

  // (e) onlyOwner admin functions — a non-owner must not configure the mother.
  it("T6 — non-owner CANNOT call setAllowedFactory: reverts OwnableUnauthorizedAccount", async () => {
    await assert.rejects(
      mother.write.setAllowedFactory([SRC_CHAIN, FACTORY, true], { account: attacker }),
      isErr(SEL_OWNABLE_UNAUTH, "OwnableUnauthorizedAccount"),
      "expected OwnableUnauthorizedAccount for a non-owner caller"
    );
  });

  it("T7 — non-owner CANNOT call configure (rotate inbox): reverts OwnableUnauthorizedAccount", async () => {
    await assert.rejects(
      mother.write.configure([attacker], { account: attacker }),
      isErr(SEL_OWNABLE_UNAUTH, "OwnableUnauthorizedAccount"),
      "expected OwnableUnauthorizedAccount for a non-owner caller"
    );
  });

  it("T8 — inherited Ownable admin (transferOwnership/renounceOwnership) is onlyOwner too", async () => {
    await assert.rejects(
      mother.write.transferOwnership([attacker], { account: attacker }),
      isErr(SEL_OWNABLE_UNAUTH, "OwnableUnauthorizedAccount"),
      "expected OwnableUnauthorizedAccount on transferOwnership by non-owner"
    );
    await assert.rejects(
      mother.write.renounceOwnership([], { account: attacker }),
      isErr(SEL_OWNABLE_UNAUTH, "OwnableUnauthorizedAccount"),
      "expected OwnableUnauthorizedAccount on renounceOwnership by non-owner"
    );
  });

  // (g) registerToken factory allowlist enforcement.
  it("T9 — registerToken from a NON-allowlisted factory reverts FactoryNotAllowed", async () => {
    // Message arrives via the inbox, but the authenticated origin is a factory that
    // the owner never allowlisted (UNREG). Modifier onlyRegisteredFactoryMessage must reject it.
    await mock.write.setContext([SRC_CHAIN, UNREG], { account: owner });
    await assert.rejects(
      mother.write.registerToken([TOKEN_A, "Name", "SYM", 18], asInbox),
      isErr(SEL_FACTORY_NOT_ALLOWED, "FactoryNotAllowed"),
      "expected FactoryNotAllowed for an un-allowlisted factory origin"
    );
  });

  it("T10 — registerToken from a NON-inbox caller reverts OnlyInbox", async () => {
    await assert.rejects(
      mother.write.registerToken([TOKEN_A, "Name", "SYM", 18], { account: attacker }),
      isErr(SEL_ONLY_INBOX, "OnlyInbox"),
      "expected OnlyInbox: registerToken must arrive through the inbox"
    );
  });

  it("T11 — factory allowlist is CHAIN-SCOPED: allowlisted on chain 1 does not authorize chain 2", async () => {
    await mother.write.setAllowedFactory([SRC_CHAIN, FACTORY, true], { account: owner });
    // Same factory address, but authenticated origin chain is OTHER_CHAIN (2), which was never allowlisted.
    await mock.write.setContext([OTHER_CHAIN, FACTORY], { account: owner });
    await assert.rejects(
      mother.write.registerToken([TOKEN_A, "Name", "SYM", 18], asInbox),
      isErr(SEL_FACTORY_NOT_ALLOWED, "FactoryNotAllowed"),
      "expected FactoryNotAllowed: allowlist key is (sourceChainId, factory)"
    );
  });

  // (a/b/c/d) spot-check: EVERY remaining state-changing entry point is gated by
  // onlyRegisteredPTokenMessage — an UNREGISTERED authenticated origin is rejected
  // with TokenNotRegistered before any state change. gtUint256 args are ABI-encoded
  // as uint256, so 0n is a valid placeholder for the garbled variants.
  it("T12 — unregistered origin is rejected on mint/mintPublic/approve/approvePublic/syncBalances and the garbled variants", async () => {
    await mock.write.setContext([SRC_CHAIN, UNREG], { account: owner });
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["mint(garbled)",            () => mother.write.mint([RECIP, 0n], asInbox)],
      ["mintPublic",               () => mother.write.mintPublic([RECIP, AMOUNT], asInbox)],
      ["approve(garbled)",         () => mother.write.approve([VICTIM, attacker, 0n], asInbox)],
      ["approvePublic",            () => mother.write.approvePublic([VICTIM, attacker, AMOUNT], asInbox)],
      ["syncBalances",             () => mother.write.syncBalances([[VICTIM]], asInbox)],
      ["transfer(garbled)",        () => mother.write.transfer([VICTIM, attacker, 0n], asInbox)],
      ["transferOwner(garbled)",   () => mother.write.transferOwner([VICTIM, attacker, 0n], asInbox)],
      ["transferOwnerPublic",      () => mother.write.transferOwnerPublic([VICTIM, attacker, AMOUNT], asInbox)],
      ["transferFromPublicAsSpender", () => mother.write.transferFromPublicAsSpender([attacker, VICTIM, attacker, AMOUNT], asInbox)],
      ["burn(garbled)",            () => mother.write.burn([VICTIM, 0n], asInbox)],
    ];
    for (const [label, fn] of cases) {
      await assert.rejects(fn, isErr(SEL_NOT_REG, "TokenNotRegistered"), `${label}: expected TokenNotRegistered for unregistered origin`);
    }
  });

  // (f) ownerMint is disabled on the unified mother — even the owner cannot use it.
  it("T13 — ownerMint is permanently disabled: reverts OwnerMintNotSupported (even for the owner)", async () => {
    await assert.rejects(
      mother.write.ownerMint([RECIP, AMOUNT], { account: owner }),
      isErr(SEL_OWNER_MINT_UNSUPPORTED, "OwnerMintNotSupported"),
      "expected OwnerMintNotSupported: minting is only via inbox from a registered pToken"
    );
    // ...and equally for a non-owner (it is `pure` + unconditional revert, no auth path).
    await assert.rejects(
      mother.write.ownerMint([RECIP, AMOUNT], { account: attacker }),
      isErr(SEL_OWNER_MINT_UNSUPPORTED, "OwnerMintNotSupported")
    );
  });

  // (h) CROSS-NAMESPACE ISOLATION — the most important property.
  // The namespace a message operates on is ALWAYS _activeTokenId() = _tokenId(inbox.inboxMsgSender()),
  // i.e. derived solely from the AUTHENTICATED origin. No state-changing entry point accepts a
  // tokenId / (chainId, token) / namespace argument — only account addresses WITHIN the namespace.
  it("T14 — a registered pToken can ONLY touch its own namespace; it cannot cross into a sibling's ledger", async () => {
    // Register A and B under the same chain via the allowlisted factory.
    await mother.write.setAllowedFactory([SRC_CHAIN, FACTORY, true], { account: owner });
    await mock.write.setContext([SRC_CHAIN, FACTORY], { account: owner });
    if (!(await mother.read.isRegistered([SRC_CHAIN, TOKEN_A]))) {
      await mother.write.registerToken([TOKEN_A, "A", "A", 18], asInbox);
    }
    if (!(await mother.read.isRegistered([SRC_CHAIN, TOKEN_B]))) {
      await mother.write.registerToken([TOKEN_B, "B", "B", 18], asInbox);
    }

    // Namespaces are distinct and B/C sit in different ledgers than A.
    const idA = await mother.read.tokenId([SRC_CHAIN, TOKEN_A]);
    const idB = await mother.read.tokenId([SRC_CHAIN, TOKEN_B]);
    assert.notEqual(idA, idB, "tokenId(A) must differ from tokenId(B)");
    assert.equal(await mother.read.isRegistered([SRC_CHAIN, TOKEN_A]), true);
    assert.equal(await mother.read.isRegistered([SRC_CHAIN, TOKEN_B]), true);
    assert.equal(await mother.read.isRegistered([SRC_CHAIN, TOKEN_C]), false, "sibling C must be unregistered");

    // SAME mother call, SAME arguments — the ONLY thing that changes is the AUTHENTICATED origin.
    // As registered A: passes auth, resolves to A's namespace, reverts only at the MPC layer.
    await mock.write.setContext([SRC_CHAIN, TOKEN_A], { account: owner });
    const asA = await callErr(() => mother.write.burnPublic([VICTIM, AMOUNT], asInbox));
    assertPastAuth(asA, "burnPublic as registered A");

    // As sibling C (same chain, unregistered): identical arguments are REJECTED with
    // TokenNotRegistered. Being a sibling of a registered token grants nothing; the namespace
    // key is the authenticated origin alone — A cannot present itself as C, and no argument
    // to any entry point can redirect A's write into B's or C's ledger.
    await mock.write.setContext([SRC_CHAIN, TOKEN_C], { account: owner });
    await assert.rejects(
      mother.write.burnPublic([VICTIM, AMOUNT], asInbox),
      isErr(SEL_NOT_REG, "TokenNotRegistered"),
      "sibling C must be rejected: namespace is bound to the authenticated origin"
    );

    // Structural proof (compile-time): enumerate the mother ABI and confirm NO state-changing
    // external function exposes a namespace selector (bytes32 id, or a (uint256,address) chain+token
    // pair) as a parameter. Every namespace is derived internally from _activeTokenId().
    const abi = (mother as unknown as { abi: any[] }).abi;
    const NAMESPACE_FNS = new Set([
      "syncBalances", "transfer", "transferPublic", "transferOwner", "transferOwnerPublic",
      "transferFromAsSpender", "transferFromPublicAsSpender", "approve", "approvePublic",
      "burn", "burnPublic", "mint", "mintPublic",
    ]);
    for (const item of abi) {
      if (item.type !== "function" || !NAMESPACE_FNS.has(item.name)) continue;
      const inputs = (item.inputs ?? []) as Array<{ type: string; name: string }>;
      // No bytes32 (a raw tokenId) is ever accepted from the caller.
      assert.ok(
        !inputs.some((i) => i.type === "bytes32"),
        `${item.name} must not accept a bytes32 namespace id`
      );
      // No parameter is named like a chain id / token id (the namespace is never caller-supplied).
      assert.ok(
        !inputs.some((i) => /chain|tokenid|namespace/i.test(i.name)),
        `${item.name} must not accept a caller-supplied namespace`
      );
    }
  });

  // (a) A registered pToken CAN mint into ITS OWN namespace (by design: the source-chain
  // pToken minter is the authority; the mother does not re-check it — same trust boundary as T5).
  // This is bounded to A's namespace and can never mint into B's, per T14.
  it("T15 — a registered pToken CAN drive mint into its own namespace (passes auth -> MPC layer)", async () => {
    await mock.write.setContext([SRC_CHAIN, TOKEN_A], { account: owner });
    const err = await callErr(() => mother.write.mintPublic([RECIP, AMOUNT], asInbox));
    assertPastAuth(err, "mintPublic as registered A");
    console.log("   T15 registered-mint past-auth revert (MPC layer):", err.split("\n").find((l) => l.includes("revert"))?.trim().slice(0, 120) ?? err.split("\n")[0].slice(0, 120));
  });
});
