-- Undo 0217 only (supabase/migrations/0217_representative_reward_fixed_50000.sql).
-- NOT a migration; never applied by tooling. In one transaction, BEFORE
-- undo_0216 (0217's claim check sits on 0216's text):
--   SET vents.rollback_confirm = 'undo-0217';
--   \i supabase/rollback/undo_0217.sql
-- Restores the pre-0217 text of representative_reward_rate_kobo,
-- earn_execute_admin_action, request_admin_action and
-- claim_representative_reward; removes the monthly-rate freeze and the
-- fixed-amount CHECK. Re-enables the discontinued higher monthly rate, so
-- run it only on an owner decision. Changes no claim, rate, ledger or wallet row.
DO $undo$
DECLARE
  v_def text;
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0217' THEN
    RAISE EXCEPTION 'undo_0217 refused: set vents.rollback_confirm = ''undo-0217'' to confirm';
  END IF;

  v_def := pg_get_functiondef('public.representative_reward_rate_kobo(uuid,date)'::regprocedure);
  IF position('[0217]' IN v_def) > 0 THEN
    v_def := replace(v_def, $a$  -- [0217] Fixed at the N50,000 base (earn_settings CHECK); monthly rates are discontinued.
  SELECT base_reward_kobo FROM public.earn_settings;$a$, $a$  SELECT COALESCE(
    (SELECT reward_kobo FROM public.representative_monthly_rates
      WHERE representative_id = p_representative_id AND month = date_trunc('month', p_month)::date),
    (SELECT base_reward_kobo FROM public.earn_settings));$a$);
    IF position('[0217]' IN v_def) > 0 THEN RAISE EXCEPTION 'undo_0217: unexpected [0217] text in representative_reward_rate_kobo'; END IF;
    EXECUTE v_def;
  END IF;

  v_def := pg_get_functiondef('public.earn_execute_admin_action(uuid)'::regprocedure);
  IF position('[0217]' IN v_def) > 0 THEN
    v_def := replace(v_def, $a$    -- [0217] Discontinued: the representative reward is fixed at N50,000.
    RAISE EXCEPTION 'Representative rewards are fixed at N50,000; monthly rates are discontinued';
$a$, '');
    IF position('[0217]' IN v_def) > 0 THEN RAISE EXCEPTION 'undo_0217: unexpected [0217] text in earn_execute_admin_action'; END IF;
    EXECUTE v_def;
  END IF;

  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  IF position('earn_set_monthly_rate' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, $a$'earn_recognize_event_profit', 'earn_decide_expense'$a$, ''))) / length($a$'earn_recognize_event_profit', 'earn_decide_expense'$a$) <> 1 THEN
      RAISE EXCEPTION 'undo_0217: request_admin_action is not the expected 0217 version';
    END IF;
    EXECUTE replace(v_def, $a$'earn_recognize_event_profit', 'earn_decide_expense'$a$,
                           $a$'earn_recognize_event_profit', 'earn_set_monthly_rate', 'earn_decide_expense'$a$);
  END IF;

  v_def := pg_get_functiondef('public.claim_representative_reward(uuid,uuid)'::regprocedure);
  IF position('[0217]' IN v_def) > 0 THEN
    v_def := replace(v_def, $a$  -- [0217] Only the fixed N50,000 reward is ever reserved or credited. A claim
  -- approved at a discontinued higher monthly rate is held, never rewritten.
  IF c.amount_kobo IS DISTINCT FROM s.base_reward_kobo THEN
    RAISE EXCEPTION 'This reward was approved at % kobo, not the fixed N50,000; it is on hold for admin review', c.amount_kobo;
  END IF;

$a$, '');
    IF position('[0217]' IN v_def) > 0 THEN RAISE EXCEPTION 'undo_0217: unexpected [0217] text in claim_representative_reward'; END IF;
    EXECUTE v_def;
  END IF;
END
$undo$;

DROP TRIGGER IF EXISTS representative_monthly_rates_frozen ON public.representative_monthly_rates;
DROP TRIGGER IF EXISTS representative_monthly_rates_frozen_truncate ON public.representative_monthly_rates;
DROP FUNCTION IF EXISTS public.representative_monthly_rates_frozen();
ALTER TABLE public.representative_reward_claims
  DROP CONSTRAINT IF EXISTS representative_reward_claims_fixed_amount;
