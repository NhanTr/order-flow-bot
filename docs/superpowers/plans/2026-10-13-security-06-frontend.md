# Frontend permission and session boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement frontend permission and session boundary against the shared security specification.

**Architecture:** Retain the existing modular monolith and reuse verified API identities, explicit DTOs and transactional persistence. Changes stay within this packet; coordinator integrates shared wiring and cross-packet contracts.

**Tech Stack:** TypeScript, Express 5, Prisma/PostgreSQL, Vitest/node tests, Next.js, Redis/BullMQ, Docker/GitHub Actions as relevant.

**Spec:** [../specs/2026-10-13-security-hardening.md](../specs/2026-10-13-security-hardening.md)

## Global Constraints

Read every requirement in the shared spec, especially its permission table, exact limits, no-production-write rule and contract preservation. Do not change files owned by another packet. Dependency manifests/lockfiles, app.ts, config/env.ts, root env templates, compose.yaml, contracts and AGENTS.md are coordinator-owned; send precise patch instructions instead of editing them. Use local disposable databases only. No commits unless coordinator assigns an isolated branch and authorizes the exact scope.

## Dispatch

Agent label: F. Dependencies: After B and D contract freeze; after E shared session interface. No backend file edits.
The coordinator may assign a fresh implementer and reviewer for each task; labels identify work packets, not currently spawned agents. Read AGENTS.md first. Return changed files, test output, assumptions, migration/rollout implications and shared-file patch instructions.

## Review Focus

- Verify adversarial request identities cannot bypass authorization or falsify audit attribution.
- Check full serialized responses and logs rather than TypeScript types alone for secret exposure.
- Check concurrent and retried operations on disposable PostgreSQL/Redis, not only mocks.
- Check malformed/oversized inputs fail before expensive work and preserve documented response shapes.
- Check outage, upgrade and legacy client behavior without production access or unsafe fallback.

---

### Task 1: Adapt staff UI, pagination and trusted BFF

**Files:**
- `frontend/src/lib/api.ts`
- `frontend/src/components/AppShell.tsx`
- `frontend/src/app/(admin)/orders/new/page.tsx`
- `frontend/src/app/(admin)/orders/[orderId]/page.tsx`
- `frontend/src/app/(admin)/payments/page.tsx`
- `frontend/src/app/(admin)/reconciliations/page.tsx`
- `frontend/src/app/(admin)/audit/page.tsx`
- `frontend/src/lib/server-api.ts`
- `frontend/src/app/api/backend/[...path]/route.ts`
- `frontend/src/app/api/auth/login/route.ts`
- `frontend/src/app/api/auth/logout/route.ts`
- `frontend/src/lib/request-security.ts (create)`
- `frontend/next.config.ts`
- `frontend/TESTING.md`

**Interfaces:** Consumes new actor-free inputs, permission matrix and paginated DTOs from B/D. Produces same-origin browser mutation guard and authenticated BFF proxy headers; uses configured PUBLIC_ORIGIN and API_PROXY_SECRET. Node runtime only for Redis client; never expose these as NEXT_PUBLIC vars. Preserve HttpOnly + Secure cookies.

- [ ] **Step 1 — Add regression tests:** Test owner/staff page matrix, own order CASH/QR without actor fields, empty last page and pagination beyond 100 records. Same-origin mutations succeed; foreign/null/absent Origin fails 403 before fetch; GET remains available. BFF strips malicious proxy/IP headers, supplies validated request identity only from trusted ingress, blocks path traversal and proxying auth/token endpoints through catch-all, times out 15s normal/60s export, handles invalid upstream JSON without token leakage.
- [ ] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [ ] **Step 3 — Implement:** Read frontend/AGENTS.md and installed Next.js docs first. Hide owner-only links/actions and show existing forbidden page for direct access. Update list consumers; do not rely on hiding UI for authorization. Allowlist upstream business paths and methods; login/logout use dedicated handlers. Sensitive proxy/auth responses use Cache-Control:no-store. Add deliberate security headers after verifying fonts/images/Next hydration.
- [ ] **Step 4 — Verify:** `npm --prefix frontend run lint; npm --prefix frontend run build; follow updated frontend/TESTING.md using owner and staff fixtures`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [ ] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): adapt staff ui, pagination and trusted bff`.

### Task 2: Distributed BFF refresh single-flight

**Files:**
- `frontend/src/lib/session-refresh.ts (create)`
- `frontend/src/lib/server-api.ts`
- `frontend/src/app/api/backend/[...path]/route.ts`
- `frontend/tests/session-refresh.test.ts (create)`
- `frontend/tests/request-security.test.ts (create)`

**Interfaces:** Produces refreshSessionOnce(refreshToken: string): Promise<SessionPayload | null> backed by separate Redis namespace/ACL, key = SHA256(refreshToken), 10-second lock, 10-second cached result; only lock winner calls API refresh. No raw tokens in Redis keys/logs. Result data contains rotated bearer tokens and must be restricted to BFF Redis role. Coordinator supplies test runner/package scripts.

- [ ] **Step 1 — Add regression tests:** Two simultaneous expired-access requests through different BFF instances make one refresh call and receive identical next cookies; two API instances accept them. Redis unavailable returns 503, no independent refresh fallback. Upstream401 clears cookies, refresh503 preserves cookies. Logout does not reuse a cached result to resurrect API session; lock owner token prevents deleting another caller lock. Slow winner beyond lock TTL must not trigger a second refresh; return503 once deadline expires.
- [ ] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [ ] **Step 3 — Implement:** Use explicit lock ownership and bounded polling below 10s; winner refresh request timeout less than lease. Do not retry ambiguous timed-out refresh or weaken API replay invalidation. Recheck API authentication after reused result and keep failed mutations from being blindly replayed after a success response. Document short-lived token-cache protections.
- [ ] **Step 4 — Verify:** `Run npm --prefix frontend run test:security and disposable Redis two-instance integration; npm --prefix frontend run lint; npm --prefix frontend run build`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [ ] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): distributed bff refresh single-flight`.

## Completion gate

Do not mark complete with skipped required integration checks. Record blockers separately. The coordinator reviews this packet and runs combined acceptance before integrating it into dev.
