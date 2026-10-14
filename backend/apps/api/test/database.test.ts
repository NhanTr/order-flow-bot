import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDatabaseUrl } from "../src/config/database.js";

test("database URL rejects remote connections without verify-full TLS", () => {
  assert.throws(
    () => normalizeDatabaseUrl(
      "postgresql://user:password@example.com:6543/postgres?pgbouncer=true&sslmode=require",
    ),
    /sslmode=verify-full/,
  );
});

test("database URL preserves an explicit SSL compatibility choice", () => {
  const normalized = new URL(
    normalizeDatabaseUrl(
      "postgresql://user:password@example.com/postgres?sslmode=verify-full",
    ),
  );

  assert.equal(normalized.searchParams.get("sslmode"), "verify-full");
  assert.equal(normalized.searchParams.has("uselibpqcompat"), false);
});

test("database URL permits plaintext only for local and private Compose database hosts", () => {
  for (const host of ["127.0.0.1", "localhost", "::1", "postgres"]) {
    const url = host === "::1"
      ? "postgresql://user:password@[::1]:5432/order_flow"
      : `postgresql://user:password@${host}:5432/order_flow`;
    assert.doesNotThrow(() => normalizeDatabaseUrl(url));
  }
  assert.throws(
    () => normalizeDatabaseUrl("postgresql://user:password@db.example.com/order_flow"),
    /sslmode=verify-full/,
  );
});

test("database URL rejects TLS compatibility downgrade on remote connections", () => {
  assert.throws(
    () => normalizeDatabaseUrl(
      "postgresql://user:password@db.example.com/order_flow?sslmode=verify-full&uselibpqcompat=true",
    ),
    /uselibpqcompat/,
  );
});
