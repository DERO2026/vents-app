-- 0217: the VENTS Representative reward is FIXED at N50,000 per qualifying
-- organizer. The 0201 "higher monthly rate" (9+ qualifying organizers in a
-- month let two admins set a higher rate for the next month) is discontinued
-- (confirmed business policy, PR #111).
--
-- This migration, and nothing else:
--   1. representative_reward_rate_kobo() returns the N50,000 base only
--      (earn_settings.base_reward_kobo, CHECK = 5000000). Submission and
--      approval take the amount from it, so every new reward is N50,000.
--      Monthly rate rows are no longer read.
--   2. earn_execute_admin_action: 'earn_set_monthly_rate' is refused, so a
--      request filed before this migration can never be approved.
--   3. request_admin_action: 'earn_set_monthly_rate' is no longer accepted.
--   4. claim_representative_reward: a claim whose recorded amount is not the
--      N50,000 base (one approved at a higher monthly rate before 0217) is
--      held -- never reserved, credited or rewritten. Admins reject or
--      reverse it through the existing dual control.
--   5. representative_monthly_rates is frozen: existing rows stay as history;
--      no insert, update, delete or truncate.
--   6. CHECK representative_reward_claims_fixed_amount: an approved, funded
--      or credited claim is exactly N50,000 (NOT VALID: historical rows are
--      reported below, never changed; reversing or rejecting one is allowed).
--
-- Unchanged: 0216's eligibility (a genuinely paid ticket, free events never
-- qualify, checked at submission, approval and before credit), attribution,
-- one reward per organizer, two-admin approval, idempotent crediting into the
-- withdrawable earnings wallet, the profit pool, reversals, withdrawals, and
-- the monthly qualifying COUNTS (still shown on the dashboards; they no longer
-- affect any amount). earn_settings.rate_review_threshold and the dashboard
-- read functions' rate fields are left in place, unused for any amount, so
-- installed app versions keep working; the app no longer shows them.
--
-- Moves no money; changes no claim, ledger, wallet, rate or audit row.
-- Prerequisite: 0216. One transaction; idempotent (marker [0217]); refuses to
-- patch a function whose text is not the expected version.
-- Rollback: supabase/rollback/undo_0217.sql (before undo_0216).

DO $pre$
BEGIN
  IF position('[0216]' IN pg_get_functiondef('public.claim_representative_reward(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0217 requires 0216 (claim_representative_reward has no [0216] check)';
  END IF;
  IF (SELECT base_reward_kobo FROM public.earn_settings) IS DISTINCT FROM 5000000 THEN
    RAISE EXCEPTION '0217: earn_settings.base_reward_kobo is not N50,000; stop and investigate';
  END IF;
END
$pre$;

DO $patch$
DECLARE
  v_def text;
  v_pairs text[][];
  i int;

  r1_old constant text := $a$  SELECT COALESCE(
    (SELECT reward_kobo FROM public.representative_monthly_rates
      WHERE representative_id = p_representative_id AND month = date_trunc('month', p_month)::date),
    (SELECT base_reward_kobo FROM public.earn_settings));$a$;
  r1_new constant text := $a$  -- [0217] Fixed at the N50,000 base (earn_settings CHECK); monthly rates are discontinued.
  SELECT base_reward_kobo FROM public.earn_settings;$a$;

  x1_old constant text := $a$  WHEN 'earn_set_monthly_rate' THEN
$a$;
  x1_new constant text := $a$  WHEN 'earn_set_monthly_rate' THEN
    -- [0217] Discontinued: the representative reward is fixed at N50,000.
    RAISE EXCEPTION 'Representative rewards are fixed at N50,000; monthly rates are discontinued';
$a$;

  q1_old constant text := $a$'earn_recognize_event_profit', 'earn_set_monthly_rate', 'earn_decide_expense'$a$;
  q1_new constant text := $a$'earn_recognize_event_profit', 'earn_decide_expense'$a$;

  c1_old constant text := $a$  -- [0216] Credited only for a qualifying event:$a$;
  c1_new constant text := $a$  -- [0217] Only the fixed N50,000 reward is ever reserved or credited. A claim
  -- approved at a discontinued higher monthly rate is held, never rewritten.
  IF c.amount_kobo IS DISTINCT FROM s.base_reward_kobo THEN
    RAISE EXCEPTION 'This reward was approved at % kobo, not the fixed N50,000; it is on hold for admin review', c.amount_kobo;
  END IF;

  -- [0216] Credited only for a qualifying event:$a$;
BEGIN
  v_def := pg_get_functiondef('public.representative_reward_rate_kobo(uuid,date)'::regprocedure);
  IF position('[0217]' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, r1_old, ''))) / length(r1_old) <> 1 THEN
      RAISE EXCEPTION '0217: representative_reward_rate_kobo is not the expected 0201 version';
    END IF;
    EXECUTE replace(v_def, r1_old, r1_new);
  END IF;

  v_def := pg_get_functiondef('public.earn_execute_admin_action(uuid)'::regprocedure);
  IF position('[0217]' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, x1_old, ''))) / length(x1_old) <> 1 THEN
      RAISE EXCEPTION '0217: earn_execute_admin_action is not the expected 0201/0216 version';
    END IF;
    EXECUTE replace(v_def, x1_old, x1_new);
  END IF;

  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  IF position('earn_set_monthly_rate' IN v_def) > 0 THEN
    IF (length(v_def) - length(replace(v_def, q1_old, ''))) / length(q1_old) <> 1 THEN
      RAISE EXCEPTION '0217: request_admin_action does not list earn_set_monthly_rate as 0201 added it';
    END IF;
    EXECUTE replace(v_def, q1_old, q1_new);
  END IF;

  v_def := pg_get_functiondef('public.claim_representative_reward(uuid,uuid)'::regprocedure);
  IF position('[0217]' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, c1_old, ''))) / length(c1_old) <> 1 THEN
      RAISE EXCEPTION '0217: claim_representative_reward is not the expected 0216 version';
    END IF;
    EXECUTE replace(v_def, c1_old, c1_new);
  END IF;
END
$patch$;

-- 5. Monthly rates: history kept, no further writes of any kind.
CREATE OR REPLACE FUNCTION public.representative_monthly_rates_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Representative monthly rates are discontinued (the reward is fixed at N50,000); existing rows are kept as history';
END;
$function$;
REVOKE ALL ON FUNCTION public.representative_monthly_rates_frozen() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS representative_monthly_rates_frozen ON public.representative_monthly_rates;
CREATE TRIGGER representative_monthly_rates_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON public.representative_monthly_rates
  FOR EACH ROW EXECUTE FUNCTION public.representative_monthly_rates_frozen();
DROP TRIGGER IF EXISTS representative_monthly_rates_frozen_truncate ON public.representative_monthly_rates;
CREATE TRIGGER representative_monthly_rates_frozen_truncate
  BEFORE TRUNCATE ON public.representative_monthly_rates
  FOR EACH STATEMENT EXECUTE FUNCTION public.representative_monthly_rates_frozen();

-- 6. An approved, funded or credited claim is exactly N50,000 from now on.
ALTER TABLE public.representative_reward_claims
  DROP CONSTRAINT IF EXISTS representative_reward_claims_fixed_amount;
ALTER TABLE public.representative_reward_claims
  ADD CONSTRAINT representative_reward_claims_fixed_amount
  CHECK (status NOT IN ('approved', 'funded', 'credited') OR amount_kobo = 5000000) NOT VALID;

-- Read-only report for the owner. Changes nothing.
DO $report$
DECLARE
  v_rates integer; v_held integer; v_paid integer; v_pending integer;
BEGIN
  SELECT count(*) INTO v_rates FROM public.representative_monthly_rates;
  SELECT count(*) INTO v_held FROM public.representative_reward_claims
   WHERE status IN ('approved', 'funded') AND amount_kobo <> 5000000;
  SELECT count(*) INTO v_paid FROM public.representative_reward_claims
   WHERE status = 'credited' AND amount_kobo <> 5000000;
  SELECT count(*) INTO v_pending FROM public.admin_action_requests
   WHERE action_type = 'earn_set_monthly_rate' AND status = 'pending';
  IF v_rates + v_held + v_paid + v_pending > 0 THEN
    RAISE WARNING '0217: % monthly rate row(s) kept as history; % approved/funded claim(s) above N50,000 now on hold; % credited claim(s) above N50,000 left as paid history; % pending monthly-rate request(s) can no longer be approved',
      v_rates, v_held, v_paid, v_pending;
  END IF;
END
$report$;
