# Gas Optimization Notes — EmberStreak

## Applied optimizations

1. **Single-slot user record.** `uint64 + uint64 + uint32 + uint32 + bool = 25 bytes`
   → one storage slot. Registration writes ONE cold slot for the whole profile;
   claims rewrite the same warm slot. This is the dominant saving in the design.

2. **Constants over storage.** `REGISTRATION_FEE`, `DAILY_FEE`, `CLAIM_INTERVAL`,
   `STREAK_WINDOW` are `constant` (inlined in bytecode, zero SLOAD).
   `USDC` is `immutable` (code-embedded, zero SLOAD).

3. **Cached reads.** `claim()` copies `u.lastClaim` into a stack variable once and
   reuses it for both the 24h and 48h comparisons; `_collectExact` caches the token
   reference; `withdraw` caches `treasury` before the event + transfer.

4. **Storage pointer reuse.** `User storage u` is taken once per function; field
   writes hit the same slot without recomputing the mapping slot hash.

5. **Custom errors** instead of revert strings — smaller bytecode, cheaper reverts.

6. **Short-circuit ordering.** Cheap checks (existence, time) run before external
   calls (allowance/balance reads, transferFrom).

7. **No loops, no arrays, no enumeration.** Every function is O(1) regardless of
   user count.

8. **Optimizer**: enabled, 200 runs (balanced deploy vs. runtime cost).

## Deliberate non-optimizations (correctness first)

- **`exists` flag** is redundant with `registeredAt != 0` but costs nothing extra
  (same slot) and makes off-chain reads unambiguous.
- **Balance-delta assertion** in `_collectExact` costs two extra `balanceOf` calls
  (~2×2.6k gas warm) per payment. Kept: it is the guarantee that internal
  accounting can never diverge from token reality.
- **Explicit allowance/balance pre-checks** cost two external view calls but buy
  precise custom errors (`InsufficientAllowance(required, current)`) that the
  frontend maps to actionable messages. On a testnet UX > marginal gas.
- **`nonReentrant`** (~2.9k gas per call) retained despite CEI already being safe —
  defense-in-depth is worth one warm SSTORE pair on a funds-handling contract.

## Approximate costs (optimizer 200, forge gas report basis)

| Operation | Approx. gas |
|---|---|
| `register()` | ~132k (one cold user slot + counters + 2 events path + transferFrom) |
| `claim()` warm | ~85k |
| `withdraw()` | ~65k |
| `setTreasury()` | ~30k |
| views | free (eth_call) |
