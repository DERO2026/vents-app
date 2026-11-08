-- 0209: dedicated VENTS Representative organizer referral links, the
-- Representative profile badge, and "free events never qualify".
--
-- Owner instruction 2026-11-08 ("VENTS — urgent production fixes"):
--   item 3  each active representative has a unique organizer referral code
--           and link; an organizer who registers through it is attributed to
--           that representative securely, once, and it cannot be changed;
--           the representative dashboard lists referred organizers with
--           registration, verification, qualifying-event and reward status;
--           existing reward rules apply; rewards stay in the withdrawable
--           earnings wallet; FREE EVENTS MUST NOT QUALIFY; no
--           recruiter-to-recruiter commissions.
--   item 5  a Representative badge from the authoritative status only.
--
-- Reuses 0193/0201: a referral creates an ACCEPTED recruiter_partnerships row
-- (commission_split_bps 0, source 'referral_link'; partnerships carry no
-- money -- 0193 computes no commission and 0201 pays the fixed reward only)
-- and 0201's earn_attribute_partnership() records the attribution with its
-- existing self-referral and duplicate guards. No reward amount, rate,
-- wallet or eligibility rule other than the free-event exclusion changes.
--
-- Prerequisite: 0201 (and 0203, whose earn_event_eligibility is patched).
-- One transaction; idempotent.

DO $pre$
BEGIN
  IF to_regprocedure('public.earn_attribute_partnership(uuid)') IS NULL THEN
    RAISE EXCEPTION '0209 requires 0201 (earn_attribute_partnership is missing)';
  END IF;
  IF to_regprocedure('public.earnings_release_delay()') IS NULL THEN
    RAISE EXCEPTION '0209 requires 0203';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- Referral codes and partnership source
-- ---------------------------------------------------------------------------
ALTER TABLE public.recruiters ADD COLUMN IF NOT EXISTS organizer_referral_code text;
ALTER TABLE public.recruiters DROP CONSTRAINT IF EXISTS recruiters_organizer_referral_code_format;
ALTER TABLE public.recruiters ADD CONSTRAINT recruiters_organizer_referral_code_format
  CHECK (organizer_referral_code IS NULL OR organizer_referral_code ~ '^[A-HJ-NP-Z2-9]{8}$');
CREATE UNIQUE INDEX IF NOT EXISTS recruiters_organizer_referral_code_key ON public.recruiters (organizer_referral_code);

ALTER TABLE public.recruiter_partnerships ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'invite';
ALTER TABLE public.recruiter_partnerships DROP CONSTRAINT IF EXISTS recruiter_partnerships_source_check;
ALTER TABLE public.recruiter_partnerships ADD CONSTRAINT recruiter_partnerships_source_check
  CHECK (source IN ('invite', 'referral_link'));

-- The code is server-generated only: clients cannot write recruiters (0193
-- grants SELECT only), and nothing below lets a caller choose or change one.

-- How long after creating an account a user may claim a referral: the link
-- must be used at registration, not later to hand an existing organizer to a
-- friend.
CREATE OR REPLACE FUNCTION public.representative_referral_window()
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$ SELECT interval '72 hours' $function$;

-- Active representative: own code and link (created on first use).
CREATE OR REPLACE FUNCTION public.get_my_representative_referral()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_code text;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT r.organizer_referral_code INTO v_code
    FROM public.recruiters r
   WHERE r.id = v_uid AND r.status = 'active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only an active VENTS Representative has an organizer referral link';
  END IF;
  WHILE v_code IS NULL LOOP
    v_code := '';
    FOR i IN 1..8 LOOP
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::integer, 1);
    END LOOP;
    BEGIN
      UPDATE public.recruiters SET organizer_referral_code = v_code, updated_at = now() WHERE id = v_uid;
    EXCEPTION WHEN unique_violation THEN
      v_code := NULL;  -- collision: draw again
    END;
  END LOOP;
  RETURN jsonb_build_object('code', v_code, 'path', '/?rep=' || v_code);
END;
$function$;

-- Called by the app right after a user registers through ?rep=CODE.
-- Statuses: attributed | already_attributed | self_referral | representative_cannot_be_referred
--           | not_a_new_account | invalid_code
CREATE OR REPLACE FUNCTION public.claim_representative_referral(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_code text := upper(btrim(COALESCE(p_code, '')));
  v_rep public.recruiters;
  v_user public.users;
  v_partnership_id uuid;
  v_attr public.representative_attributions;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF v_code !~ '^[A-HJ-NP-Z2-9]{8}$' THEN
    RETURN jsonb_build_object('status', 'invalid_code');
  END IF;
  SELECT * INTO v_rep FROM public.recruiters WHERE organizer_referral_code = v_code;
  IF NOT FOUND OR v_rep.status <> 'active' THEN
    RETURN jsonb_build_object('status', 'invalid_code');
  END IF;

  -- Serialize claims for this user: one attribution, ever.
  SELECT * INTO v_user FROM public.users WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND OR v_user.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  IF v_rep.id = v_uid THEN
    PERFORM public.earn_audit('attribution', NULL, 'self_referral_blocked', v_uid,
      jsonb_build_object('source', 'referral_link', 'representative_id', v_rep.id));
    RETURN jsonb_build_object('status', 'self_referral');
  END IF;

  SELECT * INTO v_attr FROM public.representative_attributions WHERE organizer_id = v_uid;
  IF FOUND THEN
    IF v_attr.representative_id <> v_rep.id THEN
      PERFORM public.earn_audit('attribution', v_attr.id, 'duplicate_attribution_blocked', v_uid,
        jsonb_build_object('source', 'referral_link', 'attempted_representative_id', v_rep.id,
                           'kept_representative_id', v_attr.representative_id));
    END IF;
    RETURN jsonb_build_object('status', 'already_attributed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.recruiter_partnerships p
              WHERE p.organizer_id = v_uid AND p.status = 'accepted') THEN
    RETURN jsonb_build_object('status', 'already_attributed');
  END IF;

  -- No recruiter-to-recruiter referrals.
  IF EXISTS (SELECT 1 FROM public.recruiters r WHERE r.id = v_uid) THEN
    RETURN jsonb_build_object('status', 'representative_cannot_be_referred');
  END IF;

  -- Registration only: an older account cannot be handed to a representative.
  IF v_user.created_at IS NULL OR v_user.created_at < now() - public.representative_referral_window() THEN
    PERFORM public.earn_audit('attribution', NULL, 'late_referral_blocked', v_uid,
      jsonb_build_object('source', 'referral_link', 'representative_id', v_rep.id, 'account_created_at', v_user.created_at));
    RETURN jsonb_build_object('status', 'not_a_new_account');
  END IF;

  INSERT INTO public.recruiter_partnerships
    (recruiter_id, organizer_id, provider_id, commission_split_bps, status, responded_at, responded_by, source)
  VALUES (v_rep.id, v_uid, NULL, 0, 'accepted', now(), v_uid, 'referral_link')
  RETURNING id INTO v_partnership_id;

  PERFORM public.earn_attribute_partnership(v_partnership_id);
  SELECT * INTO v_attr FROM public.representative_attributions WHERE organizer_id = v_uid;
  IF NOT FOUND OR v_attr.representative_id <> v_rep.id THEN
    RAISE EXCEPTION 'Referral could not be recorded';
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_rep.id, 'social', 'New organizer referred',
    COALESCE(NULLIF(btrim(v_user.full_name), ''), 'A new user') || ' joined VENTS through your organizer referral link.',
    false, '🤝',
    jsonb_build_object('type', 'representative_referral', 'attributionId', v_attr.id, 'organizerId', v_uid));

  RETURN jsonb_build_object('status', 'attributed', 'representative_name',
    COALESCE(v_rep.display_name, (SELECT COALESCE(u.full_name, u.username) FROM public.users u WHERE u.id = v_rep.id)));
END;
$function$;

-- Representative badge: true only for a registered representative whose
-- status is active and whose account is not deleted. Public by design.
CREATE OR REPLACE FUNCTION public.get_representative_badges(p_user_ids uuid[])
 RETURNS TABLE (user_id uuid)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT r.id
    FROM public.recruiters r
    JOIN public.users u ON u.id = r.id
   WHERE r.id = ANY ((COALESCE(p_user_ids, ARRAY[]::uuid[]))[1:200])
     AND r.status = 'active'
     AND u.deleted_at IS NULL
$function$;

REVOKE ALL ON FUNCTION public.representative_referral_window() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_representative_referral() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_representative_referral() TO authenticated;
REVOKE ALL ON FUNCTION public.claim_representative_referral(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_representative_referral(text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_representative_badges(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_representative_badges(uuid[]) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Free events never qualify (replaces 0201's "admin-verified free event")
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_old constant text := E'\n  RETURN jsonb_build_object(\n    ''eligible'',';
  v_new constant text := E'\n  -- [0209] free events never qualify for representative rewards\n  IF v_paid = 0 AND v_fees = 0 THEN\n    v_reasons := array_append(v_reasons, ''free_event'');\n  END IF;\n\n  RETURN jsonb_build_object(\n    ''eligible'',';
BEGIN
  v_def := pg_get_functiondef('public.earn_event_eligibility(uuid)'::regprocedure);
  IF position('[0209]' IN v_def) = 0 THEN
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION '0209: earn_event_eligibility is not the expected 0201/0203 version';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;

  -- Referred organizers: registration, verification and reward status.
  v_def := pg_get_functiondef('public.get_my_representative_history(text,text,timestamptz,uuid,integer)'::regprocedure);
  IF position('[0209]' IN v_def) = 0 THEN
    IF position(E'        ''organizer_username'', u.username,\n        ''attributed_at'', a.attributed_at,' IN v_def) = 0 THEN
      RAISE EXCEPTION '0209: get_my_representative_history is not the expected 0201 version';
    END IF;
    v_def := replace(v_def,
      E'        ''organizer_username'', u.username,\n        ''attributed_at'', a.attributed_at,',
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
      || E'                                  ORDER BY c.created_at DESC LIMIT 1),');
    EXECUTE v_def;
  END IF;
END
$patch$;
