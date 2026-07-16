-- Organizer Verification — Tasks 6/7 (in-app notifications on approve/reject)
-- and Task 8 (close the direct-UPDATE bypass).
--
-- The approve/reject RPCs already: flip users.is_verified (approve), save the
-- rejection reason, record reviewed_by + reviewed_at, and write admin_logs.
-- What was missing is the IN-APP notification the organizer sees inside the
-- app (the confirmation EMAIL is already fired client-side after the RPC
-- succeeds). These rewrites add a notifications row, atomically, inside the
-- same SECURITY DEFINER transaction as the status change — so an organizer
-- can never be marked verified/rejected without also being notified.

CREATE OR REPLACE FUNCTION public.admin_approve_organizer_verification(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_user_id uuid; v_company text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  SELECT user_id, company_name INTO v_user_id, v_company
  FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;

  UPDATE public.organizer_verification_requests
  SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;
  UPDATE public.users SET is_verified = true WHERE id = v_user_id;

  -- In-app notification (Task 6).
  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_user_id, 'promo', 'Brand Verified ✓',
          COALESCE(v_company, 'Your organization') || ' has been verified. Your verified badge is now live across Vents.',
          false, '🛡️');

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'approve_organizer_verification', v_user_id,
          jsonb_build_object('request_id', p_request_id), public.actor_role());
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_reject_organizer_verification(p_request_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT user_id INTO v_user_id FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;

  UPDATE public.organizer_verification_requests
  SET status = 'rejected', admin_note = p_reason, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;

  -- In-app notification (Task 7) — includes the reason and invites resubmission.
  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_user_id, 'promo', 'Verification Not Approved',
          'Your brand verification request was not approved. Reason: ' || p_reason ||
          ' — you can correct the issue and submit a new request.',
          false, '⚠️');

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_organizer_verification', v_user_id,
          jsonb_build_object('request_id', p_request_id, 'reason', p_reason), public.actor_role());
END; $function$;

-- Task 8 — close the direct-UPDATE bypass. The previous policy allowed ANY
-- admin tier (including Sub-Admin) to UPDATE a request row directly via
-- PostgREST, which would let them flip status to 'approved'/'rejected'
-- WITHOUT the is_verified change, the notification, or the audit-log row —
-- the exact side effects the RPCs guarantee. Status transitions must go
-- ONLY through the SECURITY DEFINER RPCs above (which bypass RLS as the
-- definer), so the client-facing UPDATE policy is dropped entirely. No
-- legitimate flow updates this table directly: organizers only INSERT
-- (submit) and SELECT (status); admins only review via the RPCs.
DROP POLICY IF EXISTS organizer_verif_admin_update ON public.organizer_verification_requests;
