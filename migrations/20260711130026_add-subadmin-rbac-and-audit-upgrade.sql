-- Sub-Admin RBAC tier + hardened root immutability + richer audit trail.
--
-- Design:
--  * Sub-Admin is a new admin-tier role (role = 'sub-admin'). is_admin() is
--    broadened to recognize it, so Sub-Admins inherit the moderation
--    capabilities gated behind is_admin() (users, events, reports, audit
--    log, VC, orphan cleanup) — the console's existing per-tab isRoot gates
--    (System tab, app_config writes) are untouched, so financial/system
--    configuration stays Root/full-Admin only regardless of this change.
--  * Root (hardcoded ROOT_UID) remains immutable: admin_set_user_role already
--    hard-blocks any role change targeting root, and the existing
--    lock_admin_root_role trigger forces root's role back to 'admin' on any
--    UPDATE as a schema-level backstop. Both are untouched by this migration.
--  * Promotion is restricted to attendee/organizer only (admin_set_user_role
--    already enforced this for all callers) — nobody can create new
--    Admin/Sub-Admin accounts through the console; that stays an out-of-band
--    (migration-level) operation. Sub-Admins are additionally blocked from
--    altering any existing Admin/Sub-Admin account at all.
--  * Every admin_logs row now records actor_role so the audit trail
--    explicitly flags whether the executor was Admin, Sub-Admin, or Root.

-- 1. Extend the role enum with 'sub-admin'.
ALTER TABLE public.users DROP CONSTRAINT users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role = ANY (ARRAY['user'::text, 'attendee'::text, 'organizer'::text, 'organiser'::text, 'admin'::text, 'sub-admin'::text]));

-- 2. Assign the Sub-Admin tier to the designated account.
UPDATE public.users SET role = 'sub-admin' WHERE username = 'ventsofficial';

-- 3. is_admin() now recognizes Sub-Admins as admin-tier.
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'sub-admin')
  );
$function$;

-- 4. Audit log schema upgrade: record the executor's authorization level.
ALTER TABLE public.admin_logs ADD COLUMN IF NOT EXISTS actor_role text;

CREATE OR REPLACE FUNCTION public.actor_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN auth.uid() = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN 'root'
    ELSE (SELECT role FROM public.users WHERE id = auth.uid())
  END;
$function$;

-- 5. Role-change RPC: stamp actor_role, and block Sub-Admins from altering
-- any Admin/Sub-Admin-tier account (root is already hard-blocked above this).
CREATE OR REPLACE FUNCTION public.admin_set_user_role(p_user_id uuid, p_new_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_target_role text;
  v_caller_role text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_new_role NOT IN ('attendee', 'organizer') THEN
    RAISE EXCEPTION 'Invalid role: % (allowed: attendee, organizer)', p_new_role;
  END IF;

  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin role cannot be changed';
  END IF;

  SELECT role INTO v_target_role FROM public.users WHERE id = p_user_id;
  SELECT role INTO v_caller_role FROM public.users WHERE id = auth.uid();

  IF v_target_role IN ('admin', 'sub-admin') AND v_caller_role = 'sub-admin' THEN
    RAISE EXCEPTION 'Sub-Admins cannot alter Admin/Sub-Admin accounts';
  END IF;

  UPDATE public.users SET role = p_new_role WHERE id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'role_change',
    p_user_id,
    jsonb_build_object('old_role', v_target_role, 'new_role', p_new_role),
    public.actor_role()
  );
END;
$function$;

-- 6. Orphan cleanup + VC debit: stamp actor_role on their existing audit rows.
CREATE OR REPLACE FUNCTION public.cleanup_orphaned_records()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_tickets_cancelled int := 0;
  v_saves_removed int := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  WITH updated AS (
    UPDATE public.tickets SET status = 'cancelled'
    WHERE status = 'active'
      AND NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = tickets.event_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_tickets_cancelled FROM updated;

  WITH deleted AS (
    DELETE FROM public.saved_events
    WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = saved_events.event_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_saves_removed FROM deleted;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'orphan_cleanup', NULL, jsonb_build_object(
    'tickets_cancelled', v_tickets_cancelled,
    'saves_removed', v_saves_removed
  ), public.actor_role());

  RETURN jsonb_build_object(
    'tickets_cancelled', v_tickets_cancelled,
    'saves_removed', v_saves_removed
  );
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_debit_vents_cents(p_user_id uuid, p_amount integer, p_reason text DEFAULT 'Admin debit'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_balance integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  PERFORM public._vc_deduct(p_user_id, p_amount, p_reason);

  SELECT balance INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Adjusted',
    p_amount || ' Vents Cents have been removed from your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'admin_vc_debit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason), public.actor_role());

  RETURN jsonb_build_object('debited', p_amount, 'target_balance', v_balance);
END;
$function$;

-- 7. Event moderation RPCs: route through is_admin() (so Sub-Admins can
-- moderate events too) instead of a hardcoded role = 'admin' check, and
-- stamp actor_role on their audit rows.
CREATE OR REPLACE FUNCTION public.admin_hide_event(p_event_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can hide events';
  END IF;

  UPDATE public.events
  SET hidden_by_admin = true,
      hidden_at       = now(),
      hidden_by       = auth.uid()
  WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (
    auth.uid(),
    'hide_event',
    jsonb_build_object('event_id', p_event_id, 'reason', p_reason),
    public.actor_role()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reinstate_event(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admins can reinstate events';
  END IF;

  UPDATE public.events
  SET hidden_by_admin = false,
      hidden_at       = NULL,
      hidden_by       = NULL
  WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (
    auth.uid(),
    'reinstate_event',
    jsonb_build_object('event_id', p_event_id),
    public.actor_role()
  );
END;
$function$;
