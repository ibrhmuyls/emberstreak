# Audit Checklist — Arc Daily Streak

For the external auditor. Every line links to code or a test proving the claim.

## Compiler & dependencies
- [x] Pragma pinned: `solidity 0.8.24` (no floating pragma)
- [x] OpenZeppelin Contracts v5.1.0 (SafeERC20, ReentrancyGuard, Pausable, Ownable2Step)
- [x] Optimizer enabled (200 runs), evm_version `paris`
- [x] `forge build` clean, `forge fmt` clean

## Access control
- [x] Owner surface is exactly: `pause`, `unpause`, `withdraw`, `setTreasury`, 2-step transfer — nothing else in bytecode
- [x] No function lets anyone write another user's record (`register`/`claim` key on `msg.sender` only)
- [x] Ownable2Step: `test_Ownership_TwoStep`, `test_Ownership_CannotAcceptUninvited`
- [x] Negative tests for every `onlyOwner` function

## Funds safety
- [x] Fees are `constant`; token is `immutable`; **no setter exists**
- [x] Payments pulled with SafeERC20 `safeTransferFrom`, exact-amount asserted via balance delta (`_collectExact`)
- [x] Fee-on-transfer rejected: `test_FeeOnTransferToken_Rejected`
- [x] Withdraw only to stored treasury: `test_Withdraw_GoesToTreasuryNotOwner`
- [x] Withdraw bounded by live balance: `test_Withdraw_RevertExceedsBalance`
- [x] Withdraw usable during pause: `test_Withdraw_WorksWhilePaused`
- [x] Owner never receives funds under fuzzed sequences: `invariant_OwnerNeverPaid`
- [x] No receive/fallback — native transfers revert: `test_NativeTokenRejected`

## Reentrancy & CEI
- [x] All state writes precede the token interaction in `register`/`claim`
- [x] `nonReentrant` on `register`, `claim`, `withdraw`
- [x] Attacking-token tests: `test_Reentrancy_RegisterBlocked`, `test_Reentrancy_ClaimBlocked`
- [x] Full rollback on failed payment: `test_Claim_StateUnchangedOnRevert`

## Time logic
- [x] 24h inclusive boundary: `test_Claim_ExactBoundary24h`
- [x] 48h inclusive boundary (no reset at exactly 48h): `test_Claim_ExactBoundary48h_NoReset`
- [x] Reset strictly after 48h with `StreakReset` + `Claimed(streak=1)`: `test_Claim_ResetAfter48h`
- [x] Fuzz over the full interval space: `testFuzz_ClaimIntervalSemantics`
- [x] `longestStreak` monotone: `test_Claim_LongestStreakNeverDecreases`, `testFuzz_StreakMonotonicity`, `invariant_UserRecordIntegrity`

## Token validation
- [x] Constructor rejects zero address, EOA, wrong decimals: 3 constructor tests
- [x] Deploy script pins canonical Arc USDC and requires chain id 5042002

## Accounting
- [x] `balance == totalCollected - totalWithdrawn` under fuzzed operation sequences: `invariant_BalanceAccounting`
- [x] Exact per-claim accounting: `testFuzz_AccountingMatchesClaims`
- [x] Registration fee charged exactly once: `test_Register_RevertDouble`

## Coverage & analysis
- [x] `forge coverage`: 100% lines / statements / branches / functions (src/)
- [x] Slither: 0 High / 0 Medium; informational findings documented in SECURITY.md
- [ ] Aderyn / Mythril — recommended before mainnet-class deployment (not run in this environment)

## Banned constructs (grep-verifiable)
- [x] No `tx.origin`, `block.number`, `delegatecall`, `selfdestruct`, `.transfer(`, `.send(`, `assembly`

## Known accepted findings
1. Slither `timestamp` info — core mechanic, 24h/48h windows vs. seconds drift, equal-cost outcomes.
2. `USDC` immutable naming (upper case) — intentional constant-like signal.
3. Stored `streak` is stale after expiry until next claim — surfaced via `isStreakExpired()`; UI labels it.
4. `renounceOwnership` inherited — would freeze admin ops but cannot harm users or trap the then-current treasury flow beyond a final `withdraw` being impossible; recommend owner = Safe and never renouncing.
