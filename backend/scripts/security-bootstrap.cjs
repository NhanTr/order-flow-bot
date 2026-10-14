const fs = require("node:fs/promises");
const path = require("node:path");
const { Client } = require("pg");

const PASSWORD_PATTERN = /^[A-Za-z0-9._~-]{24,}$/;

function required(name, environment = process.env) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runtimePassword(name, environment = process.env) {
  const value = required(name, environment);
  if (!PASSWORD_PATTERN.test(value)) {
    throw new Error(`${name} must be at least 24 URL-safe characters (letters, numbers, dot, underscore, tilde or hyphen)`);
  }
  return value;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function safeErrorMessage(error) {
  if (!(error instanceof Error)) return "unknown bootstrap error";
  return error.message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted database URL]")
    .replace(/password\s*[=:]\s*[^\s,;]+/gi, "password=[redacted]");
}

async function applySqlFile(client, relativePath) {
  const absolutePath = path.resolve(__dirname, "..", relativePath);
  const sql = await fs.readFile(absolutePath, "utf8");
  await client.query(sql);
}

async function bootstrapSecurity(environment = process.env) {
  const connectionString = required("ADMIN_DATABASE_URL", environment);
  const apiPassword = runtimePassword("API_DATABASE_PASSWORD", environment);
  const workerPassword = runtimePassword("WORKER_DATABASE_PASSWORD", environment);
  if (apiPassword === workerPassword) {
    throw new Error("API_DATABASE_PASSWORD and WORKER_DATABASE_PASSWORD must be distinct");
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await applySqlFile(client, "prisma/sql/2026-10-13_refund_idempotency.sql");
    await applySqlFile(client, "prisma/sql/2026-10-13_runtime_roles.sql");
    await client.query(`ALTER ROLE order_flow_api LOGIN PASSWORD ${quoteLiteral(apiPassword)}`);
    await client.query(`ALTER ROLE order_flow_worker LOGIN PASSWORD ${quoteLiteral(workerPassword)}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  bootstrapSecurity()
    .then(() => console.info("Runtime database security bootstrap completed"))
    .catch((error) => {
      console.error(`Runtime database security bootstrap failed: ${safeErrorMessage(error)}`);
      process.exitCode = 1;
    });
}

module.exports = { bootstrapSecurity, quoteLiteral, runtimePassword, safeErrorMessage };
