import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { errorHandler } from "../../../middleware/error-handler";
import { createProxyClientIdentity } from "../../../middleware/proxy-client-identity";
import { createSecurityLimiters, type RedisRateLimitClient } from "../../../middleware/rate-limit";
import { requestId } from "../../../middleware/request-id";

type Entry = { value: number | string; expiresAt: number | null };

class FakeRedis implements RedisRateLimitClient {
  private readonly entries = new Map<string, Entry>();
  public now = 0;
  public unavailable = false;

  async eval(script: string, numberOfKeys: number, ...values: Array<string | number>): Promise<unknown> {
    if (this.unavailable) throw new Error("redis unavailable");
    const keys = values.slice(0, numberOfKeys).map(String);
    const args = values.slice(numberOfKeys).map(String);
    keys.forEach((key) => this.expire(key));

    if (script.includes("order-flow:fixed-window")) {
      const key = keys[0];
      const windowMs = Number(args[0]);
      const entry = this.entries.get(key);
      const count = typeof entry?.value === "number" ? entry.value + 1 : 1;
      const expiresAt = entry?.expiresAt ?? this.now + windowMs;
      this.entries.set(key, { value: count, expiresAt });
      return [count, Math.max(0, expiresAt - this.now)];
    }

    if (script.includes("order-flow:export-acquire")) {
      const [quotaKey, lockKey] = keys;
      const quotaWindowMs = Number(args[0]);
      const lockMs = Number(args[1]);
      const token = args[2];
      const existingLock = this.entries.get(lockKey);
      if (existingLock) return [0, "busy", Math.max(0, (existingLock.expiresAt ?? this.now) - this.now)];
      const quota = this.entries.get(quotaKey);
      const count = typeof quota?.value === "number" ? quota.value + 1 : 1;
      const quotaExpiresAt = quota?.expiresAt ?? this.now + quotaWindowMs;
      this.entries.set(quotaKey, { value: count, expiresAt: quotaExpiresAt });
      if (count > 5) return [0, "quota", Math.max(0, quotaExpiresAt - this.now)];
      this.entries.set(lockKey, { value: token, expiresAt: this.now + lockMs });
      return [1, "ok", lockMs];
    }

    if (script.includes("order-flow:export-release")) {
      const entry = this.entries.get(keys[0]);
      if (entry?.value === args[0]) this.entries.delete(keys[0]);
      return 1;
    }

    throw new Error("unknown script");
  }

  advance(ms: number): void {
    this.now += ms;
  }

  private expire(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.expiresAt !== null && entry?.expiresAt !== undefined && entry.expiresAt <= this.now) {
      this.entries.delete(key);
    }
  }
}

function createApp(redis: FakeRedis, middleware: express.RequestHandler, options: {
  proxySecret?: string;
  authUserId?: string;
} = {}) {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use(createProxyClientIdentity({
    proxySecret: options.proxySecret ?? "trusted-proxy-secret",
    trustProxyHops: 0,
  }));
  if (options.authUserId) {
    app.use((req, _res, next) => {
      req.auth = { userId: options.authUserId!, sessionId: "session-1", role: "OWNER" };
      next();
    });
  }
  app.post("/test", middleware, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe("distributed security limiters", () => {
  it("returns 429 and Retry-After after the login IP threshold", async () => {
    const redis = new FakeRedis();
    const limiter = createSecurityLimiters(redis, { proxySecret: "trusted-proxy-secret", trustProxyHops: 0 });
    const app = createApp(redis, limiter.loginIp);
    for (let index = 0; index < 100; index += 1) {
      expect((await request(app).post("/test")).status).toBe(200);
    }
    const rejected = await request(app).post("/test");
    expect(rejected.status).toBe(429);
    expect(Number(rejected.header["retry-after"])).toBeGreaterThan(0);
    expect(rejected.body.error.code).toBe("RATE_LIMITED");
  });

  it("shares counters between API instances", async () => {
    const redis = new FakeRedis();
    const first = createSecurityLimiters(redis, { proxySecret: "secret", trustProxyHops: 0 });
    const second = createSecurityLimiters(redis, { proxySecret: "secret", trustProxyHops: 0 });
    const firstApp = createApp(redis, first.refreshIp, { proxySecret: "secret" });
    const secondApp = createApp(redis, second.refreshIp, { proxySecret: "secret" });
    for (let index = 0; index < 30; index += 1) {
      expect((await request(firstApp).post("/test")).status).toBe(200);
      expect((await request(secondApp).post("/test")).status).toBe(200);
    }
    expect((await request(secondApp).post("/test")).status).toBe(429);
  });

  it("ignores rotating forwarding headers and fake trusted-client headers", async () => {
    const redis = new FakeRedis();
    const limiters = createSecurityLimiters(redis, { proxySecret: "real-secret", trustProxyHops: 0 });
    const app = createApp(redis, limiters.telegramIp, { proxySecret: "real-secret" });
    for (let index = 0; index < 60; index += 1) {
      const response = await request(app)
        .post("/test")
        .set("x-forwarded-for", `198.51.100.${index + 1}`)
        .set("x-order-flow-client-ip", `203.0.113.${index + 1}`)
        .set("x-order-flow-proxy-secret", "fake-secret");
      expect(response.status).toBe(200);
    }
    expect((await request(app).post("/test").set("x-forwarded-for", "192.0.2.99")).status).toBe(429);
  });

  it("accepts the internal client IP only with the proxy credential", async () => {
    const redis = new FakeRedis();
    const limiters = createSecurityLimiters(redis, { proxySecret: "real-secret", trustProxyHops: 0 });
    const app = createApp(redis, limiters.refreshIp, { proxySecret: "real-secret" });
    for (let index = 0; index < 60; index += 1) {
      const response = await request(app).post("/test")
        .set("x-order-flow-client-ip", "203.0.113.10")
        .set("x-order-flow-proxy-secret", "real-secret");
      expect(response.status).toBe(200);
    }
    expect((await request(app).post("/test")
      .set("x-order-flow-client-ip", "203.0.113.11")
      .set("x-order-flow-proxy-secret", "real-secret")).status).toBe(200);
  });

  it("normalizes login account keys and resets after expiry", async () => {
    const redis = new FakeRedis();
    const limiters = createSecurityLimiters(redis, { proxySecret: "secret", trustProxyHops: 0 });
    const app = createApp(redis, limiters.loginAccount, { proxySecret: "secret" });
    for (let index = 0; index < 10; index += 1) {
      const username = index % 2 === 0 ? " Owner " : "owner";
      expect((await request(app).post("/test").send({ username })).status).toBe(200);
    }
    expect((await request(app).post("/test").send({ username: "OWNER" })).status).toBe(429);
    redis.advance(15 * 60_000 + 1);
    expect((await request(app).post("/test").send({ username: "owner" })).status).toBe(200);
  });

  it("does not create unlimited account counters when username is absent", async () => {
    const redis = new FakeRedis();
    const limiters = createSecurityLimiters(redis, { proxySecret: "secret", trustProxyHops: 0 });
    const app = createApp(redis, limiters.loginAccount, { proxySecret: "secret" });
    for (let index = 0; index < 10; index += 1) {
      expect((await request(app).post("/test").send({ arbitrary: index })).status).toBe(200);
    }
    expect((await request(app).post("/test").send({ anotherShape: true })).status).toBe(429);
  });

  it("fails closed with 503 when Redis is unavailable", async () => {
    const redis = new FakeRedis();
    redis.unavailable = true;
    const limiter = createSecurityLimiters(redis, { proxySecret: "secret", trustProxyHops: 0 });
    const response = await request(createApp(redis, limiter.loginIp, { proxySecret: "secret" })).post("/test");
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("limits authenticated users to 120 requests per minute", async () => {
    const redis = new FakeRedis();
    const limiter = createSecurityLimiters(redis, { proxySecret: "secret", trustProxyHops: 0 });
    const app = createApp(redis, limiter.authenticatedUser, { proxySecret: "secret", authUserId: "owner-1" });
    for (let index = 0; index < 120; index += 1) {
      expect((await request(app).post("/test")).status).toBe(200);
    }
    expect((await request(app).post("/test")).status).toBe(429);
  });

  it("allows one export in flight and at most five exports per ten minutes", async () => {
    const redis = new FakeRedis();
    const limiters = createSecurityLimiters(redis, { proxySecret: "secret", trustProxyHops: 0 });
    const app = createApp(redis, limiters.export, { proxySecret: "secret", authUserId: "owner-1" });
    for (let index = 0; index < 5; index += 1) {
      expect((await request(app).post("/test")).status).toBe(200);
    }
    const rejected = await request(app).post("/test");
    expect(rejected.status).toBe(429);
    expect(rejected.body.error.code).toBe("RATE_LIMITED");
  });

  it("rejects a concurrent export for the same user", async () => {
    const redis = new FakeRedis();
    const limiters = createSecurityLimiters(redis, { proxySecret: "secret", trustProxyHops: 0 });
    const app = express();
    let continueFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { continueFirst = resolve; });
    app.use(requestId, express.json(), limiters.clientIdentity);
    app.use((req, _res, next) => {
      req.auth = { userId: "owner-1", sessionId: "session-1", role: "OWNER" };
      next();
    });
    app.post("/test", limiters.export, async (_req, res) => {
      markStarted();
      await gate;
      res.json({ ok: true });
    });

    const first = request(app).post("/test");
    const firstResponsePromise = first.then((response) => response);
    await started;
    const concurrent = await request(app).post("/test");
    expect(concurrent.status).toBe(429);
    expect(concurrent.body.error.message).toContain("already in progress");
    continueFirst();
    expect((await firstResponsePromise).status).toBe(200);
  });
});
