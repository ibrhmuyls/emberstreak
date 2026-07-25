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
  appName: "Arc Daily Streak",
  projectId,
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network", {
      batch: false,
      retryCount: 3,
      retryDelay: 500,
    }),
  },
  ssr: true,
});
