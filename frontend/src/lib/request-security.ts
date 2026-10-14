import { isIP } from "node:net";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BUSINESS_ROOTS = new Set(["admin", "orders", "barista", "menu"]);
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export class RequestSecurityError extends Error {
  constructor(message: string, public readonly status = 403) {
    super(message);
    this.name = "RequestSecurityError";
  }
}

export function requireSameOriginMutation(request: Request, configuredOrigin: string): void {
  if (!MUTATION_METHODS.has(request.method.toUpperCase())) return;
  let expected: string;
  try {
    expected = new URL(configuredOrigin).origin;
  } catch {
    throw new RequestSecurityError("Public origin is not configured", 503);
  }
  const supplied = request.headers.get("origin");
  if (!supplied || supplied === "null") {
    throw new RequestSecurityError("A valid Origin header is required");
  }
  try {
    if (new URL(supplied).origin !== expected) {
      throw new RequestSecurityError("Request origin is not allowed");
    }
  } catch (error) {
    if (error instanceof RequestSecurityError) throw error;
    throw new RequestSecurityError("Request origin is not allowed");
  }
}

export function validateBackendRoute(path: string[], method: string): string {
  const normalizedMethod = method.toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) {
    throw new RequestSecurityError("Method is not allowed", 405);
  }
  if (
    path.length === 0
    || !BUSINESS_ROOTS.has(path[0])
    || path.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")
  ) {
    throw new RequestSecurityError("Backend route is not allowed", 404);
  }
  if (path[0] === "admin" && path[1] === "auth") {
    if (!(path.length === 3 && path[2] === "me" && normalizedMethod === "GET")) {
      throw new RequestSecurityError("Authentication route is not available through this proxy", 404);
    }
  }
  return path.join("/");
}

export function trustedClientIp(request: Request, trustProxyHops: number): string {
  if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0) return "unknown";
  if (trustProxyHops === 0) return "unknown";
  const chain = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const candidate = chain[chain.length - trustProxyHops];
  if (!candidate) return "unknown";
  const normalized = candidate.startsWith("::ffff:") ? candidate.slice(7) : candidate;
  return isIP(normalized) ? normalized.toLowerCase() : "unknown";
}

export function buildUpstreamHeaders(
  request: Request,
  options: { accessToken?: string; proxySecret: string; clientIp: string },
): Headers {
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("accept", request.headers.get("accept") ?? "application/json");
  if (options.accessToken) headers.set("authorization", `Bearer ${options.accessToken}`);
  headers.set("x-order-flow-client-ip", options.clientIp);
  headers.set("x-order-flow-proxy-secret", options.proxySecret);
  return headers;
}

export function upstreamTimeoutMs(path: string[], method: string): number {
  return method.toUpperCase() === "POST"
    && path.join("/") === "admin/reports/revenue/export"
    ? 60_000
    : 15_000;
}
