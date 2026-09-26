-- Batch 1b (2/3) — Reconciles TWO independently-developed fixes for the same
-- functions from claude/admin-console (0082_service_provider_kyc_maker_checker)
-- and claude/admin-security-hardening (0085_atomic_request_decisions). See
-- the Batch 1b pre-flight report for the full comparison; summary:
--
--   admin_decide_service_provider_request had two competing rewrites:
--     - admin-console: repoints the gate to is_super_admin() directly, but
--       keeps the ORIGINAL check-then-act body (still races).
--     - admin-security-hardening: fixes the race with an atomic
--       UPDATE ... WHERE status = 'pending' RETURNING, but keeps calling
--       is_admin_or_root() and its own comment claims that admits
--       Sub-Admin -- which is FALSE. is_admin_or_root() has been
--       `SELECT public.is_super_admin();` since the base schema, on both
--       branches, confirmed by reading its live definition -- it has never
--       admitted Sub-Admin. Neither file alone is correct: one still races,
--       the other's reasoning comment is wrong (functionally harmless today
--       since is_admin_or_root() == is_super_admin(), but misleading for
--       anyone maintaining this later).
--   This migration takes BOTH fixes: the atomic body, with the gate spelled
--   is_super_admin() directly (belt-and-suspenders, independent of how
--   is_admin_or_root() happens to be defined elsewhere), and a corrected
--   comment.
--
-- admin_decide_organizer_request is new in this migration (from
-- admin-security-hardening's 0085; admin-console's branch never touches
-- organizer_requests). It fixes a confirmed-live bug: AdminDashboardScreen's
-- reviewOrgRequest did a raw two-step client operation --
-- organizer_requests.update() (RLS policy organizer_requests_admin_update is
-- USING (is_admin()), which admits Sub-Admin) followed by an
-- errors-not-checked admin_set_user_role RPC call (is_super_admin()-gated).
-- A Sub-Admin can mark a request "approved" today with the role grant
-- silently failing and no error shown.
--
-- DEVIATION FROM admin-security-hardening's 0085 FILE, REQUIRED BY A REAL
-- SCHEMA CHANGE SINCE IT WAS WRITTEN: 0085's original body only promotes
-- when `v_prior_role = 'attendee'`. Production no longer has an 'attendee'
-- role at all -- a prior batch (0088/0089) changed the signup default to
-- 'user' and backfilled every existing 'attendee' row to 'user' (confirmed
-- via direct query: zero 'attendee' rows remain). Applying 0085 verbatim
-- would make this guard never match, silently no-op-ing every organizer
-- promotion (request marked approved, notification sent, but no role
-- granted -- reintroducing the exact bug this migration exists to fix).
-- The guard below checks 'user' instead, matching admin_set_user_role's own
-- live allow-list (confirmed: p_new_role NOT IN ('user','organizer') ->
-- 'Invalid role').
--
-- Both functions also gain a self-approval guard here (see 0092, which
-- calls them via the generic queue) -- ported and generalized from
-- admin-console's KYC-scoped guard, since neither branch had one for the
-- organizer path.

-- ── admin_decide_organizer_request ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_decide_organizer_request(
  p_request_id uuid,
  p_approve boolean,
  p_reason text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id     uuid;
  v_status      text;
  v_prior_role  text;
  v_role_granted boolean := false;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required to decide an organizer request (your role: %). Sub-Admins must submit this for approval.',
      COALESCE(public.actor_role(), 'none');
  END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'p_request_id is required'; END IF;
  IF p_approve IS NULL THEN RAISE EXCEPTION 'p_approve is required'; END IF;

  v_status := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;

  -- Atomic claim: status = 'pending' asserted IN the UPDATE, so exactly one
  -- concurrent caller can ever win; every loser gets NULL and bails without
  -- side effects (same idempotency pattern as admin_decide_service_provider_
  -- request below and admin_claim_payout_for_processing).
  UPDATE public.organizer_requests
     SET status      = v_status,
         admin_note  = p_reason,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   WHERE id = p_request_id
     AND status = 'pending'
  RETURNING user_id INTO v_user_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Request not found or already reviewed';
  END IF;

  SELECT u.role INTO v_prior_role FROM public.users u WHERE u.id = v_user_id;

  IF p_approve THEN
    -- Only promote a plain user. Without this guard, approving a stale
    -- request from an account that has since become an admin, sub-admin or
    -- already an organizer would DEMOTE/overwrite it -- a privilege bug in
    -- what is nominally a grant operation.
    IF v_prior_role = 'user' THEN
      -- Delegates to admin_set_user_role rather than writing users.role
      -- directly: it re-checks is_super_admin(), refuses the Root UID, and
      -- emits the standard 'role_change' audit entry.
      PERFORM public.admin_set_user_role(v_user_id, 'organizer');
      v_role_granted := true;
    END IF;

    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (v_user_id, 'promo', 'Organizer Application Approved ✓',
            'You''re approved as an Organizer on Vents. You can now create and sell tickets for your events.',
            false, '🎤');
  ELSE
    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (v_user_id, 'promo', 'Organizer Application Update',
            COALESCE('Your Organizer application was not approved: ' || p_reason,
                     'Your Organizer application was not approved.'),
            false, 'ℹ️');
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'organizer_request_decision',
    v_user_id,
    jsonb_build_object(
      'request_id',   p_request_id,
      'status',       v_status,
      'reason',       p_reason,
      'prior_role',   v_prior_role,
      'role_granted', v_role_granted
    ),
    public.actor_role()
  );

  RETURN jsonb_build_object(
    'request_id', p_request_id,
    'status', v_status,
    'user_id', v_user_id,
    'role_granted', v_role_granted
  );
END;
$function$
;

-- New function -- granted the same shape as the other admin decision RPCs
-- confirmed live above (admin_decide_service_provider_request,
-- admin_set_event_featured): authenticated + project_admin.
REVOKE ALL ON FUNCTION public.admin_decide_organizer_request(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_decide_organizer_request(uuid, boolean, text) TO authenticated, project_admin;

-- ── admin_decide_service_provider_request: atomic body + direct gate ───────
CREATE OR REPLACE FUNCTION public.admin_decide_service_provider_request(p_request_id uuid, p_status text, p_admin_note text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid; v_business text; v_type text;
BEGIN
  -- Was is_admin_or_root() -- functionally identical (that function has
  -- always been `SELECT public.is_super_admin();`), spelled directly here
  -- so this gate is correct independent of how is_admin_or_root() is
  -- defined elsewhere or redefined later.
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'status must be ''approved'' or ''rejected''';
  END IF;

  -- Atomic claim: status = 'pending' is asserted IN the UPDATE (was a
  -- separate SELECT ... then UPDATE with no re-check), so exactly one
  -- concurrent caller can ever win the race.
  UPDATE public.service_provider_requests
  SET status = p_status, admin_note = p_admin_note, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id AND status = 'pending'
  RETURNING user_id, business_name, provider_type INTO v_user_id, v_business, v_type;

  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;

  IF p_status = 'approved' THEN
    UPDATE public.users SET is_service_provider = true WHERE id = v_user_id;
    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (
      v_user_id, 'promo', 'Provider Application Approved ✓',
      'You''re approved as a Service Provider on Vents. Set up your services listing to go live.',
      false, '🛠️'
    );
  ELSE
    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (
      v_user_id, 'promo', 'Provider Application Update',
      COALESCE('Your Service Provider application was not approved: ' || p_admin_note, 'Your Service Provider application was not approved.'),
      false, 'ℹ️'
    );
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'service_provider_request_decision', v_user_id, jsonb_build_object('request_id', p_request_id, 'status', p_status), public.actor_role());
END;
$function$
;

-- Grants restated exactly as confirmed live (has_function_privilege check
-- run immediately before writing this migration): authenticated AND
-- project_admin both currently have EXECUTE. Neither source branch's grant
-- statement matched this exactly (admin-security-hardening's 0085 dropped
-- project_admin) -- preserved here rather than narrowed.
REVOKE ALL ON FUNCTION public.admin_decide_service_provider_request(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_decide_service_provider_request(uuid, text, text) TO authenticated, project_admin;
