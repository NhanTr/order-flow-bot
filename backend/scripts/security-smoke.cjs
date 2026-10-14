const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
const caddy = fs.readFileSync(path.join(root, "deploy/Caddyfile"), "utf8");
const roles = fs.readFileSync(path.join(root, "backend/prisma/sql/2026-10-13_runtime_roles.sql"), "utf8");
const backendDockerfile = fs.readFileSync(path.join(root, "backend/Dockerfile"), "utf8");
const frontendDockerfile = fs.readFileSync(path.join(root, "frontend/Dockerfile"), "utf8");
const postgresDockerfile = fs.readFileSync(path.join(root, "backend/Dockerfile.postgres"), "utf8");

const composeEnvironment = {
  ...process.env,
  POSTGRES_PASSWORD: "Admin.database-password-2026.test",
  API_DATABASE_PASSWORD: "Api.database-password-2026.test",
  WORKER_DATABASE_PASSWORD: "Worker.database-password-2026.test",
  REDIS_ADMIN_PASSWORD: "Admin.redis-password-2026.test",
  REDIS_API_PASSWORD: "Api.redis-password-2026.test",
  REDIS_BFF_PASSWORD: "Bff.redis-password-2026.test",
  REDIS_WORKER_PASSWORD: "Worker.redis-password-2026.test",
  JWT_ACCESS_SECRET: "jwt-access-secret-at-least-32-characters",
  JWT_REFRESH_SECRET: "jwt-refresh-secret-at-least-32-characters",
  BOT_INTERNAL_SECRET: "bot-internal-secret-at-least-32-characters",
  API_PROXY_SECRET: "api-proxy-secret-at-least-32-characters",
  PUBLIC_ORIGIN: "http://localhost",
  SEED_OWNER_PASSWORD: "owner-password-at-least-12",
  TELEGRAM_BOT_TOKEN: "123456:test-token",
};
delete composeEnvironment.ORDER_FLOW_VERSION;

const unpinned = spawnSync("docker", ["compose", "config", "--format", "json"], {
  cwd: root,
  env: composeEnvironment,
  encoding: "utf8",
});
assert.notEqual(unpinned.status, 0, "Compose must reject a missing immutable application version");

const configured = spawnSync("docker", ["compose", "config", "--format", "json"], {
  cwd: root,
  env: {
    ...composeEnvironment,
    ORDER_FLOW_VERSION: "sha-testcommit",
    TELEGRAM_WEBHOOK_PATH: "/telegram/custom",
  },
  encoding: "utf8",
});
assert.equal(configured.status, 0, configured.stderr);
const deployment = JSON.parse(configured.stdout);
assert.equal(
  deployment.services.caddy.environment.TELEGRAM_WEBHOOK_PATH,
  deployment.services["telegram-bot"].environment.TELEGRAM_WEBHOOK_PATH,
  "Caddy and Telegram Bot must use the same explicit webhook path",
);
for (const serviceName of ["postgres", "redis", "api", "web", "telegram-bot", "notification-worker"]) {
  assert.equal(deployment.services[serviceName].ports, undefined, `${serviceName} must not publish host ports`);
}
assert.deepEqual(
  deployment.services.caddy.ports.map(({ target }) => target).sort((left, right) => left - right),
  [80, 443],
);
for (const serviceName of ["db-init", "redis-init", "api", "web", "telegram-bot", "notification-worker", "caddy"]) {
  const serviceConfig = deployment.services[serviceName];
  assert.equal(serviceConfig.read_only, true, `${serviceName} must use a read-only root filesystem`);
  assert.ok(serviceConfig.cap_drop.includes("ALL"), `${serviceName} must drop all Linux capabilities`);
  assert.ok(serviceConfig.security_opt.includes("no-new-privileges:true"), `${serviceName} must disable privilege escalation`);
}

let service = "";
for (const line of compose.split("\n")) {
  const serviceHeader = line.match(/^  ([a-z][a-z0-9-]*):$/);
  if (serviceHeader) service = serviceHeader[1];
  if (/^    ports:$/.test(line) && ["api", "web", "telegram-bot"].includes(service)) {
    assert.fail(`${service} must not publish host ports`);
  }
}
assert.match(compose, /caddy:[\s\S]*ports:[\s\S]*:80["']?[\s\S]*:443["']?/m);
assert.match(compose, /data:\n\s+internal: true/);
assert.match(compose, /API_DATABASE_PASSWORD/);
assert.match(compose, /WORKER_DATABASE_PASSWORD/);
assert.match(compose, /redis:\/\/order_flow_api:/);
assert.match(compose, /redis:\/\/order_flow_bff:/);
assert.match(compose, /redis:\/\/order_flow_worker:/);
assert.match(caddy, /api\/v1\/sepay\/webhook/);
assert.match(roles, /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.audit_logs/);
assert.match(roles, /GRANT SELECT \(id, role\) ON TABLE public\.users TO order_flow_worker/);
for (const dockerfile of [backendDockerfile, frontendDockerfile, postgresDockerfile]) {
  for (const instruction of dockerfile.matchAll(/^FROM\s+(\S+)/gm)) {
    assert.match(instruction[1], /@sha256:[a-f0-9]{64}$/, `Base image must be digest-pinned: ${instruction[1]}`);
  }
}

console.info("Deployment security smoke checks passed");
