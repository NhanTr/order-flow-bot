# Shared authentication sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement shared authentication sessions against the shared security specification.

**Architecture:** Retain the existing modular monolith and reuse verified API identities, explicit DTOs and transactional persistence. Changes stay within this packet; coordinator integrates shared wiring and cross-packet contracts.

**Tech Stack:** TypeScript, Express 5, Prisma/PostgreSQL, Vitest/node tests, Next.js, Redis/BullMQ, Docker/GitHub Actions as relevant.

**Spec:** [../specs/2026-10-13-security-hardening.md](../specs/2026-10-13-security-hardening.md)

## Global Constraints

Read every requirement in the shared spec, especially its permission table, exact limits, no-production-write rule and contract preservation. Do not change files owned by another packet. Dependency manifests/lockfiles, app.ts, config/env.ts, root env templates, compose.yaml, contracts and AGENTS.md are coordinator-owned; send precise patch instructions instead of editing them. Use local disposable databases only. No commits unless coordinator assigns an isolated branch and authorizes the exact scope.

## Dispatch

Agent label: E. Dependencies: After D debug removal; may develop new Redis files alongside B/C but integrate auth changes sequentially.
The coordinator may assign a fresh implementer and reviewer for each task; labels identify work packets, not currently spawned agents. Read AGENTS.md first. Return changed files, test output, assumptions, migration/rollout implications and shared-file patch instructions.

## Review Focus

- Verify adversarial request identities cannot bypass authorization or falsify audit attribution.
- Check full serialized responses and logs rather than TypeScript types alone for secret exposure.
- Check concurrent and retried operations on disposable PostgreSQL/Redis, not only mocks.
- Check malformed/oversized inputs fail before expensive work and preserve documented response shapes.
- Check outage, upgrade and legacy client behavior without production access or unsafe fallback.

---

### Task 1: Async session storage with atomic Redis rotation

**Files:**
- `backend/apps/api/src/modules/auth/auth-session.store.ts`
- `backend/apps/api/src/modules/auth/redis-auth-session.store.ts (create)`
- `backend/apps/api/src/modules/auth/auth.service.ts`
- `backend/apps/api/test/auth-session.store.test.ts`
- `backend/apps/api/test/auth.service.test.ts`
- `backend/apps/api/src/modules/auth/tests/redis-session.security.integration.test.ts (create)`

**Interfaces:** Produces asynchronous AuthSessionStorePort: create(session): Promise<void>; isActive(sessionId,userId): Promise<boolean>; rotate(input): Promise<boolean>; revoke(sessionId,userId): Promise<void>. Memory store remains test/local explicit adapter. Remove clear/list from port; no shared-store clear on shutdown. RedisAuthSessionStore consumes RedisClient (approved redis package) and implements TTL + Lua compare-and-swap; keep refresh-token hashes only in session records.

- [ ] **Step 1 — Add regression tests:** Test login on API A authenticates on API B; logout/reuse on B revokes A; parallel rotation has one winner and reused token invalidates session. Test expired sessions, wrong user, Redis timeout/outage ->503, service disposal does not revoke others, inactive user/changed role enforcement survives. Test memory adapter async parity. JWT retains HS256 allowlist; add issuer=order-flow, audience=order-flow-api and require both on verify, with explicit existing-session re-login release note.
- [ ] **Step 2 — Observe baseline failure:** Run the targeted command below. Record failure that demonstrates missing security behavior; missing dependencies are setup failures, not proof of regression.
- [ ] **Step 3 — Implement:** Await every store operation in AuthService and tests. Lua mutation compares user/current hash and applies new TTL atomically; mismatch deletes only that session. Use separate namespaced keys, connection timeouts and typed SERVICE_UNAVAILABLE. Provide coordinator app.ts/environment wiring; production requires Redis store with no memory fallback. Secrets require >=32 random characters; validate access/refresh/proxy/bot secrets are distinct where applicable.
- [ ] **Step 4 — Verify:** `npm --prefix backend/apps/api run test:node; npm --prefix backend/apps/api test -- src/modules/auth/tests; TEST_REDIS_URL=<disposable-local-url> npm --prefix backend/apps/api run test:security:integration; npm --prefix backend/apps/api run check`. Expect the targeted tests and typecheck/build to pass; run the relevant existing tests as well. Commands containing placeholders must be split and configured by the executor, never pasted literally or pointed at production.
- [ ] **Step 5 — Review and hand off:** Check all five Review Focus conditions against this task; include corresponding assertions where applicable. Return the exact file list and evidence. Commit only on an assigned isolated branch with scoped staging, using `fix(security): async session storage with atomic redis rotation`.

## Completion gate

Do not mark complete with skipped required integration checks. Record blockers separately. The coordinator reviews this packet and runs combined acceptance before integrating it into dev.
