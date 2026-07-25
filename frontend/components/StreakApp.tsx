"use client";

import * as React from "react";
import {ConnectButton} from "@rainbow-me/rainbowkit";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import {formatUnits} from "viem";
import {arcDailyStreakAbi, erc20Abi} from "@/lib/abi";
import {
  CONTRACT_CONFIGURED,
  DAILY_FEE,
  EXPLORER_URL,
  REGISTRATION_FEE,
  STREAK_CONTRACT,
  USDC_ADDRESS,
  USDC_DECIMALS,
  arcTestnet,
} from "@/lib/config";
import {explainError} from "@/lib/errors";
import {CountdownRing} from "./CountdownRing";
import {StreakTimeline} from "./StreakTimeline";
import {Calendar, ChevronDown, Clock, Coins, ExternalLink, Flame, ShieldCheck, Trophy, Wallet} from "./icons";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** USDC display, always 2 decimals ("13.74 USDC"). */
function fmtUsdc2(v?: bigint): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, USDC_DECIMALS));
  return `${n.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
}

function fmtCountdown(totalSeconds: number): string {
  if (totalSeconds <= 0) return "00:00:00";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((x) => String(x).padStart(2, "0")).join(":");
}

function shortAddr(a?: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

type TxRecord = {
  hash: `0x${string}`;
  label: string;
  time: number;
  status: "pending" | "confirmed" | "failed";
};

type Busy = "idle" | "approving" | "registering" | "claiming";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function StreakApp() {
  const {address, isConnected} = useAccount();
  const chainId = useChainId();
  const {switchChain} = useSwitchChain();
  const publicClient = usePublicClient();
  const {writeContractAsync} = useWriteContract();

  const wrongNetwork = isConnected && chainId !== arcTestnet.id;
  const ready = isConnected && !wrongNetwork && CONTRACT_CONFIGURED;

  const [busy, setBusy] = React.useState<Busy>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [txs, setTxs] = React.useState<TxRecord[]>([]);
  const [now, setNow] = React.useState<number>(() => Math.floor(Date.now() / 1000));
  const [justClaimed, setJustClaimed] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  // 1s ticker for the countdown.
  React.useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // ------------------------------------------------------------------
  // On-chain reads (contract is the single source of truth)
  // ------------------------------------------------------------------

  const common = {abi: arcDailyStreakAbi, address: STREAK_CONTRACT} as const;
  const enabled = ready && !!address;

  const userQ = useReadContract({
    ...common,
    functionName: "getUser",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: {enabled, refetchInterval: 15_000},
  });
  const pausedQ = useReadContract({
    ...common,
    functionName: "paused",
    query: {enabled: ready, refetchInterval: 30_000},
  });
  const treasuryQ = useReadContract({
    ...common,
    functionName: "treasury",
    query: {enabled: ready && advancedOpen, refetchInterval: 60_000},
  });
  const usdcBalQ = useReadContract({
    abi: erc20Abi,
    address: USDC_ADDRESS,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: {enabled, refetchInterval: 15_000},
  });
  const allowanceQ = useReadContract({
    abi: erc20Abi,
    address: USDC_ADDRESS,
    functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", STREAK_CONTRACT],
    query: {enabled, refetchInterval: 15_000},
  });

  const user = userQ.data;
  const registered = !!user?.exists;
  const paused = pausedQ.data === true;

  const lastClaim = user ? Number(user.lastClaim) : 0;
  const nextClaimAt = registered ? lastClaim + 24 * 3600 : 0;
  const expiresAt = registered ? lastClaim + 48 * 3600 : 0;
  const secondsToClaim = registered ? Math.max(0, nextClaimAt - now) : 0;
  const secondsToExpiry = registered ? Math.max(0, expiresAt - now) : 0;
  const claimable = registered && !paused && secondsToClaim === 0;
  const expired = registered && now > expiresAt;

  const refetchAll = React.useCallback(() => {
    void userQ.refetch();
    void usdcBalQ.refetch();
    void allowanceQ.refetch();
  }, [userQ, usdcBalQ, allowanceQ]);

  // ------------------------------------------------------------------
  // Transaction helpers (flow preserved: simulate → approve → wait → act)
  // ------------------------------------------------------------------

  const trackTx = React.useCallback((hash: `0x${string}`, label: string) => {
    setTxs((prev) => [{hash, label, time: Date.now(), status: "pending" as const}, ...prev].slice(0, 20));
  }, []);

  const settleTx = React.useCallback((hash: `0x${string}`, ok: boolean) => {
    setTxs((prev) => prev.map((t) => (t.hash === hash ? {...t, status: ok ? "confirmed" : "failed"} : t)));
  }, []);

  /**
   * Ensures allowance >= fee. Sends approve and — critically — WAITS for the
   * approval receipt before returning, so the follow-up transaction never
   * races a still-pending approval (allowance would read 0 and revert).
   */
  const ensureAllowance = React.useCallback(
    async (fee: bigint): Promise<void> => {
      if (!publicClient || !address) throw new Error("Client not ready.");
      const current = (await publicClient.readContract({
        abi: erc20Abi,
        address: USDC_ADDRESS,
        functionName: "allowance",
        args: [address, STREAK_CONTRACT],
      })) as bigint;
      if (current >= fee) return;

      setBusy("approving");
      setNotice(`Approving ${formatUnits(fee, USDC_DECIMALS)} USDC…`);
      const hash = await writeContractAsync({
        abi: erc20Abi,
        address: USDC_ADDRESS,
        functionName: "approve",
        args: [STREAK_CONTRACT, fee],
        chainId: arcTestnet.id,
      });
      trackTx(hash, "Approve USDC");
      const receipt = await publicClient.waitForTransactionReceipt({hash, timeout: 120_000});
      settleTx(hash, receipt.status === "success");
      if (receipt.status !== "success") throw new Error("USDC approval failed on-chain.");
      setNotice("Approval confirmed.");
    },
    [publicClient, address, writeContractAsync, trackTx, settleTx],
  );

  /** Simulates, sends, and awaits a streak-contract write. */
  const sendStreakTx = React.useCallback(
    async (functionName: "register" | "claim", label: string): Promise<void> => {
      if (!publicClient || !address) throw new Error("Client not ready.");
      // Simulation first: surfaces the exact custom error before any gas is spent.
      const {request} = await publicClient.simulateContract({
        abi: arcDailyStreakAbi,
        address: STREAK_CONTRACT,
        functionName,
        account: address,
        chain: arcTestnet,
      });
      const hash = await writeContractAsync(request);
      trackTx(hash, label);
      setNotice(`${label} sent — waiting for confirmation…`);
      try {
        const receipt = await publicClient.waitForTransactionReceipt({hash, timeout: 120_000});
        settleTx(hash, receipt.status === "success");
        if (receipt.status !== "success") throw new Error(`${label} reverted on-chain.`);
      } catch (e) {
        // Slow-testnet guard: the tx may have landed even if waiting timed out.
        const msg = e instanceof Error ? e.message : "";
        if (msg.toLowerCase().includes("timed out")) {
          setNotice(`${label} submitted (confirmation is slow). Check the explorer.`);
          return;
        }
        throw e;
      }
    },
    [publicClient, address, writeContractAsync, trackTx, settleTx],
  );

  const onRegister = React.useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      await ensureAllowance(REGISTRATION_FEE);
      setBusy("registering");
      await sendStreakTx("register", "Register (1.00 USDC)");
      setNotice("Registered! Your streak starts at 1. Come back in 24 hours.");
      setJustClaimed(true);
      setTimeout(() => setJustClaimed(false), 2500);
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy("idle");
      refetchAll();
    }
  }, [ensureAllowance, sendStreakTx, refetchAll]);

  const onClaim = React.useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      await ensureAllowance(DAILY_FEE);
      setBusy("claiming");
      await sendStreakTx("claim", "Daily claim (0.01 USDC)");
      setNotice(expired ? "Streak restarted at 1 — keep it going!" : "Claim confirmed — streak extended!");
      setJustClaimed(true);
      setTimeout(() => setJustClaimed(false), 2500);
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy("idle");
      refetchAll();
    }
  }, [ensureAllowance, sendStreakTx, refetchAll, expired]);

  // ------------------------------------------------------------------
  // Countdown ring labels
  // ------------------------------------------------------------------

  const ringLabel = !registered ? "—" : claimable ? "Ready" : fmtCountdown(secondsToClaim);
  const ringSublabel = !registered
    ? ""
    : claimable
      ? expired
        ? "Claim to restart your streak"
        : `Claim within ${fmtCountdown(secondsToExpiry)} to keep your streak`
      : "until your next claim";

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6">
      {/* Header */}
      <header className="mb-10 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-400">
            <Flame size={22} />
          </div>
          <div>
            <h1 className="text-lg font-black tracking-tight text-slate-100">EmberStreak</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-800/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Built on Arc · Testnet
            </span>
          </div>
        </div>
        <ConnectButton showBalance={false} chainStatus="none" />
      </header>

      {/* Config / network warnings */}
      {!CONTRACT_CONFIGURED && (
        <div className="card mb-6 border-amber-700/60 bg-amber-950/30 text-amber-200">
          <p className="font-semibold">Contract not configured</p>
          <p className="mt-1 text-sm">
            Set <code className="rounded bg-black/40 px-1">NEXT_PUBLIC_STREAK_CONTRACT</code> and redeploy.
          </p>
        </div>
      )}

      {wrongNetwork && (
        <div className="card mb-6 flex flex-wrap items-center justify-between gap-3 border-rose-700/60 bg-rose-950/30 text-rose-200">
          <p className="text-sm font-semibold">Wrong network — this app runs on Arc Testnet.</p>
          <button className="btn-secondary" onClick={() => switchChain({chainId: arcTestnet.id})}>
            Switch network
          </button>
        </div>
      )}

      {paused && (
        <div className="card mb-6 border-amber-700/60 bg-amber-950/30 text-amber-200">
          <p className="text-sm font-semibold">Contract paused — claims are temporarily disabled.</p>
        </div>
      )}

      {!isConnected ? (
        /* ---------------- Landing (disconnected) ---------------- */
        <section className="fade-up card card-hover px-8 py-14 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-400/10 text-cyan-400">
            <Flame size={30} />
          </div>
          <h2 className="mt-6 text-3xl font-black tracking-tight text-slate-100 sm:text-4xl">
            Build consistency.
            <br />
            <span className="text-cyan-400">Claim daily.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-slate-400">
            Register once for <strong className="text-slate-200">1.00 USDC</strong>, then check in every day for{" "}
            <strong className="text-slate-200">0.01 USDC</strong> to grow your on-chain streak. Miss 48 hours and
            it restarts — your longest streak is preserved forever. Built on the Arc Network testnet.
          </p>
          <div className="mt-8 flex justify-center">
            <ConnectButton label="Connect wallet to start" />
          </div>
          <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-slate-600">
            <ShieldCheck size={14} />
            Fully on-chain · No backend · Open source
          </p>
        </section>
      ) : (
        <>
          {/* ---------------- Hero: the three answers ---------------- */}
          <section className="fade-up mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {/* 1. How many days is my streak? */}
            <div className={`card card-hover text-center ${justClaimed ? "claim-success" : ""}`}>
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-orange-400/10 text-orange-400">
                <Flame size={20} />
              </div>
              <p className="stat-value mt-3">
                {registered ? user!.streak : "—"}
                {registered && <span className="ml-1 text-base font-semibold text-slate-400">day{user!.streak === 1 ? "" : "s"}</span>}
              </p>
              <p className="stat-label mt-2">Current streak</p>
              {expired && registered && (
                <p className="mt-1.5 text-[11px] font-semibold text-rose-400">expired — claim to restart</p>
              )}
            </div>

            {/* 2. Longest streak */}
            <div className="card card-hover text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400/10 text-amber-400">
                <Trophy size={20} />
              </div>
              <p className="stat-value mt-3">
                {registered ? user!.longestStreak : "—"}
                {registered && <span className="ml-1 text-base font-semibold text-slate-400">day{user!.longestStreak === 1 ? "" : "s"}</span>}
              </p>
              <p className="stat-label mt-2">Longest streak</p>
            </div>

            {/* 3. My balance */}
            <div className="card card-hover text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-400">
                <Wallet size={20} />
              </div>
              <p className="stat-value mt-3">
                {fmtUsdc2(usdcBalQ.data as bigint | undefined)}
                <span className="ml-1 text-base font-semibold text-slate-400">USDC</span>
              </p>
              <p className="stat-label mt-2">Your balance</p>
            </div>
          </section>

          {/* ---------------- Countdown + action ---------------- */}
          <section className="fade-up fade-up-1 card mb-6 flex flex-col items-center px-6 py-8">
            {registered ? (
              <>
                <CountdownRing
                  secondsRemaining={secondsToClaim}
                  totalSeconds={24 * 3600}
                  label={ringLabel}
                  sublabel={ringSublabel}
                  claimable={claimable}
                />
                <button
                  className="btn-primary mt-6 w-full max-w-xs"
                  disabled={busy !== "idle" || !claimable || paused}
                  onClick={onClaim}
                >
                  {busy === "approving" ? (
                    "Approving USDC…"
                  ) : busy === "claiming" ? (
                    "Claiming…"
                  ) : expired ? (
                    <>
                      <Flame size={18} /> Restart streak · 0.01 USDC
                    </>
                  ) : claimable ? (
                    <>
                      <Flame size={18} /> Claim day {user!.streak + 1} · 0.01 USDC
                    </>
                  ) : (
                    <>
                      <Clock size={18} /> Next claim in {fmtCountdown(secondsToClaim)}
                    </>
                  )}
                </button>

                {/* Timeline */}
                <div className="mt-8 w-full border-t border-slate-800/70 pt-6">
                  <StreakTimeline streak={user!.streak} />
                </div>
              </>
            ) : (
              <div className="flex w-full flex-col items-center py-4 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-400/10 text-cyan-400">
                  <Calendar size={24} />
                </div>
                <h2 className="mt-4 text-xl font-bold text-slate-100">Start your streak</h2>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-400">
                  One-time registration: <strong className="text-slate-200">1.00 USDC</strong>. Never charged
                  again. Your streak starts at day 1 immediately.
                </p>
                <button
                  className="btn-primary mt-6 w-full max-w-xs"
                  disabled={busy !== "idle" || !ready || paused}
                  onClick={onRegister}
                >
                  {busy === "approving" ? (
                    "Approving USDC…"
                  ) : busy === "registering" ? (
                    "Registering…"
                  ) : (
                    <>
                      <Coins size={18} /> Register · 1.00 USDC
                    </>
                  )}
                </button>
              </div>
            )}

            {error && (
              <p className="mt-5 w-full rounded-xl border border-rose-800/70 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
                {error}
              </p>
            )}
            {notice && !error && (
              <p className="mt-5 w-full rounded-xl border border-cyan-800/70 bg-cyan-950/30 px-4 py-3 text-sm text-cyan-200">
                {notice}
              </p>
            )}
          </section>

          {/* ---------------- Secondary info ---------------- */}
          {registered && (
            <section className="fade-up fade-up-2 mb-6 grid gap-4 sm:grid-cols-2">
              <div className="card">
                <p className="stat-label flex items-center gap-1.5">
                  <Calendar size={13} /> Member since
                </p>
                <p className="mt-2 text-sm text-slate-300">
                  {new Date(Number(user!.registeredAt) * 1000).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </p>
              </div>
              <div className="card">
                <p className="stat-label flex items-center gap-1.5">
                  <Clock size={13} /> Claim window
                </p>
                <p className="mt-2 text-sm text-slate-300">
                  Opens {new Date(nextClaimAt * 1000).toLocaleString()} · closes{" "}
                  {new Date(expiresAt * 1000).toLocaleString()}
                </p>
              </div>
            </section>
          )}

          {/* ---------------- Session transactions ---------------- */}
          {txs.length > 0 && (
            <section className="fade-up fade-up-3 card mb-6">
              <p className="stat-label mb-3">Recent activity</p>
              <ul className="space-y-2.5 text-sm">
                {txs.map((t) => (
                  <li key={t.hash} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-slate-300">{t.label}</span>
                    <span className="flex items-center gap-3">
                      <span
                        className={
                          t.status === "confirmed"
                            ? "inline-flex items-center gap-1 text-xs font-medium text-emerald-400"
                            : t.status === "failed"
                              ? "text-xs font-medium text-rose-400"
                              : "text-xs font-medium text-amber-300"
                        }
                      >
                        {t.status}
                      </span>
                      <a
                        className="inline-flex items-center gap-1 text-xs text-cyan-400 hover:underline"
                        href={`${EXPLORER_URL}/tx/${t.hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {shortAddr(t.hash)} <ExternalLink size={11} />
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ---------------- Advanced details (collapsed) ---------------- */}
          <section className="fade-up fade-up-3 mb-6">
            <button
              className="flex w-full items-center justify-between rounded-xl border border-slate-800/70 bg-slate-900/30 px-4 py-3 text-left text-xs font-medium text-slate-500 transition hover:text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-500"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
            >
              <span>Advanced details</span>
              <ChevronDown size={14} className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
            </button>
            {advancedOpen && (
              <div className="mt-2 rounded-xl border border-slate-800/70 bg-slate-900/30 px-4 py-3">
                <ul className="space-y-2 text-xs text-slate-500">
                  <li className="flex flex-wrap items-center justify-between gap-2">
                    <span>Streak contract</span>
                    <a
                      className="inline-flex items-center gap-1 text-cyan-500 hover:underline"
                      href={`${EXPLORER_URL}/address/${STREAK_CONTRACT}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {shortAddr(STREAK_CONTRACT)} <ExternalLink size={11} />
                    </a>
                  </li>
                  <li className="flex flex-wrap items-center justify-between gap-2">
                    <span>Treasury</span>
                    <a
                      className="inline-flex items-center gap-1 text-cyan-500 hover:underline"
                      href={`${EXPLORER_URL}/address/${treasuryQ.data ?? ""}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {shortAddr(treasuryQ.data as string | undefined)} <ExternalLink size={11} />
                    </a>
                  </li>
                  <li className="flex flex-wrap items-center justify-between gap-2">
                    <span>USDC token</span>
                    <a
                      className="inline-flex items-center gap-1 text-cyan-500 hover:underline"
                      href={`${EXPLORER_URL}/token/${USDC_ADDRESS}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {shortAddr(USDC_ADDRESS)} <ExternalLink size={11} />
                    </a>
                  </li>
                </ul>
              </div>
            )}
          </section>
        </>
      )}

      {/* ---------------- Footer ---------------- */}
      <footer className="mt-12 border-t border-slate-800/60 pt-6">
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-slate-500">
          <span className="text-slate-600">EmberStreak — built on Arc</span>
          <a
            className="hover:text-slate-300"
            href={`${EXPLORER_URL}/address/${STREAK_CONTRACT}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Contract
          </a>
          <a className="hover:text-slate-300" href={EXPLORER_URL} target="_blank" rel="noopener noreferrer">
            Explorer
          </a>
          <a
            className="hover:text-slate-300"
            href="https://github.com/ibrhmuyls/emberstreak"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </div>
        <p className="mt-4 text-center text-[11px] leading-4 text-slate-700">
          Unofficial community project. Not affiliated with, endorsed by, or sponsored by Circle or the Arc
          network. Arc is a trademark of Circle Internet Group, Inc. and/or its affiliates. Testnet tokens only —
          no monetary value. All state lives on-chain; this site holds no funds and has no backend.
        </p>
      </footer>
    </main>
  );
}
