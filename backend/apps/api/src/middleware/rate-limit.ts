import { createHash, randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

import { createProxyClientIdentity, getSecurityClientIp } from "./proxy-client-identity";

export interface RedisRateLimitClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

export interface SecurityLimiterOptions {
  proxySecret: string;
  trustProxyHops: number;
  keyPrefix?: string;
}

export interface SecurityLimiters {
  clientIdentity: RequestHandler;
  loginAccount: RequestHandler;
  loginIp: RequestHandler;
  refreshIp: RequestHandler;
  telegramIp: RequestHandler;
  authenticatedUser: RequestHandler;
  export: RequestHandler;
}

const FIXED_WINDOW_SCRIPT = `-- order-flow:fixed-window
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("PTTL", KEYS[1])
return { count, ttl }`;

const EXPORT_ACQUIRE_SCRIPT = `-- order-flow:export-acquire
if redis.call("EXISTS", KEYS[2]) == 1 then
  return { 0, "busy", redis.call("PTTL", KEYS[2]) }
end
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
local quota_ttl = redis.call("PTTL", KEYS[1])
if count > 5 then return { 0, "quota", quota_ttl } end
redis.call("SET", KEYS[2], ARGV[3], "PX", ARGV[2], "NX")
return { 1, "ok", ARGV[2] }`;

const EXPORT_RELEASE_SCRIPT = `-- order-flow:export-release
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

const FIFTEEN_MINUTES_MS = 15 * 60_000;
const TEN_MINUTES_MS = 10 * 60_000;
const ONE_MINUTE_MS = 60_000;
const EXPORT_LOCK_MS = 2 * 60_000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseRedisTuple(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length < 2) throw new Error("Invalid Redis limiter response");
  const count = Number(value[0]);
  const ttlMs = Number(value[1]);
  if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) {
    throw new Error("Invalid Redis limiter response");
  }
  return [count, Math.max(1, ttlMs)];
}

function sendRateLimited(response: Response, request: Request, ttlMs: number, message: string): void {
  response.setHeader("Retry-After", Math.max(1, Math.ceil(ttlMs / 1_000)).toString());
  response.status(429).json({
    error: { code: "RATE_LIMITED", message, requestId: request.requestId },
  });
}

function sendUnavailable(response: Response, request: Request): void {
  response.status(503).json({
    error: {
      code: "SERVICE_UNAVAILABLE",
      message: "Request limiting service is unavailable",
      requestId: request.requestId,
    },
  });
}

function createFixedWindowLimiter(
  redis: RedisRateLimitClient,
  keyPrefix: string,
  limit: number,
  windowMs: number,
  identity: (request: Request) => string,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const key = `${keyPrefix}:${digest(identity(request))}`;
      const [count, ttlMs] = parseRedisTuple(
        await redis.eval(FIXED_WINDOW_SCRIPT, {
          keys: [key],
          arguments: [windowMs.toString()],
        }),
      );
      if (count > limit) {
        sendRateLimited(response, request, ttlMs, "Too many requests");
        return;
      }
      next();
    } catch {
      sendUnavailable(response, request);
    }
  };
}

function accountIdentity(request: Request): string {
  const username = typeof request.body?.username === "string"
    ? request.body.username.trim().toLocaleLowerCase("en-US")
    : "";
  return username || `missing:${getSecurityClientIp(request)}`;
}

function authenticatedIdentity(request: Request): string {
  return request.auth?.userId ?? `missing:${getSecurityClientIp(request)}`;
}

function createExportLimiter(
  redis: RedisRateLimitClient,
  keyPrefix: string,
): RequestHandler {
  return async (request, response, next) => {
    const identity = authenticatedIdentity(request);
    const identityDigest = digest(identity);
    const quotaKey = `${keyPrefix}:export:quota:${identityDigest}`;
    const lockKey = `${keyPrefix}:export:lock:${identityDigest}`;
    const token = randomUUID();

    try {
      const result = await redis.eval(
        EXPORT_ACQUIRE_SCRIPT,
        {
          keys: [quotaKey, lockKey],
          arguments: [TEN_MINUTES_MS.toString(), EXPORT_LOCK_MS.toString(), token],
        },
      );
      if (!Array.isArray(result) || result.length < 3) throw new Error("Invalid Redis export response");
      const acquired = Number(result[0]) === 1;
      const reason = String(result[1]);
      const ttlMs = Math.max(1, Number(result[2]));
      if (!acquired) {
        sendRateLimited(
          response,
          request,
          ttlMs,
          reason === "busy" ? "An export is already in progress" : "Export limit exceeded",
        );
        return;
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        void redis.eval(EXPORT_RELEASE_SCRIPT, {
          keys: [lockKey],
          arguments: [token],
        }).catch(() => undefined);
      };
      response.once("finish", release);
      response.once("close", release);
      next();
    } catch {
      sendUnavailable(response, request);
    }
  };
}

export function createSecurityLimiters(
  redis: RedisRateLimitClient,
  options: SecurityLimiterOptions,
): SecurityLimiters {
  const prefix = options.keyPrefix ?? "order-flow:security:v1";
  return {
    clientIdentity: createProxyClientIdentity(options),
    loginAccount: createFixedWindowLimiter(redis, `${prefix}:login:account`, 10, FIFTEEN_MINUTES_MS, accountIdentity),
    loginIp: createFixedWindowLimiter(redis, `${prefix}:login:ip`, 100, FIFTEEN_MINUTES_MS, getSecurityClientIp),
    refreshIp: createFixedWindowLimiter(redis, `${prefix}:refresh:ip`, 60, ONE_MINUTE_MS, getSecurityClientIp),
    telegramIp: createFixedWindowLimiter(redis, `${prefix}:telegram:ip`, 60, ONE_MINUTE_MS, getSecurityClientIp),
    authenticatedUser: createFixedWindowLimiter(redis, `${prefix}:authenticated:user`, 120, ONE_MINUTE_MS, authenticatedIdentity),
    export: createExportLimiter(redis, prefix),
  };
}
