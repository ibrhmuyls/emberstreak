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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtUsdc(v?: bigint): string {
  if (v === undefined) return "—";
  return `${formatUnits(v, USDC_DECIMALS)} USDC`;
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
  const balanceQ = useReadContract({
    ...common,
    functionName: "contractBalance",
    query: {enabled: ready, refetchInterval: 30_000},
  });
  const treasuryQ = useReadContract({
    ...common,
    functionName: "treasury",
    query: {enabled: ready, refetchInterval: 60_000},
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
    void balanceQ.refetch();
    void usdcBalQ.refetch();
    void allowanceQ.refetch();
  }, [userQ, balanceQ, usdcBalQ, allowanceQ]);

  // ------------------------------------------------------------------
  // Transaction helpers
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
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy("idle");
      refetchAll();
    }
  }, [ensureAllowance, sendStreakTx, refetchAll, expired]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <main className="mx-auto max-w-4xl px-4 pb-20 pt-8">
      {/* Header */}
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-100">
            <span className="text-cyan-400">Arc</span> Daily Streak
          </h1>
          <p className="text-sm text-slate-500">On-chain daily streaks on Arc Testnet · USDC</p>
        </div>
        <ConnectButton showBalance={false} />
      </header>

      {/* Config / network warnings */}
      {!CONTRACT_CONFIGURED && (
        <div className="card mb-6 border-amber-700/60 bg-amber-950/30 text-amber-200">
          <p className="font-semibold">Contract not configured</p>
          <p className="mt-1 text-sm">
            Set <code className="rounded bg-black/40 px-1">NEXT_PUBLIC_STREAK_CONTRACT</code> to the deployed
            ArcDailyStreak address and redeploy the frontend.
          </p>
        </div>
      )}

      {wrongNetwork && (
        <div className="card mb-6 flex flex-wrap items-center justify-between gap-3 border-rose-700/60 bg-rose-950/30 text-rose-200">
          <p className="font-semibold">Wrong network — this app runs on Arc Testnet (chain 5042002).</p>
          <button className="btn-secondary" onClick={() => switchChain({chainId: arcTestnet.id})}>
            Switch to Arc Testnet
          </button>
        </div>
      )}

      {paused && (
        <div className="card mb-6 border-amber-700/60 bg-amber-950/30 text-amber-200">
          <p className="font-semibold">Contract paused</p>
          <p className="mt-1 text-sm">Registrations and claims are temporarily disabled by the administrator.</p>
        </div>
      )}

      {!isConnected ? (
        <section className="card text-center">
          <h2 className="text-xl font-bold text-slate-100">Build your on-chain streak</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-400">
            Register once for <strong className="text-slate-200">1.00 USDC</strong>, then claim every day for{" "}
            <strong className="text-slate-200">0.01 USDC</strong> to extend your streak. Miss the 48-hour window
            and your streak restarts at 1 — your longest streak is preserved forever. Everything lives on-chain;
            this site only displays blockchain state.
          </p>
          <div className="mt-6 flex justify-center">
            <ConnectButton />
          </div>
        </section>
      ) : (
        <>
          {/* Streak stats */}
          <section className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="card">
              <p className="stat-label">Current streak</p>
              <p className="stat-value">
                {registered ? `${user!.streak} 🔥` : "—"}
                {expired && registered && (
                  <span className="ml-2 align-middle text-xs font-semibold text-rose-400">expired</span>
                )}
              </p>
            </div>
            <div className="card">
              <p className="stat-label">Longest streak</p>
              <p className="stat-value">{registered ? String(user!.longestStreak) : "—"}</p>
            </div>
            <div className="card">
              <p className="stat-label">Your USDC</p>
              <p className="stat-value">{fmtUsdc(usdcBalQ.data as bigint | undefined)}</p>
            </div>
            <div className="card">
              <p className="stat-label">Next claim in</p>
              <p className="stat-value tabular-nums">
                {registered ? (claimable ? "Now" : fmtCountdown(secondsToClaim)) : "—"}
              </p>
            </div>
          </section>

          {/* Action */}
          <section className="card mb-6">
            {!registered ? (
              <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-100">Start your streak</h2>
                  <p className="mt-1 text-sm text-slate-400">
                    One-time registration fee: <strong className="text-slate-200">1.00 USDC</strong>. Never charged
                    again. Your streak starts at 1 immediately.
                  </p>
                </div>
                <button
                  className="btn-primary"
                  disabled={busy !== "idle" || !ready || paused}
                  onClick={onRegister}
                >
                  {busy === "approving"
                    ? "Approving USDC…"
                    : busy === "registering"
                      ? "Registering…"
                      : "Register · 1.00 USDC"}
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-100">
                    {expired ? "Streak expired — restart it" : claimable ? "Claim available!" : "Come back soon"}
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">
                    {expired ? (
                      <>
                        More than 48h passed since your last claim. Claiming now costs{" "}
                        <strong className="text-slate-200">0.01 USDC</strong> and restarts your streak at 1. Your
                        longest streak ({String(user!.longestStreak)}) is preserved.
                      </>
                    ) : claimable ? (
                      <>
                        Pay <strong className="text-slate-200">0.01 USDC</strong> to extend your streak to{" "}
                        {user!.streak + 1}. Claim within{" "}
                        <strong className="text-slate-200">{fmtCountdown(secondsToExpiry)}</strong> or it resets.
                      </>
                    ) : (
                      <>
                        Next claim unlocks in{" "}
                        <strong className="tabular-nums text-slate-200">{fmtCountdown(secondsToClaim)}</strong>.
                        After unlocking, claim before the 48h mark to keep your streak.
                      </>
                    )}
                  </p>
                </div>
                <button
                  className="btn-primary"
                  disabled={busy !== "idle" || !claimable || paused}
                  onClick={onClaim}
                >
                  {busy === "approving"
                    ? "Approving USDC…"
                    : busy === "claiming"
                      ? "Claiming…"
                      : expired
                        ? "Restart streak · 0.01 USDC"
                        : "Claim · 0.01 USDC"}
                </button>
              </div>
            )}

            {error && (
              <p className="mt-4 rounded-lg border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
                {error}
              </p>
            )}
            {notice && !error && (
              <p className="mt-4 rounded-lg border border-cyan-800 bg-cyan-950/30 px-4 py-3 text-sm text-cyan-200">
                {notice}
              </p>
            )}
          </section>

          {/* Profile details */}
          {registered && (
            <section className="mb-6 grid gap-4 md:grid-cols-2">
              <div className="card">
                <p className="stat-label">Registered</p>
                <p className="mt-1 text-sm text-slate-300">
                  {new Date(Number(user!.registeredAt) * 1000).toLocaleString()}
                </p>
                <p className="stat-label mt-4">Last claim</p>
                <p className="mt-1 text-sm text-slate-300">{new Date(lastClaim * 1000).toLocaleString()}</p>
              </div>
              <div className="card">
                <p className="stat-label">Claim window</p>
                <p className="mt-1 text-sm text-slate-300">
                  Opens: {new Date(nextClaimAt * 1000).toLocaleString()}
                </p>
                <p className="mt-1 text-sm text-slate-300">
                  Expires: {new Date(expiresAt * 1000).toLocaleString()}
                </p>
                {registered && !expired && (
                  <p className="mt-2 text-xs text-slate-500">
                    Streak survives if you claim before the expiry time.
                  </p>
                )}
              </div>
            </section>
          )}
        </>
      )}

      {/* Contract info */}
      <section className="mb-6 grid gap-4 md:grid-cols-2">
        <div className="card">
          <p className="stat-label">Contract USDC balance</p>
          <p className="stat-value">{fmtUsdc(balanceQ.data as bigint | undefined)}</p>
          <p className="mt-3 text-xs text-slate-500">
            Fees accumulate in the contract; only the treasury can receive withdrawals.
          </p>
        </div>
        <div className="card">
          <p className="stat-label">Addresses</p>
          <ul className="mt-2 space-y-2 text-sm">
            <li>
              <span className="text-slate-500">Contract: </span>
              <a
                className="text-cyan-400 hover:underline"
                href={`${EXPLORER_URL}/address/${STREAK_CONTRACT}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {shortAddr(STREAK_CONTRACT)}
              </a>
            </li>
            <li>
              <span className="text-slate-500">Treasury: </span>
              <a
                className="text-cyan-400 hover:underline"
                href={`${EXPLORER_URL}/address/${treasuryQ.data ?? ""}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {shortAddr(treasuryQ.data as string | undefined)}
              </a>
            </li>
            <li>
              <span className="text-slate-500">USDC: </span>
              <a
                className="text-cyan-400 hover:underline"
                href={`${EXPLORER_URL}/token/${USDC_ADDRESS}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {shortAddr(USDC_ADDRESS)}
              </a>
            </li>
          </ul>
        </div>
      </section>

      {/* Session transaction history */}
      {txs.length > 0 && (
        <section className="card">
          <p className="stat-label mb-3">Your transactions (this session)</p>
          <ul className="space-y-2 text-sm">
            {txs.map((t) => (
              <li key={t.hash} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-slate-300">{t.label}</span>
                <span className="flex items-center gap-3">
                  <span
                    className={
                      t.status === "confirmed"
                        ? "text-emerald-400"
                        : t.status === "failed"
                          ? "text-rose-400"
                          : "text-amber-300"
                    }
                  >
                    {t.status}
                  </span>
                  <a
                    className="text-cyan-400 hover:underline"
                    href={`${EXPLORER_URL}/tx/${t.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {shortAddr(t.hash)}
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-10 text-center text-xs leading-5 text-slate-600">
        <p>
          Unofficial community project on Arc Testnet. Not affiliated with, endorsed by, or sponsored by Circle or
          the Arc network. Testnet tokens only — no monetary value.
        </p>
        <p className="mt-1">
          All state lives on-chain. This site holds no funds and has no backend.
        </p>
      </footer>
    </main>
  );
}
