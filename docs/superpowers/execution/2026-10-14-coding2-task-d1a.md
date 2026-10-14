# coding2 assignment — D1a bounded order input and pagination

Implement this small, isolated subset of Packet D Task 1. Read `AGENTS.md`, the
shared security spec, and Packet D first. Work test-first on the current `dev`
worktree. Preserve all existing work. Do not commit, push, deploy, access a
remote database, or start another task.

## Exact allowlist

- `backend/apps/api/src/middleware/pagination.ts` (create)
- `backend/apps/api/src/modules/orders/order.validation.ts`
- `backend/apps/api/src/modules/orders/order.controller.ts`
- `backend/apps/api/src/modules/admin/admin.controller.ts`
- `backend/apps/api/src/modules/admin/tests/resource-limits.test.ts` (create)

Do not edit manifests, app/config/env files, contracts, docs, SePay, audit,
reconciliation, reports, frontend, Telegram, Prisma, or any other file. Report
an exact patch request if the implementation truly needs another file.

## Required behavior

- Add `parsePagination(query)` returning `{ page, limit, skip }`, defaults 1/20,
  maximum limit 100. Reject zero, negative, fractional, overflow/unsafe values,
  junk suffixes, empty strings and repeated/array/object query values with a
  typed 400 error. `limit=100` must pass.
- Use it for normal and admin web order lists. Keep current response shape and
  filters. SERVICE_STAFF server-side ownership scoping from B1 must remain.
- Create order accepts 1..100 lines. Every quantity is a safe integer 1..1000.
  Apply the same quantity rule to add/update item.
- `customerNote`, item `note`, update `note`, cancel/READY/delivery/override
  reason are at most 2000 Unicode code points when present. Preserve existing
  null allowance for update note. Do not trim or mutate user text here.
- Invalid requests must return 400 before calling order/admin services.
- Catalog and employee limit 1000 behavior is out of scope and must not change.

Add adversarial controller/validation tests in the assigned test file. Capture a
real failing-before result. Then run the new test, existing order authorization
and controller tests, API typecheck, and `git diff --check`. Return exact changed
files and evidence, then wait for coordinator review. Do not start D1b/D2.
