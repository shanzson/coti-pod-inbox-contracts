// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";

import "../../contracts/fee/FeeManager.sol";
import "../../contracts/fee/LibFeeStorage.sol";
import "../../contracts/fee/PriceOracle.sol";
import "../../contracts/fee/FeeManagerStubBase.sol";
import {InboxFeeHost} from "./InboxFeeHost.sol";

/// @title FeeManagerDirectCall
/// @notice Foundry PoC answering: "What happens if a user calls the {FeeManager} implementation
///         DIRECTLY (not via Inbox DELEGATECALL)? Can it break the protocol or turn bad?"
///
/// @dev Modelled on the Hardhat `test/PocAuditFindings.ts` / `test/FeeManagerModule.ts` structure,
///      re-expressed in Solidity so the storage-context distinction (DELEGATECALL vs direct CALL)
///      is explicit and checkable with `vm.load`.
///
///      Threat model. {FeeManager} is a stateless LOGIC contract. Every state-changing function on
///      it (`updateMinFeeConfigs`, `setPriceOracle`, `setGasPriceBounds`, `setMaxReplyMethodCallBytes`,
///      `setMaxMessageLife`, `collectFees`, `ensureDefaults`) is `external` with NO access control.
///      The `onlyOwner` gate lives one layer up, on the Inbox stubs (contracts/InboxMiner.sol) that
///      reach it via `_delegateModule(feeManager, ...)`. So a natural worry is: since anyone can call
///      those functions directly, can an attacker corrupt fee config, drain fees, or brick sends?
///
///      Conclusion proven below: NO. Under a direct CALL, `address(this)` is the FeeManager
///      implementation itself, so `LibFeeStorage.get()` resolves the `pod.inbox.fee.v1` ERC-7201 slot
///      on the IMPLEMENTATION's own storage — an address no Inbox ever reads — and `collectFees`
///      moves only the implementation's own balance. DELEGATECALL storage isolation fully contains
///      the blast radius. The absence of access control on {FeeManager} is therefore safe by design.
///      The one genuinely "bad" (but out-of-protocol) effect: the implementation behaves as a
///      permissionless wallet, so any ETH mistakenly sent to its address is sweepable by anyone.
contract FeeManagerDirectCallTest is Test {
    /// @dev `keccak256(abi.encode(uint256(keccak256("pod.inbox.fee.v1")) - 1)) & ~0xff`
    ///      (must equal LibFeeStorage.STORAGE_SLOT). First Layout field is `priceOracle`, so this
    ///      base slot holds the oracle address for whichever contract owns the storage.
    bytes32 internal constant FEE_SLOT = 0xd050cb16de05f0d1bf135ea8150bd588c80bebfb96a13dbebca4dce96e619600;

    uint256 internal constant P18 = 1e18;
    uint256 internal constant GP = 1 gwei; // pinned reference gas price (via gas-price bounds)

    address internal constant LOCAL_TOKEN = address(0xA11CE);
    address internal constant REMOTE_TOKEN = address(0xB0B);

    FeeManager internal feeImpl; // the shared DELEGATECALL target (logic contract)
    PriceOracle internal oracle; // the Inbox's configured oracle
    PriceOracle internal oracle2; // a second oracle the attacker points the impl at
    InboxFeeHost internal host; // stands in for the Inbox; owner == this test contract

    address internal attacker = makeAddr("attacker");
    address internal user = makeAddr("user");

    function setUp() public {
        feeImpl = new FeeManager();

        oracle = _deployOracle();
        oracle2 = _deployOracle();

        // Deploy the "Inbox" and configure its fee state through the OWNER path (DELEGATECALL).
        host = new InboxFeeHost(address(feeImpl)); // msg.sender (this contract) becomes owner
        host.setPriceOracle(address(oracle));
        host.updateMinFeeConfigs(_goodStub(), _goodStub());
        host.setGasPriceBounds(0, GP, GP); // pin reference gas price to exactly GP
        host.setMaxReplyMethodCallBytes(4096);
        host.setMaxMessageLife(172_800);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1) Direct admin calls: no access control, yet they cannot touch Inbox state.
    // ─────────────────────────────────────────────────────────────────────────
    function test_DirectAdminCalls_SucceedWithoutAuth_ButCannotTouchInboxState() public {
        // Snapshot the Inbox's fee state BEFORE the attack.
        Snapshot memory before = _snapshot();

        // An arbitrary EOA hammers every state-changing FeeManager function directly on the impl.
        // None of these are gated, so each one SUCCEEDS — proving there is no access control here.
        vm.startPrank(attacker);
        feeImpl.ensureDefaults();
        feeImpl.setPriceOracle(address(oracle2)); // point impl at a DIFFERENT oracle
        feeImpl.updateMinFeeConfigs(_adversarialLib(), _adversarialLib()); // "make sends free" config
        feeImpl.setGasPriceBounds(0, 1, 0);
        feeImpl.setMaxReplyMethodCallBytes(1);
        feeImpl.setMaxMessageLife(0);
        vm.stopPrank();
        console2.log("1) All 6 unauthenticated direct writes SUCCEEDED (FeeManager has no access control).");

        // The attacker DID mutate storage -- but the IMPLEMENTATION's own storage, not the Inbox's.
        // Base fee slot holds the priceOracle address for whoever owns the storage:
        address hostOracleSlot = _oracleAt(address(host));
        address implOracleSlot = _oracleAt(address(feeImpl));
        assertEq(hostOracleSlot, address(oracle), "host oracle slot must be untouched");
        assertEq(implOracleSlot, address(oracle2), "impl oracle slot took the attacker's write");
        assertTrue(hostOracleSlot != implOracleSlot, "storage contexts are isolated");
        console2.log("   Inbox pod.inbox.fee.v1 oracle slot :", hostOracleSlot, "(unchanged)");
        console2.log("   Impl  pod.inbox.fee.v1 oracle slot :", implOracleSlot, "(attacker's write, inert)");

        // The Inbox's entire fee configuration is byte-for-byte unchanged.
        _assertSameSnapshot(before, _snapshot());
        console2.log("2) Inbox fee config (oracle, min templates, caps) is byte-for-byte UNCHANGED.");

        // And the Inbox still validates fees against ITS OWN config, ignoring the attacker's writes.
        // With mul==div==1 and equal USD prices, one-way target gas == totalFee / GP.
        uint256 totalFee = 5_000_000 * GP;
        uint256 targetGas = host.validateOneWay(256, totalFee);
        assertEq(targetGas, 5_000_000, "Inbox fee math still driven by its own (good) config");
        console2.log("3) Inbox fee validation still works and still uses ITS config. targetGas =", targetGas);

        console2.log("VERDICT [1]: SAFE - direct admin calls are unauthenticated but write only impl storage.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2) collectFees: a direct call cannot drain the Inbox's collected fees.
    // ─────────────────────────────────────────────────────────────────────────
    function test_DirectCollectFees_CannotDrainInboxCollectedFees() public {
        // Simulate fees accrued ON THE INBOX (they live on the Inbox, never on the impl).
        vm.deal(address(host), 5 ether);
        assertEq(address(host).balance, 5 ether);
        assertEq(address(feeImpl).balance, 0);

        // Attacker calls collectFees DIRECTLY on the impl, aiming the payout at themselves.
        // It is unauthenticated and succeeds, but `address(this).balance` is the IMPL's balance (0),
        // so it is a no-op: the Inbox's 5 ETH is never in scope.
        vm.prank(attacker);
        feeImpl.collectFees(payable(attacker));
        assertEq(attacker.balance, 0, "direct collectFees cannot see the Inbox balance");
        assertEq(address(host).balance, 5 ether, "Inbox collected fees are untouched");
        console2.log("1) Attacker's direct collectFees swept the impl's balance (0) - Inbox 5 ETH untouched.");

        // Attacker cannot go through the Inbox either: that path is onlyOwner.
        vm.prank(attacker);
        vm.expectRevert(InboxFeeHost.NotOwner.selector);
        host.collectFees(payable(attacker));
        console2.log("2) Attacker's Inbox.collectFees reverts NotOwner (the real gate).");

        // The legitimate owner CAN collect via the Inbox (DELEGATECALL => moves the Inbox's balance).
        address payable sink = payable(makeAddr("sink"));
        host.collectFees(sink); // called by owner (this contract)
        assertEq(sink.balance, 5 ether, "owner collects the Inbox fees via DELEGATECALL");
        assertEq(address(host).balance, 0);
        console2.log("3) Owner collectFees via Inbox moved the real 5 ETH. Direct calls never could.");

        console2.log("VERDICT [2]: SAFE - protocol fees are only reachable through the onlyOwner Inbox path.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3) The one "turns bad" effect (OUT of protocol scope): the implementation
    //    is a permissionless wallet, so ETH mistakenly sent to it is stealable.
    // ─────────────────────────────────────────────────────────────────────────
    function test_ImplementationIsPermissionlessWallet_AccidentalEthIsStealable() public {
        // A user accidentally routes value at the IMPLEMENTATION address. `localRequestExecutionBudget`
        // is a live `payable` entrypoint that neither forwards nor rejects value, so the ETH sticks.
        vm.deal(user, 1 ether);
        vm.prank(user);
        feeImpl.localRequestExecutionBudget{value: 1 ether}(0);
        assertEq(address(feeImpl).balance, 1 ether, "value stuck on the implementation");
        console2.log("1) 1 ETH mistakenly sent to the FeeManager IMPLEMENTATION address sticks there.");

        // Because collectFees is unauthenticated, ANYONE (not the depositor) can sweep it.
        uint256 attackerBefore = attacker.balance;
        vm.prank(attacker);
        feeImpl.collectFees(payable(attacker));
        assertEq(attacker.balance, attackerBefore + 1 ether, "any caller sweeps the implementation");
        assertEq(address(feeImpl).balance, 0);
        console2.log("2) An UNRELATED account swept it via the unauthenticated collectFees.");

        // Scope check: this is the depositor's own mistaken funds. The Inbox holds nothing here,
        // so no protocol / other-user funds are ever at risk from this behaviour.
        assertEq(address(host).balance, 0, "no protocol funds involved");
        console2.log("VERDICT [3]: LOW/INFO - impl is an open wallet; only ETH misdirected TO it is at risk.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4) Direct validation on a fresh impl reverts (and never moves value anyway).
    // ─────────────────────────────────────────────────────────────────────────
    function test_DirectValidation_OnFreshImpl_RevertsOracleNotConfigured() public {
        // A fresh impl has an empty oracle slot in ITS OWN storage, so the validate/budget entrypoints
        // revert before doing anything. They are pure computation + reverts: they never transfer value,
        // so even when "configured" by an attacker they cannot extract anything from the impl.
        FeeManager fresh = new FeeManager();

        vm.prank(attacker);
        vm.expectRevert(FeeManager.OracleNotConfigured.selector);
        fresh.validateAndPrepareOneWayFees(256, 5_000_000 * GP);

        vm.prank(attacker);
        vm.expectRevert(FeeManager.OracleNotConfigured.selector);
        fresh.validateAndPrepareTwoWayFees(256, 5_000_000 * GP, 1_000_000 * GP);

        console2.log("VERDICT [4]: SAFE - direct validate calls revert on a fresh impl; they never move value.");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    struct Snapshot {
        address oracle;
        uint32 maxReply;
        uint32 maxLife;
        uint256 minGas;
        uint256 maxGas;
        // localMinFeeConfig fields that matter for admission / pricing
        uint32 lConstant;
        uint32 lGasPerByte;
        uint32 lMaxMethodCallBytes;
        uint32 lMaxExecutionGas;
        uint16 lMul;
        uint16 lDiv;
    }

    function _snapshot() internal view returns (Snapshot memory s) {
        s.oracle = address(host.priceOracle());
        s.maxReply = host.maxReplyMethodCallBytes();
        s.maxLife = host.maxMessageLife();
        s.minGas = host.minGasPriceWei();
        s.maxGas = host.maxGasPriceWei();
        (uint32 c,, uint32 gpb,,, uint32 mmcb, uint32 mxg, uint16 mul, uint16 div) = host.localMinFeeConfig();
        s.lConstant = c;
        s.lGasPerByte = gpb;
        s.lMaxMethodCallBytes = mmcb;
        s.lMaxExecutionGas = mxg;
        s.lMul = mul;
        s.lDiv = div;
    }

    function _assertSameSnapshot(Snapshot memory a, Snapshot memory b) internal pure {
        assertEq(a.oracle, b.oracle, "oracle changed");
        assertEq(a.maxReply, b.maxReply, "maxReply changed");
        assertEq(a.maxLife, b.maxLife, "maxLife changed");
        assertEq(a.minGas, b.minGas, "minGas changed");
        assertEq(a.maxGas, b.maxGas, "maxGas changed");
        assertEq(a.lConstant, b.lConstant, "localMin.constantFee changed");
        assertEq(a.lGasPerByte, b.lGasPerByte, "localMin.gasPerByte changed");
        assertEq(a.lMaxMethodCallBytes, b.lMaxMethodCallBytes, "localMin.maxMethodCallBytes changed");
        assertEq(a.lMaxExecutionGas, b.lMaxExecutionGas, "localMin.maxExecutionGas changed");
        assertEq(a.lMul, b.lMul, "localMin.gasPriceMul changed");
        assertEq(a.lDiv, b.lDiv, "localMin.gasPriceDiv changed");
    }

    /// @dev Read the priceOracle address stored at the ERC-7201 base slot of `who`.
    function _oracleAt(address who) internal view returns (address) {
        return address(uint160(uint256(vm.load(who, FEE_SLOT))));
    }

    function _deployOracle() internal returns (PriceOracle o) {
        o = new PriceOracle(address(this)); // owner + priceAdmin == this test contract
        o.setInboxTokens(LOCAL_TOKEN, REMOTE_TOKEN);
        o.setLocalTokenPriceUSD(P18);
        o.setRemoteTokenPriceUSD(P18);
    }

    /// @dev A valid, realistic non-constant template (mirrors `VAR_FEE` in PocAuditFindings.ts).
    function _goodStub() internal pure returns (FeeManagerStubBase.FeeConfig memory) {
        return FeeManagerStubBase.FeeConfig({
            constantFee: 0,
            gasPerByte: 800,
            callbackExecutionGas: 100_000,
            errorLength: 256,
            bufferRatioX10000: 5_000,
            maxMethodCallBytes: 8_192,
            maxExecutionGas: 5_000_000,
            gasPriceMul: 1,
            gasPriceDiv: 1
        });
    }

    /// @dev What an attacker would WANT to install: near-free sends, maxed caps. Valid, so the direct
    ///      write succeeds — the point is that it lands in the impl's storage and never reaches an Inbox.
    function _adversarialLib() internal pure returns (LibFeeStorage.FeeConfig memory) {
        return LibFeeStorage.FeeConfig({
            constantFee: 1,
            gasPerByte: 0,
            callbackExecutionGas: 0,
            errorLength: 0,
            bufferRatioX10000: 0,
            maxMethodCallBytes: 32_768,
            maxExecutionGas: 25_000_000,
            gasPriceMul: 1,
            gasPriceDiv: 1
        });
    }
}
