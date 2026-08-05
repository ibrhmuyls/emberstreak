"use client";

import {getDefaultConfig} from "@rainbow-me/rainbowkit";
import {http} from "wagmi";
import {arcTestnet} from "./config";

/**
 * WalletConnect project id. RainbowKit requires one; get a free id at
 * https://cloud.walletconnect.com and set NEXT_PUBLIC_WALLETCONNECT_ID.
 * A placeholder keeps injected wallets (MetaMask etc.) fully functional.
 */
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_ID ?? "00000000000000000000000000000000";

export const wagmiConfig = getDefaultConfig({
  appName: "EmberStreak",
  projectId,
  chains: [arcTestnet],
  transports: {
    // Same-origin proxy (app/api/rpc) — the public Arc RPC sends no CORS
    // headers and rejects browser preflights, so calling it directly from the
    // browser fails with "HTTP request failed." The proxy forwards server-side.
    [arcTestnet.id]: http("/api/rpc", {
      batch: false,
      retryCount: 3,
      retryDelay: 500,
    }),
  },
  ssr: true,
});
