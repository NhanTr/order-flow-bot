# Order Flow container deployment

The release consists of three project images plus digest-pinned Redis and
Caddy images:

- `order-flow-backend`: API, Telegram Bot, notification worker, and database initializer.
- `order-flow-frontend`: production Next.js standalone server.
- `order-flow-postgres`: PostgreSQL 16 with the baseline Order Flow schema embedded.
- Redis: API sessions/rate limits, BFF refresh coordination, and BullMQ data
  separated by ACL users.
- Caddy: the only public ingress and HTTPS termination point.

The same backend image is started with different commands for the API, Bot, worker, and one-shot database initialization job. Images are published for both `linux/amd64` and `linux/arm64`.

## Run the published release

The target machine only needs Docker Engine with Docker Compose. Copy
`compose.yaml`, `.env.docker.example`, and the repository `deploy/` directory
into the same deployment directory, then:

```bash
cp .env.docker.example .env.docker
# Edit every replace-with-* value in .env.docker.
# Set ORDER_FLOW_VERSION to the immutable sha-<commit> release tag.
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker ps
```

Open the configured `PUBLIC_ORIGIN`. Only Caddy publishes `HTTP_PORT` and
`HTTPS_PORT`; API, Admin Web, Telegram Bot, PostgreSQL, and Redis remain on
Docker networks. Production should use an HTTPS domain. For a loopback test,
use `PUBLIC_ORIGIN=http://localhost` and a free `HTTP_PORT`.

`db-init` is expected to finish with exit code 0. It applies the rerunnable
security migration, creates least-privilege API/worker roles, and creates or
refreshes only the configured OWNER login. PostgreSQL initializes the baseline
schema only when its named volume is empty. Normal restarts preserve data.

Useful operations:

```bash
docker compose --env-file .env.docker logs -f api web telegram-bot notification-worker
docker compose --env-file .env.docker pull
docker compose --env-file .env.docker up -d
docker compose --env-file .env.docker down
```

`docker compose down` keeps data. `docker compose down -v` permanently deletes the PostgreSQL and Redis volumes and must only be used when a clean database is intended.

Telegram uses long polling when `TELEGRAM_WEBHOOK_DOMAIN` is empty. In webhook
mode, Caddy routes the configured Telegram path. Caddy also routes the explicit
SePay webhook path directly to the API; all browser traffic passes through the
Next.js BFF.

Credential separation, upgrade order, TLS verification, backup/restore, and
rollback steps are documented in
`backend/docs/security-operations.md`.

## Publish images to GHCR

The workflow `.github/workflows/publish-containers.yml` publishes all three
images when a version tag is pushed, after the same commit passes
`.github/workflows/security-checks.yml`:

```bash
git tag v1.0.0
git push origin v1.0.0
```

It creates `v1.0.0`, commit-SHA, and `latest` tags under:

```text
ghcr.io/danielnguyendbk/order-flow-backend
ghcr.io/danielnguyendbk/order-flow-frontend
ghcr.io/danielnguyendbk/order-flow-postgres
```

Set the three GHCR packages to **Public** if recipients should pull without authenticating. For private packages, recipients must run `docker login ghcr.io` with a token that has `read:packages` access.

To publish under another account or registry, build/push equivalent image names and change `ORDER_FLOW_IMAGE_PREFIX` in `.env.docker`.

## Build and test locally

```bash
docker build -t order-flow-backend:local backend
docker build -t order-flow-frontend:local frontend
docker build -f backend/Dockerfile.postgres -t order-flow-postgres:local backend
```

Use this local image prefix before running Compose:

```dotenv
ORDER_FLOW_IMAGE_PREFIX=order-flow
ORDER_FLOW_VERSION=local
```

For a release smoke test, verify that `redis-init` and `db-init` exit
successfully, all long-running services are healthy, only Caddy exposes host
ports, the OWNER can sign in, and the Bot can answer `/start`.
