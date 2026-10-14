const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TEST_DATABASE_NAME = /^order_flow_security_test(?:[_-][A-Za-z0-9][A-Za-z0-9_-]*)?$/;

export function validateDisposableTestDatabaseUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("TEST_DATABASE_URL must use a PostgreSQL URL scheme");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error("TEST_DATABASE_URL must use a loopback host (127.0.0.1, localhost, or ::1)");
  }

  if (!url.port || url.port === "5432") {
    throw new Error("TEST_DATABASE_URL must use an explicit non-default port other than 5432");
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("TEST_DATABASE_URL must contain a valid database name");
  }

  if (!TEST_DATABASE_NAME.test(databaseName)) {
    throw new Error(
      "TEST_DATABASE_URL must target order_flow_security_test or an explicitly suffixed test database",
    );
  }

  return rawUrl;
}

export function createDisposableTestDatabase<T>(
  rawUrl: string | undefined,
  createClient: (validatedUrl: string) => T,
): T | undefined {
  if (!rawUrl) return undefined;

  const validatedUrl = validateDisposableTestDatabaseUrl(rawUrl);
  return createClient(validatedUrl);
}
