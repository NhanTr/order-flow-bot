# Hermes assignment — C2: exact SePay matching and concurrent delivery

C1 has passed coordinator review. Implement only Packet C Task 2 from
`docs/superpowers/plans/2026-10-13-security-03-sepay.md`. Read `AGENTS.md`, the
shared security spec, the complete Packet C plan, and this brief before editing.
Preserve all current work on `dev`. Do not commit, push, deploy, access a remote
database, make live SePay/bank requests, or start another task.

## Exact allowlist

- `backend/apps/api/src/modules/sepay/sepay.service.ts`
- `backend/apps/api/src/modules/sepay/tests/sepay.security.integration.test.ts` (create)

Request a precise scope expansion before editing any other file. Coordinator
owns app/config/env/manifests/contracts and the D1 files now in the shared tree.

## Required behavior

- Remove partial `contains` matching and the unbounded payment `findMany` scan.
  Extract complete payment/order code tokens and select exact matches only.
- A short prefix, embedded substring, order-code-only text, or two different
  complete known codes must never silently assign a payment. Ambiguous relevant
  incoming transactions are persisted for owner review without payment linkage.
- Duplicate external IDs return success. Concurrent duplicate delivery and two
  different transactions racing for one payment must preserve one valid settled
  transition, one ORDER_PAID notification, and consistent audit/history rows.
- Paid, PREPARING, READY, DELIVERED and CANCELLED orders must never have settled
  payment state or received amount downgraded/overwritten by review events.
- Webhook ingestion and active lookup races obey the same rules. Use guarded
  writes plus serializable retry and handle the unique-key conflict only after
  rollback by reading the existing duplicate.
- Use only the disposable local Docker PostgreSQL URL for integration tests.
  Never use normal `.env.local`, Supabase, production, or port 5432. Keep a
  strong loopback/dedicated-database guard and clean all fixtures.

Work test-first and capture a real failing-before result. Run all SePay tests,
the new disposable-DB integration test, related Telegram lookup regressions,
API typecheck, and `git diff --check`. Report exact changed files, commands,
results, cleanup evidence and any blocker, then wait for coordinator review.
