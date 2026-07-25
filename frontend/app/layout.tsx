import type {Metadata} from "next";
import {Providers} from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arc Daily Streak",
  description:
    "On-chain daily streak tracker on Arc Testnet. Register once for 1 USDC, claim daily for 0.01 USDC, keep your streak alive.",
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#070b12] text-slate-200 antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
