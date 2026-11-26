-- Undo 0226 (payment exceptions). Gated: run with
--   SET vents.rollback_confirm = 'undo-0226';
-- WARNING: dropping the table discards the record of every captured payment
-- that could not become a ticket. Export open rows first
-- (SELECT * FROM public.payment_exceptions) and keep them with the
-- Paystack references. Nothing else depends on these objects.
BEGIN;
DO $$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0226' THEN
    RAISE EXCEPTION 'Refusing: SET vents.rollback_confirm = ''undo-0226'' first';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.admin_resolve_payment_exception(uuid, text);
DROP FUNCTION IF EXISTS public.admin_list_payment_exceptions(text, integer, integer);
DROP FUNCTION IF EXISTS public.mark_payment_exception_ticketed(text);
DROP FUNCTION IF EXISTS public.record_payment_exception(text, text, text, text, bigint, bigint, text);
DROP TABLE IF EXISTS public.payment_exceptions;
COMMIT;
