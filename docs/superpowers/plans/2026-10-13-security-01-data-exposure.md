# Response data exposure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement response data exposure against the shared security specification.

**Architecture:** Retain the existing modular monolith and reuse verified API identities, explicit DTOs and transactional persistence. Changes stay within this packet; coordinator integrates shared wiring and cross-packet contracts.

**Tech Stack:** TypeScript, Express 5, Prisma/PostgreSQL, Vitest/node tests, Next.js, Redis/BullMQ, Docker/GitHub Actions as relevant.

**Spec:** [../specs/2026-10-13-security-hardening.md](../specs/2026-10-13-security-hardening.md)

## Global Constraints

Read every requirement in the shared spec, especially its permission table, exact limits, no-production-write rule and contract preservation. Do not change files owned by another packet. Dependency manifests/lockfiles, app.ts, config/env.ts, root env templates, compose.yaml, contracts and AGENTS.md are coordinator-owned; send precise patch instructions instead of editing them. Use local disposable databases only. No commits unless coordinator assigns an isolated branch and authorizes the exact scope.

## Dispatch

Agent label: A. Dependencies: None; start first.
The coordinator may assign a fresh implementer and reviewer for each task; labels identify work packets, not currently spawned agents. Read AGENTS.md first. Return changed files, test output, assumptions, migration/rollout implications and shared-file patch instructions.

## Review Focus

- Verify adversarial request identities cannot bypass authorization or falsify audit attribution.
- Check full serialized responses and logs rather than TypeScript types alone for secret exposure.
- Check concurrent and retried operations on disposable PostgreSQL/Redis, not only mocks.
- Check malformed/oversized inputs fail before expensive work and preserve documented response shapes.
- Check outage, upgrade and legacy client behavior without production access or unsafe fallback.

---

### Task 1: Safe user relations

**Files:**
- `backend/apps/api/src/modules/auth/public-user.select.ts (create)`
- `backend/apps/api/src/modules/admin/admin.repository.ts`
- `backend/apps/api/src/modules/audit/audit.service.ts`
- `backend/apps/api/src/modules/reconciliations/reconciliation.service.ts`
- `backend/apps/api/src/modules/admin/tests/data-exposure.test.ts (create)`

**Interfaces:** Consumes Prisma.UserSelect. Produces PUBLIC_USER_SELECT = { id: true, fullName: true, role: true } satisfies Prisma.UserSelect; reuse for all response-bearing User relations. Existing endpoint DTO shapes are retained except removed private user properties.

- [x] **Step 1 — Add regression tests:** Add tests named admin_order_relations_omit_credentials, audit_actor_omits_credentials, reconciliation_resolver_omits_credentials. Use fixture users with passwordHash="SENTINEL_HASH" and telegramChatId; assert serialized output contains neither field nor sentinel and preserves id/fullName/role, including null relations. Assert Prisma query uses explicit select, then serialize representative actual query results in disposable-DB acceptance tests.
- [x] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [x] **Step 3 — Implement:** Replace creator:true, assignedBarista:true, actor:true and resolvedBy:true in response queries with explicit select; inspect other response-bearing Prisma user relations. Do not change report internal-only relations just because they contain fields needed privately. No global string redaction or casting away fields.
- [x] **Step 4 — Verify:** `npm --prefix backend/apps/api test -- src/modules/admin/tests/data-exposure.test.ts; npm --prefix backend/apps/api run check`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [x] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): safe user relations`.

## Completion gate

Do not mark complete with skipped required integration checks. Record blockers separately. The coordinator reviews this packet and runs combined acceptance before integrating it into dev.

## Accepted execution — 2026-10-13

Completed by Hermes in Herdr coding1, pane wA:p2. Coordinator found and returned an unsafe disposable-database guard; fixed in one round with a test-only helper authorized as an additional file. Independent re-review ACCEPT. Coordinator fresh verification: focused unit/regression8 pass; API typecheck pass; Docker real query/serialization integration1 pass. Full API suite is not green: agent reports two missing DOCX-template failures. Source changes remain uncommitted on dev. See ../execution/2026-10-13-security-ledger.md.
