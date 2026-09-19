-- P0-1 — VENTS Wallet admin visibility (READ-ONLY).
--
-- Before this migration, user_wallets and user_wallet_transactions (0065)
-- carried exactly one policy each — user_wallets_own_read /
-- user_wallet_transactions_own_read, both `user_id = auth.uid()`. There was
-- no admin SELECT policy and no RPC of any kind that could read another
-- user's balance or ledger. Net effect: the platform had a real, customer-
-- funded NGN liability (deposit-backed, non-withdrawable) that NO ONE could
-- see in aggregate — not Root, not Admin. There was no way to answer "how
-- much customer money are we holding right now", which is both an
-- operational and a reconciliation gap.
--
-- Scope discipline — this migration adds READ capability ONLY. It
-- deliberately does NOT add any RPC that credits or debits a customer
-- wallet. user_wallets is still write-reachable only through the existing
-- SECURITY DEFINER deposit/spend/refund functions (0065-0068, 0075), and
-- still has no INSERT/UPDATE/DELETE policy for authenticated at all. An
-- admin balance-adjustment capability would be a real-money mutation of a
-- customer's funds and needs its own dual-controlled, separately-authorized,
-- fully-audited flow — explicitly out of scope here.

-- ---------------------------------------------------------------------
-- Admin SELECT policies. Style matches the existing admin-read policies on
-- sibling financial tables — vc_transactions_admin_select (0008:150),
-- service_bookings_admin_select (0054:253) — i.e. an additional PERMISSIVE
-- SELECT policy gated on is_admin(), sitting alongside (never replacing)
-- the own-row policy.
--
-- is_admin() (not is_super_admin()) is correct here: this is read-only
-- visibility, and every other financial read surface a Sub-Admin already
-- has — vc_transactions, service_bookings, organizer payouts via
-- admin_list_pending_payouts — is is_admin()-gated too. Widening Sub-Admin
-- *read* is consistent with the established tier model; it is *writes* that
-- this task tightens.
--
-- Adding a second PERMISSIVE policy cannot narrow the existing own-row
-- access: PostgreSQL ORs permissive policies together, so a normal user's
-- own-row read is bit-for-bit unchanged.
-- ---------------------------------------------------------------------
CREATE POLICY user_wallets_admin_select ON public.user_wallets
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY user_wallet_transactions_admin_select ON public.user_wallet_transactions
  FOR SELECT TO authenticated USING (public.is_admin());

-- ---------------------------------------------------------------------
-- admin_get_wallet_aggregates: platform-wide VENTS Wallet totals.
--
-- Shape and gate mirror admin_get_vc_aggregates (0004) exactly — the
-- existing precedent for "one call, one row of platform financial totals",
-- including its is_admin() gate and STABLE SECURITY DEFINER declaration.
--
-- total_balance_kobo is the headline number: the platform's outstanding
-- customer-money liability. The deposit/spend/refund breakdown below it
-- exists so that figure can be independently reconciled against the ledger
-- (deposits - spends + refunds should equal the balance sum; a divergence
-- means a balance was moved without a ledger row, which 0065's design is
-- specifically built to prevent).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_wallet_aggregates()
 RETURNS TABLE(
   total_balance_kobo bigint,
   wallet_count bigint,
   funded_wallet_count bigint,
   total_deposited_kobo bigint,
   total_spent_kobo bigint,
   total_refunded_kobo bigint,
   transaction_count bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN QUERY
  SELECT
    (SELECT COALESCE(sum(w.balance_kobo), 0) FROM public.user_wallets w)::bigint,
    (SELECT count(*) FROM public.user_wallets)::bigint,
    (SELECT count(*) FROM public.user_wallets w WHERE w.balance_kobo > 0)::bigint,
    (SELECT COALESCE(sum(t.amount_kobo), 0) FROM public.user_wallet_transactions t WHERE t.type = 'deposit')::bigint,
    (SELECT COALESCE(sum(t.amount_kobo), 0) FROM public.user_wallet_transactions t WHERE t.type = 'spend')::bigint,
    (SELECT COALESCE(sum(t.amount_kobo), 0) FROM public.user_wallet_transactions t WHERE t.type = 'refund')::bigint,
    (SELECT count(*) FROM public.user_wallet_transactions)::bigint;
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_get_wallet_aggregates() FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_get_wallet_aggregates() TO authenticated;

-- ---------------------------------------------------------------------
-- admin_get_user_wallet: per-user drill-down — balance plus a page of that
-- user's ledger, in one call.
--
-- Returns jsonb rather than a TABLE because the two halves have different
-- shapes (one scalar balance + N ledger rows); jsonb-returning RPCs are
-- already the established pattern here for composite results
-- (initiate_wallet_deposit 0065, admin_broadcast 0004).
--
-- Pagination bounds are copied verbatim from get_my_wallet_transactions
-- (0065): default 50, floor 1, ceiling 100. An admin cannot request an
-- unbounded page any more than a user can.
--
-- A user who has never opened the Wallet screen has no user_wallets row
-- (0065 creates them lazily in get_my_wallet). That is a normal state, not
-- an error, so balance_kobo reports 0 via COALESCE rather than null — and
-- this function deliberately does NOT lazily create the row, because an
-- admin merely *looking* at an account should never write to it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_user_wallet(
  p_user_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_result jsonb;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id is required'; END IF;

  SELECT jsonb_build_object(
    'user_id', p_user_id,
    'balance_kobo', COALESCE((SELECT w.balance_kobo FROM public.user_wallets w WHERE w.user_id = p_user_id), 0),
    'wallet_created_at', (SELECT w.created_at FROM public.user_wallets w WHERE w.user_id = p_user_id),
    'transaction_count', (SELECT count(*) FROM public.user_wallet_transactions t WHERE t.user_id = p_user_id),
    'limit', v_limit,
    'offset', v_offset,
    'transactions', COALESCE((
      SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.created_at DESC)
      FROM (
        SELECT t.id, t.type, t.amount_kobo, t.description, t.reference_id, t.metadata, t.created_at
        FROM public.user_wallet_transactions t
        WHERE t.user_id = p_user_id
        ORDER BY t.created_at DESC
        LIMIT v_limit OFFSET v_offset
      ) x
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_get_user_wallet(uuid, integer, integer) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_get_user_wallet(uuid, integer, integer) TO authenticated;
