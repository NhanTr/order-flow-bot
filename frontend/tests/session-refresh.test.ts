import { describe, expect, it, vi } from "vitest";

import {
  RefreshSessionUnavailableError,
  invalidateRefreshSession,
  refreshSessionOnce,
  type RefreshRedisClient,
} from "../src/lib/session-refresh";

class SharedFakeRedis implements RefreshRedisClient {
  private readonly values = new Map<string, { value: string; expiresAt: number }>();
  unavailable = false;

  async get(key: string) {
    if (this.unavailable) throw new Error("redis unavailable");
    const entry = this.values.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, options: { PX: number; NX?: boolean }) {
    if (this.unavailable) throw new Error("redis unavailable");
    const existing = this.values.get(key);
    if (existing && existing.expiresAt <= Date.now()) this.values.delete(key);
    if (options.NX && this.values.has(key)) return null;
    this.values.set(key, { value, expiresAt: Date.now() + options.PX });
    return "OK";
  }

  async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
    if (this.unavailable) throw new Error("redis unavailable");
    const [key] = options.keys;
    const [expected] = options.arguments;
    const current = await this.get(key);
    if (current !== expected) return 0;
    this.values.delete(key);
    return 1;
  }

  async del(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys];
    return list.reduce((count, key) => count + Number(this.values.delete(key)), 0);
  }
}

const session = {
  accessToken: "next-access",
  refreshToken: "next-refresh",
  expiresIn: 900,
};

describe("distributed refresh single-flight", () => {
  it("makes one refresh call for concurrent BFF instances and shares the result", async () => {
    const redis = new SharedFakeRedis();
    const refresh = vi.fn(async () => session);
    const [first, second] = await Promise.all([
      refreshSessionOnce("old-refresh", { redis, refresh }),
      refreshSessionOnce("old-refresh", { redis, refresh }),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(first).toEqual(session);
    expect(second).toEqual(session);
  });

  it("fails closed when Redis is unavailable", async () => {
    const redis = new SharedFakeRedis();
    redis.unavailable = true;
    await expect(refreshSessionOnce("old-refresh", { redis, refresh: async () => session }))
      .rejects.toBeInstanceOf(RefreshSessionUnavailableError);
  });

  it("prevents a cached refresh result from resurrecting a logged-out session", async () => {
    const redis = new SharedFakeRedis();
    await refreshSessionOnce("old-refresh", { redis, refresh: async () => session });
    await invalidateRefreshSession("old-refresh", redis);
    await expect(refreshSessionOnce("old-refresh", { redis, refresh: async () => session })).resolves.toBeNull();
  });

  it("does not delete a lock owned by another caller", async () => {
    const redis = new SharedFakeRedis();
    await redis.set("lock", "new-owner", { PX: 10_000 });
    await redis.eval("release", { keys: ["lock"], arguments: ["old-owner"] });
    expect(await redis.get("lock")).toBe("new-owner");
  });

  it("returns 503 semantics at the deadline instead of starting a second refresh", async () => {
    vi.useFakeTimers();
    const redis = new SharedFakeRedis();
    const refresh = vi.fn(() => new Promise<typeof session>(() => undefined));
    const first = refreshSessionOnce("slow-refresh", { redis, refresh, now: () => Date.now() });
    const second = refreshSessionOnce("slow-refresh", { redis, refresh, now: () => Date.now() });
    const firstExpectation = expect(first).rejects.toBeInstanceOf(RefreshSessionUnavailableError);
    const secondExpectation = expect(second).rejects.toBeInstanceOf(RefreshSessionUnavailableError);
    await vi.advanceTimersByTimeAsync(9_500);
    await firstExpectation;
    await secondExpectation;
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
