-- ── Admin authorization tier fix (single root cause) ────────────────────────
-- ROOT CAUSE: public.is_admin_or_root() — the gate on ~20 admin RPCs
-- (organizer verification, payouts, event management, user verification, VC
-- credit/debit, refunds, health) — matched only role='admin' OR the root UID,
-- SILENTLY EXCLUDING role='sub-admin'. Every Support Admin (Sub-Admin) was
-- therefore denied "Super Admin access required" on every admin action, while
-- Root and full Admins worked. Reproduced live: a sub-admin JWT hits
-- admin_list_pending_payouts / admin_approve_organizer_verification → P0001
-- "Super Admin access required".
--
-- SINGLE SOURCE OF TRUTH — three clearly-scoped SECURITY DEFINER helpers:
--   is_root()        → the one platform super-root account (fixed UID)
--   is_super_admin() → Root OR full Admin         (ELEVATED tier; NO Sub-Admin)
--   is_admin()       → Root OR Admin OR Sub-Admin (GENERAL admin-console tier)
-- is_admin_or_root() is kept as a backward-compatible ALIAS of the GENERAL tier,
-- so the ~18 general RPCs that reference it immediately admit Sub-Admins with no
-- per-function edits. The two genuinely-elevated actions (role changes, orphan
-- cleanup) are re-gated to is_super_admin(), keeping Sub-Admins correctly
-- restricted — exactly matching the UI, which already labels those "Super Admin
-- only" for Sub-Admins.
--
-- Every helper stays schema-qualified (public.users, auth.uid) and keeps
-- search_path='' hardening (CREATE OR REPLACE resets proconfig, so it is
-- re-applied explicitly below).

-- ── Helpers ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_super_admin()
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $fn$
  SELECT public.is_root()
     OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin');
$fn$;

CREATE OR REPLACE FUNCTION public.is_admin()
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $fn$
  SELECT public.is_root()
     OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'sub-admin'));
$fn$;

-- Backward-compatible alias: now means the GENERAL admin-console tier so all
-- RPCs already gated on it admit Sub-Admins.
CREATE OR REPLACE FUNCTION public.is_admin_or_root()
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $fn$
  SELECT public.is_admin();
$fn$;

ALTER FUNCTION public.is_super_admin()   SET search_path = '';
ALTER FUNCTION public.is_admin()         SET search_path = '';
ALTER FUNCTION public.is_admin_or_root() SET search_path = '';

-- ── Observability: whoami for the admin console (detailed permission logging) ─
-- The frontend calls this once when an admin surface loads and logs the result,
-- surfacing: authenticated user id, resolved role, and each resolved tier flag.
CREATE OR REPLACE FUNCTION public.whoami_admin()
  RETURNS jsonb
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO ''
AS $fn$
  SELECT jsonb_build_object(
    'uid',            auth.uid(),
    'role',           (SELECT role FROM public.users WHERE id = auth.uid()),
    'is_root',        public.is_root(),
    'is_admin',       public.is_admin(),
    'is_super_admin', public.is_super_admin()
  );
$fn$;
ALTER FUNCTION public.whoami_admin() SET search_path = '';

-- ── Re-gate the two genuinely-elevated actions to Super Admin ────────────────
-- (bodies reproduced verbatim from the live definitions; ONLY the auth gate and
-- its denial message change — the denial now names the caller's role so the
-- reason is visible to the client, satisfying the logging requirement.)

CREATE OR REPLACE FUNCTION public.admin_set_user_role(p_user_id uuid, p_new_role text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $fn$
DECLARE
  v_target_role text;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)',
      COALESCE((SELECT role FROM public.users WHERE id = auth.uid()), 'none');
  END IF;

  IF p_new_role = 'sub-admin' THEN
    IF NOT public.is_root() THEN
      RAISE EXCEPTION 'Only Root can assign the Sub-Admin role';
    END IF;
  ELSIF p_new_role NOT IN ('attendee', 'organizer') THEN
    RAISE EXCEPTION 'Invalid role: % (allowed: attendee, organizer, sub-admin [Root only])', p_new_role;
  END IF;

  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin role cannot be changed';
  END IF;

  SELECT role INTO v_target_role FROM public.users WHERE id = p_user_id;

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
$fn$;

CREATE OR REPLACE FUNCTION public.cleanup_orphaned_records()
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $fn$
DECLARE
  v_tickets_cancelled int := 0;
  v_saves_removed int := 0;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)',
      COALESCE((SELECT role FROM public.users WHERE id = auth.uid()), 'none');
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
END;
$fn$;
