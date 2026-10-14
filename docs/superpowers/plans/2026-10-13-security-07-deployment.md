# Deployment and security delivery gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement deployment and security delivery gates against the shared security specification.

**Architecture:** Retain the existing modular monolith and reuse verified API identities, explicit DTOs and transactional persistence. Changes stay within this packet; coordinator integrates shared wiring and cross-packet contracts.

**Tech Stack:** TypeScript, Express 5, Prisma/PostgreSQL, Vitest/node tests, Next.js, Redis/BullMQ, Docker/GitHub Actions as relevant.

**Spec:** [../specs/2026-10-13-security-hardening.md](../specs/2026-10-13-security-hardening.md)

## Global Constraints

Read every requirement in the shared spec, especially its permission table, exact limits, no-production-write rule and contract preservation. Do not change files owned by another packet. Dependency manifests/lockfiles, app.ts, config/env.ts, root env templates, compose.yaml, contracts and AGENTS.md are coordinator-owned; send precise patch instructions instead of editing them. Use local disposable databases only. No commits unless coordinator assigns an isolated branch and authorizes the exact scope.

## Dispatch

Agent label: G. Dependencies: May draft alongside A/C; final wiring after D/E/F interfaces freeze. Coordinator owns all shared manifests, Compose and AGENTS edits.
The coordinator may assign a fresh implementer and reviewer for each task; labels identify work packets, not currently spawned agents. Read AGENTS.md first. Return changed files, test output, assumptions, migration/rollout implications and shared-file patch instructions.

## Review Focus

- Verify adversarial request identities cannot bypass authorization or falsify audit attribution.
- Check full serialized responses and logs rather than TypeScript types alone for secret exposure.
- Check concurrent and retried operations on disposable PostgreSQL/Redis, not only mocks.
- Check malformed/oversized inputs fail before expensive work and preserve documented response shapes.
- Check outage, upgrade and legacy client behavior without production access or unsafe fallback.

---

### Task 1: Least-privilege DB, Redis and HTTPS deployment

**Files:**
- `backend/prisma/sql/2026-10-13_runtime_roles.sql (create)`
- `backend/scripts/container-init.cjs`
- `backend/scripts/security-bootstrap.cjs (create)`
- `backend/apps/api/src/config/database.ts`
- `backend/apps/api/test/database.test.ts`
- `deploy/Caddyfile (create)`
- `deploy/redis-acl.template (create)`
- `backend/Dockerfile`
- `frontend/Dockerfile`
- `DOCKER_DEPLOYMENT.md`

**Interfaces:** Produces idempotent administrative bootstrap of order_flow_api and order_flow_worker non-superuser roles; API gets required business table DML but audit_logs only SELECT/INSERT, worker only notifications SELECT/UPDATE and users(id,role) SELECT. Admin migration credentials remain distinct. Redis ACL users: api(session/rate keys), bff(refresh keys), worker(BullMQ namespace). Caddy routes public web and explicit API/webhook paths over HTTPS; loopback development mode is documented.

- [ ] **Step 1 — Add regression tests:** Disposable roles cannot CREATE ROLE/DATABASE, ALTER/DROP tables, delete audit logs or read users.password_hash as worker; API authentication still reads hash. Worker dispatcher/requeue/send flows work using limited grants. DB invalid cert/hostname rejects, verify-full preserved. Untrusted Redis role cannot read session/result namespaces; BullMQ Lua/queue operations work. No external listener bypasses ingress in production config. SQL re-run is safe; new-volume and existing-volume upgrade both tested.
- [ ] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [ ] **Step 3 — Implement:** Do not embed passwords in SQL. Bootstrap reads secrets via files/environment with redacted errors; admin path initializes grants/sequences and applies pending migrations explicitly. Replace SSL compatibility downgrade with verify-full + CA support for remote URLs, retain explicitly local plaintext DB path. Draft Compose changes for coordinator: distinct API_DATABASE_URL/WORKER_DATABASE_URL, Redis URLs, PUBLIC_ORIGIN/proxy credential, private networks, reverse proxy, versions/digests, health checks, cap_drop/no-new-privileges/read-only + tmpfs where compatible. TLS domain and backup destinations remain operator-supplied; do not invent real values.
- [ ] **Step 4 — Verify:** `Validate composed config with dummy environment; run isolated Docker security integration for fresh/upgrade databases and Redis ACLs. Never run live migration/restore. npm --prefix backend/apps/api run test:node`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [ ] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): least-privilege db, redis and https deployment`.

### Task 2: CI scans, security regressions and restore rehearsal

**Files:**
- `.github/workflows/security-checks.yml (create)`
- `.github/workflows/publish-containers.yml`
- `backend/scripts/security-smoke.cjs (create)`
- `backend/docs/security-operations.md (create)`

**Interfaces:** Produces PR/push security workflow and release dependency gate. CI PostgreSQL/Redis instances supply TEST_DATABASE_URL/TEST_REDIS_URL only. Frontend test script from coordinator runs in CI. Scan dependencies in backend, backend/apps/api and frontend; scan tracked secrets/history and built runtime containers. No scanner credentials in repo.

- [ ] **Step 1 — Add regression tests:** Fixture forbidden staff requests, spoofed actor IDs, secret-free responses, wrong-bank/direction webhook, DB/Redis role isolation and concurrent transitions all pass in CI. Gate blocks known unwaived high/critical runtime findings and failing tests; report advisory identifiers rather than invent CVEs. Restore backup into disposable instance and compare expected user/order/payment/history/outbox counts and consistency.
- [ ] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [ ] **Step 3 — Implement:** Pin third-party actions by verified commit SHA and tools by explicit version; pin containers by digest at release. Release workflow needs successful checks on the same commit before publishing. Document finding exceptions with owner/expiry, JWT rollout re-login, credential migration, ingress/client IP trust, least-privilege upgrades, encrypted backups and restore runbook. Do not publish, rotate deployed credentials or modify GitHub settings.
- [ ] **Step 4 — Verify:** `Run all documented commands locally where dependencies available; validate workflow YAML, inspect permissions, then run CI on an explicitly authorized push. Record unavailable checks honestly.`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [ ] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): ci scans, security regressions and restore rehearsal`.

## Completion gate

Do not mark complete with skipped required integration checks. Record blockers separately. The coordinator reviews this packet and runs combined acceptance before integrating it into dev.
