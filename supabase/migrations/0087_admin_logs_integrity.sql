-- P0-9 — admin_logs integrity: the actor can no longer be forged.
--
-- ROOT CAUSE. admin_logs had two PERMISSIVE INSERT policies (0008:51,53):
--
--   admin_insert_logs          WITH CHECK (is_admin())
--   self_organizer_promotion_log WITH CHECK ((auth.uid() = admin_id) OR is_admin())
--
-- Neither constrained admin_id to the caller. PostgreSQL ORs permissive
-- policies, so the effective rule was `is_admin() OR auth.uid() = admin_id`,
-- and admin_logs carried a blanket INSERT grant to anon + authenticated
-- (0011:489-490, re-granted 0012:60-61). Two concrete forgeries followed:
--
--   1. ANY Sub-Admin could insert a row with admin_id set to ROOT's uuid and
--      actor_role 'root', fabricating an action attributed to Root — or bury
--      a real action under decoy entries. The audit log is the ONLY record
--      of privileged activity, so this undermined every other control in
--      this hardening pass.
--   2. ANY authenticated user (not just admins) satisfied the second policy
--      for their own uuid, letting a normal user inject arbitrary `action`
--      strings — e.g. a row reading 'role_change' — as audit-log pollution.
--
-- Client-supplied actor_role made it worse: writeAuditLog()
-- (AdminDashboardScreen.tsx:186) sends actor_role from the browser, so even
-- an honest admin_id could ship a dishonest role label.
--
-- ─────────────────────────────────────────────────────────────────────
-- WHY DROPPING self_organizer_promotion_log PRESERVES ITS BEHAVIOR.
--
-- Traced before changing anything. The organizer self-promotion audit entry
-- is written by log_organizer_promotion(p_user_id, p_email, p_username)
-- (0004), which is:
--
--   * SECURITY DEFINER — so it executes as the function owner and BYPASSES
--     RLS on admin_logs entirely. The policy was never what permitted it.
--   * already self-authorizing in its own body:
--       IF auth.uid() <> p_user_id THEN RAISE EXCEPTION 'caller must be the
--       target user'; END IF;
--     plus an EXISTS check that the user really holds an organizer role.
--   * the ONLY organizer-promotion logging path — its only callers are
--     App.tsx:2942 and App.tsx:2971, both via supabase.rpc(), never a
--     direct table insert.
--
-- So the policy was vestigial for that flow: it granted a broad direct-table
-- INSERT right that the actual feature never used. Dropping it removes the
-- forgery surface and changes nothing about organizer promotion logging —
-- no separate table or split path is needed. (A test in
-- adminLogsIntegrity.security.test.ts pins this reasoning so a future change
-- to log_organizer_promotion cannot silently invalidate it.)
-- ─────────────────────────────────────────────────────────────────────

-- ---------------------------------------------------------------------
-- 1. Stamp the actor from the execution context, never from the client.
--
-- A BEFORE INSERT trigger overwrites admin_id and actor_role with the
-- authenticated identity. Whatever a client sends in those two columns is
-- discarded, so forgery is structurally impossible rather than merely
-- policy-checked — this holds for direct table inserts AND for every one of
-- the 47 SECURITY DEFINER functions that log (which already pass
-- auth.uid()/actor_role(), so for them the trigger is a no-op rewrite of
-- identical values).
--
-- THE auth.uid() IS NULL CASE IS LOAD-BEARING. complete_organizer_payout and
-- fail_organizer_payout (0084) run on the project_admin connection from the
-- Paystack webhook and the reconcile route, where there is no JWT: auth.uid()
-- is NULL and they deliberately log actor_role 'system:project_admin'. The
-- trigger must leave those untouched, so it only rewrites when there IS an
-- authenticated user. A NULL auth.uid() cannot be reached from any client
-- session (anon/authenticated both carry a JWT context), so this branch is
-- not a bypass — it is exclusively the server-side path.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stamp_admin_log_actor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.admin_id   := auth.uid();
    NEW.actor_role := public.actor_role();
  END IF;
  RETURN NEW;
END;
$function$
;

DROP TRIGGER IF EXISTS trg_stamp_admin_log_actor ON public.admin_logs;
CREATE TRIGGER trg_stamp_admin_log_actor
  BEFORE INSERT ON public.admin_logs
  FOR EACH ROW EXECUTE FUNCTION public.stamp_admin_log_actor();

-- ---------------------------------------------------------------------
-- 2. One INSERT policy, requiring BOTH admin identity and self-attribution.
--
-- The trigger above already forces admin_id = auth.uid(), and BEFORE-row
-- triggers run before the RLS WITH CHECK is evaluated, so the admin_id
-- clause can never fail spuriously — it is defense in depth for the case
-- where the trigger is ever dropped. The is_admin() clause is the real gate:
-- it stops a normal authenticated user from inserting audit rows at all,
-- which the old self_organizer_promotion_log policy permitted.
--
-- SELECT is deliberately untouched: admin_select_logs (0008:52) still gives
-- is_admin() sessions full read, so the dashboard's audit tab
-- (AdminDashboardScreen.tsx:1157) keeps working unchanged.
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS admin_insert_logs ON public.admin_logs;
DROP POLICY IF EXISTS self_organizer_promotion_log ON public.admin_logs;

CREATE POLICY admin_logs_insert_self_admin ON public.admin_logs
  FOR INSERT TO authenticated
  WITH CHECK (admin_id = (SELECT auth.uid()) AND public.is_admin());

-- ---------------------------------------------------------------------
-- 3. Make the log append-only for clients.
--
-- 0011:489-490 and 0012:60-61 grant anon and authenticated
-- DELETE/INSERT/SELECT/UPDATE. UPDATE and DELETE were already blocked in
-- practice (RLS has no policy for either), but an audit log that is one
-- accidental permissive policy away from being client-editable is not an
-- audit log. anon loses INSERT outright — it has no legitimate reason to
-- write here, and the only anon-granted logging RPC
-- (log_organizer_promotion, 0011:289) is SECURITY DEFINER and unaffected.
--
-- project_admin retains full access for server-side paths.
-- ---------------------------------------------------------------------
-- SELECT is left exactly as 0011 set it (and is gated by admin_select_logs,
-- which is TO authenticated — so anon's residual SELECT grant matches no
-- policy and reads nothing). Only write access changes here.
REVOKE INSERT, UPDATE, DELETE ON public.admin_logs FROM anon, authenticated;
GRANT INSERT ON public.admin_logs TO authenticated;
