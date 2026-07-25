"use client";

import * as React from "react";
import {Check, Flame} from "./icons";

/**
 * Horizontal streak timeline: shows recent completed days, the current day,
 * and the upcoming days. Pure presentation — derives everything from the
 * on-chain streak value. No invented bonuses or rewards.
 */
export function StreakTimeline({streak}: {streak: number}) {
  // Window of 7 steps centered so the current day sits in the middle-right.
  const start = Math.max(1, streak - 3);
  const steps = Array.from({length: 7}, (_, i) => start + i);

  return (
    <div className="flex items-center justify-between gap-1 overflow-x-auto py-2" aria-label="Streak timeline">
      {steps.map((day, i) => {
        const done = day < streak;
        const current = day === streak;
        return (
          <React.Fragment key={day}>
            {i > 0 && (
              <div
                className={`h-px min-w-3 flex-1 ${done || current ? "bg-cyan-500/50" : "bg-slate-800"}`}
              />
            )}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={
                  current
                    ? "flex h-9 w-9 items-center justify-center rounded-full bg-cyan-400 text-cyan-950 shadow-[0_0_14px_rgba(34,211,238,0.4)]"
                    : done
                      ? "flex h-8 w-8 items-center justify-center rounded-full border border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                      : "flex h-8 w-8 items-center justify-center rounded-full border border-slate-700 bg-slate-800/60 text-slate-600"
                }
              >
                {done ? <Check size={14} /> : current ? <Flame size={16} /> : <span className="text-xs">{day}</span>}
              </div>
              <span className={`text-[10px] ${current ? "font-semibold text-cyan-300" : "text-slate-600"}`}>
                Day {day}
              </span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
