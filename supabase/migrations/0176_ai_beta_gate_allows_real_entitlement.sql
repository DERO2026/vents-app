-- Root cause of production AI_BETA_RESTRICTED for every paying user:
-- 0168_ai_beta_allowlist.sql's is_ai_beta_user() is a single-row,
-- hand-seeded allowlist ("testerboy only") from a measurement-gate phase
-- that predates the real subscription system (0165/0166) and the real
-- Paystack-verified purchase flow (0175). aiAssistantHandler.ts checks
-- ONLY this allowlist, before ever consulting ai_entitlements at all --
-- so a user who genuinely subscribes and pays (a real, server-granted
-- 'active' ai_entitlements row) is still rejected with AI_BETA_RESTRICTED,
-- because that row is never looked at by this gate.
--
-- Fix: a new function, has_ai_chat_access(), that is true if EITHER the
-- legacy beta allowlist says so (preserved, unchanged, for the one
-- existing approved account) OR the user has a genuine, currently-valid
-- entitlement -- the exact same status/period logic
-- check_and_reserve_ai_usage() already uses (trialing/active/grace,
-- and not expired past any grace window). This does not grant
-- unrestricted access to everyone: a user with no entitlement row and
-- not on the beta list is still correctly rejected. is_ai_beta_user()
-- itself is left completely unchanged (still used for its original
-- purpose/audit trail) -- this adds a new, narrower-scoped function
-- rather than redefining it, so nothing about the beta allowlist's own
-- semantics changes.
CREATE OR REPLACE FUNCTION public.has_ai_chat_access(p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ent public.ai_entitlements;
BEGIN
  IF COALESCE((SELECT active FROM public.ai_beta_users WHERE user_id = p_user_id), false) THEN
    RETURN true;
  END IF;

  SELECT * INTO v_ent FROM public.ai_entitlements WHERE user_id = p_user_id;
  IF v_ent IS NULL THEN
    RETURN false;
  END IF;
  IF v_ent.status NOT IN ('trialing', 'active', 'grace') THEN
    RETURN false;
  END IF;
  -- Same period/grace check check_and_reserve_ai_usage() applies --
  -- a lapsed period with no remaining grace window is not valid access,
  -- whatever `status` still says (that column only flips to 'expired' on
  -- the NEXT actual usage attempt, not proactively).
  IF v_ent.period_end IS NOT NULL AND v_ent.period_end < now()
     AND (v_ent.grace_until IS NULL OR v_ent.grace_until < now()) THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.has_ai_chat_access(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_ai_chat_access(uuid) TO project_admin;
