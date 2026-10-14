# Authorization and atomic web lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement authorization and atomic web lifecycle against the shared security specification.

**Architecture:** Retain the existing modular monolith and reuse verified API identities, explicit DTOs and transactional persistence. Changes stay within this packet; coordinator integrates shared wiring and cross-packet contracts.

**Tech Stack:** TypeScript, Express 5, Prisma/PostgreSQL, Vitest/node tests, Next.js, Redis/BullMQ, Docker/GitHub Actions as relevant.

**Spec:** [../specs/2026-10-13-security-hardening.md](../specs/2026-10-13-security-hardening.md)

## Global Constraints

Read every requirement in the shared spec, especially its permission table, exact limits, no-production-write rule and contract preservation. Do not change files owned by another packet. Dependency manifests/lockfiles, app.ts, config/env.ts, root env templates, compose.yaml, contracts and AGENTS.md are coordinator-owned; send precise patch instructions instead of editing them. Use local disposable databases only. No commits unless coordinator assigns an isolated branch and authorizes the exact scope.

## Dispatch

Agent label: B. Dependencies: After A; before frontend integration and resource-limit integration.
The coordinator may assign a fresh implementer and reviewer for each task; labels identify work packets, not currently spawned agents. Read AGENTS.md first. Return changed files, test output, assumptions, migration/rollout implications and shared-file patch instructions.

## Review Focus

- Verify adversarial request identities cannot bypass authorization or falsify audit attribution.
- Check full serialized responses and logs rather than TypeScript types alone for secret exposure.
- Check concurrent and retried operations on disposable PostgreSQL/Redis, not only mocks.
- Check malformed/oversized inputs fail before expensive work and preserve documented response shapes.
- Check outage, upgrade and legacy client behavior without production access or unsafe fallback.

---

### Task 1: Verified actors and permission policy

**Files:**
- `backend/apps/api/src/modules/auth/auth.middleware.ts`
- `backend/apps/api/src/modules/auth/order-access.policy.ts (create)`
- `backend/apps/api/src/modules/admin/admin.routes.ts`
- `backend/apps/api/src/routes/index.ts`
- `backend/apps/api/src/modules/orders/order.controller.ts`
- `backend/apps/api/src/modules/orders/order.service.ts`
- `backend/apps/api/src/modules/orders/order.validation.ts`
- `backend/apps/api/src/modules/payments/payment.controller.ts`
- `backend/apps/api/src/modules/payments/payment.validation.ts`
- `backend/apps/api/src/modules/payments/payment.service.ts`
- `backend/apps/api/src/modules/refunds/refund.controller.ts`
- `backend/apps/api/src/modules/refunds/refund.validation.ts`
- `backend/apps/api/src/modules/refunds/refund.service.ts`
- `backend/apps/api/src/modules/reconciliations/reconciliation.controller.ts`
- `backend/apps/api/src/modules/admin/tests/admin.routes.test.ts`
- `backend/apps/api/src/modules/orders/tests/order.authorization.vitest.test.ts (create)`
- `backend/apps/api/src/modules/payments/tests/payment.authorization.test.ts (create)`

**Interfaces:** Consumes AccessIdentity from authenticated middleware and the spec permission table. Produces assertOrderAccess(actor: AccessIdentity, order: { createdByUserId: string }, action: "read" | "edit" | "cancel" | "pay" | "deliver"): void. Web services take actor: AccessIdentity as a separate required argument; addItem/updateItem/deleteItem/cancelOrder use this actor instead of optional requester IDs. confirmCash(orderId, input, actor) and initQrPayment(orderId, input, actor) derive attribution from actor.userId. Refund/reconciliation controllers force actor.userId into their internal service inputs after OWNER gating, never from the body.

- [ ] **Step 1 — Add regression tests:** Add authenticated staff-A/staff-B/owner/barista cases across list, read, edit, cancel, pay, refund, resolve, override and reports. Assert staff-A plus forged owner actor IDs cannot mutate staff-B orders or record refund/resolve (403, zero writes). Assert legacy actor fields are ignored; valid own-order cash succeeds with staff-A attribution. Assert staff list is scoped server-side even when createdByUserId query names staff-B. Replace existing test allowing staff overrides with expected 403. Missing auth returns 401; unknown order 404. Explicit owner assignment records owner as actor, barista as assignee.
- [ ] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [ ] **Step 3 — Implement:** Apply owner middleware to financial/admin routes individually or put all after OWNER gate, keeping staff own-order access in /orders. Remove client IDs as acting identity throughout the web flow. Pass authenticated actor to services, validate role/ownership within the transaction, and keep lifecycle checks. Ready is owner-with-reason on web, assigned barista through existing Telegram path. Do not modify Telegram router auth protocol.
- [ ] **Step 4 — Verify:** `npm --prefix backend/apps/api test -- src/modules/admin/tests/admin.routes.test.ts src/modules/orders/tests/order.authorization.vitest.test.ts src/modules/payments/tests/payment.authorization.test.ts; npm --prefix backend/apps/api run check`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [ ] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): verified actors and permission policy`.

### Task 2: Atomic state, history and refund idempotency

**Files:**
- `backend/apps/api/src/modules/orders/order.repository.ts`
- `backend/apps/api/src/modules/orders/order.service.ts`
- `backend/apps/api/src/modules/refunds/refund.service.ts`
- `backend/prisma/sql/2026-10-13_refund_idempotency.sql (create)`
- `backend/apps/api/src/modules/orders/tests/web-lifecycle.security.integration.test.ts (create)`
- `backend/apps/api/src/modules/refunds/tests/refund.security.integration.test.ts (create)`
- `backend/apps/api/vitest.security-integration.config.ts (create)`

**Interfaces:** Consumes policy from Task 1 and Prisma.TransactionClient. Produces web lifecycle repository methods taking tx and guarded expected status; service transaction encompasses mutation/history/audit/outbox. SQL produces unique index on audit_logs(entity_id) WHERE action='MANUAL_REFUND_RECORDED' AND entity_type='PAYMENT'; verify enum names against schema. Existing duplicate audits cause migration to abort with a diagnostic, never delete records automatically.

- [ ] **Step 1 — Add regression tests:** In disposable PostgreSQL race two claims, ready versus cancel, edit versus cash, and two refund requests. Assert one winner for mutually exclusive transitions, no orphan history or missing history, only one refund audit; forced history insertion failure rolls back mutation. Assert two different payments can each refund once. Test guard refuses non-disposable database URLs.
- [ ] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [ ] **Step 3 — Implement:** Reuse serializable retry and conditional updates from Telegram implementation; retain precise 409 conflicts. Create unique partial index and map collision to 409. Cancellation of paid orders must not erase payment data. Stage this migration for deploy; do not run against normal DATABASE_URL.
- [ ] **Step 4 — Verify:** `TEST_DATABASE_URL=<disposable-local-url> npm --prefix backend/apps/api run test:security:integration; npm --prefix backend/apps/api test`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [ ] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): atomic state, history and refund idempotency`.

## Completion gate

B1 accepted 2026-10-13 after coordinator review and fresh verification: 50 tests
across 11 relevant files, API typecheck and diff checks passed. See the execution
ledger for review corrections. B2 accepted 2026-10-14 after 61 relevant unit tests,
9 Docker concurrency/rollback/migration integration tests, API typecheck and
diff checks passed. Generated-code collisions retry fresh transactions; other
unique errors are not retried. User requested stopping after B2.

Do not mark complete with skipped required integration checks. Record blockers separately. The coordinator reviews this packet and runs combined acceptance before integrating it into dev.
