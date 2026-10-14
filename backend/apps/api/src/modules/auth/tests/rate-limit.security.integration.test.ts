import express from "express";
import Redis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyClientIdentity } from "../../../middleware/proxy-client-identity";
import { createSecurityLimiters } from "../../../middleware/rate-limit";
import { requestId } from "../../../middleware/request-id";

const testRedisUrl = process.env.TEST_REDIS_URL;
const runIntegration = testRedisUrl ? describe : describe.skip;
let firstRedis: Redis | undefined;
let secondRedis: Redis | undefined;

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

function appFor(redis: Redis, prefix: string) {
  const app = express();
  const limiters = createSecurityLimiters(redis, {
    proxySecret: "integration-proxy-secret",
    trustProxyHops: 0,
    keyPrefix: prefix,
  });
  app.use(requestId);
  app.use(createProxyClientIdentity({ proxySecret: "integration-proxy-secret", trustProxyHops: 0 }));
  app.post("/login", limiters.loginIp, (_req, res) => res.json({ ok: true }));
  return app;
}

runIntegration("Redis rate-limit security integration", () => {
  beforeAll(async () => {
    assertDisposableRedisUrl(testRedisUrl!);
    firstRedis = new Redis(testRedisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    secondRedis = new Redis(testRedisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await Promise.all([firstRedis.connect(), secondRedis.connect()]);
  });

  afterAll(async () => {
    await Promise.allSettled([firstRedis?.quit(), secondRedis?.quit()]);
  });

  it("atomically shares the login IP counter between API instances", async () => {
    const prefix = `order-flow:test:${crypto.randomUUID()}`;
    const firstApp = appFor(firstRedis!, prefix);
    const secondApp = appFor(secondRedis!, prefix);
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      request(index % 2 === 0 ? firstApp : secondApp).post("/login"),
    ));
    expect(responses.every((response) => response.status === 200)).toBe(true);

    const rejected = await request(secondApp).post("/login");
    expect(rejected.status).toBe(429);
    expect(Number(rejected.header["retry-after"])).toBeGreaterThan(0);
  });
});
