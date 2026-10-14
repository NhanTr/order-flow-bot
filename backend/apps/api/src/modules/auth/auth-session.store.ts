export interface CachedAuthSession {
  id: string;
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

export interface RotateSessionInput {
  sessionId: string;
  userId: string;
  currentTokenHash: string;
  nextTokenHash: string;
  expiresAt: Date;
}

export interface AuthSessionStorePort {
  create(session: CachedAuthSession): Promise<void>;
  isActive(sessionId: string, userId: string): Promise<boolean>;
  rotate(input: RotateSessionInput): Promise<boolean>;
  revoke(sessionId: string, userId: string): Promise<void>;
}

/**
 * Explicit in-process adapter for unit tests and isolated local use.
 * Production application wiring uses RedisAuthSessionStore.
 *
 * Process-local, bounded session cache.
 *
 * Only refresh-token hashes are kept in memory. Restarting the API clears all
 * sessions, and separate API processes do not share this cache.
 */
export class MemoryAuthSessionStore implements AuthSessionStorePort {
  private readonly sessions = new Map<string, CachedAuthSession>();

  constructor(private readonly maxSessions = 10_000) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1) {
      throw new Error("maxSessions must be a positive integer");
    }
  }

  async create(session: CachedAuthSession): Promise<void> {
    this.removeExpired();
    if (this.sessions.size >= this.maxSessions) {
      const oldestSessionId = this.sessions.keys().next().value as string | undefined;
      if (oldestSessionId) this.sessions.delete(oldestSessionId);
    }
    this.sessions.set(session.id, { ...session });
  }

  async isActive(sessionId: string, userId: string): Promise<boolean> {
    const session = this.getActive(sessionId, userId);
    return session !== undefined;
  }

  async rotate(input: RotateSessionInput): Promise<boolean> {
    const session = this.getActive(input.sessionId, input.userId);
    if (!session) return false;

    if (session.refreshTokenHash !== input.currentTokenHash) {
      // Reuse of an already-rotated refresh token invalidates the whole session.
      this.sessions.delete(input.sessionId);
      return false;
    }

    this.sessions.set(input.sessionId, {
      ...session,
      refreshTokenHash: input.nextTokenHash,
      expiresAt: input.expiresAt,
    });
    return true;
  }

  async revoke(sessionId: string, userId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.userId === userId) this.sessions.delete(sessionId);
  }

  private getActive(
    sessionId: string,
    userId: string,
  ): CachedAuthSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return undefined;
    if (session.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt.getTime() <= now) this.sessions.delete(sessionId);
    }
  }
}
