# API resource bounds and debug removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement api resource bounds and debug removal against the shared security specification.

**Architecture:** Retain the existing modular monolith and reuse verified API identities, explicit DTOs and transactional persistence. Changes stay within this packet; coordinator integrates shared wiring and cross-packet contracts.

**Tech Stack:** TypeScript, Express 5, Prisma/PostgreSQL, Vitest/node tests, Next.js, Redis/BullMQ, Docker/GitHub Actions as relevant.

**Spec:** [../specs/2026-10-13-security-hardening.md](../specs/2026-10-13-security-hardening.md)

## Global Constraints

Read every requirement in the shared spec, especially its permission table, exact limits, no-production-write rule and contract preservation. Do not change files owned by another packet. Dependency manifests/lockfiles, app.ts, config/env.ts, root env templates, compose.yaml, contracts and AGENTS.md are coordinator-owned; send precise patch instructions instead of editing them. Use local disposable databases only. No commits unless coordinator assigns an isolated branch and authorizes the exact scope.

## Dispatch

Agent label: D. Dependencies: After B; reserves app.ts/config/env.ts changes through coordinator integration, not simultaneous edits with E.
The coordinator may assign a fresh implementer and reviewer for each task; labels identify work packets, not currently spawned agents. Read AGENTS.md first. Return changed files, test output, assumptions, migration/rollout implications and shared-file patch instructions.

## Review Focus

- Verify adversarial request identities cannot bypass authorization or falsify audit attribution.
- Check full serialized responses and logs rather than TypeScript types alone for secret exposure.
- Check concurrent and retried operations on disposable PostgreSQL/Redis, not only mocks.
- Check malformed/oversized inputs fail before expensive work and preserve documented response shapes.
- Check outage, upgrade and legacy client behavior without production access or unsafe fallback.

---

### Task 1: Bound inputs and responses

**Files:**
- `backend/apps/api/src/middleware/pagination.ts (create)`
- `backend/apps/api/src/middleware/request-limits.ts (create)`
- `backend/apps/api/src/modules/orders/order.validation.ts`
- `backend/apps/api/src/modules/orders/order.controller.ts`
- `backend/apps/api/src/modules/admin/admin.controller.ts`
- `backend/apps/api/src/modules/audit/audit.controller.ts`
- `backend/apps/api/src/modules/audit/audit.service.ts`
- `backend/apps/api/src/modules/reconciliations/reconciliation.controller.ts`
- `backend/apps/api/src/modules/reconciliations/reconciliation.service.ts`
- `backend/apps/api/src/modules/reports/revenue.validation.ts`
- `backend/apps/api/src/modules/reports/revenue-export.service.ts`
- `backend/apps/api/src/modules/auth/auth.routes.ts`
- `backend/apps/api/src/middleware/error-handler.ts`
- `backend/apps/api/src/modules/admin/tests/resource-limits.test.ts (create)`

**Interfaces:** Produces parsePagination(query: unknown): { page: number; limit: number; skip: number } and bounded existing list DTO { data, total, page, limit }. Reconciliation/audit services consume parsed pagination. Remove debug session route entirely. Resource middleware builder receives Redis connection and trusted client identity from coordinator; no module-global connection.

- [x] **Step 1 — Add regression tests:** Test page/limit zero, negative, fractional, overflow, repeated query parameters and limit=101 reject with 400; limit=100 works. Test 101 lines, quantity=1001, unsafe integer and 2001-character note rejected. Test 367-day range and export 10001-order preflight rejected before workbook rendering. Verify debug route 404 in every environment. Verify typed HTTP parser errors honor 400/413 rather than leak internals or become 500.
- [x] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [x] **Step 3 — Implement:** Implement spec limits without changing catalog/employee maximum 1000. Bound reads in DB, not after loading everything. Reports count before generation and apply per-owner export lock. Keep frontend-compatible data wrapper. Remove debug list from public store interface after E reconciliation. Supply app/env integration patch notes to coordinator.
- [x] **Step 4 — Verify:** `npm --prefix backend/apps/api test -- src/modules/admin/tests/resource-limits.test.ts; npm --prefix backend/apps/api run test:node; npm --prefix backend/apps/api run check`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [x] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): bound inputs and responses`.

### Task 2: Distributed throttling and security headers

**Files:**
- `backend/apps/api/src/middleware/rate-limit.ts (create)`
- `backend/apps/api/src/middleware/proxy-client-identity.ts (create)`
- `backend/apps/api/src/modules/auth/tests/rate-limit.test.ts (create)`
- `backend/apps/api/src/modules/auth/tests/rate-limit.security.integration.test.ts (create)`

**Interfaces:** Produces createSecurityLimiters(redis: RedisClient, options: { proxySecret: string; trustProxyHops: number }): middleware set for login/session/general/export. Use the same approved Redis client dependency as E. Internal header names: x-order-flow-proxy-secret and x-order-flow-client-ip. API accepts them only after timing-safe proxy credential check; untrusted copies do not affect identity.

- [x] **Step 1 — Add regression tests:** At configured threshold next request returns 429 + Retry-After; second API instance sees same count. Rotating untrusted X-Forwarded-For does not bypass limit. Fake BFF client-IP header without proxy secret ignored. Redis outage returns 503. Expired window resets counters. Verify non-auth requests cannot mint unlimited IP-independent session counters.
- [x] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [x] **Step 3 — Implement:** Use atomic Redis counters with TTL and namespaced keys; account keys normalize lowercase username. Default trust proxy=0. Provide coordinator exact middleware mount order: parsers/body limits, credential-validated client identity, auth endpoint limiters, authenticated per-user limiter after auth, export lock. Add secure headers/CSP through maintained middleware after compatibility testing; no blanket CSP that breaks Next.js.
- [x] **Step 4 — Verify:** `npm --prefix backend/apps/api test -- src/modules/auth/tests/rate-limit.test.ts; TEST_REDIS_URL=<disposable-local-url> npm --prefix backend/apps/api run test:security:integration`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [x] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): distributed throttling and security headers`.

## Completion gate

Do not mark complete with skipped required integration checks. Record blockers separately. The coordinator reviews this packet and runs combined acceptance before integrating it into dev.
