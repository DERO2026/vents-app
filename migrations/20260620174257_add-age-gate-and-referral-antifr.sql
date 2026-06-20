-- ── Item 7: Age gate ──────────────────────────────────────────────────────────
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS date_of_birth DATE;

-- ── Item 9: Referral anti-fraud ───────────────────────────────────────────────

-- 1. Device fingerprints table
CREATE TABLE IF NOT EXISTS public.device_fingerprints (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.device_fingerprints ENABLE ROW LEVEL SECURITY;
CREATE POLICY dp_own ON public.device_fingerprints
  FOR ALL USING (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT ON public.device_fingerprints TO authenticated;
CREATE UNIQUE INDEX IF NOT EXISTS dp_user_fp ON public.device_fingerprints(user_id, fingerprint);

-- 2. Referred email hashes (global dedup)
CREATE TABLE IF NOT EXISTS public.referred_emails (
  email_hash   TEXT PRIMARY KEY,
  referrer_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.referred_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY re_read   ON public.referred_emails FOR SELECT USING (true);
CREATE POLICY re_insert ON public.referred_emails FOR INSERT
  WITH CHECK (referrer_id = (SELECT auth.uid()));
GRANT SELECT, INSERT ON public.referred_emails TO authenticated;

-- 3. 14-day pending hold: pending_until is created_at + 14 days, stored as regular column
-- (generated columns on TIMESTAMPTZ are not immutable in PostgreSQL — using trigger instead)
ALTER TABLE public.referrals ADD COLUMN IF NOT EXISTS pending_until TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.set_referral_pending_until()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.pending_until := NEW.created_at + INTERVAL '14 days';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_pending_until ON public.referrals;
CREATE TRIGGER trg_referral_pending_until
  BEFORE INSERT ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION public.set_referral_pending_until();

-- 4. SECURITY DEFINER referral creation with all anti-fraud checks
CREATE OR REPLACE FUNCTION public.create_referral(
  p_invitee_email TEXT,
  p_email_hash    TEXT,
  p_fingerprint   TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_total    INT;
  v_recent   INT;
BEGIN
  -- Hard cap: max 20 referrals total
  SELECT COUNT(*) INTO v_total FROM referrals WHERE referrer_id = v_uid;
  IF v_total >= 20 THEN RETURN 'limit_reached'; END IF;

  -- Velocity cap: max 3 per 24h
  SELECT COUNT(*) INTO v_recent
  FROM referrals
  WHERE referrer_id = v_uid AND created_at > now() - INTERVAL '24 hours';
  IF v_recent >= 3 THEN RETURN 'velocity_cap'; END IF;

  -- Register device fingerprint (upsert — doesn't block, just tracks)
  IF p_fingerprint IS NOT NULL AND p_fingerprint != '' THEN
    INSERT INTO device_fingerprints(user_id, fingerprint)
    VALUES (v_uid, p_fingerprint)
    ON CONFLICT (user_id, fingerprint) DO NOTHING;
  END IF;

  -- Email hash uniqueness (any referrer)
  IF p_email_hash IS NOT NULL AND p_email_hash != '' THEN
    IF EXISTS (SELECT 1 FROM referred_emails WHERE email_hash = p_email_hash) THEN
      RETURN 'already_referred';
    END IF;
    INSERT INTO referred_emails(email_hash, referrer_id) VALUES (p_email_hash, v_uid);
  END IF;

  -- Create the referral in pending state
  INSERT INTO referrals(referrer_id, invitee_email, status)
  VALUES (v_uid, p_invitee_email, 'pending');

  RETURN NULL; -- NULL = success
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_referral(TEXT, TEXT, TEXT) TO authenticated;

-- 5. Ensure referrals SELECT policy exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'referrals' AND policyname = 'referrals_select'
  ) THEN
    EXECUTE 'CREATE POLICY referrals_select ON public.referrals FOR SELECT USING (referrer_id = (SELECT auth.uid()))';
  END IF;
END $$;
