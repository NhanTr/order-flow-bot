# Order Flow Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the reviewed authorization, data exposure, payment integrity and deployment gaps with independently reviewable agent tasks.

**Architecture:** Keep the modular monolith and its separate web/bot/worker processes. Share one documented authorization policy across entry points; harden database transactions, DTOs, Redis authentication state and ingress. Do not split services in this change.

**Tech Stack:** Express 5/TypeScript, Prisma 6/PostgreSQL 16, Next.js 16/React 19, Redis/BullMQ, Vitest/node tests, Docker Compose/GitHub Actions.

**Spec:** [Security specification](../specs/2026-10-13-security-hardening.md)

## Global Constraints

- Repository: NhanTr/order-flow-bot; local branch dev created from master d970cbdd822b29b18e144b375d301c1a71281a3b on 2026-10-13. No remote branch was created or pushed.
- Implementation is in progress; checkboxes are marked only after coordinator verification. See the execution ledger for current evidence.
- Read AGENTS.md and the shared spec; preserve /api/v1, Telegram revision protocol, numeric/UUID transaction IDs and OWNER-only read-only Swift contract.
- Never run migration, restore, secret rotation or deployment against live systems. TEST_DATABASE_URL and TEST_REDIS_URL must explicitly identify disposable local resources and must never fall back to normal environment credentials.
- Parent session has four concurrency slots: at most three child agents plus the coordinator. Do not launch all seven packets simultaneously.
- Coordinator owns backend/package.json + lock, backend/apps/api/package.json + lock, frontend/package.json + lock, backend/apps/api/src/app.ts, backend/apps/api/src/config/env.ts, root env templates, compose.yaml, backend/docs/api-contract.md, backend/docs/openapi.yaml and AGENTS.md. Agent patches for these files are integrated sequentially.
- Agents edit only their packet files. For integration-test config shared by B/C/D/E, B creates it and others request updates through coordinator. Shared file conflicts stop dependent work until reconciled; never overwrite another agent's edits.

## Review Focus

- Forged owner IDs and existing staff override tests must become denied requests with zero side effects (B).
- Nested User relations can leak password hashes despite safe frontend TypeScript types (A).
- Distinct concurrent transfers/retries and refunds can corrupt settled state even when ordinary duplicate tests pass (B/C).
- Parallel BFF refresh across replicas must not trigger reuse revocation or resurrect a logged-out session (E/F).
- Fresh install and upgrade, Redis outage/ACL isolation and remote invalid certificates must fail safely (D/E/G).

## Agent packets and ownership

| Agent | Packet | Main deliverable | Dependency |
| --- | --- | --- | --- |
| A | [01 Data exposure](2026-10-13-security-01-data-exposure.md) | Safe response user projections | None |
| B | [02 Authorization](2026-10-13-security-02-authorization.md) | Verified actors, ownership, role policy, atomic web lifecycle/refund | A |
| C | [03 SePay](2026-10-13-security-03-sepay.md) | Authenticated exact bank matching, atomic settlement | Independent; combined acceptance after B |
| D | [04 API controls](2026-10-13-security-04-api-controls.md) | Bounds, throttling, debug removal | B |
| E | [05 Sessions](2026-10-13-security-05-sessions.md) | Async Redis sessions and rotation | D for auth-route/interface cleanup |
| F | [06 Frontend](2026-10-13-security-06-frontend.md) | Role-aware UI, pagination, BFF protection and refresh | B/D/E |
| G | [07 Deployment](2026-10-13-security-07-deployment.md) | Limited DB/Redis roles, HTTPS, CI and restore verification | Draft independently; finish after D/E/F |

## Dispatch order

1. A, C and G initial file-local work can run together. G must send shared Compose/env/dependency changes to coordinator instead of editing them.
2. Review A, then dispatch B while C/G continue, maintaining at most three active children. B must not edit SePay files.
3. Review B/C. Dispatch D; coordinator prepares shared dependency/environment interfaces. G may continue file-local work.
4. Review D, integrate its app/env changes, then dispatch E. Do not concurrently edit auth.service/store or app/env.
5. Integrate E, dispatch F, and resume G deployment finalization against frozen config/contract names.
6. Review packets individually; coordinator executes combined security acceptance and whole-branch review. Publishing and live deployment are a separate operation.

## Copy-ready agent assignment

Use this prompt with the appropriate packet path:

> Implement only the assigned security packet `<path>` on an isolated assigned branch based on the latest reviewed dev. Read AGENTS.md and docs/superpowers/specs/2026-10-13-security-hardening.md first. Follow the packet's interfaces, ownership, dependency and test gates. Use the specified superpowers implementation skills. Do not edit coordinator-owned or other agents' files; return exact patches/instructions for shared wiring. No remote push, deployment or production data access. Report changed files, failing-before/passing-after evidence, required disposable integration checks, rollout implications and remaining blockers. Do not claim completion if required checks were not run.

Coordinator provisions worktrees only with user authorization and sandbox approval where necessary. In a shared filesystem, directory separation alone is insufficient: assign branches/worktrees and never have agents switch the coordinator's branch. If isolation is unavailable, execute packets sequentially.

## Coordinator tasks

### Task 1: Dependency setup and baseline

**Files:** shared manifests/lockfiles; backend/apps/api/vitest.security-integration.config.ts (with B); frontend/vitest.config.ts (create); frontend test setup if needed.

**Interfaces:** approve the maintained `redis` client package for API/BFF stores, `helmet` for API headers, and a Redis-backed limiter implemented through the common client. Existing worker BullMQ connection behavior is retained. Add API `test:security:integration` and frontend `test:security` scripts; integration config includes `**/*.security.integration.test.ts`, frontend Vitest includes `tests/**/*.test.ts` with Node environment. Install versions verified against current official docs and record lockfile changes; do not invent version floors.

- [ ] Install locked existing dependencies with npm ci in backend, backend/apps/api and frontend; generate Prisma with npm --prefix backend run generate:prisma.
- [ ] Run API test, test:node, check; bot test:bot/check:bot; frontend lint/build. Record baseline failures separately from security failures.
- [ ] Add only agreed dependencies, configs and scripts with lockfile updates. Frontend agents must read installed Next.js docs before code changes.
- [ ] Establish reusable disposable local PostgreSQL/Redis fixture URLs and defensive target checks. Tests create/clean only their assigned disposable resources. No printing credentials.

### Task 2: Sequential shared wiring and contracts

**Files:** app.ts, config/env.ts, .env.example, .env.docker.example, compose.yaml, API contracts, AGENTS.md.

**Interfaces:** API Redis config REDIS_URL; BFF config BFF_REDIS_URL; API_PROXY_SECRET in API/BFF; PUBLIC_ORIGIN in BFF; TRUST_PROXY_HOPS defaults 0 and production ingress config 1. Dedicated runtime API_DATABASE_URL/WORKER_DATABASE_URL are mapped to each process DATABASE_URL; administrative POSTGRES/bootstrap credential never injected into API/worker. Secrets are distinct and minimum 32 characters. Domain/public-origin/operator passwords have no real defaults.

- [ ] Integrate D middleware in documented order; add parser-error mapping, exact rate/size settings and export locks. Account/IP throttling must continue to work behind BFF.
- [ ] Integrate E Redis session composition/disposal; change every session-store consumer/test to await operations; no global clear on shutdown. Remove obsolete debug/list interface.
- [ ] Integrate F authenticated BFF identity headers and Redis single-flight config. Cache-Control:no-store for session/sensitive responses; explicitly protect cookie mutations against cross-origin requests.
- [ ] Integrate G private ingress, distinct DB/Redis credentials, verified TLS and initialization/migration path. Fresh DB images AND existing-volume upgrades must include new refund-idempotency SQL; bootstrap runtime grants only after schema migrations.
- [ ] Update api-contract.md/openapi.yaml for actor-free inputs, permission table, bounded page envelopes, limits/status codes, webhook ignored behavior and Redis outage503. Preserve menu/employee limits1000.
- [ ] Update AGENTS architecture/config/operational navigation together with actual changes.

### Task 3: Acceptance and branch handoff

**Interfaces:** all packet outputs and completed permission/transaction/transport checks.

- [ ] Run npm --prefix backend/apps/api run check, test and test:node; npm --prefix backend run check:bot/test:bot/build:bot; npm --prefix frontend run test:security/lint/build (run each script individually).
- [ ] Run npm --prefix backend/apps/api run test:security:integration with explicit disposable TEST_DATABASE_URL/TEST_REDIS_URL; run two-instance API/BFF tests and limited-role Docker smoke. No required skip accepted as passing.
- [ ] Check every finding against its packet evidence: hashes A, actor/ownership/admin B, webhook C, bounds/debug/rates D, shared sessions E, BFF/CSRF F, least privilege/TLS/ingress/CI G. Confirm relevant owner/staff/Telegram CASH/QR/barista/export flows still work.
- [ ] Inspect git diff --check and scoped file changes; ensure no secrets/generated artifacts/unrelated edits. Run dependency scans against all three lockfiles and scans against actual runtime images; record actual advisories and resolved/waived findings.
- [ ] Run backup restore into disposable DB; verify state/history/outbox consistency. Do not restore live data.
- [ ] Request fresh whole-branch code review, address findings, rerun affected checks. Update packet completion and test evidence.
- [ ] Hand off reviewed dev branch with migration order, rollback limits, required operator settings, JWT re-login note and deployment risks. Commit/push only within explicitly authorized scope; never publish or deploy implicitly.

## Current state

Local dev branch exists. Packet A has been implemented and accepted after unit,
typecheck and disposable Docker integration verification. Hermes in Herdr pane
`wA:p2` completed B1 and B2. B2 was accepted on 2026-10-14 after coordinator
verification: 61 relevant unit tests, 9 Docker integration tests, API typecheck
and diff checks passed. The user then explicitly stopped execution at B2;
C through G are pending and C1 was never dispatched. The user subsequently
authorized committing and pushing the accumulated changes to origin/dev.
Full API suite: 111 passed, 2 known failures from missing DOCX templates.
Current details and evidence:
[execution ledger](../execution/2026-10-13-security-ledger.md).
