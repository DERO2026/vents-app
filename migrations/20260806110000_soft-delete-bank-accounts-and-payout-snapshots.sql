-- Fixes: "update or delete on table organizer_bank_accounts violates foreign
-- key constraint organizer_withdrawal_requests_bank_account_id_fkey" —
-- remove_bank_account_confirmed() (migrations/20260716220638) does a hard
-- DELETE, which fails outright the moment an organizer has ANY withdrawal
-- history pointing at that account (confdeltype was 'a' / NO ACTION, i.e.
-- no ON DELETE clause at all). is_default already exists from
-- 20260716215622_multi-account-payouts-and-security.sql — this migration
-- adds the missing pieces: is_active (soft delete), payout-history
-- snapshot columns (so a removed/edited bank account never rewrites what a
-- past payout actually went to), a real ON DELETE SET NULL on the FK as a
-- backstop, and a hard cap of 3 accounts per organizer.

-- ── 1. Soft-delete flag ──────────────────────────────────────────────────
ALTER TABLE public.organizer_bank_accounts
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Existing rows are all currently "live" from the app's perspective.
UPDATE public.organizer_bank_accounts SET is_active = true WHERE is_active IS DISTINCT FROM true;

-- The is_default partial-unique index only needs to ever hold for ACTIVE
-- accounts — a soft-deleted row must never block a new default from being
-- set. Recreate it scoped to is_active.
DROP INDEX IF EXISTS public.uniq_org_default_bank;
CREATE UNIQUE INDEX uniq_org_default_bank
  ON public.organizer_bank_accounts (organizer_id) WHERE is_default AND is_active;

-- ── 2. Payout-history snapshot columns ───────────────────────────────────
-- A withdrawal_requests row previously only carried a bank_account_id FK —
-- if that account was later edited (bank_name/account_number changed via
-- the same add_bank_account_confirmed upsert) or removed, historical
-- payout records would silently reflect the CURRENT state of the account,
-- not what the money actually went to at the time. These columns freeze
-- that at request time.
ALTER TABLE public.organizer_withdrawal_requests
  ADD COLUMN IF NOT EXISTS bank_name      text,
  ADD COLUMN IF NOT EXISTS bank_code      text,
  ADD COLUMN IF NOT EXISTS account_number text,
  ADD COLUMN IF NOT EXISTS account_name   text;

-- Backfill existing rows from whatever their linked account currently
-- holds — best-effort, since that's the only data available for history
-- predating this migration (some may already have been edited since).
UPDATE public.organizer_withdrawal_requests w
   SET bank_name      = b.bank_name,
       bank_code      = b.bank_code,
       account_number = b.account_number,
       account_name   = b.account_name
  FROM public.organizer_bank_accounts b
 WHERE w.bank_account_id = b.id
   AND w.bank_name IS NULL;

-- ── 3. FK backstop ────────────────────────────────────────────────────────
-- Now that every request snapshots its own bank details independently, the
-- FK no longer needs to protect against "losing" the payout destination on
-- delete — ON DELETE SET NULL is safe (and correct: with soft-delete as the
-- normal path below, this only ever fires if a row is removed by some other
-- means, e.g. a manual admin cleanup).
ALTER TABLE public.organizer_withdrawal_requests
  DROP CONSTRAINT IF EXISTS organizer_withdrawal_requests_bank_account_id_fkey;
ALTER TABLE public.organizer_withdrawal_requests
  ADD CONSTRAINT organizer_withdrawal_requests_bank_account_id_fkey
  FOREIGN KEY (bank_account_id) REFERENCES public.organizer_bank_accounts(id) ON DELETE SET NULL;

-- ── 4. request_organizer_payout: snapshot at request time ────────────────
-- Same body as the latest version (20260710171452_gate-wallet-on-email-
-- verification.sql) with the four snapshot columns added to the INSERT,
-- pulled from the account row being charged right now — everything else
-- (balance lock, email-verification gate, insufficient-balance check) is
-- unchanged.
CREATE OR REPLACE FUNCTION public.request_organizer_payout(
  p_amount_kobo     bigint,
  p_bank_account_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_organizer_id uuid := auth.uid();
  v_balance      bigint;
  v_request_id   uuid;
  v_account      public.organizer_bank_accounts;
BEGIN
  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before requesting a withdrawal';
  END IF;

  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;

  SELECT * INTO v_account FROM public.organizer_bank_accounts
  WHERE id = p_bank_account_id AND organizer_id = v_organizer_id
    AND is_active AND recipient_code IS NOT NULL;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Bank account not verified';
  END IF;

  SELECT balance_kobo INTO v_balance
  FROM public.organizer_wallets
  WHERE organizer_id = v_organizer_id
  FOR UPDATE;

  IF v_balance IS NULL OR v_balance < p_amount_kobo THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo - p_amount_kobo,
      pending_kobo = pending_kobo + p_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_withdrawal_requests
    (organizer_id, amount_kobo, bank_account_id, status, bank_name, bank_code, account_number, account_name)
  VALUES
    (v_organizer_id, p_amount_kobo, p_bank_account_id, 'pending',
     v_account.bank_name, v_account.bank_code, v_account.account_number, v_account.account_name)
  RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$function$;

-- ── 5. Bank-mutation RPCs: max 3 accounts, soft delete, reactivate-on-re-add ──
-- Same "assert_recent_auth() + auth.uid()-only" security model as
-- 20260716220638_bank-mutation-confirmed-rpcs.sql — only the bodies change.

CREATE OR REPLACE FUNCTION public.add_bank_account_confirmed(
  p_bank_name text, p_bank_code text, p_account_number text,
  p_account_name text, p_recipient_code text
) RETURNS public.organizer_bank_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.organizer_bank_accounts;
  v_existing public.organizer_bank_accounts;
  v_active_count integer;
  v_has_default boolean;
BEGIN
  PERFORM public.assert_recent_auth();
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid AND email_verified) THEN
    RAISE EXCEPTION 'Please verify your email first';
  END IF;

  SELECT * INTO v_existing FROM public.organizer_bank_accounts
  WHERE organizer_id = v_uid AND account_number = p_account_number;

  -- Editing an already-active account, or reactivating a soft-deleted one
  -- with the same account number, is never blocked by the 3-account cap —
  -- the cap only applies to genuinely NEW active accounts.
  IF v_existing IS NULL OR NOT v_existing.is_active THEN
    SELECT count(*) INTO v_active_count FROM public.organizer_bank_accounts
    WHERE organizer_id = v_uid AND is_active;
    IF v_active_count >= 3 THEN
      RAISE EXCEPTION 'You can link at most 3 bank accounts. Remove one before adding another.';
    END IF;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                 WHERE organizer_id = v_uid AND is_default AND is_active) INTO v_has_default;

  INSERT INTO public.organizer_bank_accounts
    (organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_default, is_active, updated_at)
  VALUES
    (v_uid, p_bank_name, p_bank_code, p_account_number, p_account_name, p_recipient_code, NOT v_has_default, true, now())
  ON CONFLICT (organizer_id, account_number) DO UPDATE SET
    bank_name = EXCLUDED.bank_name, bank_code = EXCLUDED.bank_code,
    account_name = EXCLUDED.account_name, recipient_code = EXCLUDED.recipient_code,
    -- Re-adding a previously-removed account brings it back as active; if
    -- the organizer currently has no active default at all (e.g. this was
    -- their only account), make it the default again.
    is_active = true,
    is_default = organizer_bank_accounts.is_default OR NOT v_has_default,
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END; $function$;

CREATE OR REPLACE FUNCTION public.set_default_bank_account_confirmed(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  PERFORM public.assert_recent_auth();
  IF NOT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                 WHERE id = p_account_id AND organizer_id = v_uid AND is_active) THEN
    RAISE EXCEPTION 'Bank account not found';
  END IF;
  UPDATE public.organizer_bank_accounts SET is_default = false, updated_at = now()
  WHERE organizer_id = v_uid AND is_default AND id <> p_account_id;
  UPDATE public.organizer_bank_accounts SET is_default = true, updated_at = now()
  WHERE id = p_account_id;
END; $function$;

-- Soft delete — this is the actual fix for the FK-violation report. Never
-- DELETEs the row (so every past organizer_withdrawal_requests.bank_account_id
-- stays valid, though it no longer needs to since #4 snapshots the details
-- independently), just flips is_active/is_default off and, if the removed
-- account was the default, promotes another active one and reassigns any
-- events still pointed at the removed account to the new default (mirrors
-- the auto-default behavior new events already get from
-- trg_event_payout_account).
CREATE OR REPLACE FUNCTION public.remove_bank_account_confirmed(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_was_default boolean; v_next uuid;
BEGIN
  PERFORM public.assert_recent_auth();
  SELECT is_default INTO v_was_default FROM public.organizer_bank_accounts
  WHERE id = p_account_id AND organizer_id = v_uid AND is_active;
  IF v_was_default IS NULL THEN RAISE EXCEPTION 'Bank account not found'; END IF;

  UPDATE public.organizer_bank_accounts
  SET is_active = false, is_default = false, updated_at = now()
  WHERE id = p_account_id AND organizer_id = v_uid;

  IF v_was_default THEN
    SELECT id INTO v_next FROM public.organizer_bank_accounts
    WHERE organizer_id = v_uid AND is_active ORDER BY created_at DESC LIMIT 1;
    IF v_next IS NOT NULL THEN
      UPDATE public.organizer_bank_accounts SET is_default = true, updated_at = now() WHERE id = v_next;
    END IF;
    UPDATE public.events SET payout_account_id = v_next
    WHERE organizer_id = v_uid AND payout_account_id = p_account_id;
  END IF;
END; $function$;

-- ── 6. Event → payout account trigger: respect is_active ─────────────────
-- Unchanged logic otherwise (migrations/20260716215622) — only added the
-- is_active filter so a new event can't auto-default to, or be manually
-- set to, a soft-deleted account.
CREATE OR REPLACE FUNCTION public.set_event_payout_account()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NEW.payout_account_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      SELECT id INTO NEW.payout_account_id FROM public.organizer_bank_accounts
      WHERE organizer_id = NEW.organizer_id AND is_default AND is_active LIMIT 1;
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                   WHERE id = NEW.payout_account_id AND organizer_id = NEW.organizer_id AND is_active) THEN
      RAISE EXCEPTION 'payout_account_id must be one of your own active bank accounts';
    END IF;
  END IF;
  RETURN NEW;
END; $function$;

REVOKE ALL ON FUNCTION public.add_bank_account_confirmed(text, text, text, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.set_default_bank_account_confirmed(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.remove_bank_account_confirmed(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.add_bank_account_confirmed(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_default_bank_account_confirmed(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_bank_account_confirmed(uuid) TO authenticated;
