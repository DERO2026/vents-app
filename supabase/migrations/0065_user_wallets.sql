-- Universal VENTS customer Wallet -- foundation + deposit flow only (no
-- spend-at-checkout wiring yet, per explicit instruction; that's a
-- separate, later pass once this foundation is independently verified).
--
-- Deliberately a THIRD, fully separate system from the two that already
-- exist and are untouched by this migration:
--   - organizer_wallets / organizer_transactions: real-money EARNINGS for
--     organizers and service providers, withdrawable via the existing
--     bank-transfer payout flow (WalletScreen.tsx). Not touched here.
--   - vents_wallets / vc_transactions: VENTS Cents, a non-cash loyalty-
--     points ledger spendable only on app features (event boosts, profile
--     badges), never real money, never withdrawable. Not touched here.
--
-- user_wallets is a customer-facing NGN cash balance: deposit-funded,
-- spendable (once checkout is wired in a later pass), and by design has
-- NO withdrawal path anywhere -- no function in this migration ever moves
-- money OUT of a user_wallets row, only in (deposit) or, later, out via
-- spend/refund against a purchase (never to a bank account).

-- ---------------------------------------------------------------------
-- Table: user_wallets -- one row per user, lazily created on first access
-- (get_my_wallet below) rather than via a signup trigger, so this never
-- touches the existing on_auth_user_created provisioning path. Every real
-- user ends up with a row the first time they open the Wallet screen or
-- any wallet RPC runs for them -- functionally "every user has a wallet"
-- without any signup-flow risk.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_wallets (
  user_id uuid NOT NULL,
  balance_kobo bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_wallets_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  -- Structural guarantee, independent of any application-level check: no
  -- write to this table, from any function written now or later, can ever
  -- leave a negative balance.
  CONSTRAINT user_wallets_balance_non_negative CHECK (balance_kobo >= 0)
);

ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;

-- Own-row read only. No INSERT/UPDATE/DELETE policy for anon/authenticated
-- at all -- every balance mutation must go through a SECURITY DEFINER
-- function (which runs as the function owner, bypassing RLS, the same
-- mechanism already proven throughout this schema).
CREATE POLICY user_wallets_own_read ON public.user_wallets FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Table-level grant is SELECT only -- RLS above is the real gate (an own-
-- row policy with no write policy already blocks writes even if a broader
-- grant existed), but matching the grant to what's actually allowed keeps
-- this table's privilege surface unambiguous at a glance.
GRANT SELECT ON public.user_wallets TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_wallets TO project_admin;

-- ---------------------------------------------------------------------
-- Table: user_wallet_transactions -- append-only ledger. Every balance
-- change, in either direction, must have exactly one row here -- designed
-- from day one to represent deposit -> spend -> refund, even though only
-- 'deposit' is actually produced by any function in this migration.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_wallet_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL,
  amount_kobo bigint NOT NULL,
  description text,
  reference_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_wallet_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT user_wallet_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT user_wallet_transactions_type_check CHECK (type = ANY (ARRAY['deposit'::text, 'spend'::text, 'refund'::text])),
  -- A ledger row's amount is always the magnitude of the change; direction
  -- comes from `type`, never a signed amount -- avoids the classic
  -- sign-flip bug where a spend accidentally credits instead of debits.
  CONSTRAINT user_wallet_transactions_amount_positive CHECK (amount_kobo > 0)
);

CREATE INDEX IF NOT EXISTS idx_user_wallet_transactions_user_id
  ON public.user_wallet_transactions (user_id, created_at DESC);

-- Idempotency guard for deposits: at most one 'deposit' ledger row per
-- Paystack reference, ever. confirm_wallet_deposit below relies on this
-- exact index (via ON CONFLICT) to make a duplicate webhook/client-verify
-- call for the same reference a guaranteed no-op instead of a double
-- credit. Partial (only 'deposit' rows) so a future 'spend'/'refund' row
-- sharing a different kind of reference_id (e.g. a booking id) is never
-- constrained by this.
CREATE UNIQUE INDEX IF NOT EXISTS user_wallet_transactions_deposit_ref_idx
  ON public.user_wallet_transactions (reference_id)
  WHERE (type = 'deposit' AND reference_id IS NOT NULL);

ALTER TABLE public.user_wallet_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_wallet_transactions_own_read ON public.user_wallet_transactions FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

GRANT SELECT ON public.user_wallet_transactions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_wallet_transactions TO project_admin;

-- ---------------------------------------------------------------------
-- Table: wallet_deposit_attempts -- maps a Paystack reference to the user
-- who initiated it, exactly like ticket_payment_attempts/get_pending_
-- purchase_owner (0060) and ticket_transfers.fee_payment_ref/get_transfer_
-- fee_payment_owner (0043) already do for their own payment flows.
-- api/webhook/paystack.ts (no user JWT/RLS context of its own, running
-- over the project_admin Postgres connection) needs this to confirm the
-- authenticated caller who hit ?action=verify is actually the person who
-- started this deposit, before ever calling Paystack's verify API on
-- their say-so.
--
-- amount_kobo is the intended deposit amount, locked in here at initiate
-- time -- confirm_wallet_deposit below reconciles Paystack's verified
-- amount against this server-recorded value (the same defense-in-depth
-- shape confirm_ticket_payment/confirm_transfer_fee_payment already use
-- against their own locked-in expected amounts), so crediting a wallet
-- never depends solely on trusting whatever amount its caller happens to
-- pass in.
--
-- No RLS policy at all (RLS enabled, zero policies for anon/authenticated)
-- and no grant to those roles either -- this table has no legitimate
-- client-facing read or write path, ever; only SECURITY DEFINER functions
-- (which run as the function owner, bypassing RLS) touch it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_deposit_attempts (
  reference text NOT NULL,
  user_id uuid NOT NULL,
  amount_kobo bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_deposit_attempts_pkey PRIMARY KEY (reference),
  CONSTRAINT wallet_deposit_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT wallet_deposit_attempts_amount_positive CHECK (amount_kobo > 0)
);

CREATE INDEX IF NOT EXISTS idx_wallet_deposit_attempts_user_id ON public.wallet_deposit_attempts (user_id);

ALTER TABLE public.wallet_deposit_attempts ENABLE ROW LEVEL SECURITY;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.wallet_deposit_attempts TO project_admin;

-- ---------------------------------------------------------------------
-- get_my_wallet: lazily creates the caller's wallet row if it doesn't
-- exist yet, then returns the balance. This is the one place a wallet row
-- ever gets INSERTed for a reason other than a deposit landing -- always
-- with balance_kobo's own DEFAULT 0, never a client-supplied starting
-- value.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_wallet()
 RETURNS TABLE(balance_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  INSERT INTO public.user_wallets (user_id) VALUES (v_uid)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN QUERY SELECT uw.balance_kobo FROM public.user_wallets uw WHERE uw.user_id = v_uid;
END;
$function$
;

REVOKE ALL ON FUNCTION public.get_my_wallet() FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.get_my_wallet() TO authenticated;

-- ---------------------------------------------------------------------
-- get_my_wallet_transactions: paginated own-history read. RLS on the
-- underlying table already scopes SELECT to the caller's own rows, so a
-- plain PostgREST select would work too -- this RPC exists only to apply
-- a sane default/max page size server-side rather than trusting the
-- client to always pass a reasonable limit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_wallet_transactions(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS SETOF public.user_wallet_transactions
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT * FROM public.user_wallet_transactions
   WHERE user_id = (SELECT auth.uid())
   ORDER BY created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
$function$
;

REVOKE ALL ON FUNCTION public.get_my_wallet_transactions(integer, integer) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.get_my_wallet_transactions(integer, integer) TO authenticated;

-- ---------------------------------------------------------------------
-- initiate_wallet_deposit: authenticated, generates a fresh 'wdep_'-
-- prefixed reference (distinct from initiate_ticket_transfer's 'txf_' and
-- service bookings' 'BKG-' prefixes api/webhook/paystack.ts already
-- switches on -- no collision possible) and records who it belongs to.
-- Unlike a ticket/booking price, a deposit amount is inherently the
-- customer's own choice -- but once chosen here, it IS the server-recorded
-- expected amount for this specific reference: confirm_wallet_deposit
-- below reconciles Paystack's verified amount against exactly this value
-- (same defense-in-depth shape confirm_ticket_payment/confirm_transfer_
-- fee_payment already use), so a privileged caller passing a fabricated
-- amount for a real reference can never credit more or less than what was
-- actually intended for that specific deposit.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.initiate_wallet_deposit(p_amount_kobo bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ref text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF p_amount_kobo IS NULL OR p_amount_kobo < 50000 THEN
    RAISE EXCEPTION 'Minimum deposit is NGN 500';
  END IF;
  IF p_amount_kobo > 500000000 THEN
    RAISE EXCEPTION 'Maximum single deposit is NGN 5,000,000';
  END IF;

  PERFORM public.check_rate_limit('wallet_deposit_init:' || v_uid::text, 10, 3600);

  v_ref := 'wdep_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.wallet_deposit_attempts (reference, user_id, amount_kobo) VALUES (v_ref, v_uid, p_amount_kobo);

  RETURN jsonb_build_object('reference', v_ref, 'amountKobo', p_amount_kobo);
END;
$function$
;

REVOKE ALL ON FUNCTION public.initiate_wallet_deposit(bigint) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.initiate_wallet_deposit(bigint) TO authenticated;

-- ---------------------------------------------------------------------
-- get_wallet_deposit_owner: same pattern as get_pending_purchase_owner
-- (0060) / get_transfer_fee_payment_owner (0043) -- lets api/webhook/
-- paystack.ts confirm the authenticated caller hitting ?action=verify is
-- actually the person who started this specific deposit, before spending
-- a Paystack API call or crediting anything on their say-so.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_wallet_deposit_owner(p_reference text)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT user_id FROM public.wallet_deposit_attempts WHERE reference = p_reference;
$function$
;

REVOKE ALL ON FUNCTION public.get_wallet_deposit_owner(text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.get_wallet_deposit_owner(text) TO project_admin;

-- ---------------------------------------------------------------------
-- confirm_wallet_deposit: project_admin-only, called exclusively from
-- api/webhook/paystack.ts after Paystack's own GET /transaction/verify
-- (or the signed webhook event) confirms status='success' -- the same
-- trust boundary confirm_ticket_payment/confirm_transfer_fee_payment
-- already use. p_amount_kobo here is ALWAYS Paystack's own verified
-- amount, but this function does NOT trust its caller alone: it
-- reconciles p_amount_kobo against v_attempt.amount_kobo (the server-
-- recorded amount locked in by initiate_wallet_deposit for this exact
-- reference) and refuses to credit anything on a mismatch -- the same
-- defense-in-depth shape confirm_ticket_payment/confirm_transfer_fee_
-- payment already use against their own locked-in expected amounts, so
-- a privileged caller passing a fabricated amount for a real reference
-- can never over- or under-credit that deposit.
--
-- Idempotent via user_wallet_transactions_deposit_ref_idx (the partial
-- unique index on reference_id for type='deposit' above): a duplicate
-- call for the same reference (webhook + client-verify racing, or a
-- Paystack webhook retry) hits ON CONFLICT DO NOTHING on the ledger
-- insert, RETURNING no row, so the balance credit below never runs twice
-- for the same payment.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_wallet_deposit(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_attempt record;
  v_tx_id   uuid;
BEGIN
  SELECT * INTO v_attempt FROM public.wallet_deposit_attempts WHERE reference = p_reference FOR UPDATE;
  IF v_attempt.reference IS NULL THEN RETURN 'not_found'; END IF;

  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN RETURN 'invalid_amount'; END IF;

  IF p_amount_kobo IS DISTINCT FROM v_attempt.amount_kobo THEN
    RETURN 'amount_mismatch:' || v_attempt.amount_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  INSERT INTO public.user_wallet_transactions (user_id, type, amount_kobo, description, reference_id, metadata)
  VALUES (v_attempt.user_id, 'deposit', p_amount_kobo, 'Wallet top-up', p_reference,
          jsonb_build_object('paystack_reference', p_reference))
  ON CONFLICT (reference_id) WHERE (type = 'deposit' AND reference_id IS NOT NULL) DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    RETURN 'already_credited';
  END IF;

  INSERT INTO public.user_wallets (user_id, balance_kobo)
  VALUES (v_attempt.user_id, p_amount_kobo)
  ON CONFLICT (user_id) DO UPDATE
    SET balance_kobo = public.user_wallets.balance_kobo + p_amount_kobo, updated_at = now();

  RETURN 'confirmed';
END;
$function$
;

REVOKE ALL ON FUNCTION public.confirm_wallet_deposit(text, bigint) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_wallet_deposit(text, bigint) TO project_admin;
