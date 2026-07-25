# Security Notes — EmberStreak

## Controls implemented

| Control | Where | Notes |
|---|---|---|
| SafeERC20 | all token moves | `safeTransferFrom` / `safeTransfer` only; raw `transfer()`/`send()` never used |
| ReentrancyGuard | `register`, `claim`, `withdraw` | defense-in-depth on top of CEI |
| Checks-Effects-Interactions | `register`, `claim` | all storage writes and events precede the single external token call; a revert rolls everything back atomically |
| Pausable | `register`, `claim` | `withdraw` deliberately NOT pausable so funds can never be trapped |
| Ownable2Step | ownership | eliminates fat-finger ownership loss; no `renounce` protection needed on a testnet app, but 2-step covers transfer mistakes |
| Custom errors | every failure path | cheaper than strings; frontend maps each to a human message |
| Immutable/constant params | fees, token, windows | no setter exists in the bytecode — not "restricted", *absent* |
| Exact-amount assertion | `_collectExact` | balance delta must equal fee; fee-on-transfer tokens revert with `TransferFailed` |
| Constructor token validation | constructor | rejects zero address, non-contract, and any token not reporting 6 decimals |
| Storage packing | `User` struct | 1 slot per user; no arrays/loops → O(1), DOS-immune |
| No receive/fallback | contract body | native-token transfers revert; tested |
| Zero-address checks | constructor, `setTreasury` | `ZeroAddress` custom error |

## Banned constructs — verified absent

`tx.origin`, `block.number` (for logic), `delegatecall`, `selfdestruct`,
`transfer()`, `send()`, assembly, unchecked unsafe casts, floating pragma
(pinned `0.8.24`), upgradeability/proxies.

The only downcasts are `uint64(block.timestamp)` (safe until year ~5.8e11) and
`uint32` streak arithmetic (overflows after 4.29 billion consecutive days;
Solidity 0.8 checked arithmetic would revert rather than wrap even then).

## Owner-power audit (exhaustive)

The owner's complete callable surface: `pause`, `unpause`, `withdraw(amount)`,
`setTreasury(addr)`, `transferOwnership`/`acceptOwnership` (2-step), `renounceOwnership`.

- `withdraw` pays **only the stored treasury**. There is no parameter to divert
  funds, and no code path pays the owner. Tested: `test_Withdraw_GoesToTreasuryNotOwner`,
  invariant `invariant_OwnerNeverPaid`.
- No function writes to `_users` except `register`/`claim` guarded by
  `msg.sender` — the owner cannot create, edit, or delete user records.
- `renounceOwnership` (inherited) would permanently freeze pause/withdraw/treasury
  rotation but still cannot harm user records; documented residual behavior.

## Static analysis results

### Slither (v0.11.x, filter: lib/test/script)
- **0 High, 0 Medium.**
- Informational `timestamp`: `claim`/`canClaim`/`secondsRemaining`/`isStreakExpired`
  compare `block.timestamp`. This is the product's core mechanic; windows are
  24h/48h while validator drift is seconds, and both claim outcomes cost the same
  0.01 USDC, so there is no exploitable margin. **Accepted.**
- Informational `naming-convention`: `USDC` immutable is upper-case to signal
  constant-like semantics. **Accepted (style).**

### forge
- `forge test`: 56/56 green (unit + fuzz 1024 runs + invariant 64×128).
- `forge coverage`: 100% lines / statements / branches / functions on
  `src/ArcDailyStreak.sol`.
- `forge fmt`: clean.

## Deliberate omissions (and why)

- **No `sweepToken(address)` rescue function.** A generic sweep gives the owner an
  arbitrary external call surface and a way to interact with malicious token
  contracts under the protocol's identity. Arbitrary ERC-20s accidentally sent here
  are unrecoverable by design; direct **USDC** donations are recoverable via the
  normal `withdraw` path (tested).
- **No fee setters.** Immutable economics remove the fee-rug class entirely.
- **No user-record admin tools.** "Support" backdoors are indistinguishable from
  exploit backdoors on-chain.
- **No upgradeability.** See ARCHITECTURE.md.

## Residual risks

1. **Owner pause abuse**: a malicious owner could pause forever. Impact: users
   stop paying fees; nobody loses held funds (users' money is in their wallets;
   collected fees still reach the treasury). Mitigation: owner should be a Safe.
2. **Treasury key compromise**: rotating to an attacker treasury redirects future
   withdrawals. Mitigation: `TreasuryChanged` is indexed and monitorable; use a
   Safe for the owner so rotation requires multiple signatures.
3. **Streak stale-display**: after 48h the stored `streak` remains until the next
   paid claim resets it. `isStreakExpired()` exposes this state and the UI labels
   it "expired". Chosen over auto-zeroing to keep claims O(1) single-write.
