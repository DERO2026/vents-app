-- Fix the admin VC dashboard's "VC in Circulation" always showing ~0: the
-- client was summing public.vents_wallets.balance directly, but that
-- table's RLS policy ("wallets_select") only lets a caller read their OWN
-- row (user_id = auth.uid()) -- an admin querying it client-side only ever
-- got their own wallet back, not the platform total. Also fixes the
-- Credits/Debits split to match the real status strings: 'earn'/'referral'
-- rows use status='active', but 'spend' rows are always inserted with
-- status='spent' (see _vc_deduct(), migrations/20260626175953_*.sql) --
-- filtering spend on status='active' matched zero rows.
CREATE OR REPLACE FUNCTION public.admin_get_vc_aggregates()
RETURNS TABLE (circulation numeric, total_txns bigint, credits bigint, debits bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT coalesce(sum(balance), 0) FROM public.vents_wallets)::numeric AS circulation,
    (SELECT count(*) FROM public.vc_transactions)::bigint AS total_txns,
    (SELECT count(*) FROM public.vc_transactions WHERE type IN ('earn', 'referral') AND status = 'active')::bigint AS credits,
    (SELECT count(*) FROM public.vc_transactions WHERE type = 'spend' AND status = 'spent')::bigint AS debits;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_get_vc_aggregates() TO authenticated;
