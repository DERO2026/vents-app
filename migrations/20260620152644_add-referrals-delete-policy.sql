-- Allow users to delete only their own pending referrals
CREATE POLICY referrals_delete ON public.referrals
  FOR DELETE
  USING (referrer_id = (SELECT auth.uid()));
