-- Expand vc_badge constraint to include platinum, elite, legend
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_vc_badge_check;

ALTER TABLE public.users ADD CONSTRAINT users_vc_badge_check
  CHECK (vc_badge = ANY (ARRAY['bronze','silver','gold','platinum','elite','legend']));

-- Also expand public_profiles view if it has a similar constraint
-- (public_profiles is typically a view so no constraint there, but update any functions)
