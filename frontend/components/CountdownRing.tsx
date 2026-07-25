"use client";

import * as React from "react";

/**
 * Circular countdown ring. Fills as the 24h wait elapses; when claimable it
 * renders a complete cyan ring. Pure SVG — no animation library.
 */
export function CountdownRing({
  secondsRemaining,
  totalSeconds,
  label,
  sublabel,
  claimable,
}: {
  secondsRemaining: number;
  totalSeconds: number;
  label: string;
  sublabel: string;
  claimable: boolean;
}) {
  const R = 84;
  const CIRC = 2 * Math.PI * R;
  const progress =
    totalSeconds <= 0 ? 1 : Math.min(1, Math.max(0, (totalSeconds - secondsRemaining) / totalSeconds));
  const dash = CIRC * progress;

  return (
    <div className="relative flex h-[220px] w-[220px] items-center justify-center">
      <svg width="220" height="220" viewBox="0 0 220 220" className="-rotate-90">
        <circle cx="110" cy="110" r={R} fill="none" stroke="rgba(148,163,184,0.12)" strokeWidth="10" />
        <circle
          cx="110"
          cy="110"
          r={R}
          fill="none"
          stroke={claimable ? "#34d399" : "#22d3ee"}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRC - dash}`}
          className="transition-[stroke-dasharray] duration-1000 ease-linear"
          style={claimable ? {filter: "drop-shadow(0 0 8px rgba(52,211,153,0.45))"} : undefined}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span
          className={`text-4xl font-black tabular-nums tracking-tight ${
            claimable ? "text-emerald-300" : "text-slate-100"
          }`}
        >
          {label}
        </span>
        <span className="mt-1 max-w-[150px] text-xs leading-4 text-slate-500">{sublabel}</span>
      </div>
    </div>
  );
}
