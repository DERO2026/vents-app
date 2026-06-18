-- The original referrals_insert WITH CHECK queried the referrals table directly
-- while RLS was active on it, causing infinite recursion.
-- Fix: use a SECURITY DEFINER function to count rows outside the RLS context.

DROP POLICY IF EXISTS referrals_insert ON public.referrals;

CREATE OR REPLACE FUNCTION public.referral_count_today(p_user_id uuid)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*) FROM public.referrals
  WHERE referrer_id = p_user_id
    AND created_at > now() - interval '24 hours';
$$;

REVOKE ALL ON FUNCTION public.referral_count_today(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.referral_count_today(uuid) TO authenticated;

CREATE POLICY referrals_insert ON public.referrals
  FOR INSERT
  WITH CHECK (
    referrer_id = (SELECT auth.uid())
    AND public.referral_count_today((SELECT auth.uid())) < 5
  );
