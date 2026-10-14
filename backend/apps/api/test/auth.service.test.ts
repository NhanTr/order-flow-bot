import assert from "node:assert/strict";
import test from "node:test";
import { hashSync } from "bcryptjs";
import { decodeJwt, SignJWT } from "jose";

import { parseAppEnv, type AppEnv } from "../src/config/env.js";
import { AppError } from "../src/core/errors.js";
import type { AuthRepositoryPort } from "../src/modules/auth/auth.repository.js";
import { MemoryAuthSessionStore } from "../src/modules/auth/auth-session.store.js";
import type { AuthSessionStorePort } from "../src/modules/auth/auth-session.store.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { AuthTokenService } from "../src/modules/auth/auth.tokens.js";
import type {
  AuthUser,
  AuthUserWithPassword,
} from "../src/modules/auth/auth.types.js";

const env: AppEnv = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  REDIS_URL: "redis://127.0.0.1:56379",
  API_PROXY_SECRET: "test-proxy-secret-at-least-32-characters",
  TRUST_PROXY_HOPS: 0,
  JWT_ACCESS_SECRET: "access-secret-that-is-at-least-32-characters",
  JWT_REFRESH_SECRET: "refresh-secret-that-is-at-least-32-characters",
  JWT_ACCESS_TTL_SECONDS: 900,
  JWT_REFRESH_TTL_SECONDS: 2_592_000,
  BOT_INTERNAL_SECRET: "test-internal-secret-at-least-32-characters",
  TELEGRAM_BOT_TOKEN: "123456:test-bot-token",
  TELEGRAM_AUTH_MAX_AGE_SECONDS: 300,
};

const owner: AuthUserWithPassword = {
  id: "29fb80af-25dc-4a21-aab8-f17fb93578ab",
  fullName: "Store Owner",
  username: "owner",
  telegramUserId: null,
  passwordHash: hashSync("correct-password", 4),
  role: "OWNER",
  status: "ACTIVE",
};

class MemoryAuthRepository implements AuthRepositoryPort {
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

function createService(): AuthService {
  return new AuthService(
    new MemoryAuthRepository(),
    new MemoryAuthSessionStore(100),
    new AuthTokenService(env),
    env,
  );
}

test("admin login issues usable tokens and logout revokes the session", async () => {
  const service = createService();

  const session = await service.loginAdmin("OWNER", "correct-password");
  assert.equal(session.user.role, "OWNER");
  assert.equal(session.tokenType, "Bearer");

  const identity = await service.authenticate(session.accessToken, "OWNER");
  assert.equal(identity.userId, owner.id);

  await service.logout(identity);
  await assert.rejects(
    service.authenticate(session.accessToken, "OWNER"),
    (error) => error instanceof AppError && error.code === "UNAUTHORIZED",
  );
});

test("refresh rotates tokens and detects reuse", async () => {
  const service = createService();
  const original = await service.loginAdmin("owner", "correct-password");
  const rotated = await service.refresh(original.refreshToken);

  assert.notEqual(rotated.refreshToken, original.refreshToken);
  await assert.rejects(
    service.refresh(original.refreshToken),
    (error) => error instanceof AppError && error.code === "UNAUTHORIZED",
  );
  await assert.rejects(
    service.refresh(rotated.refreshToken),
    (error) => error instanceof AppError && error.code === "UNAUTHORIZED",
  );
});

test("auth service awaits asynchronous session checks", async () => {
  const unavailableSession = {
    create: async () => undefined,
    isActive: async () => false,
    rotate: async () => false,
    revoke: async () => undefined,
  } as AuthSessionStorePort;
  const service = new AuthService(
    new MemoryAuthRepository(),
    unavailableSession,
    new AuthTokenService(env),
    env,
  );
  const token = await new AuthTokenService(env).signAccessToken(owner, "missing-session");

  await assert.rejects(
    service.authenticate(token, "OWNER"),
    (error) => error instanceof AppError && error.code === "UNAUTHORIZED",
  );
});

test("issued JWTs contain and require the configured issuer and audience", async () => {
  const tokens = new AuthTokenService(env);
  const session = await createService().loginAdmin("owner", "correct-password");
  const accessPayload = decodeJwt(session.accessToken);
  const refreshPayload = decodeJwt(session.refreshToken);

  for (const payload of [accessPayload, refreshPayload]) {
    assert.equal(payload.iss, "order-flow");
    assert.deepEqual(payload.aud, "order-flow-api");
  }

  const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
  const invalidClaims = [
    { issuer: undefined, audience: "order-flow-api" },
    { issuer: "order-flow", audience: undefined },
    { issuer: "another-service", audience: "order-flow-api" },
    { issuer: "order-flow", audience: "another-api" },
  ];
  for (const claims of invalidClaims) {
    let builder = new SignJWT({
      sid: "legacy-session",
      role: "OWNER",
      tokenType: "access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(owner.id)
      .setIssuedAt()
      .setExpirationTime("5m");
    if (claims.issuer) builder = builder.setIssuer(claims.issuer);
    if (claims.audience) builder = builder.setAudience(claims.audience);
    const invalidToken = await builder.sign(secret);
    await assert.rejects(
      tokens.verifyAccessToken(invalidToken),
      (error) => error instanceof AppError && error.code === "UNAUTHORIZED",
    );
  }
});

test("authentication rechecks inactive status and changed roles", async () => {
  let currentUser: AuthUser = owner;
  const repository: AuthRepositoryPort = {
    findAdminByUsername: async () => owner,
    findTelegramUser: async () => null,
    findUserById: async () => currentUser,
  };
  const sessions = new MemoryAuthSessionStore(10);
  const service = new AuthService(repository, sessions, new AuthTokenService(env), env);
  const inactiveSession = await service.loginAdmin("owner", "correct-password");
  currentUser = { ...owner, status: "INACTIVE" };
  await assert.rejects(
    service.authenticate(inactiveSession.accessToken),
    (error) => error instanceof AppError && error.code === "UNAUTHORIZED",
  );
  currentUser = owner;
  await assert.rejects(
    service.authenticate(inactiveSession.accessToken),
    (error) => error instanceof AppError && error.code === "UNAUTHORIZED",
  );

  const roleSession = await service.loginAdmin("owner", "correct-password");
  currentUser = { ...owner, role: "SERVICE_STAFF" };
  assert.equal((await service.authenticate(roleSession.accessToken)).role, "SERVICE_STAFF");
  await assert.rejects(
    service.authenticate(roleSession.accessToken, "OWNER"),
    (error) => error instanceof AppError && error.code === "FORBIDDEN",
  );
});

test("environment requires Redis and distinct authentication secrets", () => {
  const base = {
    NODE_ENV: "test",
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    API_PROXY_SECRET: env.API_PROXY_SECRET,
    JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: env.JWT_REFRESH_SECRET,
    BOT_INTERNAL_SECRET: env.BOT_INTERNAL_SECRET,
  } as NodeJS.ProcessEnv;

  assert.throws(() => parseAppEnv({ ...base, REDIS_URL: "https://redis.example.com" }));
  assert.throws(() => parseAppEnv({
    ...base,
    JWT_REFRESH_SECRET: env.JWT_ACCESS_SECRET,
  }));
  assert.throws(() => parseAppEnv({
    ...base,
    BOT_INTERNAL_SECRET: env.JWT_ACCESS_SECRET,
  }));
  assert.throws(() => parseAppEnv({
    ...base,
    API_PROXY_SECRET: env.JWT_ACCESS_SECRET,
  }));
});

test("admin login does not reveal whether username or password is wrong", async () => {
  const service = createService();

  for (const [username, password] of [
    ["missing", "correct-password"],
    ["owner", "incorrect-password"],
  ]) {
    await assert.rejects(
      service.loginAdmin(username!, password!),
      (error) =>
        error instanceof AppError &&
        error.code === "INVALID_CREDENTIALS" &&
        error.message === "Invalid username or password",
    );
  }
});

test("Telegram auth can be disabled without affecting API startup", async () => {
  const telegramDisabledEnv = { ...env, TELEGRAM_BOT_TOKEN: "" };
  const service = new AuthService(
    new MemoryAuthRepository(),
    new MemoryAuthSessionStore(100),
    new AuthTokenService(telegramDisabledEnv),
    telegramDisabledEnv,
  );

  await assert.rejects(
    service.createTelegramSession("unused-while-disabled"),
    (error) => error instanceof AppError && error.code === "SERVICE_UNAVAILABLE",
  );
});
