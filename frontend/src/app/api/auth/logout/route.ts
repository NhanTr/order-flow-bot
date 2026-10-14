import { NextResponse } from "next/server";

import { API_BASE_URL, clearSessionCookies, getBffConfig, noStore, readSessionTokens } from "@/lib/server-api";
import { buildUpstreamHeaders, RequestSecurityError, requireSameOriginMutation, trustedClientIp } from "@/lib/request-security";
import { invalidateRefreshSession } from "@/lib/session-refresh";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const config = getBffConfig();
    requireSameOriginMutation(request, config.publicOrigin);
    const { accessToken, refreshToken } = await readSessionTokens();
    if (accessToken) {
      await fetch(`${API_BASE_URL}/admin/auth/logout`, {
        method: "POST",
        headers: buildUpstreamHeaders(request, {
          accessToken,
          proxySecret: config.proxySecret,
          clientIp: trustedClientIp(request, config.trustProxyHops),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
    }
    if (refreshToken) await invalidateRefreshSession(refreshToken).catch(() => undefined);
    const response = noStore(NextResponse.json({ ok: true }));
    clearSessionCookies(response);
    return response;
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return noStore(NextResponse.json({ error: { code: "FORBIDDEN", message: error.message } }, { status: error.status }));
    }
    return noStore(NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Logout service is unavailable" } }, { status: 503 }));
  }
}
