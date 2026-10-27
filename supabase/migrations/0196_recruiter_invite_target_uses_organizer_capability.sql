-- 0196: Representatives invite eligibility honours the Organizer capability.
--
-- Bug: a user granted the Organizer capability in the Admin Console
-- (admin_set_organizer_capability -> public.users.is_organizer = true,
-- the same flag public_profiles and public.is_organizer() read) could not
-- be invited from Representatives: "This user is not an organizer or a
-- registered service provider, so they cannot be invited."
--
-- Root cause: 0193's invite path never looked at is_organizer. It inferred
-- "organizer" purely from activity -- at least one events row with
-- organizer_id = target -- both in the client (RepresentativesScreen's
-- resolveTargetRole) and in invite_recruiter_partnership's own
-- 'Target organizer not found' check. An organizer who has not created an
-- event yet was therefore "neither". Separately, the client's
-- `.from('events')...eq('organizer_id', id).maybeSingle()` errors
-- (PGRST116) for any organizer with MORE than one event, which it treated
-- as "not an organizer" -- so prolific organizers were rejected too.
--
-- Fix: one server-side predicate, used by both the resolver the UI calls
-- and the invite function itself, so the two can never disagree again:
--   organizer  := users.is_organizer = true (account not soft-deleted)
--                 OR has any events row  (preserved from 0193 -- legacy
--                 organizers with events but no flag stay invitable)
-- Admin-implicit organizer capability (role = 'admin' in is_organizer())
-- is deliberately NOT included: that is a staff perk, not a commercial
-- organizer a recruiter can earn commission on.
--
-- Provider side is unchanged: recruiter_partnerships.provider_id is a FK
-- to service_providers.id, so a "registered service provider" still means
-- a service_providers row. The resolver returns only an 'approved' row,
-- exactly what the client could see before under the
-- service_providers_public_select_approved RLS policy. The
-- users.is_service_provider flag alone (no service_providers row) does
-- NOT make someone provider-invitable -- there is no provider_id to
-- attach the partnership to.

CREATE OR REPLACE FUNCTION public.recruiter_target_is_organizer(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
           SELECT 1 FROM public.users u
            WHERE u.id = p_user_id
              AND u.is_organizer = true
              AND u.deleted_at IS NULL
         )
      OR EXISTS (
           SELECT 1 FROM public.events e WHERE e.organizer_id = p_user_id
         );
$function$;

-- Internal helper only: called from the SECURITY DEFINER functions below.
REVOKE ALL ON FUNCTION public.recruiter_target_is_organizer(uuid) FROM PUBLIC, anon, authenticated;

-- Resolver the Representatives Invite button calls. Returns whether the
-- target is an invitable organizer and, if they are an approved service
-- provider, their service_providers.id (which invite_recruiter_partnership
-- needs as p_provider_id). Both facts are already public (public_profiles
-- exposes is_organizer; approved service_providers rows are publicly
-- readable), so this discloses nothing new.
CREATE OR REPLACE FUNCTION public.get_recruiter_invite_target(p_user_id uuid)
 RETURNS TABLE (target_is_organizer boolean, target_provider_id uuid)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT public.recruiter_target_is_organizer(p_user_id),
         (SELECT sp.id FROM public.service_providers sp
           WHERE sp.user_id = p_user_id AND sp.status = 'approved');
END;
$function$;

REVOKE ALL ON FUNCTION public.get_recruiter_invite_target(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_recruiter_invite_target(uuid) TO authenticated;

-- invite_recruiter_partnership: identical to 0193 except the organizer
-- existence check now uses recruiter_target_is_organizer().
CREATE OR REPLACE FUNCTION public.invite_recruiter_partnership(
  p_organizer_id uuid DEFAULT NULL,
  p_provider_id  uuid DEFAULT NULL,
  p_commission_split_bps integer DEFAULT 0
)
 RETURNS public.recruiter_partnerships
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.recruiter_partnerships;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.recruiters r WHERE r.id = v_uid AND r.status = 'active') THEN
    RAISE EXCEPTION 'Caller is not a registered, active recruiter';
  END IF;

  IF (p_organizer_id IS NULL) = (p_provider_id IS NULL) THEN
    RAISE EXCEPTION 'Exactly one of p_organizer_id or p_provider_id must be provided';
  END IF;

  IF p_commission_split_bps IS NULL OR p_commission_split_bps < 0 OR p_commission_split_bps > 10000 THEN
    RAISE EXCEPTION 'commission_split_bps must be between 0 and 10000';
  END IF;

  -- A recruiter cannot invite themselves as the organizer/provider side.
  IF p_organizer_id = v_uid THEN
    RAISE EXCEPTION 'Cannot form a partnership with yourself';
  END IF;
  IF p_provider_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.service_providers sp WHERE sp.id = p_provider_id AND sp.user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Cannot form a partnership with yourself';
  END IF;

  IF p_organizer_id IS NOT NULL AND NOT public.recruiter_target_is_organizer(p_organizer_id) THEN
    RAISE EXCEPTION 'Target organizer not found';
  END IF;
  IF p_provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.service_providers sp WHERE sp.id = p_provider_id
  ) THEN
    RAISE EXCEPTION 'Target provider not found';
  END IF;

  PERFORM public.check_rate_limit('invite_recruiter_partnership:' || v_uid::text, 20, 3600);

  INSERT INTO public.recruiter_partnerships (recruiter_id, organizer_id, provider_id, commission_split_bps, status)
  VALUES (v_uid, p_organizer_id, p_provider_id, p_commission_split_bps, 'pending')
  RETURNING * INTO v_row;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    COALESCE(p_organizer_id, (SELECT sp.user_id FROM public.service_providers sp WHERE sp.id = p_provider_id)),
    'recruiter_invitation',
    'New VENTS Earn partnership invitation',
    'A recruiter wants to partner with you and share part of their commission.',
    false,
    '🤝',
    jsonb_build_object('partnershipId', v_row.id, 'recruiterId', v_uid, 'commissionSplitBps', p_commission_split_bps)
  );

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.invite_recruiter_partnership(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invite_recruiter_partnership(uuid, uuid, integer) TO authenticated;
