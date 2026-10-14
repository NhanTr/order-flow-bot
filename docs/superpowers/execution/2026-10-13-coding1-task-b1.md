# coding1 assignment — Packet B, Task 1

Implement only **Task 1 — Verified actors and permission policy** from
`docs/superpowers/plans/2026-10-13-security-02-authorization.md`.

## Required reading and method

1. Read `AGENTS.md`.
2. Read `docs/superpowers/specs/2026-10-13-security-hardening.md` completely.
3. Read the Packet B plan completely.
4. Use the required Superpowers implementation workflow, including test-first
   evidence. Do not treat a missing dependency as a security regression.

Task A is accepted and its uncommitted response-projection changes are the
baseline. Preserve every existing working-tree change. This is sequential work
on local `dev`; do not switch branches, commit, push, deploy, access production,
or use a normal/remote database.

## Scope

Edit only the files listed under Packet B Task 1:

- `backend/apps/api/src/modules/auth/auth.middleware.ts`
- `backend/apps/api/src/modules/auth/order-access.policy.ts` (create)
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
- `backend/apps/api/src/modules/orders/tests/order.authorization.vitest.test.ts` (create)
- `backend/apps/api/src/modules/payments/tests/payment.authorization.test.ts` (create)

Do not edit manifests, lockfiles, `app.ts`, `config/env.ts`, env templates,
Compose, contracts, AGENTS/docs, Task A files, seed files, Bruno files,
INSTALLATION.md, frontend, Telegram router/protocol, SePay, or Packet B Task 2
files. If an essential change outside the allowlist is discovered, stop and
report the exact patch request to the coordinator.

## Required behavior

- Every web actor comes from verified `req.auth`. Never use body/query actor IDs
  for access decisions, ownership, history or audit attribution.
- OWNER may use the web lifecycle per the spec. SERVICE_STAFF may list/read/edit/
  cancel/pay only its own orders. BARISTA has no web access.
- Financial/admin routes (dashboard, revenue/export, audit, bank transactions,
  reconciliation, refunds and override) are OWNER-only. Menu/employee admin
  remains OWNER-only through its existing routers.
- Staff list scoping is server-enforced even if `createdByUserId` names another
  user. Unknown order UUID returns 404; known forbidden order returns 403 with
  no writes or object details.
- Order creation derives `createdByUserId` from auth. OWNER creates for itself;
  creation on behalf of another user is out of scope.
- `assertOrderAccess(actor, order, action)` matches the packet interface.
- Cash/QR attribution comes from auth. Refund and reconciliation resolution
  force OWNER `actor.userId` internally. Legacy actor fields may be accepted for
  one compatibility release but must be ignored.
- Explicit OWNER barista assignment records OWNER as actor and the active
  barista only as assignee. Web READY is OWNER override with a reason; assigned
  barista READY remains on the existing Telegram path. Delivery follows the
  shared permission table.
- Preserve `/api/v1`, Telegram callback/session behavior, error mapping and
  current response shapes except removal of trust in client actor IDs.

## Evidence and handoff

Add the adversarial regression coverage required by Packet B Step 1. Capture a
real failing-before result, then implement and run:

```bash
npm --prefix backend/apps/api test -- src/modules/admin/tests/admin.routes.test.ts src/modules/orders/tests/order.authorization.vitest.test.ts src/modules/payments/tests/payment.authorization.test.ts
npm --prefix backend/apps/api run check
```

Also run relevant existing order/payment/refund/reconciliation tests. Do not
claim the full suite is green if the known missing tax DOCX templates still
fail. Run `git diff --check` and inspect the final scoped diff.

Return:

- exact files changed;
- failing-before and passing-after evidence;
- permission cases covered and any unresolved ambiguity;
- shared-file patch requests, if any;
- remaining blockers and known unrelated failures.

Then wait for coordinator review. Do not start Task B2 or another packet.
