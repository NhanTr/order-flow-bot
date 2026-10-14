import { createHash } from "node:crypto";

import { AppError } from "../../core/errors.js";
import type {
  AuthSessionStorePort,
  CachedAuthSession,
  RotateSessionInput,
} from "./auth-session.store.js";

export interface RedisAuthSessionClient {
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

const ROTATE_SCRIPT = `-- order-flow:auth-session:rotate
local value = redis.call("GET", KEYS[1])
if not value then return 0 end
local session = cjson.decode(value)
if session.userId ~= ARGV[1] then return 0 end
if session.refreshTokenHash ~= ARGV[2] then
  redis.call("DEL", KEYS[1])
  return -1
end
session.refreshTokenHash = ARGV[3]
session.expiresAt = ARGV[4]
redis.call("SET", KEYS[1], cjson.encode(session), "PX", ARGV[5])
return 1`;

const REVOKE_SCRIPT = `-- order-flow:auth-session:revoke
local value = redis.call("GET", KEYS[1])
if not value then return 0 end
local session = cjson.decode(value)
if session.userId ~= ARGV[1] then return 0 end
return redis.call("DEL", KEYS[1])`;

interface StoredAuthSession {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: string;
  ipAddress?: string;
  userAgent?: string;
}

export class RedisAuthSessionStore implements AuthSessionStorePort {
  constructor(
    private readonly redis: RedisAuthSessionClient,
    private readonly keyPrefix = "order-flow:auth-session:v1",
  ) {}

  async create(session: CachedAuthSession): Promise<void> {
    try {
      await this.redis.set(
        this.key(session.id),
        JSON.stringify(serialize(session)),
        { PX: ttlMilliseconds(session.expiresAt) },
      );
    } catch (error) {
      throw unavailable(error);
    }
  }

  async isActive(sessionId: string, userId: string): Promise<boolean> {
    try {
      const value = await this.redis.get(this.key(sessionId));
      if (!value) return false;
      const session = parseStoredSession(value);
      return session.userId === userId && Date.parse(session.expiresAt) > Date.now();
    } catch (error) {
      throw unavailable(error);
    }
  }

  async rotate(input: RotateSessionInput): Promise<boolean> {
    try {
      const result = await this.redis.eval(ROTATE_SCRIPT, {
        keys: [this.key(input.sessionId)],
        arguments: [
          input.userId,
          input.currentTokenHash,
          input.nextTokenHash,
          input.expiresAt.toISOString(),
          ttlMilliseconds(input.expiresAt).toString(),
        ],
      });
      return Number(result) === 1;
    } catch (error) {
      throw unavailable(error);
    }
  }

  async revoke(sessionId: string, userId: string): Promise<void> {
    try {
      await this.redis.eval(REVOKE_SCRIPT, {
        keys: [this.key(sessionId)],
        arguments: [userId],
      });
    } catch (error) {
      throw unavailable(error);
    }
  }

  private key(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return `${this.keyPrefix}:${digest}`;
  }
}

function serialize(session: CachedAuthSession): StoredAuthSession {
  return {
    ...session,
    expiresAt: session.expiresAt.toISOString(),
  };
}

function parseStoredSession(value: string): StoredAuthSession {
  const parsed = JSON.parse(value) as Partial<StoredAuthSession>;
  if (
    typeof parsed.id !== "string"
    || typeof parsed.userId !== "string"
    || typeof parsed.refreshTokenHash !== "string"
    || typeof parsed.expiresAt !== "string"
  ) {
    throw new Error("Invalid Redis auth session payload");
  }
  return parsed as StoredAuthSession;
}

function ttlMilliseconds(expiresAt: Date): number {
  return Math.max(1, expiresAt.getTime() - Date.now());
}

function unavailable(cause: unknown): AppError {
  if (cause instanceof AppError) return cause;
  return new AppError(
    "SERVICE_UNAVAILABLE",
    "Authentication session service is unavailable",
    { cause },
  );
}
