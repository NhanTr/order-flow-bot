# Security operations

This runbook applies to the production Compose stack. It does not authorize a
live deployment, credential rotation, database migration, or restore.

## Required credentials

Generate every credential independently. Database and Redis passwords must be
at least 24 URL-safe characters using letters, numbers, dot, underscore, tilde,
or hyphen. JWT, Bot, and BFF proxy secrets must contain at least 32 characters.

- `POSTGRES_PASSWORD` is administrative and is injected only into `postgres`
  and the one-shot `db-init` job.
- `API_DATABASE_PASSWORD` belongs to `order_flow_api`.
- `WORKER_DATABASE_PASSWORD` belongs to `order_flow_worker`.
- `REDIS_ADMIN_PASSWORD` belongs only to the ACL initialization job.
- `REDIS_API_PASSWORD`, `REDIS_BFF_PASSWORD`, and `REDIS_WORKER_PASSWORD`
  grant access only to their service namespaces.

Never inject the PostgreSQL administrator credential into API or worker
containers. Keep `.env.docker` outside Git and restrict it to the operator.

## Database initialization and upgrades

The PostgreSQL image initializes a fresh volume in this order:

1. baseline schema;
2. SePay v2 identifier migration;
3. manual-refund idempotency index.

On every deployment, `db-init` connects with `ADMIN_DATABASE_URL`, reruns the
idempotent refund migration, creates or repairs runtime grants, assigns runtime
passwords, and then creates or refreshes the OWNER login. This covers existing
volumes that do not rerun `/docker-entrypoint-initdb.d`.

The API role can read and mutate business tables, but `audit_logs` permits only
`SELECT` and `INSERT`. The worker can only read/update `notifications` and read
`users(id, role)`. Neither role owns schema objects or can create roles or
databases.

For a PostgreSQL server outside the private Compose network, use
`sslmode=verify-full`. Add `sslrootcert=/absolute/path/to/ca.pem` when the
server certificate is not rooted in the operating-system trust store.
`sslmode=require` and `uselibpqcompat` are rejected for remote hosts.

## Ingress and Redis

Caddy is the only service with host ports. It terminates HTTPS, sends normal
traffic to the Next.js BFF, and exposes only the explicit SePay and Telegram
webhook paths to their services. API, Web, Bot, PostgreSQL, and Redis have no
host port in the production Compose file. Set `TRUST_PROXY_HOPS=1` only for
this topology.

Redis starts on the private data network. The `redis-init` job creates separate
ACL users for API sessions/rate limits, BFF refresh coordination, and the
BullMQ notification queue, then disables the default user. The tracked ACL
template contains placeholders only.

For loopback-only evaluation without public TLS, set
`PUBLIC_ORIGIN=http://localhost` and map `HTTP_PORT` to a free local port.
Keep `TRUST_PROXY_HOPS=1` because Caddy remains the only ingress.

## Backup and restore rehearsal

Create backups with the administrative database credential, encrypt them at
rest, and store them outside the application host. Never put a database URL in
the command history; use `PGPASSFILE` or the operator's secret manager.

Before each release, restore the backup into a disposable database and compare
counts for `users`, `orders`, `payments`, `order_status_history`, and
`notifications`. Verify that status-history rows still reference orders and
notification rows still reference recipients. The security workflow performs
this rehearsal with synthetic CI data. It never restores production data.

## Release and rollback

Use the immutable `sha-<commit>` application image tag and the digest-pinned
Redis/Caddy images in `.env.docker`. The publish workflow cannot publish until
the reusable security workflow succeeds for the same commit.

The JWT issuer/audience change invalidates older sessions, so users must sign
in again after the security release. Rollback can restore prior application
images, but it must not remove the refund uniqueness index or runtime roles.
Keep the new credentials and ACLs during rollback.

## Security findings

`npm --prefix backend run security:audit` rejects unwaived high or critical
runtime findings across all three package locks. The current Prisma CLI
configuration advisory `GHSA-ggr8-5vv4-36mx` is temporarily waived until
2027-01-31 because the affected merge code is build/migration tooling and does
not process request data in a runtime service. The owner and expiry live in
`backend/docs/security-advisory-waivers.json`; an expired waiver fails the gate.

Image scanning uses Trivy and fails on fixed high or critical findings.
Gitleaks scans tracked history. Exceptions require a named owner, rationale,
and expiry in the repository before release.
