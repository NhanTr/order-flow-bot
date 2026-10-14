import pg from "pg";

import type { AppEnv } from "./env.js";

const { Pool } = pg;

export function normalizeDatabaseUrl(connectionString: string): string {
  const url = new URL(connectionString);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "postgres"]);

  if (!localHosts.has(hostname)) {
    if (url.searchParams.get("sslmode") !== "verify-full") {
      throw new Error("Remote DATABASE_URL must use sslmode=verify-full");
    }
    if (url.searchParams.has("uselibpqcompat")) {
      throw new Error("Remote DATABASE_URL must not enable uselibpqcompat");
    }
  }

  return url.toString();
}

export function createDatabasePool(env: AppEnv) {
  return new Pool({
    connectionString: normalizeDatabaseUrl(env.DATABASE_URL),
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}
