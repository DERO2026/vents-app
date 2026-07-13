-- Block 19: Internal Admin Safety.
--
-- Role model: 'admin' (+ the hardcoded Root UID) = Super Admin; 'sub-admin'
-- = Support Admin. public.is_admin_or_root() already existed (role='admin'
-- OR Root) but was defined and never actually used anywhere -- exactly the
-- "Super Admin" primitive this phase needs. public.is_admin() (role IN
-- ('admin','sub-admin') OR Root) remains the "any admin tier" check, kept
-- for the handful of things Support Admin is explicitly allowed to do:
-- viewing users/events (RLS, unchanged), refunding individual tickets
-- (refund_ticket + attach_ticket_refund_id, unchanged), and site-wide
-- password reset (not yet a distinct admin action anywhere in this schema).
-- Everything else that was gated by is_admin() -- payouts, VC credit/debit,
-- kill switches' underlying config writes, organizer verification,
-- event hide/reinstate/delete/restore, role changes, user bans, and system
-- maintenance -- is tightened to is_admin_or_root() (Super Admin only)
-- below, and every one of those actions now writes an admin_logs row
-- (admin_id, action, target_user_id, details, actor_role) if it didn't
-- already.

-- ── Payouts (Super Admin only — "can manage payouts") ────────────────────

CREATE OR REPLACE FUNCTION public.admin_get_payout_for_processing(p_request_id uuid)
RETURNS TABLE(request_id uuid, organizer_id uuid, amount_kobo bigint, recipient_code text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, b.recipient_code, r.status
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id = p_request_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_list_pending_payouts()
RETURNS TABLE(request_id uuid, organizer_id uuid, organizer_name text, organizer_email text, organizer_phone text, amount_kobo bigint, bank_name text, account_number text, account_name text, recipient_code text, status text, created_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.organizer_id, u.full_name, u.email, u.phone_number,
    r.amount_kobo, b.bank_name, b.account_number, b.account_name, b.recipient_code,
    r.status, r.created_at
  FROM public.organizer_withdrawal_requests r
  JOIN public.users u ON u.id = r.organizer_id
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.status IN ('pending', 'processing')
  ORDER BY r.created_at ASC;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_list_processing_payouts()
RETURNS TABLE(request_id uuid, organizer_id uuid, amount_kobo bigint, transfer_code text, paystack_reference text, updated_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, r.transfer_code, r.paystack_reference, r.updated_at
  FROM public.organizer_withdrawal_requests r
  WHERE r.status = 'processing'
  ORDER BY r.updated_at ASC;
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_mark_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  UPDATE public.organizer_withdrawal_requests
  SET status = 'processing', paystack_reference = p_paystack_reference, transfer_code = p_transfer_code,
      resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id AND status = 'pending';

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'approve_payout_request',
          jsonb_build_object('request_id', p_request_id, 'transfer_code', p_transfer_code),
          public.actor_role());
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_reject_organizer_payout(p_request_id uuid, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_organizer_id uuid; v_amount_kobo bigint; v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests WHERE id = p_request_id;
  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status NOT IN ('pending') THEN RAISE EXCEPTION 'Only pending requests can be rejected'; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'rejected', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;
  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo, pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo), updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_payout_request', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN 'rejected';
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text)
RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id = p_request_id;

  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status <> 'processing' THEN RAISE EXCEPTION 'Only requests in Processing status can be cancelled (current status: %)', v_status; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'cancelled', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, withdrawal_request_id)
  VALUES (v_organizer_id, 'cancelled_payout_refund', v_amount_kobo,
          'Payout request cancelled by admin, funds returned — ' || p_reason, p_request_id);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'cancel_processing_payout', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN QUERY
  SELECT 'cancelled'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END; $function$;

-- ── Vents Cents (Super Admin only — "consolidate admin credits") ────────

CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(p_user_id uuid, p_amount numeric, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_amount <= 0 THEN
    RETURN 'invalid_amount';
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (p_user_id, p_amount::integer, 'earn', 'active', gen_random_uuid(), now());

  INSERT INTO public.vents_wallets (user_id, balance)
  VALUES (p_user_id, p_amount::integer)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.vents_wallets.balance + p_amount::integer, updated_at = now();

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Credited',
    p_amount || ' Vents Cents have been added to your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  -- Previously the ONLY VC admin action that didn't write an audit row —
  -- admin_debit_vents_cents already did (Block 19 audit logging expansion).
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'admin_vc_credit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason), public.actor_role());

  RETURN 'ok';
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_debit_vents_cents(p_user_id uuid, p_amount integer, p_reason text DEFAULT 'Admin debit'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_balance integer;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  PERFORM public._vc_deduct(p_user_id, p_amount, p_reason);

  SELECT balance INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Adjusted',
    p_amount || ' Vents Cents have been removed from your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'admin_vc_debit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason), public.actor_role());

  RETURN jsonb_build_object('debited', p_amount, 'target_balance', v_balance);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_get_vc_aggregates()
RETURNS TABLE (circulation numeric, total_txns bigint, credits bigint, debits bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT coalesce(sum(balance), 0) FROM public.vents_wallets)::numeric AS circulation,
    (SELECT count(*) FROM public.vc_transactions)::bigint AS total_txns,
    (SELECT count(*) FROM public.vc_transactions WHERE type IN ('earn', 'referral') AND status = 'active')::bigint AS credits,
    (SELECT count(*) FROM public.vc_transactions WHERE type = 'spend' AND status = 'spent')::bigint AS debits;
END;
$function$;

-- ── Organizer verification (Super Admin only — trust/eligibility change) ─

CREATE OR REPLACE FUNCTION public.admin_approve_organizer_verification(p_request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  SELECT user_id INTO v_user_id FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;
  UPDATE public.organizer_verification_requests
  SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;
  UPDATE public.users SET is_verified = true WHERE id = v_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'approve_organizer_verification', v_user_id,
          jsonb_build_object('request_id', p_request_id), public.actor_role());
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_reject_organizer_verification(p_request_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  SELECT user_id INTO v_user_id FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;
  UPDATE public.organizer_verification_requests
  SET status = 'rejected', admin_note = p_reason, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_organizer_verification', v_user_id,
          jsonb_build_object('request_id', p_request_id, 'reason', p_reason), public.actor_role());
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_list_organizer_verifications()
RETURNS TABLE(request_id uuid, user_id uuid, full_name text, email text, phone_number text, state text, company_name text, cac_number text, business_address text, document_url text, status text, created_at timestamp with time zone)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.user_id, u.full_name, u.email, u.phone_number, u.state,
    r.company_name, r.cac_number, r.business_address, r.document_url, r.status, r.created_at
  FROM public.organizer_verification_requests r
  JOIN public.users u ON u.id = r.user_id
  WHERE r.status = 'pending'
  ORDER BY r.created_at ASC;
END; $function$;

-- ── Events (Super Admin only — moderation/deletion beyond plain viewing) ─

CREATE OR REPLACE FUNCTION public.admin_hide_event(p_event_id uuid, p_reason text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  UPDATE public.events
  SET hidden_by_admin = true,
      hidden_at       = now(),
      hidden_by       = auth.uid()
  WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (
    auth.uid(),
    'hide_event',
    jsonb_build_object('event_id', p_event_id, 'reason', p_reason),
    public.actor_role()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reinstate_event(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  UPDATE public.events
  SET hidden_by_admin = false,
      hidden_at       = NULL,
      hidden_by       = NULL
  WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (
    auth.uid(),
    'reinstate_event',
    jsonb_build_object('event_id', p_event_id),
    public.actor_role()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_restore_deleted_event(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  UPDATE public.events
     SET deleted_at = NULL, deleted_by = NULL, reason = NULL, status = 'live'
   WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'restore_event', jsonb_build_object('event_id', p_event_id), public.actor_role());
END;
$function$;

-- soft_delete_event is dual-purpose: an organizer deleting their OWN event
-- (self-service, unaffected by role) or an admin force-deleting SOMEONE
-- ELSE's event (the override branch below — that override is the part
-- tightened to Super Admin only).
CREATE OR REPLACE FUNCTION public.soft_delete_event(p_event_id uuid, p_reason text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_owner   uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT organizer_id INTO v_owner FROM public.events WHERE id = p_event_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_owner <> v_user_id AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'You do not have permission to delete this event';
  END IF;

  UPDATE public.events
     SET deleted_at = now(),
         deleted_by = v_user_id,
         reason = p_reason,
         status = 'draft'
   WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (v_user_id, 'delete_event',
          jsonb_build_object('event_id', p_event_id, 'reason', p_reason),
          public.actor_role());
END;
$function$;

-- ── Refunds — the stuck-refund reverter is a financial correction beyond
-- a plain per-ticket refund, so it stays Super Admin only; refund_ticket
-- and attach_ticket_refund_id are untouched (Support Admin's explicit
-- "refund individual tickets" allowance) but attach_ticket_refund_id gets
-- its missing audit row.

CREATE OR REPLACE FUNCTION public.admin_revert_stuck_refund(p_ticket_id uuid, p_reason text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  SELECT id, user_id, payment_status INTO v_ticket
    FROM public.tickets
   WHERE id = p_ticket_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Only tickets awaiting refund can be reverted (current status: %)', v_ticket.payment_status;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid', status = 'active', refund_id = NULL
   WHERE id = p_ticket_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'admin_revert_stuck_refund', v_ticket.user_id,
    jsonb_build_object('ticket_id', p_ticket_id, 'reason', p_reason),
    public.actor_role()
  );

  RETURN 'reverted';
END;
$function$;

CREATE OR REPLACE FUNCTION public.attach_ticket_refund_id(p_ticket_id uuid, p_refund_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_status       text;
  v_user_id      uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT e.organizer_id, t.payment_status, t.user_id INTO v_organizer_id, v_status, v_user_id
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND auth.uid() <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Ticket is not awaiting a refund (status: %)', v_status;
  END IF;

  UPDATE public.tickets SET refund_id = p_refund_id WHERE id = p_ticket_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'attach_ticket_refund_id', v_user_id,
          jsonb_build_object('ticket_id', p_ticket_id, 'refund_id', p_refund_id), public.actor_role());
END;
$function$;

-- ── Users — role changes (Super Admin only, always was; simplified now
-- that the entry gate itself blocks Support Admin) ───────────────────────

CREATE OR REPLACE FUNCTION public.admin_set_user_role(p_user_id uuid, p_new_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_target_role text;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_new_role = 'sub-admin' THEN
    IF NOT public.is_root() THEN
      RAISE EXCEPTION 'Only Root can assign the Sub-Admin role';
    END IF;
  ELSIF p_new_role NOT IN ('attendee', 'organizer') THEN
    RAISE EXCEPTION 'Invalid role: % (allowed: attendee, organizer, sub-admin [Root only])', p_new_role;
  END IF;

  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin role cannot be changed';
  END IF;

  SELECT role INTO v_target_role FROM public.users WHERE id = p_user_id;

  UPDATE public.users SET role = p_new_role WHERE id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'role_change',
    p_user_id,
    jsonb_build_object('old_role', v_target_role, 'new_role', p_new_role),
    public.actor_role()
  );
END;
$function$;

-- ── System maintenance (Super Admin only) ────────────────────────────────

CREATE OR REPLACE FUNCTION public.cleanup_orphaned_records()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_tickets_cancelled int := 0;
  v_saves_removed int := 0;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  WITH updated AS (
    UPDATE public.tickets SET status = 'cancelled'
    WHERE status = 'active'
      AND NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = tickets.event_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_tickets_cancelled FROM updated;

  WITH deleted AS (
    DELETE FROM public.saved_events
    WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = saved_events.event_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_saves_removed FROM deleted;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'orphan_cleanup', NULL, jsonb_build_object(
    'tickets_cancelled', v_tickets_cancelled,
    'saves_removed', v_saves_removed
  ), public.actor_role());

  RETURN jsonb_build_object(
    'tickets_cancelled', v_tickets_cancelled,
    'saves_removed', v_saves_removed
  );
END; $function$;

CREATE OR REPLACE FUNCTION public.admin_health_ping()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_user_count bigint;
  v_event_count bigint;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  SELECT count(*) INTO v_user_count FROM public.users;
  SELECT count(*) INTO v_event_count FROM public.events;

  RETURN jsonb_build_object(
    'status', 'ok',
    'server_time', now(),
    'users_reachable', v_user_count,
    'events_reachable', v_event_count
  );
END;
$function$;

-- ── User bans/suspend/delete-restore — was a direct client-side table
-- UPDATE relying on RLS (admin_update_users: any admin tier) plus an
-- optional, non-atomic client-side writeAuditLog() call that a buggy or
-- malicious client could simply skip. Support Admin's allowed scope is
-- "view users/events, reset passwords, refund tickets" — banning isn't in
-- it, so this is now blocked for Support Admin server-side (not just in
-- the UI), and every actual status/ban change is logged unconditionally
-- as part of the same trigger that already protected Root/Admin-tier
-- accounts from Sub-Admin tampering, so it can't be bypassed by a direct
-- table update that skips the app's own audit-log call.
CREATE OR REPLACE FUNCTION public.protect_admin_tier_status_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_caller_role text;
  v_action text;
BEGIN
  -- Acting on your own account is always allowed — this trigger exists to
  -- stop OTHERS from altering an account's status, not to restrict
  -- self-service actions like delete_own_account.
  IF auth.uid() IS NOT NULL AND OLD.id = auth.uid() THEN
    RETURN NEW;
  END IF;

  -- Root's status/banned_until/deleted_at can never be touched by anyone
  -- else, full stop.
  IF OLD.id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root account status cannot be modified';
  END IF;

  SELECT role INTO v_caller_role FROM public.users WHERE id = auth.uid();

  -- Banning/suspending/deleting/restoring ANY account (not just other
  -- Admin/Sub-Admin accounts) is a Super Admin action.
  IF v_caller_role = 'sub-admin' THEN
    RAISE EXCEPTION 'Sub-Admins cannot modify account status — Super Admin (Admin/Root) required';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_action := CASE
      WHEN NEW.banned_until IS DISTINCT FROM OLD.banned_until AND NEW.banned_until IS NOT NULL THEN 'ban_user'
      WHEN NEW.banned_until IS DISTINCT FROM OLD.banned_until AND NEW.banned_until IS NULL THEN 'unban_user'
      WHEN NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL THEN 'delete_user'
      WHEN NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NULL THEN 'restore_user'
      WHEN NEW.status IS DISTINCT FROM OLD.status THEN 'status_change'
      ELSE NULL
    END;

    IF v_action IS NOT NULL THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        auth.uid(), v_action, OLD.id,
        jsonb_build_object(
          'old_status', OLD.status, 'new_status', NEW.status,
          'old_banned_until', OLD.banned_until, 'new_banned_until', NEW.banned_until
        ),
        public.actor_role()
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
