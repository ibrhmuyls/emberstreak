# Deployment Guide — EmberStreak

## 0. Prerequisites

- Arc Testnet wallet funded with native gas USDC (faucet: see Arc docs / Circle faucet)
- Decide two addresses **before** deploying:
  - **OWNER** — admin (pause/unpause/withdraw/setTreasury). Strongly recommended: a Safe multisig or at least a hardware wallet.
  - **TREASURY** — fee destination. Strongly recommended: a Safe multisig. Can be rotated later by the owner.

Canonical network values (verified live):

| | |
|---|---|
| Chain ID | 5042002 (`0x4cef52`) |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| USDC | `0x3600000000000000000000000000000000000000` |

## Current deployment (Arc Testnet)

| | |
|---|---|
| Contract | `ArcDailyStreak` (source name), product name **EmberStreak** |
| Address | `0x878B1ECE9f861D8E9a0DdB6a3dA7cc4CA5F70423` |
| Compiler | Solidity `0.8.24+commit.e11b9ed9`, EVM `shanghai`, optimizer **off** |
| Owner / Treasury | `0xCb4D9629D3F6cc5C26dd1B6E56320602177A7a70` |
| Frontend | `https://emberstreak.vercel.app` |

> Deployed via Remix single-file flat (OZ bundled). Verify on Arcscan with the
> same settings + ABI-encoded constructor args
> `0x0000...3600...0000cb4d...7a700000...cb4d...7a70`.

## 1A. Deploy the contract — Foundry script (recommended)

```bash
cd contracts-foundry

export PRIVATE_KEY=0x...        # throwaway deployer key, testnet only
export OWNER=0xYourOwnerSafe
export TREASURY=0xYourTreasurySafe

forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.arc.network \
  --broadcast
```

The script **refuses to run on any chain other than 5042002** and pins the
canonical USDC address — the token is deliberately not configurable via env.

Record the printed `ArcDailyStreak deployed:` address.

## 1B. Deploy the contract — Remix (browser-only alternative)

1. Open remix.ethereum.org → create `ArcDailyStreak.sol`, paste `src/ArcDailyStreak.sol`.
2. Compiler 0.8.24, optimizer ON (200 runs). OpenZeppelin imports resolve automatically via Remix's GitHub import.
3. Deploy with MetaMask connected to Arc Testnet, constructor args:
   - `usdcToken`: `0x3600000000000000000000000000000000000000`
   - `initialOwner`: your OWNER address
   - `initialTreasury`: your TREASURY address
4. Verify on `https://testnet.arcscan.app` (single-file or standard-json).

## 2. Post-deploy verification (do not skip)

```bash
C=<deployed address>
RPC=https://rpc.testnet.arc.network

# USDC() must return 0x36..0000
cast call $C "USDC()(address)" --rpc-url $RPC
# treasury() must be your Safe
cast call $C "treasury()(address)" --rpc-url $RPC
# fees must be 1000000 / 10000
cast call $C "registrationFee()(uint256)" --rpc-url $RPC
cast call $C "dailyFee()(uint256)" --rpc-url $RPC
# paused() must be false
cast call $C "paused()(bool)" --rpc-url $RPC
```

## 3. Frontend on Vercel

1. Push this repository to GitHub (private is fine).
2. Vercel → New Project → import → **Root Directory: `frontend`** (framework auto-detected: Next.js).
3. Environment variables:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_STREAK_CONTRACT` | deployed contract address |
| `NEXT_PUBLIC_WALLETCONNECT_ID` | WalletConnect Cloud project id (optional but recommended) |

4. Deploy. No backend, no serverless functions, no secrets beyond the two public vars.

Local dev:

```bash
cd frontend
cp .env.example .env.local   # fill values
npm install
npm run dev
```

## 4. Operational runbook

- **Withdraw fees**: owner calls `withdraw(amount)`; funds go to the treasury only.
- **Rotate treasury**: owner calls `setTreasury(newSafe)`; verify the `TreasuryChanged` event.
- **Emergency**: `pause()` halts register/claim; `withdraw` still works; `unpause()` resumes.
- **Ownership handover**: `transferOwnership(new)` then `acceptOwnership()` from the new key (2-step).
- **Monitoring**: watch `TreasuryChanged`, `Paused`, `Withdraw` events on the explorer; any unexpected occurrence indicates key compromise.
