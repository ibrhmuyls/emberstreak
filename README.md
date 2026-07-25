# Arc Daily Streak

Production-grade, fully on-chain daily streak dApp for **Arc Testnet**, paid in the
official Arc Testnet USDC. No backend — the smart contract is the single source of
truth and the frontend only displays blockchain state.

> Unofficial community project. Not affiliated with, endorsed by, or sponsored by
> Circle or the Arc network. Testnet tokens only — no monetary value.

## How it works

| Action | Cost | Effect |
|---|---|---|
| **Register** (once, ever) | 1.00 USDC | Profile created, `streak = 1`, `longestStreak = 1` |
| **Daily claim** | 0.01 USDC | `streak + 1` if ≥ 24h and ≤ 48h since last claim |
| **Missed window** (> 48h) | 0.01 USDC | Streak restarts at 1; `longestStreak` preserved |

All fees accumulate **inside the contract**; only the configured treasury (intended
to be a Safe multisig) can ever receive withdrawals. The owner cannot touch user
records, change fees, change the token, or pay itself.

## Repository layout

```
contracts-foundry/
  src/ArcDailyStreak.sol          # the contract (Solidity 0.8.24, OZ 5.x)
  test/ArcDailyStreak.t.sol       # 52 unit + fuzz tests
  test/ArcDailyStreak.invariant.t.sol  # 4 invariant suites (handler-based)
  test/mocks/Mocks.sol            # mock USDC, fee-on-transfer, reentrant token
  script/Deploy.s.sol             # chain-id-guarded deploy script
  slither-report.txt              # static analysis output
frontend/
  app/ components/ lib/           # Next.js 14 + wagmi v2 + viem + RainbowKit
docs/
  ARCHITECTURE.md  SECURITY.md  THREAT_MODEL.md
  GAS_OPTIMIZATION.md  AUDIT_CHECKLIST.md  DEPLOYMENT.md
```

## Canonical network parameters (verified live via RPC)

| Parameter | Value |
|---|---|
| Chain ID | `5042002` (hex `0x4cef52`) |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Native USDC (6 decimals) | `0x3600000000000000000000000000000000000000` |

## Contract quality gates (all green)

- `forge build` — clean compile, Solidity 0.8.24, optimizer 200 runs
- `forge test` — **56/56 passed** (unit, fuzz @ 1024 runs, invariants @ 64 runs × 128 depth)
- `forge coverage` — **100% lines / 100% statements / 100% branches / 100% functions**
- `forge fmt` — formatted
- Slither — no High/Medium findings (2 informational: benign `block.timestamp`
  comparisons inherent to the product, and the `USDC` immutable naming convention;
  both documented in `docs/SECURITY.md`)

## Frontend environment variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_STREAK_CONTRACT` | yes | Deployed `ArcDailyStreak` address |
| `NEXT_PUBLIC_WALLETCONNECT_ID` | recommended | WalletConnect Cloud project id (injected wallets work without it) |

Copy `frontend/.env.example` to `frontend/.env.local` for local dev.

## Quick start

```bash
# Contracts
cd contracts-foundry
forge test -vv
forge coverage

# Frontend
cd frontend
npm install
npm run dev        # http://localhost:3000
```

Deployment instructions: **docs/DEPLOYMENT.md** (contract via Foundry script or
Remix, frontend via Vercel).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — design decisions and trust assumptions
- [Security Notes](docs/SECURITY.md) — every control, every deliberate omission
- [Threat Model](docs/THREAT_MODEL.md) — attack-by-attack analysis
- [Gas Optimization Notes](docs/GAS_OPTIMIZATION.md)
- [Audit Checklist](docs/AUDIT_CHECKLIST.md) — for the external audit
- [Deployment Guide](docs/DEPLOYMENT.md)

## License

MIT
