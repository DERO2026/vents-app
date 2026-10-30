-- Loaded AFTER schema-vents-earn.sql + 0193/0196/0197 to give migration
-- 0201 the rest of what it touches. Hand-approximated from production
-- (read-only information_schema / pg_get_functiondef, 2026-10-30); NOT the
-- real schema. request_admin_action / approve_admin_action are verbatim
-- copies of the live definitions, because 0201 patches them in place and
-- the test must prove the patch anchors match production text.

ALTER TABLE public.users ADD COLUMN full_name text, ADD COLUMN username text;

ALTER TABLE public.events
  ADD COLUMN event_date      timestamptz,
  ADD COLUMN end_date        timestamptz,
  ADD COLUMN status          text DEFAULT 'live',
  ADD COLUMN hidden_by_admin boolean DEFAULT false,
  ADD COLUMN deleted_at      timestamptz,
  ADD COLUMN created_at      timestamptz DEFAULT now();

CREATE TABLE public.tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES public.events(id),
  user_id             uuid,
  amount              numeric NOT NULL DEFAULT 0,
  discount_percentage numeric,
  payment_status      text NOT NULL DEFAULT 'paid',
  status              text DEFAULT 'active'
);

-- Earnings wallet, ledger and withdrawals: columns, constraints and
-- indexes verbatim from production (2026-10-30). Representative rewards
-- (0201) credit this wallet, so the live payout functions below run against
-- it in the test.
CREATE TABLE public.organizer_wallets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id         uuid NOT NULL UNIQUE,
  balance_kobo         bigint NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0),
  total_earned_kobo    bigint NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  total_withdrawn_kobo bigint NOT NULL DEFAULT 0,
  pending_kobo         bigint NOT NULL DEFAULT 0
);

CREATE TABLE public.organizer_bank_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id   uuid NOT NULL,
  bank_name      text,
  account_number text,
  account_name   text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  bank_code      text,
  recipient_code text,
  is_default     boolean DEFAULT false,
  is_active      boolean DEFAULT true
);

CREATE TABLE public.organizer_withdrawal_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id       uuid NOT NULL,
  amount_kobo        bigint NOT NULL CHECK (amount_kobo > 0),
  status             text NOT NULL DEFAULT 'pending' CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text]))),
  bank_account_id    uuid REFERENCES public.organizer_bank_accounts(id) ON DELETE SET NULL,
  admin_note         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  paystack_reference text,
  transfer_code      text,
  resolved_by        uuid,
  bank_name          text,
  bank_code          text,
  account_number     text,
  account_name       text,
  idempotency_key    text
);
CREATE UNIQUE INDEX uniq_organizer_withdraw_idempotency ON public.organizer_withdrawal_requests USING btree (organizer_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE TABLE public.organizer_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id          uuid NOT NULL,
  type                  text NOT NULL,
  amount_kobo           bigint NOT NULL,
  description           text,
  ticket_sale_id        uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  withdrawal_request_id uuid REFERENCES public.organizer_withdrawal_requests(id),
  metadata              jsonb,
  CONSTRAINT organizer_transactions_amount_kobo_check CHECK ((amount_kobo > 0)),
  CONSTRAINT organizer_transactions_type_check CHECK ((type = ANY (ARRAY['credit'::text, 'debit'::text, 'payout'::text, 'cancelled_payout_refund'::text, 'refund'::text])))
);

CREATE TABLE public.app_config (id int PRIMARY KEY DEFAULT 1, disable_payouts boolean);
INSERT INTO public.app_config (disable_payouts) VALUES (false);  -- live value
CREATE OR REPLACE FUNCTION public.payouts_disabled() RETURNS boolean LANGUAGE sql STABLE SET search_path TO '' AS
$$ SELECT COALESCE((SELECT disable_payouts FROM public.app_config LIMIT 1), true) $$;
CREATE OR REPLACE FUNCTION public.is_email_verified() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;

CREATE TABLE public.pending_purchases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL,
  status     text NOT NULL DEFAULT 'pending',
  expires_at timestamptz
);

CREATE TABLE public.admin_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       uuid,
  action         text,
  target_user_id uuid,
  details        jsonb,
  created_at     timestamptz DEFAULT now(),
  actor_role     text
);

-- Verbatim constraint and partial unique indexes from production.
CREATE TABLE public.user_wallets (
  user_id      uuid PRIMARY KEY,
  balance_kobo bigint NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0),
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE TABLE public.user_wallet_transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  type         text NOT NULL,
  amount_kobo  bigint NOT NULL,
  description  text,
  reference_id text,
  metadata     jsonb,
  created_at   timestamptz DEFAULT now(),
  CONSTRAINT user_wallet_transactions_type_check CHECK ((type = ANY (ARRAY['deposit'::text, 'spend'::text, 'refund'::text, 'vc_conversion'::text])))
);
CREATE UNIQUE INDEX user_wallet_transactions_deposit_ref_idx ON public.user_wallet_transactions USING btree (reference_id) WHERE ((type = 'deposit'::text) AND (reference_id IS NOT NULL));
CREATE UNIQUE INDEX user_wallet_transactions_spend_ref_idx ON public.user_wallet_transactions USING btree (reference_id) WHERE ((type = 'spend'::text) AND (reference_id IS NOT NULL));
CREATE UNIQUE INDEX user_wallet_transactions_refund_ref_idx ON public.user_wallet_transactions USING btree (reference_id) WHERE ((type = 'refund'::text) AND (reference_id IS NOT NULL));
CREATE UNIQUE INDEX user_wallet_transactions_vc_conversion_ref_idx ON public.user_wallet_transactions USING btree (reference_id) WHERE ((type = 'vc_conversion'::text) AND (reference_id IS NOT NULL));

CREATE TABLE public.admin_action_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type       text NOT NULL,
  target_type       text,
  target_id         uuid,
  target_label      text,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_values   jsonb,
  requested_changes jsonb,
  requested_by      uuid NOT NULL,
  requested_by_role text,
  status            text NOT NULL DEFAULT 'pending' CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
  reviewed_by       uuid,
  review_reason     text,
  device            text,
  ip                text,
  requested_at      timestamptz DEFAULT now(),
  reviewed_at       timestamptz,
  seen_at           timestamptz
);

CREATE OR REPLACE FUNCTION public.is_root() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT auth.uid() = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid $$;
CREATE OR REPLACE FUNCTION public.is_super_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS
$$ SELECT public.is_root() OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin') $$;
CREATE OR REPLACE FUNCTION public.actor_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT COALESCE((SELECT role FROM public.users WHERE id = auth.uid()), 'none') $$;
CREATE OR REPLACE FUNCTION public.client_ip() RETURNS text LANGUAGE sql STABLE AS $$ SELECT '127.0.0.1'::text $$;

-- Live definition (pg_get_functiondef, 2026-10-30), verbatim.
CREATE OR REPLACE FUNCTION public.request_admin_action(p_action_type text, p_target_type text, p_target_id uuid, p_target_label text, p_payload jsonb DEFAULT '{}'::jsonb, p_previous_values jsonb DEFAULT NULL::jsonb, p_requested_changes jsonb DEFAULT NULL::jsonb, p_device text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.admin_action_requests;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required to submit an action request';
  END IF;

  IF p_action_type NOT IN (
    'organizer_verification_approve', 'organizer_verification_reject',
    'hide_event', 'reinstate_event', 'soft_delete_event',
    'restore_deleted_event', 'restore_event',
    'toggle_event_featured',
    'set_user_role', 'suspend_user', 'unsuspend_user',
    'soft_delete_user', 'reinstate_user', 'toggle_user_verified',
    'credit_vents_cents', 'debit_vents_cents',
    'approve_payout', 'reject_payout', 'cancel_payout',
    'decide_organizer_request', 'decide_service_provider_request'
  ) THEN
    RAISE EXCEPTION 'Unknown action_type: % (no executor is mapped for it)', p_action_type;
  END IF;

  INSERT INTO public.admin_action_requests (
    action_type, target_type, target_id, target_label, payload,
    previous_values, requested_changes, requested_by, requested_by_role, device, ip
  ) VALUES (
    p_action_type, p_target_type, p_target_id, p_target_label, COALESCE(p_payload, '{}'::jsonb),
    p_previous_values, p_requested_changes, auth.uid(), public.actor_role(), p_device,
    public.client_ip()
  ) RETURNING * INTO v_row;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_requested',
          CASE WHEN p_target_type = 'user' THEN p_target_id ELSE NULL END,
          jsonb_build_object('request_id', v_row.id, 'action_type', p_action_type,
                             'target_type', p_target_type, 'target_id', p_target_id,
                             'target_label', p_target_label,
                             'device', p_device, 'ip', v_row.ip),
          public.actor_role());

  RETURN to_jsonb(v_row);
END; $function$;

-- Live definition (pg_get_functiondef, 2026-10-30), verbatim.
CREATE OR REPLACE FUNCTION public.approve_admin_action(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  IF r.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;

  CASE r.action_type
    WHEN 'organizer_verification_approve' THEN PERFORM public.admin_approve_organizer_verification((r.payload->>'request_id')::uuid);
    WHEN 'organizer_verification_reject'  THEN PERFORM public.admin_reject_organizer_verification((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'hide_event'             THEN PERFORM public.admin_hide_event(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_event'        THEN PERFORM public.admin_reinstate_event(r.target_id);
    WHEN 'soft_delete_event'      THEN PERFORM public.soft_delete_event(r.target_id, r.payload->>'reason');
    WHEN 'restore_deleted_event'  THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    WHEN 'restore_event'          THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    WHEN 'set_user_role'          THEN PERFORM public.admin_set_user_role(r.target_id, r.payload->>'new_role');
    WHEN 'suspend_user'           THEN PERFORM public.admin_suspend_user(r.target_id, NULLIF(r.payload->>'banned_until','')::timestamptz, r.payload->>'reason');
    WHEN 'unsuspend_user'         THEN PERFORM public.admin_unsuspend_user(r.target_id);
    WHEN 'soft_delete_user'       THEN PERFORM public.admin_soft_delete_user(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_user'         THEN PERFORM public.admin_reinstate_user(r.target_id);
    WHEN 'toggle_user_verified'   THEN PERFORM public.admin_toggle_user_verified(r.target_id, (r.payload->>'verified')::boolean, r.payload->>'reason');
    WHEN 'set_organizer_capability' THEN
      IF r.payload->>'is_organizer' IS NULL OR r.payload->>'is_organizer' NOT IN ('true', 'false') THEN
        RAISE EXCEPTION 'set_organizer_capability requires a boolean payload.is_organizer (got: %)', r.payload->>'is_organizer';
      END IF;
      PERFORM public.admin_set_organizer_capability(r.target_id, (r.payload->>'is_organizer')::boolean);
    WHEN 'set_service_provider_capability' THEN
      IF r.payload->>'is_service_provider' IS NULL OR r.payload->>'is_service_provider' NOT IN ('true', 'false') THEN
        RAISE EXCEPTION 'set_service_provider_capability requires a boolean payload.is_service_provider (got: %)', r.payload->>'is_service_provider';
      END IF;
      PERFORM public.admin_set_service_provider_capability(r.target_id, (r.payload->>'is_service_provider')::boolean);
    WHEN 'credit_vents_cents'     THEN PERFORM public.admin_credit_vents_cents(r.target_id, (r.payload->>'amount')::numeric, r.payload->>'reason');
    WHEN 'debit_vents_cents'      THEN PERFORM public.admin_debit_vents_cents(r.target_id, (r.payload->>'amount')::integer, r.payload->>'reason');
    WHEN 'approve_payout'         THEN PERFORM public.admin_mark_payout_processing((r.payload->>'request_id')::uuid, r.payload->>'paystack_reference', r.payload->>'transfer_code');
    WHEN 'reject_payout'          THEN PERFORM public.admin_reject_organizer_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'cancel_payout'          THEN PERFORM public.admin_cancel_processing_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'toggle_event_featured'  THEN
      IF r.payload->>'featured' IS NULL OR r.payload->>'featured' NOT IN ('true', 'false') THEN
        RAISE EXCEPTION 'toggle_event_featured requires a boolean payload.featured (got: %)', r.payload->>'featured';
      END IF;
      PERFORM public.admin_set_event_featured(
        r.target_id,
        (r.payload->>'featured')::boolean,
        COALESCE((r.payload->>'duration_days')::integer, 14));
    WHEN 'toggle_event_trending' THEN
      IF r.payload->>'trending' IS NULL OR r.payload->>'trending' NOT IN ('true', 'false') THEN
        RAISE EXCEPTION 'toggle_event_trending requires a boolean payload.trending (got: %)', r.payload->>'trending';
      END IF;
      PERFORM public.admin_set_event_trending(r.target_id, (r.payload->>'trending')::boolean);
    WHEN 'decide_organizer_request' THEN PERFORM public.admin_decide_organizer_request(
                                      (r.payload->>'request_id')::uuid,
                                      COALESCE((r.payload->>'approve')::boolean, false),
                                      r.payload->>'reason');
    WHEN 'decide_service_provider_request' THEN PERFORM public.admin_decide_service_provider_request(
                                      (r.payload->>'request_id')::uuid,
                                      r.payload->>'status',
                                      r.payload->>'admin_note');
    ELSE RAISE EXCEPTION 'No executor mapped for action_type: %', r.action_type;
  END CASE;

  UPDATE public.admin_action_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_approved', CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type, 'requested_by', r.requested_by,
                             'target_label', r.target_label, 'reviewer_ip', public.client_ip(),
                             'previous_values', r.previous_values, 'requested_changes', r.requested_changes),
          public.actor_role());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (r.requested_by, 'broadcast', 'Your request has been approved',
          format('Your request (%s) was approved and executed.', COALESCE(r.target_label, r.action_type)), false, '✅');

  RETURN to_jsonb(r);
END; $function$;

GRANT EXECUTE ON FUNCTION public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_admin_action(uuid) TO authenticated;

-- Live request_organizer_payout (verbatim) and complete_organizer_payout (its money-moving statements verbatim; returned rows simplified) -- pg_get_functiondef,
-- 2026-10-30.
CREATE OR REPLACE FUNCTION public.request_organizer_payout(p_amount_kobo bigint, p_bank_account_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid := auth.uid();
  v_balance      bigint;
  v_request_id   uuid;
  v_account      public.organizer_bank_accounts;
BEGIN
  IF public.payouts_disabled() THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before requesting a withdrawal';
  END IF;
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;
  IF p_idempotency_key IS NOT NULL AND trim(p_idempotency_key) <> '' THEN
    SELECT id INTO v_request_id
    FROM public.organizer_withdrawal_requests
    WHERE organizer_id = v_organizer_id AND idempotency_key = p_idempotency_key;
    IF v_request_id IS NOT NULL THEN
      RETURN v_request_id;
    END IF;
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
  BEGIN
    INSERT INTO public.organizer_withdrawal_requests
      (organizer_id, amount_kobo, bank_account_id, status, bank_name, bank_code, account_number, account_name, idempotency_key)
    VALUES
      (v_organizer_id, p_amount_kobo, p_bank_account_id, 'pending',
       v_account.bank_name, v_account.bank_code, v_account.account_number, v_account.account_name,
       NULLIF(trim(COALESCE(p_idempotency_key, '')), ''))
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.organizer_wallets
    SET balance_kobo = balance_kobo + p_amount_kobo,
        pending_kobo = GREATEST(0, pending_kobo - p_amount_kobo),
        updated_at = now()
    WHERE organizer_id = v_organizer_id;
    SELECT id INTO v_request_id
    FROM public.organizer_withdrawal_requests
    WHERE organizer_id = v_organizer_id AND idempotency_key = p_idempotency_key;
    RETURN v_request_id;
  END;
  RETURN v_request_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_organizer_payout(p_request_id text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
  v_bank_name text;
  v_account_number text;
  v_account_name text;
  v_rows int;
BEGIN
  SELECT r.id, r.organizer_id, r.amount_kobo, r.status, b.bank_name, b.account_number, b.account_name
    INTO v_id, v_organizer_id, v_amount_kobo, v_status, v_bank_name, v_account_number, v_account_name
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id
  FOR UPDATE OF r;
  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;
  IF v_status = 'completed' THEN
    RETURN QUERY SELECT 'already_completed'::text, NULL::text, NULL::text, v_amount_kobo;
    RETURN;
  END IF;
  UPDATE public.organizer_withdrawal_requests
  SET status = 'completed', updated_at = now()
  WHERE id = v_id AND public.organizer_withdrawal_requests.status IN ('pending', 'processing');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY SELECT 'already_completed'::text, NULL::text, NULL::text, v_amount_kobo;
    RETURN;
  END IF;
  UPDATE public.organizer_wallets
  SET pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      total_withdrawn_kobo = COALESCE(total_withdrawn_kobo, 0) + v_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;
  INSERT INTO public.organizer_transactions
    (organizer_id, type, amount_kobo, description, withdrawal_request_id, metadata)
  VALUES (v_organizer_id, 'payout', v_amount_kobo,
    'Withdrawal to ' || COALESCE(v_bank_name, 'bank account') || ' — completed', v_id,
    jsonb_build_object('bank_name', v_bank_name, 'account_number', v_account_number, 'account_name', v_account_name));
  RETURN QUERY SELECT 'completed'::text, NULL::text, NULL::text, v_amount_kobo;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.request_organizer_payout(bigint, uuid, text) TO authenticated;
