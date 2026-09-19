-- P0-6 — Organizer request approval: one atomic, authorized, audited RPC.
-- P0-7 — Service provider KYC approval: close the check-then-act race.

-- =====================================================================
-- P0-6: admin_decide_organizer_request
--
-- ROOT CAUSE. Organizer approval was a raw two-step CLIENT operation
-- (AdminDashboardScreen.tsx:1229 reviewOrgRequest):
--
--   1. supabase.from('organizer_requests').update({ status, ... })
--   2. if approved: supabase.rpc('admin_set_user_role', { 'organizer' })
--
-- Four distinct defects, all of which this RPC fixes:
--
--  (a) NOT ATOMIC. Two independent round trips with no transaction. If the
--      client died, the tab was closed, or the network dropped between
--      them, the request was permanently marked 'approved' while the user
--      never received the organizer role. Unrecoverable without manual DB
--      surgery, and invisible — the UI showed success.
--
--  (b) SILENTLY HALF-BROKEN FOR SUB-ADMINS, TODAY, IN PRODUCTION. RLS
--      organizer_requests_admin_update (0008:106) is `USING (is_admin())`,
--      which ADMITS Sub-Admins — so step 1 succeeds for them. But
--      admin_set_user_role (0004) requires is_super_admin(), so step 2
--      throws. reviewOrgRequest does not await-guard or surface that
--      rejection. Net effect: a Sub-Admin approving an organizer request
--      marks it approved, shows success, sends the applicant a decision
--      email — and the applicant never becomes an organizer. This is a
--      live correctness bug, not merely a hardening gap.
--
--  (c) NO AUDIT. Neither step wrote admin_logs. Organizer promotion — the
--      gateway to selling tickets and receiving payouts — was the only
--      privilege grant in the system with no audit record at all. (Step 2
--      logged 'role_change' when it worked, but for a Sub-Admin it never
--      ran, and nothing tied it to the request that authorized it.)
--
--  (d) NO DUAL CONTROL. reviewOrgRequest did not go through
--      submitOrExecute() at all, unlike every other privileged dashboard
--      action, so the maker-checker queue never saw it.
--
-- TIER CHOICE: is_super_admin(), matching admin_set_user_role. This is not
-- a tightening invented here — it is the tier the role grant ALREADY
-- required. Defect (b) exists precisely because the table policy (is_admin)
-- and the role grant (is_super_admin) disagreed. Aligning the whole
-- operation to the stricter of the two is what makes it coherent. Sub-Admins
-- keep a working path via request_admin_action → 'decide_organizer_request'
-- (wired into approve_admin_action's CASE in 0086).
-- =====================================================================
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

  -- Atomic claim. The `AND status = 'pending'` predicate plus RETURNING is
  -- the idempotency pattern already used by admin_claim_payout_for_processing
  -- (0022) and complete_organizer_payout (0023): whoever wins the race gets
  -- the row back, every loser gets NULL and bails without side effects. This
  -- replaces admin_decide_service_provider_request's check-then-act shape
  -- (see P0-7 below, fixed in the same migration).
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
    -- Only promote an actual attendee. Without this guard, approving a
    -- stale request from an account that has since become an admin,
    -- sub-admin or service provider would DEMOTE it to 'organizer' —
    -- a privilege-downgrade bug in what is nominally a grant operation.
    IF v_prior_role = 'attendee' THEN
      -- Delegates to admin_set_user_role rather than writing users.role
      -- directly: it re-checks is_super_admin(), refuses the Root UID, and
      -- emits the standard 'role_change' audit entry, so organizer
      -- promotion stays consistent with every other role change in the
      -- system instead of becoming a second, divergent write path.
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

REVOKE ALL ON FUNCTION public.admin_decide_organizer_request(uuid, boolean, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_decide_organizer_request(uuid, boolean, text) TO authenticated;

-- =====================================================================
-- P0-7: admin_decide_service_provider_request — close the race.
--
-- The 0044 original was check-then-act:
--
--   SELECT user_id ... WHERE id = p_request_id AND status = 'pending';
--   IF v_user_id IS NULL THEN RAISE ...;
--   UPDATE service_provider_requests SET status = p_status WHERE id = p_request_id;
--
-- The SELECT took no lock and the UPDATE did not re-assert status =
-- 'pending'. Two admins approving the same KYC application concurrently
-- could both pass the SELECT, and both proceed: two notifications to the
-- applicant, two admin_logs entries, and the second UPDATE overwriting the
-- first reviewer's decision — so an approve/reject pair racing could land
-- either way, with the audit log showing both as having succeeded.
--
-- Fixed with the same atomic UPDATE ... WHERE status = 'pending' RETURNING
-- shape used above. Everything else is preserved exactly: the
-- is_admin_or_root() gate (unchanged — this grants a marketplace listing
-- capability, not a platform role, and Sub-Admin KYC review is the intended
-- existing behavior), the p_status validation, the users.is_service_provider
-- flag, both notification bodies, and the admin_logs write.
--
-- Signature is unchanged (p_request_id, p_status, p_admin_note), so the
-- existing caller at AdminDashboardScreen.tsx:1291 keeps working untouched.
-- Note 0044 used CREATE FUNCTION (not CREATE OR REPLACE); replacing it here
-- is safe because the argument types are identical.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_decide_service_provider_request(p_request_id uuid, p_status text, p_admin_note text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid; v_business text; v_type text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'status must be ''approved'' or ''rejected''';
  END IF;

  -- Atomic claim: status = 'pending' is asserted IN the UPDATE, so exactly
  -- one concurrent caller can ever win.
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

REVOKE ALL ON FUNCTION public.admin_decide_service_provider_request(uuid, text, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_decide_service_provider_request(uuid, text, text) TO authenticated;
