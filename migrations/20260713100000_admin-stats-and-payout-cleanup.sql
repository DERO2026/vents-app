-- Critical platform sweep: admin stats, toggles, VC metrics, test payouts.
--
-- 1. "New Users This Week/Month" counted every public.users row created in
--    the window, including abandoned/unconfirmed signups (public.users rows
--    are created by handle_new_user() the moment someone starts signup, well
--    before they confirm their email). Add an admin-only RPC that joins
--    auth.users.email_verified (the same source of truth already used by
--    public.is_email_verified() for wallet gating) so only completed
--    signups count as "new users."
CREATE OR REPLACE FUNCTION public.admin_get_new_user_stats()
RETURNS TABLE (new_this_week bigint, new_this_month bigint)
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
    count(*) FILTER (WHERE u.created_at >= now() - interval '7 days')::bigint AS new_this_week,
    count(*) FILTER (WHERE u.created_at >= now() - interval '30 days')::bigint AS new_this_month
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  WHERE coalesce(au.email_verified, false) = true;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_get_new_user_stats() TO authenticated;

-- 2. Location-sharing kill switch (Operational Controls follow-up — the
-- Block 17 sweep covered purchases/scanning/signups/payouts; DM location
-- sharing in ConversationScreen.tsx was the one client-side geolocation
-- entry point still ungated).
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS disable_location_sharing boolean NOT NULL DEFAULT false;

-- 3. Clear the stale "Total pending payout" balance the admin console has
-- been showing — every single row in organizer_withdrawal_requests belongs
-- to the 'testerboy' test organizer account, left in 'processing' from
-- pre-launch testing. Cancel the non-terminal ones so their amounts stop
-- counting toward the pending total (mirrors what admin_cancel_processing_payout
-- does for a real cancel — same status string, same resolved_by/admin_note
-- shape — just applied administratively instead of through the RPC since
-- there's no real approval decision being made here).
UPDATE public.organizer_withdrawal_requests w
SET status = 'cancelled',
    admin_note = 'Test payout request cleared during platform launch sweep',
    updated_at = now()
FROM public.users u
WHERE w.organizer_id = u.id
  AND u.username = 'testerboy'
  AND w.status IN ('pending', 'processing');
