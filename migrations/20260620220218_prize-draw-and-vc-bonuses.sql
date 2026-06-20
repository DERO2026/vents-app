-- prize_draw_entries
CREATE TABLE IF NOT EXISTS public.prize_draw_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  draw_month    TEXT NOT NULL,
  entry_number  INTEGER NOT NULL CHECK (entry_number BETWEEN 1 AND 3),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  vc_spent      INTEGER NOT NULL DEFAULT 500,
  UNIQUE(user_id, draw_month, entry_number)
);
ALTER TABLE public.prize_draw_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY pde_own ON public.prize_draw_entries FOR ALL USING (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT ON public.prize_draw_entries TO authenticated;

-- prize_draw_winners
CREATE TABLE IF NOT EXISTS public.prize_draw_winners (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.users(id),
  draw_month        TEXT NOT NULL UNIQUE,
  prize_description TEXT NOT NULL,
  drawn_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified          BOOLEAN NOT NULL DEFAULT false,
  delivered         BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE public.prize_draw_winners ENABLE ROW LEVEL SECURITY;
CREATE POLICY pdw_read ON public.prize_draw_winners FOR SELECT USING (true);
GRANT SELECT ON public.prize_draw_winners TO authenticated;

-- vc_bonuses
CREATE TABLE IF NOT EXISTS public.vc_bonuses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bonus_type  TEXT NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, bonus_type)
);
ALTER TABLE public.vc_bonuses ENABLE ROW LEVEL SECURITY;
CREATE POLICY vcb_own ON public.vc_bonuses FOR ALL USING (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT ON public.vc_bonuses TO authenticated;

-- check_and_clear_pending_vc: promotes referral VC after 14-day hold
-- and cancels VC where the triggering ticket was refunded
CREATE OR REPLACE FUNCTION public.check_and_clear_pending_vc()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  -- Activate pending VC where 14 days have passed and ticket not refunded
  UPDATE public.vc_transactions t
  SET status = 'active'
  WHERE t.user_id = v_uid
    AND t.status = 'pending'
    AND t.earned_at < now() - INTERVAL '14 days'
    AND (
      t.reference_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.tickets tk
        WHERE tk.id = t.reference_id
          AND tk.payment_status = 'refunded'
      )
    );

  -- Cancel pending VC where the triggering ticket was refunded
  UPDATE public.vc_transactions t
  SET status = 'cancelled'
  WHERE t.user_id = v_uid
    AND t.status = 'pending'
    AND EXISTS (
      SELECT 1 FROM public.tickets tk
      WHERE tk.id = t.reference_id
        AND tk.payment_status = 'refunded'
    );
END;
$$;
GRANT EXECUTE ON FUNCTION public.check_and_clear_pending_vc() TO authenticated;
