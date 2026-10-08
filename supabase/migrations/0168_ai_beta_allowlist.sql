-- VENTS Phase 7 -- temporary, server-side AI beta allowlist.
--
-- Purpose: Phase 6 found zero rows in ai_usage_events -- there is no real
-- VENTS AI traffic yet to measure. This lets a small number of explicitly
-- approved accounts use VENTS AI chat (and only chat -- see
-- api/_lib/aiAssistantHandler.ts; extraction/vision stay exactly as they
-- are, unrestricted, since they're a different, already-free feature)
-- so Phase 5A's telemetry can start collecting real cost data, WITHOUT
-- opening unrestricted free Anthropic usage to every VENTS user.
--
-- Deliberately separate from the subscription foundation (0165/0166):
-- no column here, no function here, touches ai_entitlements,
-- ai_usage_periods, app_config.ai_entitlement_enforced, or
-- check_and_reserve_ai_usage in any way. This table/gate can be dropped
-- entirely once real usage data exists, without touching anything about
-- the entitlement system.
--
-- Removal is a soft-disable (`active = false`), not a DELETE -- this
-- keeps an audit trail of who was ever approved, and is a simpler/safer
-- revocation primitive than a hard delete for a short-lived measurement
-- gate.
CREATE TABLE IF NOT EXISTS public.ai_beta_users (
  user_id   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by  uuid, -- the Root admin who approved this account; NULL for the migration's own seed row below
  added_at  timestamptz NOT NULL DEFAULT now(),
  active    boolean NOT NULL DEFAULT true
);

ALTER TABLE public.ai_beta_users ENABLE ROW LEVEL SECURITY;
-- No policies -- no direct anon/authenticated access by design (same
-- pattern as every other server-only table in this codebase). The only
-- reader is is_ai_beta_user() below (project_admin-only); the only
-- writers are the two Root-gated admin RPCs further down.

-- Seed: testerboy only, per the explicit instruction to start with
-- exactly one approved account. added_by NULL marks this as a
-- migration-time seed rather than a Root admin action (which would
-- instead go through admin_add_ai_beta_user and get logged to
-- admin_logs).
INSERT INTO public.ai_beta_users (user_id, added_by)
VALUES ('91b0afb4-b5dc-4289-ae00-8e6e58c60f5f', NULL)
ON CONFLICT (user_id) DO NOTHING;

-- Server-only check, reachable ONLY via the trusted project_admin
-- Postgres connection (api/_lib/aiBeta.ts) -- no anon/authenticated
-- EXECUTE grant exists, so a client cannot query this, let alone bypass
-- it. Fails closed at the CALLER level (see aiBeta.ts's own comment);
-- this function itself simply reports whether an ACTIVE row exists,
-- COALESCEd to false so a missing row or a soft-removed (active=false)
-- row are both treated as "not approved".
CREATE OR REPLACE FUNCTION public.is_ai_beta_user(p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT active FROM public.ai_beta_users WHERE user_id = p_user_id), false);
$function$;

REVOKE ALL ON FUNCTION public.is_ai_beta_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_ai_beta_user(uuid) TO project_admin;

-- Root-gated admin controls -- the only way to add/remove a beta account
-- beyond this migration's own seed row. Mirrors admin_set_ai_entitlement's
-- own is_root() gate and admin_logs audit trail exactly. No new admin UI
-- is required for this: these are plain RPCs, callable directly via the
-- project's trusted SQL tooling for this temporary measurement phase.
CREATE OR REPLACE FUNCTION public.admin_add_ai_beta_user(p_user_id uuid, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_root() THEN
    RAISE EXCEPTION 'Root access required to approve an AI beta account (your role: %)',
      COALESCE(public.actor_role(), 'none');
  END IF;

  INSERT INTO public.ai_beta_users (user_id, added_by, active)
  VALUES (p_user_id, auth.uid(), true)
  ON CONFLICT (user_id) DO UPDATE SET active = true, added_by = auth.uid(), added_at = now();

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'ai_beta_user_added', p_user_id, jsonb_build_object('reason', p_reason), public.actor_role());

  RETURN jsonb_build_object('user_id', p_user_id, 'approved', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_add_ai_beta_user(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_ai_beta_user(uuid, text) TO project_admin;

-- Soft-disable, not a DELETE -- see the table's own comment above for why.
CREATE OR REPLACE FUNCTION public.admin_remove_ai_beta_user(p_user_id uuid, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_root() THEN
    RAISE EXCEPTION 'Root access required to remove an AI beta account (your role: %)',
      COALESCE(public.actor_role(), 'none');
  END IF;

  UPDATE public.ai_beta_users SET active = false WHERE user_id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'ai_beta_user_removed', p_user_id, jsonb_build_object('reason', p_reason), public.actor_role());

  RETURN jsonb_build_object('user_id', p_user_id, 'approved', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_remove_ai_beta_user(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_ai_beta_user(uuid, text) TO project_admin;
