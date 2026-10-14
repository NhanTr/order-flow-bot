# Hermes assignment — B2: atomic web lifecycle and refund idempotency

Start only after the coordinator explicitly accepts B1 and dispatches this brief.

Read AGENTS.md, the shared security spec, and Task 2 in
`docs/superpowers/plans/2026-10-13-security-02-authorization.md`.
Implement Task 2 only, test first, on the existing dev worktree. Preserve all
uncommitted changes. No commit, push, production database access or deployment.

## Allowed files

Use the exact B2 plan allowlist. Existing B1 order authorization/claim tests may
also be updated for transaction mocks while preserving their security assertions.
Reuse (import, do not weaken) Task A's disposable database guard. Request any
additional essential file changes with an exact patch description.
Approved expansion: `payments/payment.service.ts` and
`payments/tests/payment.service.test.ts` under API modules, so cash/QR
transactions use compatible serializable guards and bounded retries. Race tests
must pass the actual `amount` input for stale cash amounts, check 409 conflicts,
and distinguish invalid stale writes from legitimate sequential operations.
Coordinator owns manifests/lockfiles, app/env wiring, docs and contracts.

## Acceptance

- All web lifecycle writes, associated payment creation, history and audit/outbox
  effects must commit or roll back together. Recheck permissions and expected
  state inside the transaction. Preserve B1's authenticated identity semantics.
- Use guarded writes and bounded serialization retries; map conflicting
  transitions to 409. No unsafe retries of external side effects.
- Race two claims, READY versus cancellation, item edit versus cash, and two
  refunds on real disposable Docker PostgreSQL. Verify histories and rollback
  when history insertion fails. Two different payments may each refund once.
- Add the partial unique refund-audit index. Abort with a diagnostic on existing
  duplicates; never delete duplicates. Verify rerunning the migration is safe.
- Test fixtures must use only explicit TEST_DATABASE_URL after validating its
  loopback host, non-default port and dedicated test database name. Unset means
  skipped; never fall back to DATABASE_URL. Do not use the development database.
- Existing isolated Docker acceptance container is named
  `order-flow-security-task-a`, port 55439, DB `order_flow_security_test`. Inspect
  before using it; do not assume it is running. Ask coordinator for infrastructure
  work if unavailable. Do not stop the user's database/Redis.

Run focused unit tests, TypeScript check, new Docker integration tests, and
relevant existing regressions. The known missing DOCX-template failures are
separate. Report failing-before/passing-after evidence, exact changed files,
migration implications and requested shared-file patches. Wait for review before
starting Packet C.
