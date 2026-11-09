-- 0210: the organizer side of VENTS Representative referrals, and a hard stop
-- on any percentage commission.
--
-- NOT APPLIED TO PRODUCTION. Verified only against a local throwaway
-- Postgres (scripts/local-pg-test/run-referral-connections-verification.sh).
--
-- Owner decision 2026-11-09 ("final business model"):
--   * VENTS has exactly two ticket platform fees (1.5% attendee service fee,
--     3.5% organizer platform deduction). Nobody -- representative, recruiter,
--     organizer or provider -- receives any commission or percentage of ticket
--     sales. Representatives receive a FIXED N50,000 reward per qualifying
--     organizer (0201), nothing else.
--   * The referral must be visible and understandable from BOTH sides: the
--     representative (0209: link, code, referred organizers) and the organizer
--     (this migration: who invited them, the state of that connection, and
--     what makes their event qualify).
--
-- What this adds (no money moves, no reward rule changes):
--   1. recruiter_partnerships.commission_split_bps can never receive a value
--      again: a trigger refuses a non-NULL value on insert and any change on
--      update. The values recorded under the retired 10% programme (0193) are
--      kept untouched as history -- never deleted, never rewritten.
--   2. get_representative_referral_preview(code): public, read-only. For a
--      valid code of an ACTIVE representative it returns only that
--      representative's display name, username and avatar, so a person opening
--      the link sees who invited them before registering. Nothing else (no id,
--      no email, no counts). Codes are 8 random characters from a 32-letter
--      alphabet (about 10^12 combinations), so they cannot be enumerated.
--   3. get_my_representative_connection(): the signed-in organizer's own view
--      -- the representative they are attributed to (established, permanent),
--      any pending invitations, reward confirmations waiting for them, and the
--      qualification state of their events -- with no money figures.
--
-- Attribution policy (unchanged, from 0201/0209; stated here because both
-- screens explain it):
--   * One representative per organizer, ever. The first ACCEPTED invitation or
--     the referral link used at registration creates it; it is never
--     reassigned, overwritten or changed by the client.
--   * A referral link only attributes a NEW account (within 72 hours of
--     registration), never an existing organizer, never the representative
--     themself, never another representative.
--   * Opening a link, clicking it or registering earns nothing by itself.
--
-- Prerequisite: 0209. One transaction; idempotent.

DO $pre$
BEGIN
  IF to_regprocedure('public.claim_representative_referral(text)') IS NULL THEN
    RAISE EXCEPTION '0210 requires 0209 (claim_representative_referral is missing)';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. No commission split can ever be recorded again
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recruiter_partnerships_no_commission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.commission_split_bps IS NOT NULL THEN
    RAISE EXCEPTION 'VENTS has no representative commission: commission_split_bps must be NULL (fixed reward model)';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.commission_split_bps IS DISTINCT FROM OLD.commission_split_bps THEN
    RAISE EXCEPTION 'commission_split_bps is history from the retired 10%% programme and cannot be changed';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS recruiter_partnerships_no_commission ON public.recruiter_partnerships;
CREATE TRIGGER recruiter_partnerships_no_commission
  BEFORE INSERT OR UPDATE ON public.recruiter_partnerships
  FOR EACH ROW EXECUTE FUNCTION public.recruiter_partnerships_no_commission();

COMMENT ON COLUMN public.recruiter_partnerships.commission_split_bps IS
  'Retired 10% commission programme (0193). Historical value only, kept for audit; never read for money. '
  'NULL for every partnership since the fixed N50,000 representative reward (0201). A trigger refuses new values (0210).';

-- ---------------------------------------------------------------------------
-- 2. Public preview of a referral code (who invited me?)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_representative_referral_preview(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_code text := upper(btrim(COALESCE(p_code, '')));
  v_rep public.recruiters;
  v_user public.users;
BEGIN
  IF v_code !~ '^[A-HJ-NP-Z2-9]{8}$' THEN
    RETURN jsonb_build_object('valid', false);
  END IF;
  SELECT * INTO v_rep FROM public.recruiters WHERE organizer_referral_code = v_code;
  IF NOT FOUND OR v_rep.status <> 'active' THEN
    RETURN jsonb_build_object('valid', false);
  END IF;
  SELECT * INTO v_user FROM public.users WHERE id = v_rep.id;
  IF NOT FOUND OR v_user.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('valid', false);
  END IF;
  RETURN jsonb_build_object(
    'valid', true,
    'code', v_code,
    'representative', jsonb_build_object(
      'display_name', COALESCE(NULLIF(btrim(v_rep.display_name), ''), NULLIF(btrim(v_user.full_name), ''), v_user.username),
      'username', v_user.username,
      'avatar_url', v_user.avatar_url));
END;
$function$;
REVOKE ALL ON FUNCTION public.get_representative_referral_preview(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_representative_referral_preview(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The organizer's own referral connection
-- ---------------------------------------------------------------------------
-- connection.status:
--   'established'  attributed to a representative (permanent)
--   'pending'      not attributed; at least one invitation waits for an answer
--   'none'         neither
CREATE OR REPLACE FUNCTION public.get_my_representative_connection()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  a public.representative_attributions;
  p public.recruiter_partnerships;
  v_rep jsonb;
  v_invites jsonb;
  v_claims jsonb;
  v_events jsonb;
  v_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO a FROM public.representative_attributions WHERE organizer_id = v_uid;
  IF FOUND THEN
    SELECT * INTO p FROM public.recruiter_partnerships WHERE id = a.partnership_id;
    SELECT jsonb_build_object(
             'display_name', COALESCE(NULLIF(btrim(r.display_name), ''), NULLIF(btrim(u.full_name), ''), u.username),
             'username', u.username,
             'avatar_url', u.avatar_url,
             'active', r.status = 'active' AND u.deleted_at IS NULL)
      INTO v_rep
      FROM public.recruiters r JOIN public.users u ON u.id = r.id
     WHERE r.id = a.representative_id;

    -- Events created after the referral, newest first: qualification state
    -- only (reasons), never fee or profit figures.
    SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'created_at') DESC), '[]'::jsonb) INTO v_events
      FROM (
        SELECT jsonb_build_object(
                 'event_id', e.id,
                 'title', e.title,
                 'event_date', e.event_date,
                 'created_at', e.created_at,
                 'eligible', (el->>'eligible')::boolean,
                 'reasons', el->'reasons',
                 'is_free_event', (el->>'is_free_event')::boolean) AS x
          FROM public.events e
          CROSS JOIN LATERAL (SELECT public.earn_event_eligibility(e.id) AS el) z
         WHERE e.organizer_id = v_uid
           AND e.created_at >= a.attributed_at
           AND e.deleted_at IS NULL
         ORDER BY e.created_at DESC
         LIMIT 20
      ) q;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'partnership_id', ip.id,
           'invited_at', ip.created_at,
           'representative', jsonb_build_object(
             'display_name', COALESCE(NULLIF(btrim(r.display_name), ''), NULLIF(btrim(u.full_name), ''), u.username),
             'username', u.username,
             'avatar_url', u.avatar_url)) ORDER BY ip.created_at DESC), '[]'::jsonb)
    INTO v_invites
    FROM public.recruiter_partnerships ip
    JOIN public.recruiters r ON r.id = ip.recruiter_id
    JOIN public.users u ON u.id = r.id
   WHERE ip.organizer_id = v_uid AND ip.status = 'pending';

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'claim_id', c.id,
           'status', c.status,
           'event_title', e.title,
           'submitted_at', c.created_at,
           'needs_your_confirmation', c.status = 'pending_organizer') ORDER BY c.created_at DESC), '[]'::jsonb)
    INTO v_claims
    FROM public.representative_reward_claims c
    JOIN public.events e ON e.id = c.event_id
   WHERE c.organizer_id = v_uid;

  v_status := CASE
    WHEN a.id IS NOT NULL THEN 'established'
    WHEN jsonb_array_length(v_invites) > 0 THEN 'pending'
    ELSE 'none' END;

  RETURN jsonb_build_object(
    'status', v_status,
    'is_representative', EXISTS (SELECT 1 FROM public.recruiters WHERE id = v_uid),
    'attribution', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
        'attributed_at', a.attributed_at,
        'source', COALESCE(p.source, 'invite'),
        'representative', v_rep) END,
    'pending_invitations', v_invites,
    'reward_confirmations', v_claims,
    'events', COALESCE(v_events, '[]'::jsonb),
    'reward_amount_kobo', (SELECT base_reward_kobo FROM public.earn_settings),
    -- Being referred never costs the organizer anything: the representative's
    -- fixed reward is paid by VENTS, never deducted from the organizer.
    'organizer_pays_for_referral', false);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_my_representative_connection() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_representative_connection() TO authenticated;
