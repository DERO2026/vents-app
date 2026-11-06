-- 0207: audited two-admin reassignment of a pending withdrawal's bank
-- account (Batch D D4a / T3).
--
-- STATUS: NOT APPLIED to production. Apply only after 0201 -> 0202 -> 0203
-- -> 0205 (-> 0206), in its own transaction, never with `supabase db push`.
-- Applying it changes no withdrawal, wallet or ledger row. Undo (only while
-- nothing has been reassigned): supabase/rollback/undo_0207.sql.
--
-- Why (Batch D §10.1): every pending request of one organizer points at a
-- bank account the organizer has since deactivated. 0203's claim refuses an
-- inactive account, and nothing could move a request to the organizer's
-- active account, so the only way out was to reject the request, which the
-- owner has ruled out (D4). This action moves a PENDING, NOT YET AUTHORIZED,
-- never-sent request to another ACTIVE, VERIFIED account OF THE SAME
-- ORGANIZER. Nothing else changes: not the amount, not the reference, not
-- the wallet, not the ledger.
--
-- Built on the existing maker-checker, exactly like 0203's
-- authorize_withdrawal and 0206's earnings_adjustment:
--   admin_request_withdrawal_bank_reassignment (snapshots server-side)
--     -> request_admin_action('reassign_withdrawal_bank_account', 'withdrawal', <request>)
--     -> approve_admin_action (super admin, not the requester)
--     -> execute_withdrawal_bank_reassignment (this file; not client-callable)
-- After it, the request still needs the normal two-admin authorize_withdrawal
-- (0203), which binds the NEW recipient, and then the claim (0202/0203/0205
-- rules unchanged).
--
-- Rules enforced at execution, inside the approval transaction:
--   * two distinct admins: requester still an admin; approver a super admin
--     who is not the requester; neither is the withdrawal's organizer (also a
--     table CHECK);
--   * the withdrawal is pending, not authorized, has no Paystack reference or
--     transfer code, and has not changed since the request (status, bank
--     account, updated_at);
--   * the new account belongs to the withdrawal's organizer, is active, has a
--     verified Paystack recipient, differs from the current one, and has not
--     changed since the request (is_active, recipient fingerprint,
--     updated_at);
--   * request under 7 days old; reason of at least 20 characters;
--   * idempotent (one execution per admin request); append-only record;
--   * audit: admin_logs + the reassignment record hold account IDs and MASKED
--     numbers only (last 4 digits). No full account number or recipient code
--     is copied anywhere.
-- A new trigger also makes the destination of a withdrawal (bank_account_id
-- and its bank snapshot columns) changeable ONLY by this executor. The one
-- exception is bank_account_id becoming NULL through the existing
-- ON DELETE SET NULL foreign key.

-- ---------------------------------------------------------------------------
-- Prerequisites (objects only; no body pinning)
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF to_regprocedure('public.execute_withdrawal_authorization(uuid)') IS NULL THEN
    RAISE EXCEPTION '0207: apply 0203 first (execute_withdrawal_authorization missing)';
  END IF;
  IF to_regprocedure('public.organizer_withdrawal_requests_guard()') IS NULL THEN
    RAISE EXCEPTION '0207: apply 0205 first (organizer_withdrawal_requests_guard missing)';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- The reassignment record (append-only; masked bank details only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.withdrawal_bank_reassignments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_request_id       uuid NOT NULL UNIQUE REFERENCES public.admin_action_requests(id) ON DELETE RESTRICT,
  withdrawal_request_id  uuid NOT NULL REFERENCES public.organizer_withdrawal_requests(id) ON DELETE RESTRICT,
  organizer_id           uuid NOT NULL,
  old_bank_account_id    uuid,
  new_bank_account_id    uuid NOT NULL,
  old_account_masked     text,
  new_account_masked     text NOT NULL,
  reason                 text NOT NULL CHECK (length(btrim(reason)) >= 20),
  requested_by           uuid NOT NULL,
  approved_by            uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT withdrawal_bank_reassignments_two_admins
    CHECK (requested_by <> approved_by AND requested_by <> organizer_id AND approved_by <> organizer_id),
  CONSTRAINT withdrawal_bank_reassignments_changes_account
    CHECK (old_bank_account_id IS DISTINCT FROM new_bank_account_id)
);
ALTER TABLE public.withdrawal_bank_reassignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.withdrawal_bank_reassignments FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.withdrawal_bank_reassignments_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'withdrawal_bank_reassignments is append-only: % is not allowed', TG_OP;
END;
$function$;
REVOKE ALL ON FUNCTION public.withdrawal_bank_reassignments_append_only() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS withdrawal_bank_reassignments_append_only ON public.withdrawal_bank_reassignments;
CREATE TRIGGER withdrawal_bank_reassignments_append_only
  BEFORE UPDATE OR DELETE ON public.withdrawal_bank_reassignments
  FOR EACH ROW EXECUTE FUNCTION public.withdrawal_bank_reassignments_append_only();

-- ---------------------------------------------------------------------------
-- A withdrawal's destination changes only through the executor
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.organizer_withdrawal_destination_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF (NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id AND NEW.bank_account_id IS NOT NULL)
     OR NEW.bank_name IS DISTINCT FROM OLD.bank_name
     OR NEW.bank_code IS DISTINCT FROM OLD.bank_code
     OR NEW.account_number IS DISTINCT FROM OLD.account_number
     OR NEW.account_name IS DISTINCT FROM OLD.account_name THEN
    IF current_setting('vents.withdrawal_reassign_executor', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Withdrawal %: its destination bank account can only be changed by an approved reassign_withdrawal_bank_account action', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.organizer_withdrawal_destination_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS organizer_withdrawal_destination_guard ON public.organizer_withdrawal_requests;
CREATE TRIGGER organizer_withdrawal_destination_guard
  BEFORE UPDATE ON public.organizer_withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.organizer_withdrawal_destination_guard();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mask_account_number(p text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO ''
AS $$ SELECT CASE WHEN p IS NULL OR length(p) = 0 THEN NULL ELSE '****' || right(p, 4) END $$;

-- Shared validation. p_check_snapshot = false at request time (the
-- snapshot is being taken), true at execution.
CREATE OR REPLACE FUNCTION public.withdrawal_reassignment_validate(p_withdrawal_request_id uuid, p jsonb, p_check_snapshot boolean)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  w public.organizer_withdrawal_requests;
  b public.organizer_bank_accounts;
BEGIN
  IF length(btrim(COALESCE(p->>'reason', ''))) < 20 THEN
    RAISE EXCEPTION 'A reason of at least 20 characters is required';
  END IF;
  IF p->>'new_bank_account_id' IS NULL THEN RAISE EXCEPTION 'payload.new_bank_account_id is required'; END IF;

  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = p_withdrawal_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending withdrawal can be moved to another bank account (it is %)', w.status;
  END IF;
  IF w.approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'This withdrawal is already authorized for its current account; it cannot be moved';
  END IF;
  IF w.paystack_reference IS NOT NULL OR w.transfer_code IS NOT NULL THEN
    RAISE EXCEPTION 'A Paystack transfer was attempted for this withdrawal; it cannot be moved. Reconcile it first';
  END IF;

  SELECT * INTO b FROM public.organizer_bank_accounts WHERE id = (p->>'new_bank_account_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'The new bank account does not exist'; END IF;
  IF b.organizer_id <> w.organizer_id THEN
    RAISE EXCEPTION 'The new bank account belongs to someone else; a withdrawal can only move to its own organizer''s account';
  END IF;
  IF NOT COALESCE(b.is_active, false) THEN RAISE EXCEPTION 'The new bank account is not active'; END IF;
  IF b.recipient_code IS NULL OR length(btrim(b.recipient_code)) = 0 THEN
    RAISE EXCEPTION 'The new bank account has no verified Paystack recipient';
  END IF;
  IF w.bank_account_id IS NOT DISTINCT FROM b.id THEN
    RAISE EXCEPTION 'The withdrawal already uses this bank account';
  END IF;

  IF p_check_snapshot THEN
    IF w.bank_account_id IS DISTINCT FROM (p->>'old_bank_account_id')::uuid
       OR w.updated_at IS DISTINCT FROM (p->>'expected_withdrawal_updated_at')::timestamptz THEN
      RAISE EXCEPTION 'The withdrawal changed since this reassignment was requested; file a new request';
    END IF;
    IF b.updated_at IS DISTINCT FROM (p->>'expected_new_account_updated_at')::timestamptz
       OR md5(b.recipient_code) IS DISTINCT FROM p->>'new_recipient_fingerprint' THEN
      RAISE EXCEPTION 'The new bank account changed since this reassignment was requested; file a new request';
    END IF;
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Requester helper (validates and snapshots server-side)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_request_withdrawal_bank_reassignment(
  p_withdrawal_request_id uuid, p_new_bank_account_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  w public.organizer_withdrawal_requests;
  b public.organizer_bank_accounts;
  v_payload jsonb;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = p_withdrawal_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.organizer_id = auth.uid() THEN
    RAISE EXCEPTION 'An admin cannot request a change to their own withdrawal';
  END IF;
  v_payload := jsonb_build_object('reason', p_reason, 'new_bank_account_id', p_new_bank_account_id);
  PERFORM public.withdrawal_reassignment_validate(p_withdrawal_request_id, v_payload, false);
  SELECT * INTO b FROM public.organizer_bank_accounts WHERE id = p_new_bank_account_id;

  v_payload := v_payload || jsonb_build_object(
    'old_bank_account_id', w.bank_account_id,
    'expected_withdrawal_updated_at', w.updated_at,
    'expected_new_account_updated_at', b.updated_at,
    'new_recipient_fingerprint', md5(b.recipient_code),
    'amount_kobo', w.amount_kobo,
    'old_account_masked', (SELECT COALESCE(o.bank_name, '') || ' ' || COALESCE(public.mask_account_number(o.account_number), '')
                             FROM public.organizer_bank_accounts o WHERE o.id = w.bank_account_id),
    'new_account_masked', COALESCE(b.bank_name, '') || ' ' || COALESCE(public.mask_account_number(b.account_number), ''));

  RETURN public.request_admin_action('reassign_withdrawal_bank_account', 'withdrawal', p_withdrawal_request_id,
    'withdrawal ' || left(p_withdrawal_request_id::text, 8) || ' -> ' || (v_payload->>'new_account_masked'),
    v_payload, NULL, NULL, NULL);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Executor: runs only inside approve_admin_action
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.execute_withdrawal_bank_reassignment(p_admin_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
  w public.organizer_withdrawal_requests;
  b public.organizer_bank_accounts;
  v_approver uuid := auth.uid();
  v_id uuid := gen_random_uuid();
  v_old_masked text;
BEGIN
  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_admin_request_id;
  IF NOT FOUND OR r.action_type <> 'reassign_withdrawal_bank_account' THEN
    RAISE EXCEPTION 'Not a withdrawal bank reassignment request';
  END IF;
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF v_approver IS NULL OR r.requested_by = v_approver THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;
  IF r.target_type IS DISTINCT FROM 'withdrawal' OR r.target_id IS NULL THEN
    RAISE EXCEPTION 'A reassignment must target exactly one withdrawal request';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = r.requested_by AND u.role IN ('admin', 'sub-admin'))
     AND r.requested_by <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RAISE EXCEPTION 'The requesting admin is no longer an admin';
  END IF;
  IF r.requested_at < now() - interval '7 days' THEN
    RAISE EXCEPTION 'This reassignment request is older than 7 days; file a new one';
  END IF;
  IF EXISTS (SELECT 1 FROM public.withdrawal_bank_reassignments x WHERE x.admin_request_id = r.id) THEN
    RAISE EXCEPTION 'This reassignment has already been executed';
  END IF;

  -- Lock both rows, then re-validate everything against the snapshot.
  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = r.target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.organizer_id IN (r.requested_by, v_approver) THEN
    RAISE EXCEPTION 'An admin cannot request or approve a change to their own withdrawal';
  END IF;
  SELECT * INTO b FROM public.organizer_bank_accounts WHERE id = (r.payload->>'new_bank_account_id')::uuid FOR UPDATE;
  PERFORM public.withdrawal_reassignment_validate(w.id, r.payload, true);

  SELECT COALESCE(o.bank_name, '') || ' ' || COALESCE(public.mask_account_number(o.account_number), '')
    INTO v_old_masked FROM public.organizer_bank_accounts o WHERE o.id = w.bank_account_id;

  PERFORM set_config('vents.withdrawal_reassign_executor', 'on', true);
  UPDATE public.organizer_withdrawal_requests
     SET bank_account_id = b.id,
         bank_name = b.bank_name, bank_code = b.bank_code,
         account_number = b.account_number, account_name = b.account_name,
         updated_at = now()
   WHERE id = w.id;
  PERFORM set_config('vents.withdrawal_reassign_executor', 'off', true);

  INSERT INTO public.withdrawal_bank_reassignments (id, admin_request_id, withdrawal_request_id, organizer_id,
    old_bank_account_id, new_bank_account_id, old_account_masked, new_account_masked, reason, requested_by, approved_by)
  VALUES (v_id, r.id, w.id, w.organizer_id, w.bank_account_id, b.id, v_old_masked,
    COALESCE(b.bank_name, '') || ' ' || COALESCE(public.mask_account_number(b.account_number), ''),
    r.payload->>'reason', r.requested_by, v_approver);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (v_approver, 'withdrawal_bank_reassigned', w.organizer_id,
          jsonb_build_object('reassignment_id', v_id, 'admin_request_id', r.id, 'request_id', w.id,
                             'amount_kobo', w.amount_kobo,
                             'old_bank_account_id', w.bank_account_id, 'new_bank_account_id', b.id,
                             'old_account', v_old_masked,
                             'new_account', COALESCE(b.bank_name, '') || ' ' || COALESCE(public.mask_account_number(b.account_number), ''),
                             'requested_by', r.requested_by, 'approved_by', v_approver, 'reason', r.payload->>'reason'),
          public.actor_role());
END;
$function$;

-- ---------------------------------------------------------------------------
-- Wire into the maker-checker (anchored, idempotent)
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_anchor text;
  v_count integer;
BEGIN
  v_def := pg_get_functiondef('public.approve_admin_action(uuid)'::regprocedure);
  IF position('execute_withdrawal_bank_reassignment' IN v_def) = 0 THEN
    v_anchor := E'      ELSIF r.action_type = ''resolve_booking_dispute'' THEN\n';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION '0207: approve_admin_action anchor found % times (expected 1; is 0203 applied?)', v_count;
    END IF;
    EXECUTE replace(v_def, v_anchor,
      E'      ELSIF r.action_type = ''reassign_withdrawal_bank_account'' THEN\n' ||
      E'        PERFORM public.execute_withdrawal_bank_reassignment(r.id);\n' || v_anchor);
  END IF;

  v_def := pg_get_functiondef('public.request_admin_action(text,text,uuid,text,jsonb,jsonb,jsonb,text)'::regprocedure);
  IF position('reassign_withdrawal_bank_account' IN v_def) = 0 THEN
    v_anchor := E'''authorize_withdrawal'', ''resolve_booking_dispute''';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION '0207: request_admin_action anchor found % times (expected 1; is 0203 applied?)', v_count;
    END IF;
    EXECUTE replace(v_def, v_anchor, v_anchor || E', ''reassign_withdrawal_bank_account''');
  END IF;
END
$patch$;

-- ---------------------------------------------------------------------------
-- Grants: only the requester helper is client-callable (admins, checked inside).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.execute_withdrawal_bank_reassignment(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.withdrawal_reassignment_validate(uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mask_account_number(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_request_withdrawal_bank_reassignment(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_request_withdrawal_bank_reassignment(uuid, uuid, text) TO authenticated;
