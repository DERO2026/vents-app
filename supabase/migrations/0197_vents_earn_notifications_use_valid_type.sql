-- 0197: VENTS Earn notifications use a valid notifications.type.
--
-- Bug: after 0196 made capability-granted organizers invitable, Send
-- Invitation failed in production with
--   new row for relation "notifications" violates check constraint
--   "notifications_type_check"
-- invite_recruiter_partnership (0193, carried into 0196) inserts
-- type = 'recruiter_invitation', and respond_to_recruiter_invitation (0193)
-- inserts type = 'recruiter_invitation_response'. Neither is allowed by
-- notifications_type_check (0005), which permits only reminder, booking,
-- promo, social, broadcast, message, sale, event_update. The whole RPC
-- rolls back, so no invitation has ever been created in production (0 rows
-- in recruiter_partnerships). The 0193/0196 local-Postgres tests missed it
-- because their minimal notifications table had no CHECK constraint.
--
-- Fix: both functions use 'social' -- the existing type for a person-to-
-- person request and its accept/decline (message requests:
-- send_direct_message / respond_to_message_request). The constraint is
-- unchanged. push_data (partnershipId, recruiterId, commissionSplitBps)
-- still identifies the notification as a VENTS Earn invitation.
--
-- Both bodies are otherwise byte-identical to what production runs today:
-- invite_recruiter_partnership from 0196, respond_to_recruiter_invitation
-- from 0193. Authorization, self-invite blocks, rate limit, duplicate-pending
-- indexes and commission bounds are untouched. Grants are re-stated
-- unchanged (CREATE OR REPLACE preserves them anyway).

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
    'social',
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

CREATE OR REPLACE FUNCTION public.respond_to_recruiter_invitation(p_partnership_id uuid, p_accept boolean)
 RETURNS public.recruiter_partnerships
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_partnership public.recruiter_partnerships;
  v_is_authorized_responder boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_partnership
    FROM public.recruiter_partnerships
   WHERE id = p_partnership_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Partnership not found';
  END IF;

  IF v_partnership.status <> 'pending' THEN
    RAISE EXCEPTION 'Partnership is not pending (status=%)', v_partnership.status;
  END IF;

  IF v_partnership.organizer_id IS NOT NULL THEN
    v_is_authorized_responder := (v_partnership.organizer_id = v_uid);
  ELSE
    v_is_authorized_responder := EXISTS (
      SELECT 1 FROM public.service_providers sp
      WHERE sp.id = v_partnership.provider_id AND sp.user_id = v_uid
    );
  END IF;

  -- The recruiter themselves is never an authorized responder, even if
  -- the above checks were somehow satisfied by a data anomaly -- belt
  -- and suspenders, since recruiter_id can never equal organizer_id or
  -- a provider's user_id by the invite function's own self-partnership
  -- guard, but this closes the gap if that invariant were ever violated
  -- by a future code path.
  IF v_uid = v_partnership.recruiter_id THEN
    RAISE EXCEPTION 'The recruiter cannot respond to their own invitation';
  END IF;

  IF NOT v_is_authorized_responder THEN
    RAISE EXCEPTION 'Not authorized to respond to this invitation';
  END IF;

  UPDATE public.recruiter_partnerships
     SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
         responded_at = now(),
         responded_by = v_uid,
         updated_at = now()
   WHERE id = p_partnership_id
  RETURNING * INTO v_partnership;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_partnership.recruiter_id,
    'social',
    CASE WHEN p_accept THEN 'Partnership accepted!' ELSE 'Partnership declined' END,
    CASE WHEN p_accept
      THEN 'Your VENTS Earn partnership invitation was accepted.'
      ELSE 'Your VENTS Earn partnership invitation was declined.'
    END,
    false,
    CASE WHEN p_accept THEN '✅' ELSE '❌' END,
    jsonb_build_object('partnershipId', v_partnership.id)
  );

  RETURN v_partnership;
END;
$function$;

REVOKE ALL ON FUNCTION public.respond_to_recruiter_invitation(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_recruiter_invitation(uuid, boolean) TO authenticated;
