import sys, html
out_dir = sys.argv[1]
W, H = 1900, 1390
el = []
MONO = "'DejaVu Sans Mono', Menlo, monospace"
SANS = "'DejaVu Sans', Arial, sans-serif"
def rect(x,y,w,h,fill,stroke,sw=2,rx=12,dash=None,op=None):
    d=f' stroke-dasharray="{dash}"' if dash else ""; o=f' opacity="{op}"' if op else ""
    el.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}{o}/>')
def text(x,y,t,size=13,color="#111827",bold=False,mono=False,anchor="start"):
    el.append(f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-family="{MONO if mono else SANS}" font-size="{size}" font-weight="{"bold" if bold else "normal"}" fill="{color}">{html.escape(t)}</text>')
def card(x,y,w,h,title,lines,fill="#ffffff",stroke="#1f2937",tsize=15,lsize=11.5,mono_lines=True):
    rect(x,y,w,h,fill,stroke)
    text(x+12,y+22,title,size=tsize,bold=True)
    yy=y+42
    for ln in lines:
        text(x+12,yy,ln,size=lsize,mono=mono_lines,color="#1f2937"); yy+=lsize+5.5
def arrow(x1,y1,x2,y2,color="#374151",sw=2.2,dash=None):
    d=f' stroke-dasharray="{dash}"' if dash else ""
    el.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{sw}" marker-end="url(#ah)"{d}/>')
def path(d,color="#374151",sw=2.2,dash=None):
    dd=f' stroke-dasharray="{dash}"' if dash else ""
    el.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" marker-end="url(#ah)"{dd}/>')
def tag(x,y,n,color="#1f2937"):
    el.append(f'<circle cx="{x}" cy="{y}" r="11" fill="{color}"/>')
    text(x,y+4.5,str(n),size=12,color="#ffffff",bold=True,anchor="middle")

text(30,40,"Privacy Portal architecture — source chain ↔ COTI: contracts, roles, state and flows",size=25,bold=True)
text(30,66,"coti-contracts 8a0c4928 · PrivacyPortalFactory / PrivacyPortal / PodErc20MintableInitializable / PodErc20CotiMother · circled numbers refer to the flow legend · rev 2 (independently verified)",size=13.5,color="#4b5563")

rect(360,95,860,885,"#dbeafe","#93c5fd",op=0.55); text(375,118,"SOURCE CHAIN (e.g. Ethereum / Avalanche)",size=15,bold=True,color="#1e3a8a")
rect(1260,95,610,885,"#fef3c7","#fcd34d",op=0.6); text(1275,118,"COTI (garbled-circuit MPC chain)",size=15,bold=True,color="#92400e")

# actors
rect(30,150,290,62,"#f3f4f6","#374151"); text(45,173,"Admin  (DEFAULT_ADMIN_ROLE)",size=13,bold=True); text(45,193,"pause · blacklist · limits · rescue · remount · routing",size=11,color="#4b5563")
rect(30,225,290,52,"#f3f4f6","#374151"); text(45,248,"Operator  (OPERATOR_ROLE)",size=13,bold=True); text(45,266,"fee configs · soft deposit switch",size=11,color="#4b5563")
rect(30,290,290,52,"#f3f4f6","#374151"); text(45,313,"Deployer  (DEPLOYER_ROLE)",size=13,bold=True); text(45,331,"createPortal(underlying, name, symbol, …)",size=11,color="#4b5563")
text(32,368,"Admin & Operator call each portal DIRECTLY; the portal only",size=10.5,color="#4b5563"); text(32,383,"reads isAdmin / isOperator from the factory (⑮ ⑯ apply to both).",size=10.5,color="#4b5563")
rect(30,480,290,76,"#e0f2fe","#0369a1"); text(45,503,"User (pToken holder)",size=13,bold=True); text(45,523,"deposit · depositNative · wrap",size=11,color="#4b5563"); text(45,541,"requestWithdrawWithPermit · pToken ops directly",size=11,color="#4b5563")
rect(30,660,290,62,"#f3f4f6","#374151"); text(45,683,"Anyone / keeper",size=13,bold=True); text(45,703,"release · refund · finalize burn · cancel",size=11,color="#4b5563")

# factory
card(390,140,800,205,"PrivacyPortalFactory  (AccessControl · Ownable owner of the pToken clones it creates)",[
 "config: inbox · cotiChainId · cotiMotherContract · portal/pToken impls · priceOracle · nativeToken (WETH)",
 "feeRecipient (immutable) · rescueRecipient · default fees (fixed | bps | max) · factory pause · blacklist",
 "admin levers: configureRouting · setPortalImplementation · setPodTokenImplementation · setPriceOracle · setDeployer",
 "createPortal (DEPLOYER_ROLE) → clone portal + clone pToken + one-way registerToken to the mother",
 "createPortalWithExistingPToken (admin) → new portal clone for an existing pToken: create when unmapped,",
 "  remount when paired (old portal must be paused → retireDepositsForUpgrade); new clone starts paused; minter rotates",
 "pToken forwarders (DEFAULT_ADMIN_ROLE; the factory must still be the pToken's Ownable owner):",
 "  configurePToken · setPTokenMinter · setPTokenRequestKillMinAge · killPTokenStaleRequest · transferPTokenOwnership",
 "views read by portals: isAdmin / isOperator · depositsPaused / withdrawalsPaused · blacklisted · fees · oracle",
],stroke="#1d4ed8",lsize=10.5)

card(610,352,380,58,"PortalFeeOracle",["owner-set USD pegs (1e18 per token) · own Ownable owner","zero price ⇒ dynamic fee off (fixed fee only)"],stroke="#6b7280",lsize=10.5)

# portal
card(390,425,380,430,"PrivacyPortal  (clone per underlying)",[
 "holds collateral · ERC-7984 wrapper (wrap/rate)",
 "STATE",
 " depositEscrows[mintRequestId]",
 "   {user, recipient, amount = received, status}",
 " withdrawals[withdrawalId]",
 "   {user, recipient, amount, transferId, status}",
 " pendingBurnAmount · burnInFlight[id]",
 " burnInFlightTotal · accumulatedPortalFees",
 " limits · fee overrides · withdrawalNonce",
 " factory · bindingFactory (remount detach)",
 " per-portal blacklist · paused · isDepositEnabled",
 "ENTRY  deposit · depositNative · wrap  (user)",
 "       requestWithdrawWithPermit  (user, EIP-712)",
 "       onPTokenTransferred  (pToken only)",
 "       permissionless: triggerWithdrawalRelease ·",
 "         cancelFailedWithdrawal ·",
 "         refundFailedDeposit · finalizeBatchBurn",
 "       adminRefundPendingDeposit (admin + paused)",
 "       admin: burnAccumulatedPTokens ·",
 "         withdrawPortalFees · rescueERC20/Native",
 "         (rescues also need paused)",
 "       retireDepositsForUpgrade · pauseByFactory",
 "         (factory only)",
],stroke="#1d4ed8",lsize=11)

# pToken
card(810,425,380,430,"PodErc20MintableInitializable  (pToken clone)",[
 "minter = portal · owner = factory",
 "ctUint256 balance cache — NOT authoritative",
 "STATE",
 " _requests[id]: None | Pending | Success",
 "                | Failed | SystemFailed",
 " _requestCallbacks[id] (portal hook on withdraw)",
 " nonces (EIP-712 TransferPermit) · balanceNonces",
 "ENTRY  mint  (minter only)",
 "       transferFromAndCallWithPermit · burn",
 "       transferCallback (onlyInboxPeer: inbox +",
 "         trusted COTI peer)",
 "       transferError (onlyInboxReturnLeg: inbox +",
 "         linked return leg, no peer check)",
 "       invalidatePendingRequest  (minter)",
 "       killStaleRequest · configure (owner=factory)",
 "       ungated holder ops: transfer · transferFrom",
 "         approve · burn · transferAndCall ·",
 "         syncBalances",
 "no MPC here: every move is a message to COTI",
],stroke="#1d4ed8",lsize=11)

card(390,870,380,100,"Underlying ERC-20 / wrapped native",["deposit / wrap: safeTransferFrom (balance delta measured)","depositNative: WETH.deposit{value}  (delta measured too)","release: safeTransfer or WETH.withdraw + send · rescue"],stroke="#6b7280",lsize=11)
card(810,870,380,100,"Inbox (source chain)",["sendTwoWayMessage / sendOneWayMessage → requestId","nonce per target chain · miner relays to COTI","return legs: callback | app error | system error"],stroke="#6b7280",lsize=11)

# COTI
card(1290,140,550,110,"MpcCore / MPC precompiles",["ops: onBoard · add/sub · ge/gt · mux · offBoard/offBoardToUser · decrypt","balances stored as ciphertexts; *Public legs carry plaintext amounts"],stroke="#6b7280",lsize=11)
card(1290,300,550,440,"PodErc20CotiMother  (unified ledger for ALL pTokens)",[
 "owner (Ownable): setAllowedFactory(chainId, factory) · configure",
 "namespace = tokenId(sourceChainId, pToken): for every balance op both",
 "halves come from the authenticated inbox origin (_activeTokenId),",
 "never from arguments. Exception: registerToken takes pToken from",
 "calldata (chainId still from the inbox) — allow-listed factory only",
 "mintPublic / mint              (portal deposits)",
 "transferOwnerPublic            (withdraw: user → portal custody)",
 "burnPublic / burn              (portal batch burn)",
 "transfer / transferFromAsSpender / approve / syncBalances",
 "all gated by onlyRegisteredPTokenMessage → TokenNotRegistered",
 "success → respond(ciphertexts + nonce) · failure → raise(reason)",
 "approve responses carry no nonce · per-token nonce starts at 1",
],stroke="#b45309")
card(1290,870,550,100,"Inbox (COTI) + miner",["executes the MpcMethodCall on the mother as (chainId, sender)","execution reverts are retryable (request stays Pending)","carries respond / raise back as the return leg"],stroke="#6b7280",lsize=11)

# arrows
arrow(320,316,390,300); tag(345,300,1)
arrow(320,181,390,200); tag(345,168,15)
arrow(320,251,390,235); tag(345,238,16)
arrow(580,345,580,425); tag(595,385,2)
arrow(1000,345,1000,425); tag(1015,385,2)
path("M1190,270 L1205,270 L1205,862 L1150,862 L1150,870",dash="7,5"); tag(1205,560,3)
arrow(320,518,390,518); tag(355,506,4)
arrow(320,690,390,680); tag(355,672,14)
arrow(470,855,470,870); arrow(520,870,520,855); tag(495,848,5)
arrow(770,485,810,485); tag(790,473,6)
arrow(810,720,770,720,color="#b91c1c"); tag(790,708,13,color="#b91c1c")
arrow(900,855,900,870); tag(885,848,7)
arrow(1000,870,1000,855,color="#059669"); tag(1015,848,12,color="#059669")
arrow(760,425,760,410); tag(778,418,17)
arrow(1190,900,1290,900); tag(1240,888,8)
arrow(1290,935,1190,935,color="#059669"); tag(1240,950,11,color="#059669")
arrow(1450,870,1450,740); tag(1435,805,9)
arrow(1700,740,1700,870,color="#059669"); tag(1715,805,11,color="#059669")
arrow(1565,300,1565,250); tag(1580,278,10)

# bottom
rect(30,1005,880,365,"#fff7ed","#c2410c")
text(45,1030,"Why the deposit escrow exists",size=16,bold=True,color="#7c2d12")
esc=[
 "The mint is ASYNCHRONOUS. On deposit the portal locks the collateral NOW (safeTransferFrom / WETH.deposit), but the",
 "pTokens are created LATER on COTI, and that leg can fail (inbox system error) or never settle. Something must remember who is owed what.",
 "",
 "depositEscrows[mintRequestId] = { user, recipient, amount, status }  is that memory:",
 "  • keyed by the pToken's request id → a refund is validated against pToken.requests(id).status (SystemFailed only)",
 "  • amount = MEASURED received (balance delta), so fee-on-transfer tokens refund exactly what arrived",
 "  • user ≠ recipient is allowed: pTokens go to `recipient`, a refund always goes back to `user`",
 "  • status Pending → Refunded makes any refund one-shot; admin path: factory admin + portal paused + status ≠ Success,",
 "    and it calls pToken.invalidatePendingRequest first so a late Success cannot mint against returned collateral",
 "",
 "Without it the portal would hold a pile of collateral with no link to any depositor or to any failed request.",
 "Known quirks: never marked terminal on mint SUCCESS (stays Pending forever) · DepositEscrowStatus.Failed is never written.",
]
yy=1052
for ln in esc:
    text(45,yy,ln,size=11.5,color="#431407"); yy+=18.5

rect(940,1005,930,365,"#f3f4f6","#374151")
text(955,1030,"Flow legend",size=16,bold=True)
leg=[
 ("1","Deployer: factory.createPortal(underlying, …) — decimals must equal the underlying's and be ≤ 18"),
 ("2","Factory clones + initializes portal and pToken (pToken.minter = portal, pToken.owner = factory)"),
 ("3","Factory → source inbox: one-way registerToken (no error selector), relayed via 8→9 to the mother; the portal is live before it lands"),
 ("4","User: deposit / depositNative / wrap (lock collateral, escrow Pending) or requestWithdrawWithPermit (EIP-712 permit by the user)"),
 ("5","Portal ↔ underlying: safeTransferFrom (deposit/wrap) or WETH.deposit (depositNative), delta measured; safeTransfer / WETH.withdraw on release"),
 ("6","Portal → pToken: mint(recipient, received) · transferFromAndCallWithPermit(user → portal) · burn(amount)"),
 ("7","pToken → inbox: sendTwoWayMessage(MpcMethodCall, callback = transferCallback, error = transferError, fee)"),
 ("8","Source inbox → COTI inbox: miner relays the request (nonce-ordered per target chain)"),
 ("9","COTI inbox → mother: mintPublic / transferOwnerPublic / burnPublic (or registerToken), authenticated as (chainId, sender)"),
 ("10","Mother ↔ MpcCore: onBoard → garbled compute → offBoardToUser; stored balances never in the clear. *Public legs carry plaintext"),
 ("  ","amounts and reveal solvency via decrypt(ge(...)); a mint before registration reverts TokenNotRegistered and is retried (stays Pending)"),
 ("11","Return leg: respond(ciphertexts) on success, raise(reason) on app failure; the inbox itself may emit a system error"),
 ("12","Inbox → pToken: transferCallback (Success) or transferError (Failed / SystemFailed); terminal, one-way"),
 ("13","pToken → portal: low-level call onPTokenTransferred(withdrawalId) → _releaseWithdrawal (withdrawals only; failure swallowed — audit finding 1)"),
 ("14","Anyone: triggerWithdrawalRelease · refundFailedDeposit (needs SystemFailed) · finalizeBatchBurn · cancelFailedWithdrawal"),
 ("15","Admin, directly on portal/factory: pause/unpause · blacklist · setLimits · rescue* (paused) · burnAccumulatedPTokens · withdrawPortalFees · remount"),
 ("16","Operator, directly on portal/factory: setDepositFee / setWithdrawFee / factory defaults (fixed | bps ≤ 10% | max) · setIsDepositEnabled"),
 ("17","Portal → oracle (address read from the factory): getLivePrices(native, underlying) for the dynamic fee floor; zero rate ⇒ fixed fee"),
]
yy=1052
for n,t in leg:
    if n.strip(): tag(965,yy-4,int(n))
    text(985,yy,t,size=11,color="#111827"); yy+=18
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" fill="#374151"/></marker></defs>
<rect width="{W}" height="{H}" fill="#ffffff"/>
{chr(10).join(el)}
</svg>'''
open(f"{out_dir}/architecture.svg","w").write(svg)
open(f"{out_dir}/architecture.html","w").write(f'<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;background:#fff}}</style></head><body>{svg}</body></html>')
print("ok")
