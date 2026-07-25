import dynamic from "next/dynamic";

// Wallet UI depends on window; render client-side only.
const StreakApp = dynamic(() => import("@/components/StreakApp"), {ssr: false});

export default function Home() {
  return <StreakApp />;
}
