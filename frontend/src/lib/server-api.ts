import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const ACCESS_COOKIE = "order_flow_access";
const REFRESH_COOKIE = "order_flow_refresh";

export const API_BASE_URL = (process.env.API_BASE_URL ?? "http://127.0.0.1:3001/api/v1").replace(/\/$/, "");

interface SessionPayload {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface BffConfig {
  publicOrigin: string;
  proxySecret: string;
  trustProxyHops: number;
}

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export async function setSessionCookies(response: NextResponse, session: SessionPayload) {
  response.cookies.set(ACCESS_COOKIE, session.accessToken, { ...cookieOptions, maxAge: session.expiresIn });
  response.cookies.set(REFRESH_COOKIE, session.refreshToken, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 });
}

export function clearSessionCookies(response: NextResponse) {
  response.cookies.set(ACCESS_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  response.cookies.set(REFRESH_COOKIE, "", { ...cookieOptions, maxAge: 0 });
}

export async function readSessionTokens() {
  const store = await cookies();
  return {
    accessToken: store.get(ACCESS_COOKIE)?.value,
    refreshToken: store.get(REFRESH_COOKIE)?.value,
  };
}

export function getBffConfig(): BffConfig {
  const publicOrigin = process.env.PUBLIC_ORIGIN
    ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  const proxySecret = process.env.API_PROXY_SECRET ?? "";
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? "0");
  if (!publicOrigin) throw new Error("PUBLIC_ORIGIN is required");
  if (proxySecret.length < 32) throw new Error("API_PROXY_SECRET must contain at least 32 characters");
  if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error("TRUST_PROXY_HOPS must be a non-negative safe integer");
  }
  return { publicOrigin: new URL(publicOrigin).origin, proxySecret, trustProxyHops };
}

export function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  response.headers.set("pragma", "no-cache");
  return response;
}

export async function safeJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
