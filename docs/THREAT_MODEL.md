# Threat Model — Arc Daily Streak

Scope: `ArcDailyStreak.sol` on Arc Testnet + static Next.js frontend.
Assets at risk: users' USDC allowances/balances, collected fees held by the
contract, integrity of streak records.

| # | Threat | Vector | Defense | Residual risk |
|---|--------|--------|---------|---------------|
| 1 | Reentrancy | malicious/nonstandard token re-enters `register`/`claim`/`withdraw` | CEI ordering + `nonReentrant` on every state-changing function; canonical USDC has no hooks anyway | None (tested with attacking token) |
| 2 | Replay | re-submitting a claim tx | State-based guards: `AlreadyRegistered`, 24h gate re-checked on-chain each call; nonces handled by the chain | None |
| 3 | Timestamp manipulation | validator skews `block.timestamp` | Windows are 24h/48h vs. seconds of drift; both claim outcomes cost identical fees → no profit motive | Negligible |
| 4 | Front-running | observing a victim's claim in mempool | Claims are per-address with no shared resource, no ordering advantage exists | None |
| 5 | Sandwich attacks | manipulating price around a swap | No swaps, no AMM interaction, fixed fees | N/A |
| 6 | Allowance abuse | contract pulling more than the fee | Contract only ever pulls the exact constant fee; UI approves exact amounts; balance-delta assert | User may grant infinite approval manually — their choice |
| 7 | Fee-on-transfer token | token delivers less than requested | Balance-delta must equal fee or revert (`TransferFailed`); canonical USDC isn't FoT | None |
| 8 | Wrong/incorrect ERC20 | deploy pointing at wrong token | Constructor requires contract code + 6 decimals; deploy script hard-pins canonical USDC + chain id 5042002 | Deployer diligence |
| 9 | DOS via gas | unbounded loops/arrays | None exist; all paths O(1); single-slot user record | None |
| 10 | Storage corruption | struct packing bugs, casts | Single packed struct, checked arithmetic, no assembly, no unsafe casts | None |
| 11 | Privilege escalation | non-owner calling admin functions | OZ `onlyOwner` + Ownable2Step; tested negative paths | None |
| 12 | Ownership abuse | owner editing users/fees/token, paying itself | Those functions do not exist in the bytecode; `withdraw` pays only the treasury | Pause-forever griefing (see SECURITY.md) |
| 13 | Unexpected token transfers | random ERC20/native sent to contract | No receive/fallback → native reverts; USDC donations withdrawable to treasury; other ERC20s inert (no sweep by design) | Donated non-USDC stuck (accepted) |
| 14 | Pause abuse | owner pauses to trap funds | `withdraw` and all view functions work while paused; users' own money never enters the contract without an action they sign | Service unavailability only |
| 15 | Treasury abuse | rotating treasury to attacker address | Only owner can rotate; event emitted; recommend Safe as owner; funds never auto-flow | Owner-key hygiene |
| 16 | Gas griefing | forcing expensive execution for others | Per-user isolated state; no cross-user writes | None |
| 17 | State inconsistency | partial updates on failed payment | Payment is the last operation; any revert rolls back the whole tx (tested: `test_Claim_StateUnchangedOnRevert`) | None |
| 18 | Failed transfer edge cases | non-reverting false-returning tokens | SafeERC20 turns false-returns into reverts; delta check as second layer | None |
| 19 | Phishing/UI supply chain | fake site draining approvals | UI approves only exact fees to the fixed contract address; users should verify domain + contract address (shown with explorer links) | Ecosystem-level |
| 20 | RPC manipulation | malicious RPC feeding wrong state | Read-only impact; writes are signed client-side and simulated; users can point wallets at any RPC | Ecosystem-level |

## Invariants (machine-checked)

1. `registrationFee == 1e6`, `dailyFee == 1e4`, `USDC` fixed — `invariant_ImmutableParameters`
2. `balanceOf(contract) == totalCollected - totalWithdrawn` — `invariant_BalanceAccounting`
3. Per user: `longestStreak >= streak`, `longestStreak` monotone, `lastClaim >= registeredAt` — `invariant_UserRecordIntegrity`
4. Owner USDC balance stays 0 through any operation sequence — `invariant_OwnerNeverPaid`
