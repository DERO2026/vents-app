-- Undo 0209 only (supabase/migrations/0209_representative_referral_links.sql).
-- NOT a migration; never applied by tooling. Runbook row R1e, in one
-- transaction, BEFORE R1d (undo_0208):
--   SET vents.rollback_confirm = 'undo-0209';
--   \i supabase/rollback/undo_0209.sql
-- Refused once any organizer was attributed through a referral link (the
-- attribution is the record a representative's reward rests on). Changes no
-- attribution, reward, wallet or ledger row.
DO $undo$
DECLARE
  v_def text;
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0209' THEN
    RAISE EXCEPTION 'undo_0209 refused: set vents.rollback_confirm = ''undo-0209'' to confirm';
  END IF;
  IF EXISTS (SELECT 1 FROM public.recruiter_partnerships WHERE source = 'referral_link') THEN
    RAISE EXCEPTION 'undo_0209 refused: organizers have been attributed through referral links';
  END IF;

  v_def := pg_get_functiondef('public.earn_event_eligibility(uuid)'::regprocedure);
  IF position('[0209]' IN v_def) > 0 THEN
    EXECUTE replace(v_def, E'\n  -- [0209] free events never qualify for representative rewards\n  IF v_paid = 0 AND v_fees = 0 THEN\n    v_reasons := array_append(v_reasons, ''free_event'');\n  END IF;\n\n  RETURN jsonb_build_object(\n    ''eligible'',', E'\n  RETURN jsonb_build_object(\n    ''eligible'',');
  END IF;
  v_def := pg_get_functiondef('public.get_my_representative_history(text,text,timestamptz,uuid,integer)'::regprocedure);
  IF position('[0209]' IN v_def) > 0 THEN
    EXECUTE replace(v_def,
      E'        ''organizer_username'', u.username,\n        ''attributed_at'', a.attributed_at,\n'
      || E'        -- [0209] referral source, registration, verification and reward status\n'
      || E'        ''source'', (SELECT p.source FROM public.recruiter_partnerships p WHERE p.id = a.partnership_id),\n'
      || E'        ''is_organizer'', COALESCE(u.is_organizer, false),\n'
      || E'        ''verification_status'', (SELECT v.status FROM public.organizer_verification_requests v\n'
      || E'                                   WHERE v.user_id = a.organizer_id ORDER BY v.created_at DESC LIMIT 1),\n'
      || E'        ''organizer_verified'', public.earn_organizer_is_verified(a.organizer_id),\n'
      || E'        ''reward_status'', (SELECT c.status FROM public.representative_reward_claims c\n'
      || E'                             WHERE c.organizer_id = a.organizer_id AND c.representative_id = a.representative_id\n'
      || E'                             ORDER BY c.created_at DESC LIMIT 1),\n'
      || E'        ''reward_amount_kobo'', (SELECT c.amount_kobo FROM public.representative_reward_claims c\n'
      || E'                                  WHERE c.organizer_id = a.organizer_id AND c.representative_id = a.representative_id\n'
      || E'                                  ORDER BY c.created_at DESC LIMIT 1),\n'
      || E'        ''reward_credited_at'', (SELECT c.credited_at FROM public.representative_reward_claims c\n'
      || E'                                  WHERE c.organizer_id = a.organizer_id AND c.representative_id = a.representative_id\n'
      || E'                                  ORDER BY c.created_at DESC LIMIT 1),',
      E'        ''organizer_username'', u.username,\n        ''attributed_at'', a.attributed_at,');
  END IF;
END
$undo$;

DROP FUNCTION IF EXISTS public.get_representative_badges(uuid[]);
DROP FUNCTION IF EXISTS public.claim_representative_referral(text);
DROP FUNCTION IF EXISTS public.get_my_representative_referral();
DROP FUNCTION IF EXISTS public.representative_referral_window();
ALTER TABLE public.recruiter_partnerships DROP CONSTRAINT IF EXISTS recruiter_partnerships_source_check;
ALTER TABLE public.recruiter_partnerships DROP COLUMN IF EXISTS source;
DROP INDEX IF EXISTS public.recruiters_organizer_referral_code_key;
ALTER TABLE public.recruiters DROP CONSTRAINT IF EXISTS recruiters_organizer_referral_code_format;
ALTER TABLE public.recruiters DROP COLUMN IF EXISTS organizer_referral_code;
