# Architecture — EmberStreak

## System overview

```
┌──────────────┐   read (viem/wagmi)   ┌─────────────────────┐
│  Next.js UI  │ ───────────────────▶ │  ArcDailyStreak.sol  │
│  (Vercel,    │   write (wallet tx)   │  (Arc Testnet)       │
│  stateless)  │ ───────────────────▶ │                      │
└──────────────┘                       │  holds collected     │
                                       │  USDC until          │
                                       │  withdraw()          │
                                       └─────────┬───────────┘
                                                 │ safeTransfer (owner-initiated)
                                                 ▼
                                       ┌─────────────────────┐
                                       │  Treasury (Safe)     │
                                       └─────────────────────┘
```

There is **no backend**. The UI derives 100% of its state from `eth_call`s and
emitted events; if the site disappears, users lose nothing.

## Contract design decisions

### One contract, no upgradability
A proxy would add a privileged upgrade path — the single largest trust liability a
contract of this size can carry. Business logic is small and final; immutability IS
the security feature. If rules must change, deploy a new contract; history remains
readable in the old one forever.

### All economic parameters are constants/immutables
`REGISTRATION_FEE`, `DAILY_FEE`, `CLAIM_INTERVAL`, `STREAK_WINDOW` are `constant`;
the `USDC` token is `immutable`. Nobody — including the owner — can change them.
This removes fee-rug and token-swap attacks completely and reads cheaper than
storage.

### Storage: one slot per user
```solidity
struct User {
    uint64 registeredAt;  // 8 bytes
    uint64 lastClaim;     // 8 bytes
    uint32 streak;        // 4 bytes
    uint32 longestStreak; // 4 bytes
    bool   exists;        // 1 byte
}                         // 25 bytes → 1 storage slot
```
`mapping(address => User)` only. No arrays, no enumeration, no loops — every code
path is O(1) and immune to unbounded-gas DOS. Leaderboards, if wanted later, are an
off-chain indexer concern (events carry all needed data).

### Time semantics (single source of truth: `lastClaim`)
- `claim` allowed when `block.timestamp >= lastClaim + 24h` (inclusive boundary).
- Streak survives when `block.timestamp <= lastClaim + 48h` (inclusive boundary).
- Strictly after 48h the claim still succeeds but restarts the streak at 1 and
  emits `StreakReset` — payment is identical, so there is no incentive to time
  transactions adversarially.
- Registration sets `lastClaim = registeredAt`, so the first claim is exactly one
  day after registering — consistent with "streak = 1 at registration".

### Payment collection: pull-exact pattern
`_collectExact` checks allowance and balance first (for precise custom errors the
frontend can map), then `safeTransferFrom`, then asserts the **balance delta equals
the fee**. Fee-on-transfer or otherwise non-standard tokens cannot corrupt
accounting: the transaction reverts atomically, profile and counters roll back.

### Treasury separation (funds never touch the owner)
- Payments accumulate in the contract; nothing is auto-forwarded. A reverting or
  blacklisted treasury can therefore never brick registration/claims.
- `withdraw(amount)` sends **only to the stored treasury**, never to a call-time
  parameter and never to the owner. Owner and treasury are separate roles by
  design; the treasury is expected to be a Safe multisig.
- `withdraw` works while paused — pausing can never trap funds.

### Roles and their complete permission sets
| Role | Can | Cannot |
|---|---|---|
| User | register once; claim daily | affect any other user |
| Owner | pause, unpause, withdraw→treasury, setTreasury, 2-step ownership transfer | touch user records, change fees/token, receive funds, claim for users, mint |
| Treasury | receive withdrawals | anything else (it is a passive address) |

### Events as the audit trail
`Registered`, `Claimed`, `StreakReset`, `Withdraw`, `TreasuryChanged` (plus OZ's
`Paused`/`Unpaused`/ownership events) carry every state transition with amounts and
timestamps — a full off-chain reconstruction of contract history requires nothing
but the event log.

## Frontend design decisions

- **wagmi v2 + viem + RainbowKit**, Next.js 14 App Router, static output — zero
  server code, deployable on Vercel's free tier.
- **Simulation before send**: every write is `simulateContract`ed first, so users
  see the mapped custom error (e.g. "Too early — claim at 14:05") before paying gas.
- **Approve → wait receipt → act**: the approval receipt is awaited before
  register/claim is submitted, eliminating the allowance race that plagues
  approve+spend flows on slow testnets.
- **Wrong-network guard** with a one-click switch to chain 5042002.
- **Custom-error mapping** (`lib/errors.ts`) translates every contract error into
  a human sentence; unknown errors fall back to viem's short message.
- **Session tx history** with explorer links; on-chain events remain the permanent
  record.

## Trust assumptions

1. Arc Testnet USDC (`0x36…0000`) behaves as a standard 6-decimal ERC-20 without
   fee-on-transfer (enforced at runtime by the balance-delta check anyway).
2. The owner key is honest-but-curious at worst: even a malicious owner can only
   pause the dApp or rotate the treasury — it can never steal user balances
   (users' funds leave their wallets only via their own approvals and exact-fee
   pulls) and can never falsify streak data.
3. Block timestamps are honest to within seconds — accounting windows are 24h/48h,
   so validator drift is immaterial.
