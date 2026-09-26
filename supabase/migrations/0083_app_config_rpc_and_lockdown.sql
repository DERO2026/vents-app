-- P0-4 / P1-1 — Platform kill switches and system config: make every write
-- go through one audited, server-authorized RPC.
--
-- WHAT WAS AND WAS NOT ACTUALLY BROKEN HERE — this differs from the brief,
-- so the reasoning is recorded in full.
--
-- NOT broken: authorization. app_config's UPDATE policy
-- (app_config_root_update, 0008:55) is already `USING (is_root()) WITH
-- CHECK (is_root())` — Root-only, for every column, today. It is NOT
-- is_admin()-writable. This migration therefore does NOT loosen anything to
-- is_super_admin(), even where the brief suggested that tier: relative to
-- the live policy that would be a WEAKENING (it would newly admit Admins to
-- the platform kill switches and the VC economy dials). Existing tier is
-- preserved exactly: Root, for every field.
--
-- Genuinely broken, and fixed here:
--
--  1. SILENT NO-OP + FALSE AUDIT ENTRY. The System tab writes app_config
--     with a raw PostgREST `.update()` (AdminDashboardScreen.tsx:1771,
--     1792, 1813, 1845). Under RLS, a non-Root admin's UPDATE matches zero
--     rows and PostgREST returns SUCCESS — no error. The handler then
--     unconditionally calls writeAuditLog(), flips local UI state, and
--     flashes "Maintenance mode enabled." So a Sub-Admin or Admin saw a
--     confirmed success, the UI showed the switch flipped, and admin_logs
--     gained an entry claiming it happened — while nothing changed. The
--     audit log actively lied about platform state. This RPC raises a real
--     exception instead, so the client's existing catch-block surfaces it.
--
--  2. CLIENT-SIDE, CONTENT-FREE AUDIT. writeAuditLog() is a client INSERT
--     into admin_logs, passing `details: {}` — no field name, no old value,
--     no new value. A kill-switch change was unreconstructable after the
--     fact. Logging now happens server-side, inside the same transaction as
--     the write, and carries field/old/new. (Audit-log INSERT forgeability
--     is a separate issue, addressed in 0087.)
--
--  3. NO SERVER-SIDE FIELD WHITELIST. A raw `.update()` can set any column,
--     including updated_by, to any value. The RPC accepts only the 13
--     whitelisted fields below, each through its own literal UPDATE — no
--     dynamic SQL anywhere, so the whitelist is structural rather than
--     validated.

-- ---------------------------------------------------------------------
-- admin_update_app_config(p_field, p_value)
--
-- p_value is text and cast per-field, so one RPC covers boolean, integer
-- and text columns without a jsonb round-trip.
--
-- Every field is Root-gated, matching app_config_root_update. The fields
-- are grouped below by blast radius purely for documentation — if a future
-- product decision lowers the tier for the media toggles, that is a
-- one-line change per group here and must be made deliberately, not as a
-- side effect of a security pass.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_app_config(p_field text, p_value text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old     jsonb;
  v_new     jsonb;
  v_oldval  text;
  v_newval  text;
  v_bool    boolean;
  v_int     integer;
BEGIN
  -- Matches app_config_root_update (0008:55) exactly. Not is_super_admin():
  -- these are platform-wide blast-radius switches plus the VC economy
  -- dials, and Root-only is the tier that is live today.
  IF NOT public.is_root() THEN
    RAISE EXCEPTION 'Root access required to change platform configuration (your role: %)',
      COALESCE(public.actor_role(), 'none');
  END IF;

  IF p_field IS NULL THEN RAISE EXCEPTION 'p_field is required'; END IF;

  SELECT to_jsonb(c) INTO v_old FROM public.app_config c WHERE c.id = true;
  IF v_old IS NULL THEN RAISE EXCEPTION 'app_config singleton row is missing'; END IF;
  v_oldval := v_old ->> p_field;

  CASE p_field

    -- ── Group A: platform-wide kill switches (highest blast radius) ────
    -- Each of these blocks a whole product surface for every user at once.
    WHEN 'maintenance_mode' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET maintenance_mode = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_purchases' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_purchases = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_scanning' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_scanning = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_signups' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_signups = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_payouts' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_payouts = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'disable_location_sharing' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET disable_location_sharing = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    -- ── Group B: media/feature toggles (lower blast radius) ────────────
    WHEN 'voice_notes_enabled' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET voice_notes_enabled = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'image_sharing_enabled' THEN
      v_bool := p_value::boolean;
      UPDATE public.app_config SET image_sharing_enabled = v_bool, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    -- ── Group C: messaging / client gating ─────────────────────────────
    WHEN 'broadcast_message' THEN
      UPDATE public.app_config SET broadcast_message = NULLIF(p_value, ''), updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'min_client_version' THEN
      IF p_value IS NULL OR p_value !~ '^[0-9]+\.[0-9]+\.[0-9]+$' THEN
        RAISE EXCEPTION 'min_client_version must look like 1.2.3';
      END IF;
      UPDATE public.app_config SET min_client_version = p_value, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    -- ── Group D: VENTS Cents economy (P1-1) ────────────────────────────
    -- Real financial impact: these set the NGN value of VC and how much of
    -- a ticket price VC can cover. Bounds below are sanity rails against a
    -- fat-fingered value silently repricing the whole loyalty economy.
    WHEN 'vc_naira_per_1000' THEN
      v_int := p_value::integer;
      IF v_int IS NULL OR v_int <= 0 OR v_int > 1000000 THEN
        RAISE EXCEPTION 'vc_naira_per_1000 must be between 1 and 1000000';
      END IF;
      UPDATE public.app_config SET vc_naira_per_1000 = v_int, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'vc_min_ticket_price' THEN
      v_int := p_value::integer;
      IF v_int IS NULL OR v_int < 0 THEN
        RAISE EXCEPTION 'vc_min_ticket_price must be >= 0';
      END IF;
      UPDATE public.app_config SET vc_min_ticket_price = v_int, updated_by = auth.uid(), updated_at = now() WHERE id = true;
    WHEN 'vc_max_redemption_pct' THEN
      v_int := p_value::integer;
      IF v_int IS NULL OR v_int < 0 OR v_int > 100 THEN
        RAISE EXCEPTION 'vc_max_redemption_pct must be between 0 and 100';
      END IF;
      UPDATE public.app_config SET vc_max_redemption_pct = v_int, updated_by = auth.uid(), updated_at = now() WHERE id = true;

    ELSE
      RAISE EXCEPTION 'Unknown or non-updatable app_config field: %', p_field;
  END CASE;

  SELECT to_jsonb(c) INTO v_new FROM public.app_config c WHERE c.id = true;
  v_newval := v_new ->> p_field;

  -- Server-side, same-transaction, with enough to reconstruct the change.
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'app_config_update',
    NULL,
    jsonb_build_object('field', p_field, 'old_value', v_oldval, 'new_value', v_newval),
    public.actor_role()
  );

  RETURN jsonb_build_object('field', p_field, 'old_value', v_oldval, 'new_value', v_newval);
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_update_app_config(text, text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_update_app_config(text, text) TO authenticated;

-- ---------------------------------------------------------------------
-- Close the direct-table write path.
--
-- 0011:494-495 and 0012:62-63 grant anon AND authenticated
-- DELETE/INSERT/SELECT/UPDATE on app_config. Those writes were blocked in
-- practice only because RLS has no INSERT/DELETE policy and its single
-- UPDATE policy is Root-only — i.e. the grant was always broader than the
-- intent, and the table was one accidental permissive policy away from
-- being client-writable.
--
-- SELECT is deliberately untouched: app_config_read_all (0008:54) stays
-- exactly as-is, and SELECT remains granted to anon and authenticated.
-- Every feature-flag read path keeps working unchanged — App.tsx:364
-- (min_client_version / maintenance poll), EventDetailsScreen
-- (disable_purchases), AuthScreen (disable_signups), ConversationScreen
-- (voice/image toggles), AdminDashboardScreen:233,1170. This migration
-- touches write access only.
--
-- project_admin keeps full access (server-side reconciliation paths), and
-- the SECURITY DEFINER RPC above runs as its owner, so it is unaffected by
-- these revokes.
REVOKE INSERT, UPDATE, DELETE ON public.app_config FROM anon, authenticated;
GRANT SELECT ON public.app_config TO anon, authenticated;

-- app_config_root_update is intentionally LEFT IN PLACE. With the UPDATE
-- grant gone it is now unreachable from a client session, but keeping it
-- means the table is still correctly gated if a future migration re-grants
-- UPDATE — defense in depth, and removing a correct policy is exactly the
-- kind of silent weakening this pass is meant to prevent.
