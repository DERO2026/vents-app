-- 0215: VENTS-to-VENTS money transfers (spendable VENTS Wallet only).
--
-- What this adds, and nothing else:
--   * Two ledger types on the EXISTING spendable wallet ledger
--     (user_wallet_transactions): 'transfer_out' (sender) and 'transfer_in'
--     (recipient). No new wallet, no new balance.
--   * wallet_transfers: one immutable row per completed transfer (both
--     parties, amount, note, reference, idempotency key). It is the audit
--     record; clients never read or write it directly.
--   * transfer_wallet_funds(): the only way to move money between two
--     spendable wallets. One transaction: both wallet rows locked in a fixed
--     order, sender debited, recipient credited, two ledger rows with the
--     same reference, two notifications -- or nothing at all.
--   * find_wallet_transfer_recipient(): exact username lookup that returns
--     public profile fields only (never a balance, email or phone).
--   * get_my_wallet_transfer_status() / get_my_wallet_transfer(): limits,
--     today's usage and a receipt for a transfer the caller is party to.
--   * A kill switch, OFF by default: app_config.disable_wallet_transfers
--     defaults to TRUE, so applying this migration enables nothing. Only the
--     VENTS Admin can turn transfers on (admin_set_wallet_transfers_enabled).
--
-- Financial rules (unchanged elsewhere):
--   * Only the spendable VENTS Wallet (user_wallets) moves. Earnings
--     (organizer_wallets), VENTS Cents and pending settlement are untouched
--     and cannot be transferred.
--   * The spendable wallet stays never-withdrawable (no function debits it
--     towards a bank); received money is spendable on tickets and services
--     immediately and is not withdrawable.
--   * Authorization: the sender's existing 4-digit PIN (withdrawal_pin_check,
--     0211: wrong attempts counted and committed, lockout, reset-required),
--     a verified email, an active account at least 24 hours old, and no
--     PIN reset within 24 hours.
--   * Limits (wallet_transfer_policy): N100 to N200,000 per transfer,
--     N500,000 and 20 transfers per rolling 24 hours, 30 transfer attempts
--     and 60 recipient lookups per hour.
--   * Never to yourself, never to a suspended, banned or deleted account,
--     never to an ambiguous username.
--
-- Prerequisite: 0211 (withdrawal PIN). One transaction; idempotent.
-- Rollback: supabase/rollback/undo_0215.sql.

DO $pre$
BEGIN
  IF to_regprocedure('public.withdrawal_pin_check(uuid,text)') IS NULL THEN
    RAISE EXCEPTION '0215 requires 0211 (withdrawal_pin_check is missing)';
  END IF;
  IF to_regclass('public.user_wallets') IS NULL OR to_regclass('public.user_wallet_transactions') IS NULL THEN
    RAISE EXCEPTION '0215 requires the VENTS Wallet tables (0065)';
  END IF;
  IF to_regprocedure('public.withdrawal_naira(bigint)') IS NULL THEN
    RAISE EXCEPTION '0215 requires 0211 (withdrawal_naira is missing)';
  END IF;
  IF to_regprocedure('public.check_rate_limit(text,integer,integer)') IS NULL THEN
    RAISE EXCEPTION '0215 requires check_rate_limit';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Ledger types (additive: every existing type and row is unchanged)
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_wallet_transactions DROP CONSTRAINT IF EXISTS user_wallet_transactions_type_check;
ALTER TABLE public.user_wallet_transactions ADD CONSTRAINT user_wallet_transactions_type_check
  CHECK (type = ANY (ARRAY['deposit'::text, 'spend'::text, 'refund'::text, 'vc_conversion'::text,
                           'transfer_out'::text, 'transfer_in'::text]));
CREATE UNIQUE INDEX IF NOT EXISTS user_wallet_transactions_transfer_out_ref_idx
  ON public.user_wallet_transactions (reference_id) WHERE (type = 'transfer_out' AND reference_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS user_wallet_transactions_transfer_in_ref_idx
  ON public.user_wallet_transactions (reference_id) WHERE (type = 'transfer_in' AND reference_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 2. Kill switch (OFF by default)
-- ---------------------------------------------------------------------------
ALTER TABLE public.app_config ADD COLUMN IF NOT EXISTS disable_wallet_transfers boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.wallet_transfers_disabled()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE((SELECT disable_wallet_transfers FROM public.app_config LIMIT 1), true);
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_wallet_transfers_enabled(p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_root() THEN RAISE EXCEPTION 'VENTS Admin access required'; END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'p_enabled is required'; END IF;
  UPDATE public.app_config SET disable_wallet_transfers = NOT p_enabled;
  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'set_wallet_transfers_enabled', jsonb_build_object('enabled', p_enabled), public.actor_role());
  RETURN p_enabled;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Policy
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wallet_transfer_policy()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT jsonb_build_object(
    'min_kobo', 10000,                 -- N100
    'max_kobo', 20000000,              -- N200,000 per transfer
    'daily_kobo', 50000000,            -- N500,000 per rolling 24 hours
    'daily_count', 20,                 -- transfers per rolling 24 hours
    'min_account_age_hours', 24,
    'note_max_length', 140,
    'attempts_per_hour', 30,
    'lookups_per_hour', 60);
$function$;

-- ---------------------------------------------------------------------------
-- 4. The transfer record (immutable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_transfers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference              text NOT NULL UNIQUE,
  sender_id              uuid REFERENCES public.users(id) ON DELETE SET NULL,
  recipient_id           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  amount_kobo            bigint NOT NULL CHECK (amount_kobo > 0),
  note                   text,
  idempotency_key        text NOT NULL,
  sender_username        text,
  sender_name            text,
  recipient_username     text,
  recipient_name         text,
  status                 text NOT NULL DEFAULT 'completed' CHECK (status = 'completed'),
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- the original parties, kept even after an account is hard-deleted
  original_sender_id     uuid NOT NULL,
  original_recipient_id  uuid NOT NULL,
  CONSTRAINT wallet_transfers_not_self CHECK (original_sender_id <> original_recipient_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_transfers_sender_key_idx ON public.wallet_transfers (original_sender_id, idempotency_key);
CREATE INDEX IF NOT EXISTS wallet_transfers_sender_created_idx ON public.wallet_transfers (original_sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_transfers_recipient_created_idx ON public.wallet_transfers (original_recipient_id, created_at DESC);
ALTER TABLE public.wallet_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallet_transfers FROM PUBLIC, anon, authenticated;

-- Append-only: nothing may change a transfer, except the foreign keys'
-- own ON DELETE SET NULL when an account is hard-deleted.
CREATE OR REPLACE FUNCTION public.wallet_transfers_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Wallet transfers are an audit trail and cannot be deleted';
  END IF;
  IF (NEW.sender_id IS NOT DISTINCT FROM OLD.sender_id OR NEW.sender_id IS NULL)
     AND (NEW.recipient_id IS NOT DISTINCT FROM OLD.recipient_id OR NEW.recipient_id IS NULL)
     AND (to_jsonb(NEW) - 'sender_id' - 'recipient_id') = (to_jsonb(OLD) - 'sender_id' - 'recipient_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Wallet transfers are an audit trail and cannot be changed';
END;
$function$;
DROP TRIGGER IF EXISTS wallet_transfers_immutable ON public.wallet_transfers;
CREATE TRIGGER wallet_transfers_immutable BEFORE UPDATE OR DELETE ON public.wallet_transfers
  FOR EACH ROW EXECUTE FUNCTION public.wallet_transfers_immutable();

-- ---------------------------------------------------------------------------
-- 5. Who may send / receive
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wallet_transfer_account_ok(p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.id = p_user
       AND COALESCE(u.status, 'active') = 'active'
       AND u.deleted_at IS NULL
       AND (u.banned_until IS NULL OR u.banned_until <= now()));
$function$;

CREATE OR REPLACE FUNCTION public.wallet_display_name(p_user uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT COALESCE(NULLIF(btrim(u.full_name), ''), u.username, 'A VENTS user') FROM public.users u WHERE u.id = p_user;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Recipient lookup: one exact, unambiguous username; public fields only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_wallet_transfer_recipient(p_username text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_q text;
  v_n int;
  r record;
  pol jsonb := public.wallet_transfer_policy();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public.check_rate_limit('wallet_recipient_lookup:' || v_uid, (pol->>'lookups_per_hour')::int, 3600);
  v_q := lower(btrim(regexp_replace(COALESCE(p_username, ''), '^@', '')));
  IF v_q !~ '^[a-z0-9._]{2,40}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_username', 'message', 'Enter a VENTS username, like @ada');
  END IF;
  SELECT count(*) INTO v_n FROM public.users u WHERE lower(u.username) = v_q;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'No VENTS user has that username');
  END IF;
  IF v_n > 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ambiguous', 'message', 'More than one account matches that username. Ask them for their exact username');
  END IF;
  SELECT u.id, u.username, u.full_name, u.avatar_url, u.is_verified INTO r FROM public.users u WHERE lower(u.username) = v_q;
  IF r.id = v_uid THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self', 'message', 'That is your own username');
  END IF;
  IF NOT public.wallet_transfer_account_ok(r.id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'recipient_unavailable', 'message', 'This account cannot receive money');
  END IF;
  RETURN jsonb_build_object('ok', true, 'recipient', jsonb_build_object(
    'id', r.id, 'username', r.username, 'name', COALESCE(NULLIF(btrim(r.full_name), ''), r.username),
    'avatar_url', r.avatar_url, 'is_verified', COALESCE(r.is_verified, false)));
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Status for the Send screen
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_wallet_transfer_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  pol jsonb := public.wallet_transfer_policy();
  v_sent bigint;
  v_count int;
  u record;
  p record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT COALESCE(sum(t.amount_kobo), 0), count(*) INTO v_sent, v_count
    FROM public.wallet_transfers t
   WHERE t.original_sender_id = v_uid AND t.created_at > now() - interval '24 hours';
  SELECT username, created_at INTO u FROM public.users WHERE id = v_uid;
  SELECT (pin_hash IS NOT NULL) AS has_pin, must_reset, (locked_until > now()) AS locked, reset_at INTO p
    FROM public.withdrawal_pins WHERE user_id = v_uid;
  RETURN jsonb_build_object(
    'enabled', NOT public.wallet_transfers_disabled(),
    'username', u.username,
    'policy', pol,
    'sent_today_kobo', v_sent,
    'sent_today_count', v_count,
    'remaining_today_kobo', GREATEST((pol->>'daily_kobo')::bigint - v_sent, 0),
    'account_ok', public.wallet_transfer_account_ok(v_uid),
    'account_old_enough', COALESCE(u.created_at <= now() - make_interval(hours => (pol->>'min_account_age_hours')::int), false),
    'email_verified', public.is_email_verified(),
    'has_pin', COALESCE(p.has_pin, false),
    'pin_locked', COALESCE(p.locked, false) OR COALESCE(p.must_reset, false),
    'pin_paused_until', CASE WHEN p.reset_at + interval '24 hours' > now() THEN p.reset_at + interval '24 hours' END);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 8. The transfer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transfer_wallet_funds(p_recipient_id uuid, p_amount_kobo bigint, p_note text,
                                                        p_pin text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  pol jsonb := public.wallet_transfer_policy();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_note text;
  v_existing public.wallet_transfers;
  v_check jsonb;
  v_reset timestamptz;
  v_created timestamptz;
  v_sent bigint;
  v_count int;
  v_balance bigint;
  v_ref text;
  v_id uuid;
  s record;
  r record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_key !~ '^[A-Za-z0-9_-]{16,100}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bad_request', 'message', 'Missing transfer key. Refresh and try again');
  END IF;

  -- A retry of a transfer that already went through returns it; nothing moves again.
  SELECT * INTO v_existing FROM public.wallet_transfers WHERE original_sender_id = v_uid AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing.original_recipient_id IS DISTINCT FROM p_recipient_id OR v_existing.amount_kobo IS DISTINCT FROM p_amount_kobo THEN
      RETURN jsonb_build_object('ok', false, 'code', 'idempotency_conflict', 'message', 'This transfer key was already used for a different transfer');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'transfer_id', v_existing.id, 'reference', v_existing.reference,
                              'amount_kobo', v_existing.amount_kobo);
  END IF;

  IF public.wallet_transfers_disabled() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'transfers_disabled', 'message', 'Sending money is not available yet');
  END IF;
  PERFORM public.check_rate_limit('wallet_transfer:' || v_uid, (pol->>'attempts_per_hour')::int, 3600);

  IF p_amount_kobo IS NULL OR p_amount_kobo < (pol->>'min_kobo')::bigint THEN
    RETURN jsonb_build_object('ok', false, 'code', 'amount_too_small', 'message', 'The minimum transfer is ' || public.withdrawal_naira((pol->>'min_kobo')::bigint));
  END IF;
  IF p_amount_kobo > (pol->>'max_kobo')::bigint THEN
    RETURN jsonb_build_object('ok', false, 'code', 'amount_too_large', 'message', 'The maximum single transfer is ' || public.withdrawal_naira((pol->>'max_kobo')::bigint));
  END IF;
  v_note := NULLIF(btrim(regexp_replace(COALESCE(p_note, ''), '[[:cntrl:]]', ' ', 'g')), '');
  IF v_note IS NOT NULL AND length(v_note) > (pol->>'note_max_length')::int THEN
    RETURN jsonb_build_object('ok', false, 'code', 'note_too_long', 'message', 'Keep the note under ' || (pol->>'note_max_length') || ' characters');
  END IF;
  IF p_recipient_id IS NULL OR p_recipient_id = v_uid THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self', 'message', 'You cannot send money to yourself');
  END IF;
  IF NOT public.wallet_transfer_account_ok(v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'sender_unavailable', 'message', 'Your account cannot send money right now');
  END IF;
  IF NOT public.wallet_transfer_account_ok(p_recipient_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'recipient_unavailable', 'message', 'This account cannot receive money');
  END IF;
  IF NOT public.is_email_verified() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'email_not_verified', 'message', 'Verify your email before sending money');
  END IF;
  SELECT created_at INTO v_created FROM public.users WHERE id = v_uid;
  IF v_created IS NULL OR v_created > now() - make_interval(hours => (pol->>'min_account_age_hours')::int) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'account_too_new', 'message', 'New accounts can send money 24 hours after signing up');
  END IF;

  -- PIN (0211). A wrong PIN is counted and committed: return, never raise.
  v_check := public.withdrawal_pin_check(v_uid, p_pin);
  IF NOT COALESCE((v_check->>'ok')::boolean, false) THEN
    RETURN v_check || jsonb_build_object('message', CASE v_check->>'code'
      WHEN 'pin_not_set' THEN 'Create your 4-digit VENTS PIN (in Earnings) before sending money'
      WHEN 'wrong_pin' THEN v_check->>'message'
      WHEN 'pin_locked' THEN 'Too many wrong PINs. Sending money and withdrawals are locked for a while'
      ELSE 'Your PIN is locked after too many wrong attempts. Reset it with your password in Earnings' END);
  END IF;
  SELECT reset_at INTO v_reset FROM public.withdrawal_pins WHERE user_id = v_uid;
  IF v_reset + interval '24 hours' > now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pin_recently_reset', 'paused_until', v_reset + interval '24 hours',
                              'message', 'Your PIN was changed recently. For your security, sending money resumes 24 hours after the change');
  END IF;

  -- Lock both wallets in a fixed order (no deadlock between opposite transfers).
  INSERT INTO public.user_wallets (user_id) VALUES (v_uid), (p_recipient_id) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM public.user_wallets WHERE user_id IN (v_uid, p_recipient_id) ORDER BY user_id FOR UPDATE;

  -- Serialized per sender from here: re-check the key and today's totals.
  SELECT * INTO v_existing FROM public.wallet_transfers WHERE original_sender_id = v_uid AND idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing.original_recipient_id IS DISTINCT FROM p_recipient_id OR v_existing.amount_kobo IS DISTINCT FROM p_amount_kobo THEN
      RETURN jsonb_build_object('ok', false, 'code', 'idempotency_conflict', 'message', 'This transfer key was already used for a different transfer');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'transfer_id', v_existing.id, 'reference', v_existing.reference,
                              'amount_kobo', v_existing.amount_kobo);
  END IF;
  SELECT COALESCE(sum(t.amount_kobo), 0), count(*) INTO v_sent, v_count
    FROM public.wallet_transfers t WHERE t.original_sender_id = v_uid AND t.created_at > now() - interval '24 hours';
  IF v_count >= (pol->>'daily_count')::int THEN
    RETURN jsonb_build_object('ok', false, 'code', 'daily_count_limit', 'message', 'You have reached today''s limit of ' || (pol->>'daily_count') || ' transfers');
  END IF;
  IF v_sent + p_amount_kobo > (pol->>'daily_kobo')::bigint THEN
    RETURN jsonb_build_object('ok', false, 'code', 'daily_amount_limit', 'remaining_kobo', GREATEST((pol->>'daily_kobo')::bigint - v_sent, 0),
                              'message', 'This would exceed your daily sending limit of ' || public.withdrawal_naira((pol->>'daily_kobo')::bigint));
  END IF;
  SELECT balance_kobo INTO v_balance FROM public.user_wallets WHERE user_id = v_uid;
  IF v_balance < p_amount_kobo THEN
    RETURN jsonb_build_object('ok', false, 'code', 'insufficient_funds', 'balance_kobo', v_balance,
                              'message', 'Not enough money in your VENTS Wallet');
  END IF;

  SELECT u.username, public.wallet_display_name(u.id) AS name INTO s FROM public.users u WHERE u.id = v_uid;
  SELECT u.username, public.wallet_display_name(u.id) AS name INTO r FROM public.users u WHERE u.id = p_recipient_id;
  v_ref := 'VT' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 14));

  INSERT INTO public.wallet_transfers (reference, sender_id, recipient_id, amount_kobo, note, idempotency_key,
                                       sender_username, sender_name, recipient_username, recipient_name,
                                       original_sender_id, original_recipient_id)
  VALUES (v_ref, v_uid, p_recipient_id, p_amount_kobo, v_note, v_key, s.username, s.name, r.username, r.name, v_uid, p_recipient_id)
  RETURNING id INTO v_id;

  UPDATE public.user_wallets SET balance_kobo = balance_kobo - p_amount_kobo, updated_at = now() WHERE user_id = v_uid;
  UPDATE public.user_wallets SET balance_kobo = balance_kobo + p_amount_kobo, updated_at = now() WHERE user_id = p_recipient_id;

  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id, metadata)
  VALUES
    (v_uid, 'transfer_out', p_amount_kobo, 'Sent to ' || COALESCE('@' || r.username, r.name), v_ref,
     jsonb_build_object('transfer_id', v_id, 'direction', 'out', 'counterparty_id', p_recipient_id,
                        'counterparty_username', r.username, 'counterparty_name', r.name, 'note', v_note)),
    (p_recipient_id, 'transfer_in', p_amount_kobo, 'Received from ' || COALESCE('@' || s.username, s.name), v_ref,
     jsonb_build_object('transfer_id', v_id, 'direction', 'in', 'counterparty_id', v_uid,
                        'counterparty_username', s.username, 'counterparty_name', s.name, 'note', v_note));

  -- Same transaction: these exist only if the transfer commits.
  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES
    (v_uid, 'sale', 'Money sent',
     'You sent ' || public.withdrawal_naira(p_amount_kobo) || ' to ' || COALESCE('@' || r.username, r.name) || '. Ref ' || v_ref,
     false, 'wallet', jsonb_build_object('screen', 'customer-wallet', 'type', 'wallet_transfer', 'reference', v_ref)),
    (p_recipient_id, 'sale', 'Money received',
     COALESCE('@' || s.username, s.name) || ' sent you ' || public.withdrawal_naira(p_amount_kobo) || '. It is in your VENTS Wallet. Ref ' || v_ref,
     false, 'wallet', jsonb_build_object('screen', 'customer-wallet', 'type', 'wallet_transfer', 'reference', v_ref));

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'transfer_id', v_id, 'reference', v_ref,
                            'amount_kobo', p_amount_kobo, 'balance_kobo', v_balance - p_amount_kobo);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Receipt (parties only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_wallet_transfer(p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  t public.wallet_transfers;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO t FROM public.wallet_transfers WHERE reference = p_reference
     AND (original_sender_id = v_uid OR original_recipient_id = v_uid);
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('reference', t.reference, 'status', t.status, 'amount_kobo', t.amount_kobo, 'note', t.note,
    'created_at', t.created_at, 'direction', CASE WHEN t.original_sender_id = v_uid THEN 'out' ELSE 'in' END,
    'sender', jsonb_build_object('username', t.sender_username, 'name', t.sender_name),
    'recipient', jsonb_build_object('username', t.recipient_username, 'name', t.recipient_name));
END;
$function$;

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.wallet_transfers_disabled(), public.wallet_transfer_policy(),
  public.wallet_transfer_account_ok(uuid), public.wallet_display_name(uuid), public.wallet_transfers_immutable()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.find_wallet_transfer_recipient(text), public.get_my_wallet_transfer_status(),
  public.transfer_wallet_funds(uuid, bigint, text, text, text), public.get_my_wallet_transfer(text),
  public.admin_set_wallet_transfers_enabled(boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_wallet_transfer_recipient(text), public.get_my_wallet_transfer_status(),
  public.transfer_wallet_funds(uuid, bigint, text, text, text), public.get_my_wallet_transfer(text),
  public.admin_set_wallet_transfers_enabled(boolean)
  TO authenticated;

DO $post$
BEGIN
  -- Applying (or re-applying) never enables transfers; only the VENTS Admin does.
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'app_config' AND column_name = 'disable_wallet_transfers') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION '0215: app_config.disable_wallet_transfers must default to true (transfers off)';
  END IF;
  IF has_table_privilege('authenticated', 'public.wallet_transfers', 'SELECT')
     OR has_table_privilege('authenticated', 'public.wallet_transfers', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_wallets', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.user_wallet_transactions', 'INSERT') THEN
    RAISE EXCEPTION '0215: a client role can write wallet money or read transfers directly';
  END IF;
  IF has_function_privilege('anon', 'public.transfer_wallet_funds(uuid,bigint,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0215: anon can execute transfer_wallet_funds';
  END IF;
END
$post$;
