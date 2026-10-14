import { hashSync } from "bcryptjs";
import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppEnv } from "../../../config/env";
import type { AuthRepositoryPort } from "../auth.repository";
import { RedisAuthSessionStore } from "../redis-auth-session.store";
import { AuthService } from "../auth.service";
import { AuthTokenService } from "../auth.tokens";
import type { AuthUser, AuthUserWithPassword } from "../auth.types";

const testRedisUrl = process.env.TEST_REDIS_URL;
const runIntegration = testRedisUrl ? describe : describe.skip;
const prefix = `order-flow:test:sessions:${randomUUID()}`;
let firstClient: RedisClientType | undefined;
let secondClient: RedisClientType | undefined;

const env = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgresql://test:test@127.0.0.1:55439/order_flow_security_test",
  REDIS_URL: "redis://127.0.0.1:56379",
  API_PROXY_SECRET: "integration-proxy-secret-at-least-32-characters",
  TRUST_PROXY_HOPS: 0,
  JWT_ACCESS_SECRET: "integration-access-secret-at-least-32-characters",
  JWT_REFRESH_SECRET: "integration-refresh-secret-at-least-32-characters",
  JWT_ACCESS_TTL_SECONDS: 900,
  JWT_REFRESH_TTL_SECONDS: 3600,
  BOT_INTERNAL_SECRET: "integration-bot-secret-at-least-32-characters",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_AUTH_MAX_AGE_SECONDS: 300,
} satisfies AppEnv;

const owner: AuthUserWithPassword = {
  id: "29fb80af-25dc-4a21-aab8-f17fb93578ab",
  fullName: "Store Owner",
  username: "owner",
  telegramUserId: null,
  passwordHash: hashSync("correct-password", 4),
  role: "OWNER",
  status: "ACTIVE",
};

class Repository implements AuthRepositoryPort {
  async findAdminByUsername(username: string): Promise<AuthUserWithPassword | null> {
    return username.toLowerCase() === owner.username ? owner : null;
  }

  async findTelegramUser(): Promise<AuthUser | null> {
    return null;
  }

  async findUserById(userId: string): Promise<AuthUser | null> {
    return userId === owner.id ? owner : null;
  }
}

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

function store(client: RedisClientType) {
  return new RedisAuthSessionStore(client, prefix);
}

runIntegration("Redis authentication sessions", () => {
  beforeAll(async () => {
    assertDisposableRedisUrl(testRedisUrl!);
    firstClient = createClient({ url: testRedisUrl!, socket: { connectTimeout: 1_000 } });
    secondClient = createClient({ url: testRedisUrl!, socket: { connectTimeout: 1_000 } });
    firstClient.on("error", () => undefined);
    secondClient.on("error", () => undefined);
    await Promise.all([firstClient.connect(), secondClient.connect()]);
  });

  afterAll(async () => {
    if (secondClient?.isOpen) {
      const keys = [prefix];
      for await (const key of secondClient.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
        keys.push(key);
      }
      await Promise.all(keys.slice(1).map((key) => secondClient!.del(key)));
    }
    await Promise.allSettled([
      firstClient?.isOpen ? firstClient.quit() : undefined,
      secondClient?.isOpen ? secondClient.quit() : undefined,
    ]);
  });

  it("shares login, logout and session activity between API instances", async () => {
    const firstService = new AuthService(new Repository(), store(firstClient!), new AuthTokenService(env), env);
    const secondService = new AuthService(new Repository(), store(secondClient!), new AuthTokenService(env), env);
    const session = await firstService.loginAdmin("owner", "correct-password");

    const identity = await secondService.authenticate(session.accessToken, "OWNER");
    expect(identity.userId).toBe(owner.id);
    await secondService.logout(identity);
    await expect(firstService.authenticate(session.accessToken, "OWNER")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("allows one atomic parallel rotation and revokes the session on reuse", async () => {
    const firstService = new AuthService(new Repository(), store(firstClient!), new AuthTokenService(env), env);
    const secondService = new AuthService(new Repository(), store(secondClient!), new AuthTokenService(env), env);
    const original = await firstService.loginAdmin("owner", "correct-password");
    const attempts = await Promise.allSettled([
      firstService.refresh(original.refreshToken),
      secondService.refresh(original.refreshToken),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<AuthService["refresh"]>>>;
    await expect(firstService.refresh(winner.value.refreshToken)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("does not let a wrong user revoke another user's session", async () => {
    const sessions = store(firstClient!);
    await sessions.create({
      id: "wrong-user-session",
      userId: owner.id,
      refreshTokenHash: "current-hash",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await sessions.rotate({
      sessionId: "wrong-user-session",
      userId: "different-user",
      currentTokenHash: "current-hash",
      nextTokenHash: "next-hash",
      expiresAt: new Date(Date.now() + 60_000),
    })).toBe(false);
    expect(await store(secondClient!).isActive("wrong-user-session", owner.id)).toBe(true);
  });

  it("expires sessions with Redis TTL", async () => {
    const sessions = store(firstClient!);
    await sessions.create({
      id: "expiring-session",
      userId: owner.id,
      refreshTokenHash: "hash",
      expiresAt: new Date(Date.now() + 20),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await store(secondClient!).isActive("expiring-session", owner.id)).toBe(false);
  });

  it("does not revoke shared sessions when one Redis client is disposed", async () => {
    const disposable = createClient({ url: testRedisUrl! });
    disposable.on("error", () => undefined);
    await disposable.connect();
    const disposableStore = store(disposable);
    await disposableStore.create({
      id: "dispose-session",
      userId: owner.id,
      refreshTokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await disposable.quit();
    expect(await store(secondClient!).isActive("dispose-session", owner.id)).toBe(true);
  });

  it("fails closed with SERVICE_UNAVAILABLE after a Redis outage", async () => {
    const disconnected = createClient({ url: testRedisUrl! });
    disconnected.on("error", () => undefined);
    const sessions = store(disconnected);
    await expect(sessions.isActive("any", owner.id)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });
});
