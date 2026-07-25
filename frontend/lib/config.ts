import {defineChain} from "viem";

/** Arc Testnet — canonical parameters (verified live via RPC). */
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {name: "USDC", symbol: "USDC", decimals: 18},
  rpcUrls: {
    default: {http: ["https://rpc.testnet.arc.network"]},
  },
  blockExplorers: {
    default: {name: "Arcscan", url: "https://testnet.arcscan.app"},
  },
  testnet: true,
});

/** Official Arc Testnet native USDC (6 decimals). */
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

/**
 * ArcDailyStreak contract address.
 * Set NEXT_PUBLIC_STREAK_CONTRACT after deployment; the zero address keeps
 * the UI in a loud "not configured" state instead of failing silently.
 */
export const STREAK_CONTRACT = ((process.env.NEXT_PUBLIC_STREAK_CONTRACT as `0x${string}` | undefined) ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

export const CONTRACT_CONFIGURED =
  STREAK_CONTRACT !== "0x0000000000000000000000000000000000000000";

export const EXPLORER_URL = "https://testnet.arcscan.app";

export const REGISTRATION_FEE = 1_000_000n; // 1.00 USDC (6 decimals)
export const DAILY_FEE = 10_000n; // 0.01 USDC (6 decimals)
export const USDC_DECIMALS = 6;
