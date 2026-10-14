# B2 review checklist — pending final diff

Final disposition 2026-10-14: resolved and accepted. Repository unique errors
escape the failed transaction; service retries only generated-code collisions
in fresh bounded transactions. Refund tests call refundOrder. Cash race uses
advisory-lock observation. Fresh 61 unit tests and 9 Docker integration tests,
typecheck and diff checks passed. Notes below retain the review history.

Observations from the in-progress implementation; recheck against the final
handoff before treating these as unresolved defects.

- Repository create currently retries P2002 inside the supplied PostgreSQL
  transaction. PostgreSQL aborts that transaction on the first unique violation.
  Order/payment-code collision retries must restart the whole transaction (or
  use a safe savepoint approach), with a real collision regression.
- Refund integration tests initially called nonexistent `recordRefund` instead
  of the production `refundOrder` entry point. Exercise the route-used method;
  a missing method is not failing-before security evidence.
- Cash race fixture initially used ignored `receivedAmount`; correction to
  `amount` was dispatched. Assert overlap and specific expected conflict errors.
- Check every mutation: create/payment/history, add/update/delete, cancel,
  claim, READY, delivery and OWNER override. Authorization and expected state
  must be checked inside the same transaction as writes/history.
- Verify transaction rollback on both payment and history insert failures,
  paid cancellation retains money, refund migration rejects duplicate existing
  records without deletion, reruns safely, and concurrent refunds yield one audit.
- Verify test URL guard and unset skip behavior before marking Docker acceptance.
