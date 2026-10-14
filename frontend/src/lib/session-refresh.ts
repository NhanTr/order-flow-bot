import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";

export interface SessionPayload {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RefreshRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number; NX?: boolean }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  del(keys: string | string[]): Promise<number>;
}

interface RefreshDependencies {
  redis: RefreshRedisClient;
  refresh: (refreshToken: string) => Promise<SessionPayload | null>;
  now?: () => number;
}

export class RefreshSessionUnavailableError extends Error {
  constructor() {
    super("Authentication session service is unavailable");
    this.name = "RefreshSessionUnavailableError";
  }
}

const PREFIX = "order-flow:bff-refresh:v1";
const LOCK_TTL_MS = 10_000;
const RESULT_TTL_MS = 10_000;
const REVOKED_TTL_MS = 20_000;
const WAIT_DEADLINE_MS = 9_000;
const REFRESH_DEADLINE_MS = 8_000;
const POLL_MS = 50;
const RELEASE_LOCK = `-- order-flow:bff-refresh:release
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

let defaultClient: ReturnType<typeof createClient> | undefined;

function keysFor(refreshToken: string) {
  const digest = createHash("sha256").update(refreshToken).digest("hex");
  return {
    lock: `${PREFIX}:lock:${digest}`,
    result: `${PREFIX}:result:${digest}`,
    revoked: `${PREFIX}:revoked:${digest}`,
  };
}

function defaultRedis(): RefreshRedisClient {
  const url = process.env.BFF_REDIS_URL;
  if (!url) throw new RefreshSessionUnavailableError();
  if (!defaultClient) {
    defaultClient = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2_000, reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 2_000) },
    });
    defaultClient.on("error", () => undefined);
    void defaultClient.connect().catch(() => undefined);
  }
  return defaultClient;
}

async function defaultRefresh(refreshToken: string): Promise<SessionPayload | null> {
  const baseUrl = (process.env.API_BASE_URL ?? "http://127.0.0.1:3001/api/v1").replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/admin/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      cache: "no-store",
      signal: AbortSignal.timeout(REFRESH_DEADLINE_MS),
    });
  } catch {
    throw new RefreshSessionUnavailableError();
  }
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new RefreshSessionUnavailableError();
  try {
    const payload = await response.json() as { data?: Partial<SessionPayload> };
    if (
      typeof payload.data?.accessToken !== "string"
      || typeof payload.data.refreshToken !== "string"
      || typeof payload.data.expiresIn !== "number"
    ) throw new Error("Invalid session response");
    return payload.data as SessionPayload;
  } catch {
    throw new RefreshSessionUnavailableError();
  }
}

function parseResult(value: string): SessionPayload | null {
  const parsed = JSON.parse(value) as { session: SessionPayload | null };
  if (parsed.session === null) return null;
  if (
    typeof parsed.session?.accessToken !== "string"
    || typeof parsed.session.refreshToken !== "string"
    || typeof parsed.session.expiresIn !== "number"
  ) throw new Error("Invalid cached refresh result");
  return parsed.session;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RefreshSessionUnavailableError()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function refreshSessionOnce(
  refreshToken: string,
  dependencies?: RefreshDependencies,
): Promise<SessionPayload | null> {
  const redis = dependencies?.redis ?? defaultRedis();
  const refresh = dependencies?.refresh ?? defaultRefresh;
  const now = dependencies?.now ?? Date.now;
  const keys = keysFor(refreshToken);
  const owner = randomUUID();
  try {
    if (await redis.get(keys.revoked)) return null;
    const cached = await redis.get(keys.result);
    if (cached) return parseResult(cached);
    const acquired = await redis.set(keys.lock, owner, { PX: LOCK_TTL_MS, NX: true });
    if (acquired) {
      try {
        const session = await deadline(refresh(refreshToken), REFRESH_DEADLINE_MS);
        if (await redis.get(keys.revoked)) return null;
        await redis.set(keys.result, JSON.stringify({ session }), { PX: RESULT_TTL_MS });
        return session;
      } finally {
        await redis.eval(RELEASE_LOCK, { keys: [keys.lock], arguments: [owner] }).catch(() => undefined);
      }
    }

    const expiresAt = now() + WAIT_DEADLINE_MS;
    while (now() < expiresAt) {
      await delay(POLL_MS);
      if (await redis.get(keys.revoked)) return null;
      const result = await redis.get(keys.result);
      if (result) return parseResult(result);
    }
    throw new RefreshSessionUnavailableError();
  } catch (error) {
    if (error instanceof RefreshSessionUnavailableError) throw error;
    throw new RefreshSessionUnavailableError();
  }
}

export async function invalidateRefreshSession(
  refreshToken: string,
  redis: RefreshRedisClient = defaultRedis(),
): Promise<void> {
  const keys = keysFor(refreshToken);
  try {
    await redis.set(keys.revoked, "1", { PX: REVOKED_TTL_MS });
    await redis.del(keys.result);
  } catch {
    throw new RefreshSessionUnavailableError();
  }
}
