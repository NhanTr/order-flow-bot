import { createClient, type RedisClientType } from "redis";
import { NextResponse } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { invalidateRefreshSession, refreshSessionOnce } from "../src/lib/session-refresh";
import { setSessionCookies } from "../src/lib/server-api";

const testRedisUrl = process.env.TEST_REDIS_URL;
const runIntegration = testRedisUrl ? describe : describe.skip;
let first: RedisClientType | undefined;
let second: RedisClientType | undefined;

function assertDisposableRedisUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "redis:") throw new Error("TEST_REDIS_URL must use redis://");
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("TEST_REDIS_URL must target a loopback host");
  }
  if (!url.port || url.port === "6379") {
    throw new Error("TEST_REDIS_URL must use an explicit non-default disposable port");
  }
}

runIntegration("Redis BFF refresh single-flight", () => {
  beforeAll(async () => {
    assertDisposableRedisUrl(testRedisUrl!);
    first = createClient({ url: testRedisUrl!, socket: { connectTimeout: 1_000 } });
    second = createClient({ url: testRedisUrl!, socket: { connectTimeout: 1_000 } });
    first.on("error", () => undefined);
    second.on("error", () => undefined);
    await Promise.all([first.connect(), second.connect()]);
  });

  afterAll(async () => {
    if (first?.isOpen) {
      for await (const key of first.scanIterator({ MATCH: "order-flow:bff-refresh:v1:*", COUNT: 100 })) {
        await first.del(key);
      }
    }
    await Promise.allSettled([
      first?.isOpen ? first.quit() : undefined,
      second?.isOpen ? second.quit() : undefined,
    ]);
  });

  it("shares one rotation result across two BFF instances and honors logout invalidation", async () => {
    const refresh = vi.fn(async () => ({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      expiresIn: 900,
    }));
    const token = `integration-${crypto.randomUUID()}`;
    const [left, right] = await Promise.all([
      refreshSessionOnce(token, { redis: first!, refresh }),
      refreshSessionOnce(token, { redis: second!, refresh }),
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(left).toEqual(right);
    const leftResponse = NextResponse.json({ ok: true });
    const rightResponse = NextResponse.json({ ok: true });
    await setSessionCookies(leftResponse, left!);
    await setSessionCookies(rightResponse, right!);
    expect(leftResponse.headers.getSetCookie()).toEqual(rightResponse.headers.getSetCookie());

    await invalidateRefreshSession(token, second!);
    await expect(refreshSessionOnce(token, { redis: first!, refresh })).resolves.toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
