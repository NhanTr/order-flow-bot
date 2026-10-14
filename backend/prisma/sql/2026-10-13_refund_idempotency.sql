-- Enforce one manual refund record per payment without deleting data.
-- This migration is rerunnable and deliberately aborts when existing
-- duplicates require operator review.

DO $$
DECLARE
  duplicate_payment_ids text;
BEGIN
  SELECT string_agg(entity_id::text, ', ' ORDER BY entity_id::text)
    INTO duplicate_payment_ids
  FROM (
    SELECT entity_id
    FROM public.audit_logs
    WHERE action = 'MANUAL_REFUND_RECORDED'
      AND entity_type = 'PAYMENT'::audit_entity_type
      AND entity_id IS NOT NULL
    GROUP BY entity_id
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_payment_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce manual refund idempotency: duplicate manual refund audit rows exist for payment IDs: %',
      duplicate_payment_ids;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_manual_refund_payment_unique_idx
  ON public.audit_logs (entity_id)
  WHERE action = 'MANUAL_REFUND_RECORDED'
    AND entity_type = 'PAYMENT'::audit_entity_type
    AND entity_id IS NOT NULL;
