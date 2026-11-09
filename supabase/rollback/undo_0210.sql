-- Undo 0210 (organizer referral connection + commission-split guard).
-- Removes only what 0210 added; no table, row or money is touched.
-- Refuses unless the operator confirms: SET vents.rollback_confirm = 'undo-0210';
DO $guard$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0210' THEN
    RAISE EXCEPTION 'undo_0210: set vents.rollback_confirm = ''undo-0210'' to confirm';
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS recruiter_partnerships_no_commission ON public.recruiter_partnerships;
DROP FUNCTION IF EXISTS public.recruiter_partnerships_no_commission();
DROP FUNCTION IF EXISTS public.get_representative_referral_preview(text);
DROP FUNCTION IF EXISTS public.get_my_representative_connection();
COMMENT ON COLUMN public.recruiter_partnerships.commission_split_bps IS
  'Retired 10% commission model. Historical value only; NULL for invitations made under the fixed representative reward (0201). Never read for money.';
