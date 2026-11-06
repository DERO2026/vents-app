-- Undo 0206 only (supabase/migrations/0206_earnings_adjustment.sql).
-- NOT a migration; never applied by tooling. Use only as runbook row R1b,
-- in one transaction:
--   SET vents.rollback_confirm = 'undo-0206';
--   \i supabase/rollback/undo_0206.sql
-- Refused once ANY adjustment has been executed: from then on the ledger
-- holds adjustment rows that are financial history, and the only safe
-- direction is forward (a new, approved adjustment). It changes no wallet,
-- ledger row or request.
DO $undo$
DECLARE
  v_def text;
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0206' THEN
    RAISE EXCEPTION 'undo_0206 refused: set vents.rollback_confirm = ''undo-0206'' to confirm';
  END IF;
  IF EXISTS (SELECT 1 FROM public.earnings_adjustments)
     OR EXISTS (SELECT 1 FROM public.organizer_transactions WHERE type IN ('adjustment_credit', 'adjustment_debit')) THEN
    RAISE EXCEPTION 'undo_0206 refused: earnings adjustments have been executed; they are financial history and cannot be rolled back';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_action_requests WHERE action_type = 'earnings_adjustment' AND status = 'pending') THEN
    RAISE EXCEPTION 'undo_0206 refused: reject the pending earnings_adjustment requests first';
  END IF;

  v_def := pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);
  IF position('execute_earnings_adjustment' IN v_def) > 0 THEN
    EXECUTE replace(v_def,
      E'      ELSIF r.action_type = ''earnings_adjustment'' THEN\n        PERFORM public.execute_earnings_adjustment(r.id);\n', '');
  END IF;
  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  IF position(E', ''earnings_adjustment''' IN v_def) > 0 THEN
    EXECUTE replace(v_def, E', ''earnings_adjustment''', '');
  END IF;
  v_def := pg_get_functiondef('public.admin_earnings_reconciliation()'::regprocedure);
  IF position('adjustment_credit' IN v_def) > 0 THEN
    v_def := replace(v_def, E', ''adjustment_credit'')', ')');
    v_def := replace(v_def, E', ''adjustment_debit'')', ')');
    EXECUTE v_def;
  END IF;
END
$undo$;

DROP FUNCTION IF EXISTS public.admin_request_earnings_adjustment(uuid, text, text, bigint, text, text, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.execute_earnings_adjustment(uuid);
DROP FUNCTION IF EXISTS public.earnings_adjustment_validate(uuid, jsonb);
DROP FUNCTION IF EXISTS public.earnings_ledger_net_kobo(uuid);
DROP FUNCTION IF EXISTS public.earnings_adjustment_cap_kobo();
DROP TRIGGER IF EXISTS organizer_transactions_adjustment_guard ON public.organizer_transactions;
DROP FUNCTION IF EXISTS public.organizer_transactions_adjustment_guard();
DROP TABLE IF EXISTS public.earnings_adjustments;
DROP FUNCTION IF EXISTS public.earnings_adjustments_append_only();

ALTER TABLE public.organizer_transactions DROP CONSTRAINT organizer_transactions_type_check;
ALTER TABLE public.organizer_transactions ADD CONSTRAINT organizer_transactions_type_check
  CHECK (type = ANY (ARRAY['credit'::text, 'debit'::text, 'payout'::text, 'cancelled_payout_refund'::text,
                           'refund'::text, 'representative_reward'::text, 'representative_reward_reversal'::text,
                           'payout_reversal'::text, 'recovery_deduction'::text]));
