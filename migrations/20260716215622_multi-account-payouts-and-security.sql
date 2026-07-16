-- Multi-account vendor payouts + bank-mutation security gate.
--
-- Before: organizer_bank_accounts had a UNIQUE(organizer_id) — exactly ONE
-- bank account per organizer, written directly by the organizer (RLS ALL)
-- or via the forwarded-token upsert_organizer_bank_account RPC.
--
-- After: organizers may link MULTIPLE accounts with exactly one Default;
-- every add/edit/remove/set-default is funnelled through server endpoints
-- that re-confirm the organizer's password and rate-limit — so direct client
-- writes are revoked and the mutation RPCs are admin-key-only (project_admin).
-- Events gain an explicit payout_account_id, auto-defaulted at creation.

-- ── 1. Multi-account shape ──────────────────────────────────────────────
ALTER TABLE public.organizer_bank_accounts
  DROP CONSTRAINT IF EXISTS organizer_bank_accounts_organizer_id_key;

ALTER TABLE public.organizer_bank_accounts
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- No duplicate accounts per organizer (also the ON CONFLICT target for add).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_bank_account
  ON public.organizer_bank_accounts (organizer_id, account_number);

-- Backfill: each organizer currently has at most one account (old UNIQUE),
-- so promoting every existing row to default is safe and gives each
-- organizer exactly one default before the partial-unique index is created.
UPDATE public.organizer_bank_accounts SET is_default = true WHERE is_default = false;

-- At most ONE default per organizer, enforced in the database.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_default_bank
  ON public.organizer_bank_accounts (organizer_id) WHERE is_default;

-- ── 2. Security gate: revoke direct client writes ───────────────────────
-- Reads still flow through the existing org_bank_own / org_bank_admin_read
-- RLS policies. Writes may ONLY happen through the password-gated,
-- rate-limited server endpoints (which use the admin key), so a client can
-- never add/change/remove a payout destination without re-authenticating.
REVOKE INSERT, UPDATE, DELETE ON public.organizer_bank_accounts FROM authenticated, anon;
-- The old single-account upsert RPC ran as the caller (authenticated) and
-- would bypass the new gate — lock it down to admin-key callers only.
REVOKE EXECUTE ON FUNCTION public.upsert_organizer_bank_account(text, text, text, text, text) FROM authenticated, anon, public;

-- ── 3. Admin-key mutation RPCs (SECURITY DEFINER, project_admin only) ────
-- Each takes the organizer id explicitly (the endpoint passes the verified
-- session user) and is callable only by the admin key, so the password gate
-- in the endpoint can never be side-stepped via PostgREST.

CREATE OR REPLACE FUNCTION public.admin_add_bank_account(
  p_organizer_id uuid, p_bank_name text, p_bank_code text,
  p_account_number text, p_account_name text, p_recipient_code text
) RETURNS public.organizer_bank_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_row public.organizer_bank_accounts; v_has_default boolean;
BEGIN
  IF p_organizer_id IS NULL THEN RAISE EXCEPTION 'organizer required'; END IF;
  SELECT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                 WHERE organizer_id = p_organizer_id AND is_default) INTO v_has_default;
  INSERT INTO public.organizer_bank_accounts
    (organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_default, updated_at)
  VALUES
    (p_organizer_id, p_bank_name, p_bank_code, p_account_number, p_account_name, p_recipient_code, NOT v_has_default, now())
  ON CONFLICT (organizer_id, account_number) DO UPDATE SET
    bank_name = EXCLUDED.bank_name, bank_code = EXCLUDED.bank_code,
    account_name = EXCLUDED.account_name, recipient_code = EXCLUDED.recipient_code,
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_set_default_bank_account(p_organizer_id uuid, p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                 WHERE id = p_account_id AND organizer_id = p_organizer_id) THEN
    RAISE EXCEPTION 'Bank account not found';
  END IF;
  -- Clear the current default first so the partial-unique index never sees two.
  UPDATE public.organizer_bank_accounts SET is_default = false, updated_at = now()
  WHERE organizer_id = p_organizer_id AND is_default AND id <> p_account_id;
  UPDATE public.organizer_bank_accounts SET is_default = true, updated_at = now()
  WHERE id = p_account_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_remove_bank_account(p_organizer_id uuid, p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_was_default boolean; v_next uuid;
BEGIN
  SELECT is_default INTO v_was_default FROM public.organizer_bank_accounts
  WHERE id = p_account_id AND organizer_id = p_organizer_id;
  IF v_was_default IS NULL THEN RAISE EXCEPTION 'Bank account not found'; END IF;
  DELETE FROM public.organizer_bank_accounts WHERE id = p_account_id AND organizer_id = p_organizer_id;
  -- If we removed the default, promote the most recently added remaining one.
  IF v_was_default THEN
    SELECT id INTO v_next FROM public.organizer_bank_accounts
    WHERE organizer_id = p_organizer_id ORDER BY created_at DESC LIMIT 1;
    IF v_next IS NOT NULL THEN
      UPDATE public.organizer_bank_accounts SET is_default = true, updated_at = now() WHERE id = v_next;
    END IF;
  END IF;
END; $function$;

REVOKE ALL ON FUNCTION public.admin_add_bank_account(uuid, text, text, text, text, text) FROM public, authenticated, anon;
REVOKE ALL ON FUNCTION public.admin_set_default_bank_account(uuid, uuid) FROM public, authenticated, anon;
REVOKE ALL ON FUNCTION public.admin_remove_bank_account(uuid, uuid) FROM public, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.admin_add_bank_account(uuid, text, text, text, text, text) TO project_admin;
GRANT EXECUTE ON FUNCTION public.admin_set_default_bank_account(uuid, uuid) TO project_admin;
GRANT EXECUTE ON FUNCTION public.admin_remove_bank_account(uuid, uuid) TO project_admin;

-- ── 4. Event → payout account mapping ───────────────────────────────────
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS payout_account_id uuid
  REFERENCES public.organizer_bank_accounts(id) ON DELETE SET NULL;

-- Auto-populate with the organizer's default at creation; validate that any
-- explicitly chosen account actually belongs to the organizer (both on
-- insert and when the organizer later changes it).
CREATE OR REPLACE FUNCTION public.set_event_payout_account()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NEW.payout_account_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      SELECT id INTO NEW.payout_account_id FROM public.organizer_bank_accounts
      WHERE organizer_id = NEW.organizer_id AND is_default LIMIT 1;
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                   WHERE id = NEW.payout_account_id AND organizer_id = NEW.organizer_id) THEN
      RAISE EXCEPTION 'payout_account_id must be one of your own bank accounts';
    END IF;
  END IF;
  RETURN NEW;
END; $function$;

DROP TRIGGER IF EXISTS trg_event_payout_account ON public.events;
CREATE TRIGGER trg_event_payout_account
  BEFORE INSERT OR UPDATE OF payout_account_id ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_event_payout_account();

-- Backfill existing events with their organizer's default account.
UPDATE public.events e SET payout_account_id = b.id
FROM public.organizer_bank_accounts b
WHERE e.payout_account_id IS NULL AND b.organizer_id = e.organizer_id AND b.is_default;
