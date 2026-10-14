import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";

declare global {
  namespace Express {
    interface Request {
      securityClientIp?: string;
    }
  }
}

export interface ProxyClientIdentityOptions {
  proxySecret: string;
  trustProxyHops: number;
}

const UNKNOWN_CLIENT = "unknown";

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.trim();
  const unwrapped = candidate.startsWith("[") && candidate.endsWith("]")
    ? candidate.slice(1, -1)
    : candidate;
  const normalized = unwrapped.startsWith("::ffff:") ? unwrapped.slice(7) : unwrapped;
  return isIP(normalized) ? normalized.toLowerCase() : undefined;
}

export function getSecurityClientIp(request: Request): string {
  return request.securityClientIp ?? normalizeIp(request.socket.remoteAddress) ?? UNKNOWN_CLIENT;
}

export function createProxyClientIdentity(options: ProxyClientIdentityOptions): RequestHandler {
  if (!Number.isSafeInteger(options.trustProxyHops) || options.trustProxyHops < 0) {
    throw new Error("trustProxyHops must be a non-negative safe integer");
  }

  return (request, _response, next) => {
    const authenticatedProxyIp = secretMatches(
      request.header("x-order-flow-proxy-secret"),
      options.proxySecret,
    )
      ? normalizeIp(request.header("x-order-flow-client-ip"))
      : undefined;

    const configuredProxyIp = options.trustProxyHops > 0
      ? normalizeIp(request.ips[0] ?? request.ip)
      : undefined;

    request.securityClientIp = authenticatedProxyIp
      ?? configuredProxyIp
      ?? normalizeIp(request.socket.remoteAddress)
      ?? UNKNOWN_CLIENT;
    next();
  };
}
