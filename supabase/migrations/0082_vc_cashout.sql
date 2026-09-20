-- ============================================================================
-- VENTS Cents (VC) cash-out to NGN via Paystack Transfers -- BATCH A.
--
-- Purely additive: new column, two new tables, new functions, new grants.
-- Nothing here touches vc_naira_per_1000 (a DIFFERENT, ticket-credit-oriented
-- rate), organizer_withdrawal_requests, organizer_bank_accounts,
-- organizer_wallets, or any organizer-payout function -- those are read-only
-- references for this migration's pattern, never modified. VC withdrawals get
-- their own, separate ledger (vc_withdrawal_requests / vc_bank_accounts) so
-- organizer and VC accounting can never mix, even though both eventually fire
-- against the same underlying Paystack /transfer balance.
--
-- Reuses the EXACT same Paystack Transfers machinery the organizer payout
-- flow already uses (bank/resolve, transferrecipient, transfer, and the
-- transfer.success/transfer.failed/transfer.reversed webhook) -- no new
-- provider integration. See api/vc/*.ts and the extended dispatch in
-- api/webhook/paystack.ts.
--
-- State machine (identical shape to organizer_withdrawal_requests):
--   pending -> processing -> completed   (webhook/reconcile-poller only)
--   pending -> processing -> failed      (webhook/reconcile-poller only, restores VC)
--   pending -> processing -> cancelled   (admin_cancel_processing_vc_payout, restores VC)
--   pending -> rejected                  (admin_reject_vc_payout, restores VC)
-- `completed` is NEVER set by request-creation or admin-approval -- only by
-- complete_vc_payout, which is project_admin-only (no anon/authenticated/
-- service_role EXECUTE grant) and is only ever invoked from
-- api/webhook/paystack.ts (Paystack's own signed webhook) or
-- api/vc/reconcile-payouts.ts (polling Paystack's own /transfer/:code status).
-- ============================================================================

-- ── 1. New, separate cash-out rate (does NOT touch vc_naira_per_1000) ──────
ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS vc_cashout_naira_per_1000 integer NOT NULL DEFAULT 100;
-- 1,000 VC = ₦100 cash-out value (25,000 VC = ₦2,500). Read server-side only,
-- at request-creation time inside request_vc_cashout -- the client never
-- supplies or can influence this rate or the resulting ngn_amount_kobo.

-- ── 2. vc_bank_accounts -- mirrors organizer_bank_accounts, scoped to user_id ──
CREATE TABLE IF NOT EXISTS public.vc_bank_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bank_name text NOT NULL,
  account_number text NOT NULL,
  account_name text NOT NULL,
  bank_code text,
  recipient_code text,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vc_bank_accounts_pkey PRIMARY KEY (id)
);

ALTER TABLE public.vc_bank_accounts
  ADD CONSTRAINT vc_bank_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_vc_bank_account ON public.vc_bank_accounts USING btree (user_id, account_number);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_vc_default_bank ON public.vc_bank_accounts USING btree (user_id) WHERE (is_default AND is_active);

ALTER TABLE public.vc_bank_accounts ENABLE ROW LEVEL SECURITY;

-- Same shape as org_bank_own/org_bank_admin_read: the owner can read/write
-- their own rows (in practice writes only ever happen via the
-- SECURITY DEFINER *_confirmed RPCs below, but this keeps the RLS/grant
-- convention identical to the organizer table), admins can read all.
CREATE POLICY vc_bank_own ON public.vc_bank_accounts FOR ALL TO authenticated
  USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY vc_bank_admin_read ON public.vc_bank_accounts FOR SELECT TO public USING (public.is_admin());

GRANT SELECT ON public.vc_bank_accounts TO anon;
GRANT SELECT ON public.vc_bank_accounts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vc_bank_accounts TO project_admin;

-- ── 3. vc_withdrawal_requests -- separate ledger from organizer_withdrawal_requests ──
CREATE TABLE IF NOT EXISTS public.vc_withdrawal_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  vc_amount integer NOT NULL,
  ngn_amount_kobo bigint NOT NULL,
  rate_used integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  bank_account_id uuid,
  admin_note text,
  paystack_reference text,
  transfer_code text,
  resolved_by uuid,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  CONSTRAINT vc_withdrawal_requests_pkey PRIMARY KEY (id),
  CONSTRAINT vc_withdrawal_requests_vc_amount_check CHECK (vc_amount > 0),
  CONSTRAINT vc_withdrawal_requests_ngn_amount_kobo_check CHECK (ngn_amount_kobo > 0),
  CONSTRAINT vc_withdrawal_requests_status_check CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text]))
);

ALTER TABLE public.vc_withdrawal_requests
  ADD CONSTRAINT vc_withdrawal_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users (id),
  ADD CONSTRAINT vc_withdrawal_requests_bank_account_id_fkey FOREIGN KEY (bank_account_id) REFERENCES public.vc_bank_accounts (id) ON DELETE SET NULL,
  ADD CONSTRAINT vc_withdrawal_requests_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users (id);

-- Idempotency: one request per (user, idempotency_key) -- the unique index
-- IS the concurrency guard request_vc_cashout relies on (see its comment).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_vc_withdraw_idempotency ON public.vc_withdrawal_requests USING btree (user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_vc_withdraw_user ON public.vc_withdrawal_requests USING btree (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vc_withdraw_status ON public.vc_withdrawal_requests USING btree (status);
CREATE INDEX IF NOT EXISTS idx_vc_withdraw_bank_account ON public.vc_withdrawal_requests USING btree (bank_account_id);

ALTER TABLE public.vc_withdrawal_requests ENABLE ROW LEVEL SECURITY;

-- Deliberately NO client-writable INSERT policy -- mirrors the fix in
-- 0076_fix_withdrawal_rls_hole_and_payout_ambiguity_bugs.sql for
-- organizer_withdrawal_requests (Defect 1). request_vc_cashout is
-- SECURITY DEFINER and performs its own INSERT; it never needs, and must
-- never be given, a client-side INSERT policy on this table.
CREATE POLICY vc_withdraw_admin_read ON public.vc_withdrawal_requests FOR SELECT TO public USING (public.is_admin());
CREATE POLICY vc_withdraw_admin_update ON public.vc_withdrawal_requests FOR UPDATE TO public USING (public.is_admin());
CREATE POLICY vc_withdraw_own_read ON public.vc_withdrawal_requests FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));

GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_withdrawal_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.vc_withdrawal_requests TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.vc_withdrawal_requests TO project_admin;
-- (Table grants are broad per this repo's existing convention -- see
-- vc_transactions/organizer_withdrawal_requests in 0011_grants.sql -- RLS
-- above, not table grants, is what actually restricts client access.)

-- ── 4. Internal restore helper -- symmetric mirror of _vc_deduct ──────────
-- Used only by fail_vc_payout / admin_reject_vc_payout /
-- admin_cancel_processing_vc_payout, always from inside a status-guarded
-- UPDATE that already established this is the exactly-once restoration for
-- a given request (see each caller's own idempotency guard). Never called
-- directly by client code -- no grants issued for it at all (same as
-- _vc_deduct, which also carries no explicit grant row of its own; both
-- run under the SECURITY DEFINER privileges of whichever function calls
-- them).
CREATE OR REPLACE FUNCTION public._vc_restore(p_user_id uuid, p_amount integer, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.vents_wallets
  SET balance = balance + p_amount, updated_at = now()
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    INSERT INTO public.vents_wallets (user_id, balance) VALUES (p_user_id, p_amount);
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at, reference_id)
  VALUES (p_user_id, p_amount, 'refund', 'active', now(), gen_random_uuid());
END;
$function$
;

-- ── 5. Bank-account mutation RPCs (password-reconfirmed via assert_recent_auth,
--       identical convention to add/remove/set_default_bank_account_confirmed) ──
CREATE OR REPLACE FUNCTION public.add_vc_bank_account_confirmed(p_bank_name text, p_bank_code text, p_account_number text, p_account_name text, p_recipient_code text)
 RETURNS vc_bank_accounts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.vc_bank_accounts;
  v_existing public.vc_bank_accounts;
  v_active_count integer;
  v_has_default boolean;
BEGIN
  PERFORM public.assert_recent_auth();
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid AND email_confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Please verify your email first';
  END IF;

  SELECT * INTO v_existing FROM public.vc_bank_accounts
  WHERE user_id = v_uid AND account_number = p_account_number;

  IF v_existing IS NULL OR NOT v_existing.is_active THEN
    SELECT count(*) INTO v_active_count FROM public.vc_bank_accounts
    WHERE user_id = v_uid AND is_active;
    IF v_active_count >= 3 THEN
      RAISE EXCEPTION 'You can link at most 3 bank accounts. Remove one before adding another.';
    END IF;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.vc_bank_accounts
                 WHERE user_id = v_uid AND is_default AND is_active) INTO v_has_default;

  INSERT INTO public.vc_bank_accounts
    (user_id, bank_name, bank_code, account_number, account_name, recipient_code, is_default, is_active, updated_at)
  VALUES
    (v_uid, p_bank_name, p_bank_code, p_account_number, p_account_name, p_recipient_code, NOT v_has_default, true, now())
  ON CONFLICT (user_id, account_number) DO UPDATE SET
    bank_name = EXCLUDED.bank_name, bank_code = EXCLUDED.bank_code,
    account_name = EXCLUDED.account_name, recipient_code = EXCLUDED.recipient_code,
    is_active = true,
    is_default = vc_bank_accounts.is_default OR NOT v_has_default,
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END; $function$
;

CREATE OR REPLACE FUNCTION public.set_default_vc_bank_account_confirmed(p_account_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  PERFORM public.assert_recent_auth();
  IF NOT EXISTS (SELECT 1 FROM public.vc_bank_accounts
                 WHERE id = p_account_id AND user_id = v_uid AND is_active) THEN
    RAISE EXCEPTION 'Bank account not found';
  END IF;
  UPDATE public.vc_bank_accounts SET is_default = false, updated_at = now()
  WHERE user_id = v_uid AND is_default AND id <> p_account_id;
  UPDATE public.vc_bank_accounts SET is_default = true, updated_at = now()
  WHERE id = p_account_id;
END; $function$
;

CREATE OR REPLACE FUNCTION public.remove_vc_bank_account_confirmed(p_account_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_was_default boolean; v_next uuid;
BEGIN
  PERFORM public.assert_recent_auth();
  SELECT is_default INTO v_was_default FROM public.vc_bank_accounts
  WHERE id = p_account_id AND user_id = v_uid AND is_active;
  IF v_was_default IS NULL THEN RAISE EXCEPTION 'Bank account not found'; END IF;

  UPDATE public.vc_bank_accounts
  SET is_active = false, is_default = false, updated_at = now()
  WHERE id = p_account_id AND user_id = v_uid;

  IF v_was_default THEN
    SELECT id INTO v_next FROM public.vc_bank_accounts
    WHERE user_id = v_uid AND is_active ORDER BY created_at DESC LIMIT 1;
    IF v_next IS NOT NULL THEN
      UPDATE public.vc_bank_accounts SET is_default = true, updated_at = now() WHERE id = v_next;
    END IF;
  END IF;
END; $function$
;

-- ── 6. request_vc_cashout -- the user-facing entry point ──────────────────
-- Rate and NGN amount are computed HERE, server-side, from app_config alone
-- -- p_vc_amount is the only amount the client supplies, and it denominates
-- VC (which the atomic debit below independently verifies the caller
-- actually has), never NGN/kobo directly.
--
-- Idempotency/concurrency: the INSERT below (with the unique index on
-- (user_id, idempotency_key) as the actual enforcement mechanism) is
-- attempted BEFORE the VC debit -- exactly the same "insert as atomic
-- reservation" pattern activate_event_promotion already uses for
-- payment_ref. Postgres serializes concurrent INSERTs racing for the same
-- unique key: only one can ever succeed; a second, concurrent call with the
-- identical idempotency_key blocks until the first commits (or rolls back
-- entirely on error, per Postgres MVCC), then either finds ROW_COUNT = 0
-- (first one won -- return its id, no new debit) or itself succeeds (first
-- one's transaction rolled back -- proceed normally). This makes it
-- impossible for the same idempotency_key to ever debit VC twice.
CREATE OR REPLACE FUNCTION public.request_vc_cashout(p_vc_amount integer, p_bank_account_id uuid, p_idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id  uuid := auth.uid();
  v_account  public.vc_bank_accounts;
  v_rate     integer;
  v_ngn_kobo bigint;
  v_id       uuid;
  v_rows     int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before requesting a cash-out';
  END IF;

  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  IF p_vc_amount IS NULL OR p_vc_amount < 1000 THEN
    RAISE EXCEPTION 'Minimum cash-out is 1,000 Vents Cents';
  END IF;

  IF p_idempotency_key IS NULL OR trim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  SELECT * INTO v_account FROM public.vc_bank_accounts
  WHERE id = p_bank_account_id AND user_id = v_user_id
    AND is_active AND recipient_code IS NOT NULL;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Bank account not verified';
  END IF;

  -- Server-side only -- never accepted as a parameter from the client.
  SELECT vc_cashout_naira_per_1000 INTO v_rate FROM public.app_config LIMIT 1;
  v_ngn_kobo := (p_vc_amount::bigint * v_rate::bigint * 100) / 1000;

  INSERT INTO public.vc_withdrawal_requests
    (user_id, vc_amount, ngn_amount_kobo, rate_used, status, bank_account_id, idempotency_key)
  VALUES
    (v_user_id, p_vc_amount, v_ngn_kobo, v_rate, 'pending', p_bank_account_id, p_idempotency_key)
  ON CONFLICT (user_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- Replayed idempotency key -- return the existing request, no new debit.
    SELECT id INTO v_id FROM public.vc_withdrawal_requests
    WHERE user_id = v_user_id AND idempotency_key = p_idempotency_key;
    RETURN v_id;
  END IF;

  -- Atomic, row-locked debit -- raises (and rolls back the INSERT above too,
  -- since this whole function is one transaction) if the balance is
  -- insufficient. Mirrors _vc_deduct's own FOR UPDATE lock on vents_wallets.
  PERFORM public._vc_deduct(v_user_id, p_vc_amount, 'VC cash-out request');

  RETURN v_id;
END;
$function$
;

-- ── 7. Admin claim/release/reject/cancel (mirrors the organizer versions) ──
CREATE OR REPLACE FUNCTION public.admin_claim_vc_payout_for_processing(p_request_id uuid)
 RETURNS TABLE(request_id uuid, user_id uuid, vc_amount integer, ngn_amount_kobo bigint, recipient_code text, status text, claimed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed_id uuid;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  -- Atomic claim: exactly one concurrent caller can win this UPDATE for a
  -- given request_id (Postgres serializes UPDATEs to the same row).
  UPDATE public.vc_withdrawal_requests
  SET status = 'processing', resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id AND status = 'pending'
  RETURNING id INTO v_claimed_id;

  IF v_claimed_id IS NOT NULL THEN
    INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
    VALUES (auth.uid(), 'claim_vc_payout_for_processing', jsonb_build_object('request_id', p_request_id), public.actor_role());
  END IF;

  RETURN QUERY
  SELECT r.id, r.user_id, r.vc_amount, r.ngn_amount_kobo, b.recipient_code, r.status, (v_claimed_id IS NOT NULL)
  FROM public.vc_withdrawal_requests r
  JOIN public.vc_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id = p_request_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_release_vc_payout_claim(p_request_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;

  UPDATE public.vc_withdrawal_requests
  SET status = 'pending', updated_at = now()
  WHERE id = p_request_id AND status = 'processing' AND transfer_code IS NULL;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'release_vc_payout_claim', jsonb_build_object('request_id', p_request_id, 'reason', p_reason), public.actor_role());
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_mark_vc_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;

  UPDATE public.vc_withdrawal_requests
  SET paystack_reference = p_paystack_reference, transfer_code = p_transfer_code, updated_at = now()
  WHERE id = p_request_id AND status = 'processing';

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'approve_vc_payout_request',
          jsonb_build_object('request_id', p_request_id, 'transfer_code', p_transfer_code),
          public.actor_role());
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_reject_vc_payout(p_request_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid; v_vc_amount integer; v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  SELECT r.user_id, r.vc_amount, r.status INTO v_user_id, v_vc_amount, v_status
  FROM public.vc_withdrawal_requests r WHERE r.id = p_request_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status NOT IN ('pending') THEN RAISE EXCEPTION 'Only pending requests can be rejected'; END IF;

  UPDATE public.vc_withdrawal_requests
  SET status = 'rejected', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;

  PERFORM public._vc_restore(v_user_id, v_vc_amount, 'VC cash-out rejected by admin, funds returned — ' || p_reason);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_vc_payout_request', v_user_id,
          jsonb_build_object('request_id', p_request_id, 'vc_amount', v_vc_amount, 'reason', p_reason),
          public.actor_role());

  RETURN 'rejected';
END; $function$
;

CREATE OR REPLACE FUNCTION public.admin_cancel_processing_vc_payout(p_request_id uuid, p_reason text)
 RETURNS TABLE(status text, user_email text, user_name text, vc_amount integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid;
  v_vc_amount integer;
  v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  SELECT r.user_id, r.vc_amount, r.status
    INTO v_user_id, v_vc_amount, v_status
  FROM public.vc_withdrawal_requests r
  WHERE r.id = p_request_id;

  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status <> 'processing' THEN RAISE EXCEPTION 'Only requests in Processing status can be cancelled (current status: %)', v_status; END IF;

  UPDATE public.vc_withdrawal_requests
  SET status = 'cancelled', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;

  PERFORM public._vc_restore(v_user_id, v_vc_amount, 'VC cash-out cancelled by admin, funds returned — ' || p_reason);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'cancel_processing_vc_payout', v_user_id,
          jsonb_build_object('request_id', p_request_id, 'vc_amount', v_vc_amount, 'reason', p_reason),
          public.actor_role());

  RETURN QUERY
  SELECT 'cancelled'::text, u.email, u.full_name, v_vc_amount
  FROM public.users u WHERE u.id = v_user_id;
END; $function$
;

-- ── 8. Admin list RPCs (for AdminDashboardScreen VC tab + reconcile-payouts) ──
CREATE OR REPLACE FUNCTION public.admin_list_pending_vc_payouts()
 RETURNS TABLE(request_id uuid, user_id uuid, user_name text, user_email text, vc_amount integer, ngn_amount_kobo bigint, bank_name text, account_number text, account_name text, recipient_code text, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.user_id, u.full_name, u.email,
    r.vc_amount, r.ngn_amount_kobo, b.bank_name, b.account_number, b.account_name, b.recipient_code,
    r.status, r.created_at
  FROM public.vc_withdrawal_requests r
  JOIN public.users u ON u.id = r.user_id
  JOIN public.vc_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.status IN ('pending', 'processing')
  ORDER BY r.created_at ASC;
END; $function$
;

CREATE OR REPLACE FUNCTION public.admin_list_processing_vc_payouts()
 RETURNS TABLE(request_id uuid, user_id uuid, vc_amount integer, ngn_amount_kobo bigint, transfer_code text, paystack_reference text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.user_id, r.vc_amount, r.ngn_amount_kobo, r.transfer_code, r.paystack_reference, r.updated_at
  FROM public.vc_withdrawal_requests r
  WHERE r.status = 'processing'
  ORDER BY r.updated_at ASC;
END; $function$
;

-- ── 9. Webhook/reconcile-driven completion -- project_admin ONLY, no
--       anon/authenticated/service_role grant (identical boundary to
--       complete_organizer_payout/fail_organizer_payout). These are called
--       exclusively via api/_lib/projectAdminDb.ts's direct project_admin
--       Postgres connection from api/webhook/paystack.ts and
--       api/vc/reconcile-payouts.ts -- there is NO code path from the
--       normal PostgREST surface, and no client-authenticated route, that
--       can ever set status = 'completed'. ──
CREATE OR REPLACE FUNCTION public.complete_vc_payout(p_request_id text)
 RETURNS TABLE(status text, user_email text, user_name text, vc_amount integer, ngn_amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_user_id uuid;
  v_vc_amount integer;
  v_ngn_amount_kobo bigint;
  v_status text;
  v_rows int;
BEGIN
  SELECT r.id, r.user_id, r.vc_amount, r.ngn_amount_kobo, r.status
    INTO v_id, v_user_id, v_vc_amount, v_ngn_amount_kobo, v_status
  FROM public.vc_withdrawal_requests r
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id
  FOR UPDATE OF r;

  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF v_status = 'completed' THEN
    RETURN QUERY
    SELECT 'already_completed'::text, u.email, u.full_name, v_vc_amount, v_ngn_amount_kobo
    FROM public.users u WHERE u.id = v_user_id;
    RETURN;
  END IF;

  -- The status-guarded UPDATE (not the earlier locked read) is the actual
  -- exactly-once gate: a duplicate webhook delivery for the same event, or
  -- a concurrent reconcile-poller run, will see ROW_COUNT = 0 here and
  -- change nothing further.
  UPDATE public.vc_withdrawal_requests
  SET status = 'completed', completed_at = now(), updated_at = now()
  WHERE id = v_id AND public.vc_withdrawal_requests.status IN ('pending', 'processing');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY
    SELECT 'already_completed'::text, u.email, u.full_name, v_vc_amount, v_ngn_amount_kobo
    FROM public.users u WHERE u.id = v_user_id;
    RETURN;
  END IF;

  -- VC was already, and remains, spent -- a successful cash-out is not
  -- restored. No wallet/ledger write happens here at all.
  RETURN QUERY
  SELECT 'completed'::text, u.email, u.full_name, v_vc_amount, v_ngn_amount_kobo
  FROM public.users u WHERE u.id = v_user_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fail_vc_payout(p_request_id text, p_reason text)
 RETURNS TABLE(status text, user_email text, user_name text, vc_amount integer, ngn_amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_user_id uuid;
  v_vc_amount integer;
  v_ngn_amount_kobo bigint;
  v_status text;
  v_rows int;
BEGIN
  SELECT r.id, r.user_id, r.vc_amount, r.ngn_amount_kobo, r.status
    INTO v_id, v_user_id, v_vc_amount, v_ngn_amount_kobo, v_status
  FROM public.vc_withdrawal_requests r
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id
  FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  IF v_status IN ('completed', 'failed', 'rejected', 'cancelled') THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  -- Status-guarded UPDATE is the exactly-once restoration gate: a duplicate
  -- transfer.failed/transfer.reversed webhook delivery, or a concurrent
  -- reconcile-poller pass, sees ROW_COUNT = 0 below and the VC restore is
  -- skipped entirely -- it can never fire twice for the same request.
  UPDATE public.vc_withdrawal_requests
  SET status = 'failed', failed_at = now(), failure_reason = COALESCE(p_reason, failure_reason),
      admin_note = COALESCE(p_reason, admin_note), updated_at = now()
  WHERE id = v_id AND public.vc_withdrawal_requests.status IN ('pending', 'processing');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::integer, NULL::bigint;
    RETURN;
  END IF;

  PERFORM public._vc_restore(v_user_id, v_vc_amount, 'VC cash-out failed/reversed — refunded: ' || COALESCE(p_reason, 'transfer failed'));

  RETURN QUERY
  SELECT 'failed'::text, u.email, u.full_name, v_vc_amount, v_ngn_amount_kobo
  FROM public.users u WHERE u.id = v_user_id;
END;
$function$
;

-- ── 10. Grants -- narrowest possible, mirroring 0011_grants.sql's exact convention ──
REVOKE ALL ON FUNCTION public.add_vc_bank_account_confirmed(p_bank_name text, p_bank_code text, p_account_number text, p_account_name text, p_recipient_code text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.add_vc_bank_account_confirmed(p_bank_name text, p_bank_code text, p_account_number text, p_account_name text, p_recipient_code text) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.set_default_vc_bank_account_confirmed(p_account_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.set_default_vc_bank_account_confirmed(p_account_id uuid) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.remove_vc_bank_account_confirmed(p_account_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.remove_vc_bank_account_confirmed(p_account_id uuid) TO authenticated, project_admin;

REVOKE ALL ON FUNCTION public.request_vc_cashout(p_vc_amount integer, p_bank_account_id uuid, p_idempotency_key text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.request_vc_cashout(p_vc_amount integer, p_bank_account_id uuid, p_idempotency_key text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_claim_vc_payout_for_processing(p_request_id uuid) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_claim_vc_payout_for_processing(p_request_id uuid) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_release_vc_payout_claim(p_request_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_release_vc_payout_claim(p_request_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_mark_vc_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_mark_vc_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_reject_vc_payout(p_request_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_reject_vc_payout(p_request_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_cancel_processing_vc_payout(p_request_id uuid, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_cancel_processing_vc_payout(p_request_id uuid, p_reason text) TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_list_pending_vc_payouts() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_list_pending_vc_payouts() TO anon, authenticated, project_admin;

REVOKE ALL ON FUNCTION public.admin_list_processing_vc_payouts() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_list_processing_vc_payouts() TO anon, authenticated, project_admin;

-- complete_vc_payout / fail_vc_payout: NO anon/authenticated/service_role
-- grant at all -- project_admin only, exactly like complete_organizer_payout
-- / fail_organizer_payout. This is what makes it structurally impossible
-- for any client-authenticated call (even from an admin session) to ever
-- set status = 'completed'.
REVOKE ALL ON FUNCTION public.complete_vc_payout(p_request_id text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.complete_vc_payout(p_request_id text) TO project_admin;

REVOKE ALL ON FUNCTION public.fail_vc_payout(p_request_id text, p_reason text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.fail_vc_payout(p_request_id text, p_reason text) TO project_admin;
