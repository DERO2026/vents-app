-- ── Capture the requester's IP on admin action requests ─────────────────────
-- admin_action_requests.ip existed but nothing ever wrote it, so the audit
-- trail was missing a field the workflow spec requires. The client cannot be
-- trusted to report its own IP (and a browser can't read it anyway), so take
-- it from the proxy headers PostgREST exposes as the request.headers GUC.
-- Prefer x-forwarded-for's FIRST hop (the original client; later hops are
-- proxies), then x-real-ip. Falls back to NULL when the GUC is absent — e.g.
-- calls made over the admin/CLI path rather than PostgREST — so this never
-- breaks a request, it just records what it can.

CREATE OR REPLACE FUNCTION public.client_ip()
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE
  h jsonb;
  v text;
BEGIN
  BEGIN
    h := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF h IS NULL THEN RETURN NULL; END IF;

  v := COALESCE(h->>'x-forwarded-for', h->>'x-real-ip', h->>'cf-connecting-ip');
  IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;

  -- x-forwarded-for is "client, proxy1, proxy2" — keep the first hop.
  RETURN btrim(split_part(v, ',', 1));
END; $fn$;

CREATE OR REPLACE FUNCTION public.request_admin_action(
  p_action_type text, p_target_type text, p_target_id uuid, p_target_label text,
  p_payload jsonb DEFAULT '{}'::jsonb, p_previous_values jsonb DEFAULT NULL::jsonb,
  p_requested_changes jsonb DEFAULT NULL::jsonb, p_device text DEFAULT NULL::text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE
  v_row public.admin_action_requests;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required to submit an action request';
  END IF;

  INSERT INTO public.admin_action_requests (
    action_type, target_type, target_id, target_label, payload,
    previous_values, requested_changes, requested_by, requested_by_role, device, ip
  ) VALUES (
    p_action_type, p_target_type, p_target_id, p_target_label, COALESCE(p_payload, '{}'::jsonb),
    p_previous_values, p_requested_changes, auth.uid(), public.actor_role(), p_device,
    public.client_ip()
  ) RETURNING * INTO v_row;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_requested',
          CASE WHEN p_target_type = 'user' THEN p_target_id ELSE NULL END,
          jsonb_build_object('request_id', v_row.id, 'action_type', p_action_type,
                             'target_type', p_target_type, 'target_id', p_target_id,
                             'target_label', p_target_label,
                             'device', p_device, 'ip', v_row.ip),
          public.actor_role());

  RETURN to_jsonb(v_row);
END; $fn$;

-- Record the reviewer's device/IP too, so approve/reject is as traceable as
-- the request itself.
CREATE OR REPLACE FUNCTION public.approve_admin_action(p_request_id uuid)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  CASE r.action_type
    WHEN 'organizer_verification_approve' THEN PERFORM public.admin_approve_organizer_verification((r.payload->>'request_id')::uuid);
    WHEN 'organizer_verification_reject'  THEN PERFORM public.admin_reject_organizer_verification((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'hide_event'             THEN PERFORM public.admin_hide_event(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_event'        THEN PERFORM public.admin_reinstate_event(r.target_id);
    WHEN 'soft_delete_event'      THEN PERFORM public.soft_delete_event(r.target_id, r.payload->>'reason');
    WHEN 'restore_deleted_event'  THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    WHEN 'set_user_role'          THEN PERFORM public.admin_set_user_role(r.target_id, r.payload->>'new_role');
    WHEN 'suspend_user'           THEN PERFORM public.admin_suspend_user(r.target_id, NULLIF(r.payload->>'banned_until','')::timestamptz, r.payload->>'reason');
    WHEN 'unsuspend_user'         THEN PERFORM public.admin_unsuspend_user(r.target_id);
    WHEN 'soft_delete_user'       THEN PERFORM public.admin_soft_delete_user(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_user'         THEN PERFORM public.admin_reinstate_user(r.target_id);
    WHEN 'toggle_user_verified'   THEN PERFORM public.admin_toggle_user_verified(r.target_id, (r.payload->>'verified')::boolean, r.payload->>'reason');
    WHEN 'credit_vents_cents'     THEN PERFORM public.admin_credit_vents_cents(r.target_id, (r.payload->>'amount')::numeric, r.payload->>'reason');
    WHEN 'debit_vents_cents'      THEN PERFORM public.admin_debit_vents_cents(r.target_id, (r.payload->>'amount')::integer, r.payload->>'reason');
    WHEN 'approve_payout'         THEN PERFORM public.admin_mark_payout_processing((r.payload->>'request_id')::uuid, r.payload->>'paystack_reference', r.payload->>'transfer_code');
    WHEN 'reject_payout'          THEN PERFORM public.admin_reject_organizer_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'cancel_payout'          THEN PERFORM public.admin_cancel_processing_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    ELSE RAISE EXCEPTION 'No executor mapped for action_type: %', r.action_type;
  END CASE;

  UPDATE public.admin_action_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_approved', CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type, 'requested_by', r.requested_by,
                             'target_label', r.target_label, 'reviewer_ip', public.client_ip(),
                             'previous_values', r.previous_values, 'requested_changes', r.requested_changes),
          public.actor_role());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (r.requested_by, 'broadcast', 'Your request has been approved',
          format('Your request (%s) was approved and executed.', COALESCE(r.target_label, r.action_type)), false, '✅');

  RETURN to_jsonb(r);
END; $fn$;

CREATE OR REPLACE FUNCTION public.reject_admin_action(p_request_id uuid, p_reason text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  UPDATE public.admin_action_requests
     SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_reason = p_reason, seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_rejected', CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type, 'requested_by', r.requested_by,
                             'reason', p_reason, 'target_label', r.target_label, 'reviewer_ip', public.client_ip()),
          public.actor_role());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (r.requested_by, 'broadcast', 'Your request has been rejected',
          format('Your request (%s) was rejected.%s', COALESCE(r.target_label, r.action_type),
                 CASE WHEN p_reason IS NOT NULL AND p_reason <> '' THEN ' Reason: ' || p_reason ELSE '' END), false, '❌');

  RETURN to_jsonb(r);
END; $fn$;
