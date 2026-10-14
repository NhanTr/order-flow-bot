# SePay payment integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement sepay payment integrity against the shared security specification.

**Architecture:** Retain the existing modular monolith and reuse verified API identities, explicit DTOs and transactional persistence. Changes stay within this packet; coordinator integrates shared wiring and cross-packet contracts.

**Tech Stack:** TypeScript, Express 5, Prisma/PostgreSQL, Vitest/node tests, Next.js, Redis/BullMQ, Docker/GitHub Actions as relevant.

**Spec:** [../specs/2026-10-13-security-hardening.md](../specs/2026-10-13-security-hardening.md)

## Global Constraints

Read every requirement in the shared spec, especially its permission table, exact limits, no-production-write rule and contract preservation. Do not change files owned by another packet. Dependency manifests/lockfiles, app.ts, config/env.ts, root env templates, compose.yaml, contracts and AGENTS.md are coordinator-owned; send precise patch instructions instead of editing them. Use local disposable databases only. No commits unless coordinator assigns an isolated branch and authorizes the exact scope.

## Dispatch

Agent label: C. Dependencies: May run alongside A/B; owns only SePay files. Coordinator runs combined payment acceptance after B.
The coordinator may assign a fresh implementer and reviewer for each task; labels identify work packets, not currently spawned agents. Read AGENTS.md first. Return changed files, test output, assumptions, migration/rollout implications and shared-file patch instructions.

## Review Focus

- Verify adversarial request identities cannot bypass authorization or falsify audit attribution.
- Check full serialized responses and logs rather than TypeScript types alone for secret exposure.
- Check concurrent and retried operations on disposable PostgreSQL/Redis, not only mocks.
- Check malformed/oversized inputs fail before expensive work and preserve documented response shapes.
- Check outage, upgrade and legacy client behavior without production access or unsafe fallback.

---

### Task 1: Authenticated canonical transaction ingestion

**Files:**
- `backend/apps/api/src/modules/sepay/sepay.validation.ts`
- `backend/apps/api/src/modules/sepay/sepay.controller.ts`
- `backend/apps/api/src/modules/sepay/sepay.service.ts`
- `backend/apps/api/src/modules/sepay/sepay-api.client.ts`
- `backend/apps/api/src/modules/sepay/sepay-transaction.ts (create)`
- `backend/apps/api/src/modules/sepay/tests/sepay.service.test.ts`
- `backend/apps/api/src/modules/sepay/tests/sepay.controller.test.ts`
- `backend/apps/api/src/modules/sepay/tests/sepay-api.client.test.ts`

**Interfaces:** Produces NormalizedSepayTransaction { externalId: string; accountNumber: string; direction: "in" | "out"; amountIn: bigint; transactionDate: Date; content: string; paymentCode: string | null; referenceCode: string | null; rawPayload: Prisma.InputJsonValue }. External adapters produce this type; trusted lookup does not bypass bank validation. Webhook verifyWebhook(headers) runs before validate/normalize. Ignored response extends existing result without removing existing matched/duplicate fields.

- [ ] **Step 1 — Add regression tests:** Test missing secret in development/test/production gives 503; bad key 401 before any business validation or DB call. Test official v1/v2 and webhook aliases, numeric/UUID IDs, zero/outgoing amount, wrong account, malformed date, unsafe numeric amounts and 60-second boundary. Wrong-account/outgoing valid records yield ignored=true and no business writes; malformed input 400; missing configured account 503. Never put real tokens/accounts in fixtures.
- [ ] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [ ] **Step 3 — Implement:** Check official SePay docs and store source links/field mapping in handoff. Build pure normalization; use nonnegative canonical decimal-string BigInt parsing with signed-bigint ceiling. Normalize Asia/Ho_Chi_Minh dates consistently with lookup. Keep secret checks timing-safe. Update tunnel-proxy fixtures if stronger contract requires it, but do not bypass authentication.
- [ ] **Step 4 — Verify:** `npm --prefix backend/apps/api test -- src/modules/sepay/tests; npm --prefix backend/apps/api run check`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [ ] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): authenticated canonical transaction ingestion`.

### Task 2: Exact matching and concurrent delivery

**Files:**
- `backend/apps/api/src/modules/sepay/sepay.service.ts`
- `backend/apps/api/src/modules/sepay/tests/sepay.security.integration.test.ts (create)`

**Interfaces:** Consumes NormalizedSepayTransaction and unique sepayTransactionId constraint. Produces exact complete-token payment-code lookup and atomic ingestion; existing public result matched/duplicate semantics remain. Uses payment.createdAt for the existing lookup timestamp baseline; no invented initialization column.

- [ ] **Step 1 — Add regression tests:** Test short code prefix, order-code-only text, embedded substring, two complete known codes, duplicate delivery, two distinct transactions racing for one payment, paid/preparing/ready/delivered/cancelled orders and webhook versus active lookup races. Assert settled state/receivedAmount never downgraded or overwritten; no duplicate ORDER_PAID; duplicate external ID returns success. Ambiguous code writes a review transaction without assigning a payment. Assert no unbounded findMany scan.
- [ ] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [ ] **Step 3 — Implement:** Remove contains filters and full-table fallback; extract complete code tokens and select exact matches. Persist nonmatching relevant incoming transactions for owner review. Conditional order transition guards and serializable retry ensure one payment transition. Review events do not mutate settled order/payment amounts. Handle unique-key conflict after rollback by reading duplicate result.
- [ ] **Step 4 — Verify:** `npm --prefix backend/apps/api test -- src/modules/sepay/tests; TEST_DATABASE_URL=<disposable-local-url> npm --prefix backend/apps/api run test:security:integration`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [ ] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): exact matching and concurrent delivery`.

## Completion gate

Do not mark complete with skipped required integration checks. Record blockers separately. The coordinator reviews this packet and runs combined acceptance before integrating it into dev.
