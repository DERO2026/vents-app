-- vc_badge column on users table
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS vc_badge TEXT DEFAULT NULL
  CHECK (vc_badge IN ('bronze', 'silver', 'gold'));

-- vc_featured_until on users (for Featured in People)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS vc_featured_until TIMESTAMPTZ DEFAULT NULL;

-- vc_event_boost table for event boosts purchased with VC
CREATE TABLE IF NOT EXISTS public.vc_event_boosts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  boosted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '3 days'),
  UNIQUE(event_id, user_id)
);
ALTER TABLE public.vc_event_boosts ENABLE ROW LEVEL SECURITY;
CREATE POLICY vceb_own ON public.vc_event_boosts FOR ALL USING (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT ON public.vc_event_boosts TO authenticated;

-- Helper: deduct VC from user; raises exception if insufficient balance
CREATE OR REPLACE FUNCTION public._vc_deduct(p_user_id uuid, p_amount integer, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_balance integer;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_balance
  FROM vc_transactions
  WHERE user_id = p_user_id AND status = 'active';

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient Vents Cents balance';
  END IF;

  INSERT INTO vc_transactions (user_id, amount, type, status, earned_at)
  VALUES (p_user_id, p_amount, 'spend', 'spent', now());
END;
$$;
GRANT EXECUTE ON FUNCTION public._vc_deduct(uuid, integer, text) TO authenticated;

-- enter_prize_draw: cost 500 VC, max 3 entries per month
CREATE OR REPLACE FUNCTION public.enter_prize_draw(p_month text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_month    text := COALESCE(p_month, to_char(now(), 'YYYY-MM'));
  v_count    integer;
  v_next_num integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT COUNT(*) INTO v_count
  FROM prize_draw_entries
  WHERE user_id = v_uid AND draw_month = v_month;

  IF v_count >= 3 THEN
    RAISE EXCEPTION 'Maximum 3 entries per month reached';
  END IF;

  v_next_num := v_count + 1;

  -- Deduct 500 VC
  PERFORM _vc_deduct(v_uid, 500, 'Prize draw entry');

  INSERT INTO prize_draw_entries (user_id, draw_month, entry_number, vc_spent)
  VALUES (v_uid, v_month, v_next_num, 500);

  RETURN jsonb_build_object('entry_number', v_next_num, 'entries_this_month', v_next_num);
END;
$$;
GRANT EXECUTE ON FUNCTION public.enter_prize_draw(text) TO authenticated;

-- purchase_badge: bronze=300, silver=800, gold=2000
CREATE OR REPLACE FUNCTION public.purchase_badge(p_badge_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_cost integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF p_badge_type NOT IN ('bronze', 'silver', 'gold') THEN
    RAISE EXCEPTION 'Invalid badge type';
  END IF;

  v_cost := CASE p_badge_type
    WHEN 'bronze' THEN 300
    WHEN 'silver' THEN 800
    WHEN 'gold'   THEN 2000
    ELSE 0
  END;

  -- Downgrade check: can upgrade but not downgrade
  IF EXISTS (
    SELECT 1 FROM users WHERE id = v_uid AND vc_badge IS NOT NULL AND (
      (p_badge_type = 'bronze' AND vc_badge IN ('silver','gold')) OR
      (p_badge_type = 'silver' AND vc_badge = 'gold')
    )
  ) THEN
    RAISE EXCEPTION 'Cannot downgrade badge';
  END IF;

  PERFORM _vc_deduct(v_uid, v_cost, 'Badge: ' || p_badge_type);

  UPDATE users SET vc_badge = p_badge_type WHERE id = v_uid;

  INSERT INTO vc_bonuses (user_id, bonus_type) VALUES (v_uid, 'badge_' || p_badge_type)
  ON CONFLICT (user_id, bonus_type) DO UPDATE SET granted_at = now();
END;
$$;
GRANT EXECUTE ON FUNCTION public.purchase_badge(text) TO authenticated;

-- feature_in_people_vc: 1500 VC for 3 days of Featured in People
CREATE OR REPLACE FUNCTION public.feature_in_people_vc()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  PERFORM _vc_deduct(v_uid, 1500, 'Featured in People (3 days)');

  UPDATE users
  SET vc_featured_until = GREATEST(COALESCE(vc_featured_until, now()), now()) + INTERVAL '3 days'
  WHERE id = v_uid;
END;
$$;
GRANT EXECUTE ON FUNCTION public.feature_in_people_vc() TO authenticated;

-- boost_event_vc: 1000 VC for event boost (3 days)
CREATE OR REPLACE FUNCTION public.boost_event_vc(p_event_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- Verify user owns this event
  IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id AND organizer_id = v_uid) THEN
    RAISE EXCEPTION 'Event not found or not yours';
  END IF;

  PERFORM _vc_deduct(v_uid, 1000, 'Event boost (3 days)');

  INSERT INTO vc_event_boosts (event_id, user_id, expires_at)
  VALUES (p_event_id, v_uid, now() + INTERVAL '3 days')
  ON CONFLICT (event_id, user_id) DO UPDATE
  SET expires_at = GREATEST(vc_event_boosts.expires_at, now()) + INTERVAL '3 days',
      boosted_at = now();
END;
$$;
GRANT EXECUTE ON FUNCTION public.boost_event_vc(uuid) TO authenticated;

-- admin_pick_draw_winner: inserts into prize_draw_winners (admin only)
CREATE OR REPLACE FUNCTION public.admin_pick_draw_winner(
  p_month            text,
  p_user_id          uuid,
  p_prize_description text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_caller AND role = 'admin') THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  INSERT INTO prize_draw_winners (user_id, draw_month, prize_description)
  VALUES (p_user_id, p_month, p_prize_description)
  ON CONFLICT (draw_month) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      prize_description = EXCLUDED.prize_description,
      drawn_at = now();
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_pick_draw_winner(text, uuid, text) TO authenticated;

-- admin_mark_winner_delivered
CREATE OR REPLACE FUNCTION public.admin_mark_winner_delivered(p_draw_month text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_caller AND role = 'admin') THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  UPDATE prize_draw_winners SET delivered = true WHERE draw_month = p_draw_month;
END;
$$;
GRANT EXECUTE ON FUNCTION public.admin_mark_winner_delivered(text) TO authenticated;
