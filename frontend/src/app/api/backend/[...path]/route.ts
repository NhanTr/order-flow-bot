import { NextResponse } from "next/server";

import {
  API_BASE_URL,
  clearSessionCookies,
  getBffConfig,
  noStore,
  readSessionTokens,
  setSessionCookies,
} from "@/lib/server-api";
import {
  buildUpstreamHeaders,
  RequestSecurityError,
  requireSameOriginMutation,
  trustedClientIp,
  upstreamTimeoutMs,
  validateBackendRoute,
} from "@/lib/request-security";
import { RefreshSessionUnavailableError, refreshSessionOnce } from "@/lib/session-refresh";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 1024 * 1024;

async function requestBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (["GET", "HEAD"].includes(request.method)) return undefined;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RequestSecurityError("Request body is too large", 413);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) throw new RequestSecurityError("Request body is too large", 413);
  return body;
}

async function proxyResponse(upstream: Response): Promise<NextResponse> {
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const headers = new Headers({ "content-type": contentType, "cache-control": "no-store", pragma: "no-cache" });
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) headers.set("content-disposition", disposition);
  if (contentType.toLowerCase().includes("json")) {
    const text = await upstream.text();
    if (text.length === 0) return new NextResponse(null, { status: upstream.status, headers });
    try {
      return NextResponse.json(JSON.parse(text), { status: upstream.status, headers });
    } catch {
      return noStore(NextResponse.json(
        { error: { code: "BAD_GATEWAY", message: "API backend returned an invalid response" } },
        { status: 502 },
      ));
    }
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const config = getBffConfig();
    requireSameOriginMutation(request, config.publicOrigin);
    const { path } = await context.params;
    const allowedPath = validateBackendRoute(path, request.method);
    const incomingUrl = new URL(request.url);
    const target = `${API_BASE_URL}/${allowedPath}${incomingUrl.search}`;
    const body = await requestBody(request);
    let { accessToken, refreshToken } = await readSessionTokens();
    const clientIp = trustedClientIp(request, config.trustProxyHops);

    const send = (token?: string) => fetch(target, {
      method: request.method,
      headers: buildUpstreamHeaders(request, {
        accessToken: token,
        proxySecret: config.proxySecret,
        clientIp,
      }),
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(upstreamTimeoutMs(path, request.method)),
    });

    let upstream = await send(accessToken).catch(() => null);
    let refreshed: Awaited<ReturnType<typeof refreshSessionOnce>> | undefined;
    if (upstream?.status === 401 && refreshToken) {
      try {
        refreshed = await refreshSessionOnce(refreshToken);
      } catch (error) {
        if (error instanceof RefreshSessionUnavailableError) {
          return noStore(NextResponse.json(
            { error: { code: "SERVICE_UNAVAILABLE", message: error.message } },
            { status: 503 },
          ));
        }
        throw error;
      }
      if (refreshed) {
        accessToken = refreshed.accessToken;
        refreshToken = refreshed.refreshToken;
        upstream = await send(accessToken).catch(() => null);
      }
    }

    if (!upstream) {
      return noStore(NextResponse.json({ message: "API backend chưa sẵn sàng." }, { status: 503 }));
    }
    const response = await proxyResponse(upstream);
    if (refreshed) await setSessionCookies(response, refreshed);
    if (upstream.status === 401) clearSessionCookies(response);
    return response;
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return noStore(NextResponse.json(
        { error: { code: error.status === 403 ? "FORBIDDEN" : "REQUEST_REJECTED", message: error.message } },
        { status: error.status },
      ));
    }
    return noStore(NextResponse.json(
      { error: { code: "SERVICE_UNAVAILABLE", message: "API proxy is unavailable" } },
      { status: 503 },
    ));
  }
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const PUT = forward;
export const DELETE = forward;
