import {NextRequest, NextResponse} from "next/server";

/**
 * CORS proxy for the Arc Testnet RPC.
 *
 * The public Arc RPC (rpc.testnet.arc.network) does NOT send
 * `Access-Control-Allow-Origin` and rejects browser OPTIONS preflights, so a
 * no-backend browser dApp cannot call it directly — viem throws
 * "HTTP request failed." This same-origin serverless route forwards JSON-RPC
 * calls server-side (where CORS does not apply) and returns them to the
 * browser with permissive CORS headers. Same-origin requests never trigger a
 * browser preflight, so the dApp works from any wallet.
 */
const ARC_RPC = "https://rpc.testnet.arc.network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const upstream = await fetch(ARC_RPC, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body,
      cache: "no-store",
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown proxy error";
    return NextResponse.json(
      {jsonrpc: "2.0", id: null, error: {code: -32603, message: `Proxy request failed: ${message}`}},
      {status: 502, headers: CORS_HEADERS},
    );
  }
}

// Same-origin requests don't require preflight, but handle it explicitly so
// the route also works if ever called cross-origin (e.g. local tooling).
export async function OPTIONS() {
  return new NextResponse(null, {status: 204, headers: CORS_HEADERS});
}
