-- Re-grant EXECUTE on referral_count_today to ensure it's callable from
-- the INSERT RLS WITH CHECK policy.  Duplicate grants are harmless.
GRANT EXECUTE ON FUNCTION public.referral_count_today(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.referral_count_today(uuid) TO anon;
