import { NextResponse } from "next/server";

import { API_BASE_URL, getBffConfig, noStore, safeJson, setSessionCookies } from "@/lib/server-api";
import { buildUpstreamHeaders, RequestSecurityError, requireSameOriginMutation, trustedClientIp } from "@/lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const config = getBffConfig();
    requireSameOriginMutation(request, config.publicOrigin);
    const upstream = await fetch(`${API_BASE_URL}/admin/auth/login`, {
      method: "POST",
      headers: buildUpstreamHeaders(request, {
        proxySecret: config.proxySecret,
        clientIp: trustedClientIp(request, config.trustProxyHops),
      }),
      body: await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);

    if (!upstream) return noStore(NextResponse.json({ message: "API backend chưa sẵn sàng." }, { status: 503 }));
    const payload = await safeJson(upstream) as { data?: { user?: unknown; accessToken?: string; refreshToken?: string; expiresIn?: number } } | null;
    if (!payload) {
      return noStore(NextResponse.json(
        { error: { code: "BAD_GATEWAY", message: "API backend returned an invalid response" } },
        { status: 502 },
      ));
    }
    const response = noStore(NextResponse.json(upstream.ok ? { user: payload.data?.user } : payload, { status: upstream.status }));
    if (upstream.ok) {
      if (
        typeof payload.data?.accessToken !== "string"
        || typeof payload.data.refreshToken !== "string"
        || typeof payload.data.expiresIn !== "number"
      ) {
        return noStore(NextResponse.json(
          { error: { code: "BAD_GATEWAY", message: "API backend returned an invalid response" } },
          { status: 502 },
        ));
      }
      await setSessionCookies(response, {
        accessToken: payload.data.accessToken,
        refreshToken: payload.data.refreshToken,
        expiresIn: payload.data.expiresIn,
      });
    }
    return response;
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return noStore(NextResponse.json({ error: { code: "FORBIDDEN", message: error.message } }, { status: error.status }));
    }
    return noStore(NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Login service is unavailable" } }, { status: 503 }));
  }
}
