-- ── Sub-Admin approval workflow (maker-checker) ──────────────────────────────
-- Sub-Admins (Support Admins) no longer execute sensitive actions directly.
-- Instead they create an admin_action_requests row (status=pending); a Super
-- Admin (Root or full Admin) reviews it and Approves (executes the underlying
-- action) or Rejects (records the reason, executes nothing). Root/full Admins
-- continue to execute directly via the existing RPCs — this workflow is the
-- path the FRONTEND routes Sub-Admins through. The request row doubles as the
-- admin notification (badge = pending count; seen_at = "read"); its status is
-- the notification state (pending/approved=completed/rejected).

-- ── Request/notification table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_action_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type        text NOT NULL,
  target_type        text,                          -- 'user' | 'event' | 'payout' | 'verification' | ...
  target_id          uuid,                          -- the primary entity id (user/event) when applicable
  target_label       text,                          -- human label (event title, @username, amount…)
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- args needed to execute on approval
  previous_values    jsonb,                         -- snapshot before the change
  requested_changes  jsonb,                         -- what would change
  requested_by       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  requested_by_role  text,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by        uuid REFERENCES public.users(id) ON DELETE SET NULL,
  review_reason      text,
  device             text,
  ip                 text,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  reviewed_at        timestamptz,
  seen_at            timestamptz                    -- an admin marked the notification read
);

CREATE INDEX IF NOT EXISTS idx_aar_status_requested_at ON public.admin_action_requests (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_aar_requested_by ON public.admin_action_requests (requested_by, requested_at DESC);

-- All access is through the SECURITY DEFINER RPCs below; enable RLS with no
-- permissive policies so the table is unreachable by direct PostgREST access.
ALTER TABLE public.admin_action_requests ENABLE ROW LEVEL SECURITY;

-- ── Create a request (the "maker" step) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_admin_action(
  p_action_type text,
  p_target_type text,
  p_target_id uuid,
  p_target_label text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_previous_values jsonb DEFAULT NULL,
  p_requested_changes jsonb DEFAULT NULL,
  p_device text DEFAULT NULL
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $fn$
DECLARE
  v_row public.admin_action_requests;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required to submit an action request';
  END IF;

  INSERT INTO public.admin_action_requests (
    action_type, target_type, target_id, target_label, payload,
    previous_values, requested_changes, requested_by, requested_by_role, device
  ) VALUES (
    p_action_type, p_target_type, p_target_id, p_target_label, COALESCE(p_payload, '{}'::jsonb),
    p_previous_values, p_requested_changes, auth.uid(), public.actor_role(), p_device
  ) RETURNING * INTO v_row;

  -- Permanent audit trail (Task 7) — the request was created.
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_requested',
          CASE WHEN p_target_type = 'user' THEN p_target_id ELSE NULL END,
          jsonb_build_object('request_id', v_row.id, 'action_type', p_action_type,
                             'target_type', p_target_type, 'target_id', p_target_id,
                             'target_label', p_target_label),
          public.actor_role());

  RETURN to_jsonb(v_row);
END;
$fn$;

-- ── List requests (review queue + Sub-Admin's own history) ───────────────────
-- Super Admins see everything (optionally filtered by status); Sub-Admins see
-- only their own requests (their Pending/Approved/Rejected history).
CREATE OR REPLACE FUNCTION public.admin_list_action_requests(p_status text DEFAULT NULL)
  RETURNS TABLE (
    id uuid, action_type text, target_type text, target_id uuid, target_label text,
    payload jsonb, previous_values jsonb, requested_changes jsonb,
    requested_by uuid, requested_by_name text, requested_by_role text,
    status text, reviewed_by uuid, reviewed_by_name text, review_reason text,
    requested_at timestamptz, reviewed_at timestamptz, seen_at timestamptz
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $fn$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN QUERY
  SELECT r.id, r.action_type, r.target_type, r.target_id, r.target_label,
         r.payload, r.previous_values, r.requested_changes,
         r.requested_by, ru.full_name, r.requested_by_role,
         r.status, r.reviewed_by, vu.full_name, r.review_reason,
         r.requested_at, r.reviewed_at, r.seen_at
  FROM public.admin_action_requests r
  LEFT JOIN public.users ru ON ru.id = r.requested_by
  LEFT JOIN public.users vu ON vu.id = r.reviewed_by
  WHERE (p_status IS NULL OR r.status = p_status)
    AND (public.is_super_admin() OR r.requested_by = auth.uid())
  ORDER BY r.requested_at DESC;
END;
$fn$;

-- ── Badge: pending count (Super Admin review queue) ──────────────────────────
CREATE OR REPLACE FUNCTION public.admin_pending_request_count()
  RETURNS integer
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $fn$
  SELECT CASE WHEN public.is_super_admin()
    THEN (SELECT count(*)::int FROM public.admin_action_requests WHERE status = 'pending')
    ELSE 0 END;
$fn$;

-- ── Mark notification(s) read ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_mark_request_seen(p_request_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  UPDATE public.admin_action_requests SET seen_at = now() WHERE id = p_request_id AND seen_at IS NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_mark_all_requests_seen()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  UPDATE public.admin_action_requests SET seen_at = now() WHERE seen_at IS NULL;
END;
$fn$;

-- ── Approve (the "checker" step — executes the underlying action) ────────────
CREATE OR REPLACE FUNCTION public.approve_admin_action(p_request_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $fn$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)',
      COALESCE((SELECT role FROM public.users WHERE id = auth.uid()), 'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  -- Dispatch: execute the requested action as the approving Super Admin.
  -- Each underlying RPC performs its own validation, root-immutability, and
  -- audit logging with the APPROVER as the actor.
  CASE r.action_type
    WHEN 'organizer_verification_approve' THEN
      PERFORM public.admin_approve_organizer_verification((r.payload->>'request_id')::uuid);
    WHEN 'organizer_verification_reject' THEN
      PERFORM public.admin_reject_organizer_verification((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'hide_event' THEN
      PERFORM public.admin_hide_event(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_event' THEN
      PERFORM public.admin_reinstate_event(r.target_id);
    WHEN 'soft_delete_event' THEN
      PERFORM public.soft_delete_event(r.target_id, r.payload->>'reason');
    WHEN 'restore_deleted_event' THEN
      PERFORM public.admin_restore_deleted_event(r.target_id);
    WHEN 'set_user_role' THEN
      PERFORM public.admin_set_user_role(r.target_id, r.payload->>'new_role');
    WHEN 'reject_payout' THEN
      PERFORM public.admin_reject_organizer_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'toggle_user_verified' THEN
      PERFORM public.admin_toggle_user_verified(r.target_id, (r.payload->>'verified')::boolean, r.payload->>'reason');
    WHEN 'credit_vents_cents' THEN
      PERFORM public.admin_credit_vents_cents(r.target_id, (r.payload->>'amount')::numeric, r.payload->>'reason');
    ELSE
      RAISE EXCEPTION 'No executor mapped for action_type: %', r.action_type;
  END CASE;

  UPDATE public.admin_action_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
         seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id
   RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_approved',
          CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type,
                             'requested_by', r.requested_by, 'target_label', r.target_label),
          public.actor_role());

  RETURN to_jsonb(r);
END;
$fn$;

-- ── Reject (records reason; executes nothing) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_admin_action(p_request_id uuid, p_reason text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $fn$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)',
      COALESCE((SELECT role FROM public.users WHERE id = auth.uid()), 'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  UPDATE public.admin_action_requests
     SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(),
         review_reason = p_reason, seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id
   RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_rejected',
          CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type,
                             'requested_by', r.requested_by, 'reason', p_reason,
                             'target_label', r.target_label),
          public.actor_role());

  RETURN to_jsonb(r);
END;
$fn$;
