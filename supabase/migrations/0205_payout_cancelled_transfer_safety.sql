-- 0205: one payout state machine for organizer_withdrawal_requests, with
-- immutable financial history, deletion protection, and an admin
-- integrity report.
--
-- STATUS: NOT APPLIED to production. Apply only after 0201 -> 0202 -> 0203,
-- in its own transaction (psql -1 / SQL editor), never with
-- `supabase db push`. Verify the result with pg_get_functiondef /
-- pg_trigger afterwards.
--
-- Consolidates PR #84 into PR #82 (Batch D §11, item T1). PR #84 wrote its
-- own 0205 against an older 0202. That version patched
-- complete_organizer_payout and pinned 0203's body by md5, so it refuses to
-- run on this branch. This file keeps #84's safety rules and drops the
-- parts this branch already has:
--   * complete_organizer_payout is NOT touched. This branch's 0202 already
--     resolves a late Paystack success on a cancelled request from
--     evidence: it takes money back only if a cancelled_payout_refund row
--     exists; it completes from pending only if pending is not owed to
--     another open request; otherwise it returns needs_review, moves no
--     money and records a payout_exceptions row. Verified by
--     scripts/local-pg-test/run-payout-incident-replay.sh.
--   * No md5 / body dependency. The prerequisite check below only looks
--     for the objects 0202 and 0203 create.
--
-- Incident (Batch D §9): on 2026-07-12 a raw UPDATE ("platform launch
-- sweep", migrations/20260713100000_admin-stats-and-payout-cleanup.sql)
-- set four 'processing' requests with live Paystack transfer codes to
-- 'cancelled'. Paystack had paid all four (owner-confirmed). The statement
-- bypassed every payout function. This migration makes that statement,
-- and any like it, fail.
--
-- What it does:
--   1. Replaces 0202's organizer_withdrawal_transfer_guard with ONE
--      BEFORE UPDATE trigger, organizer_withdrawal_requests_guard, which
--      enforces:
--        - a withdrawal's owner and amount never change;
--        - an existing Paystack reference or transfer code never changes
--          or is cleared;
--        - final states stay final: failed, rejected and reversed never
--          change; completed may only become reversed; cancelled may only
--          become completed (a late Paystack success, resolved by
--          complete_organizer_payout);
--        - only a completed request can be reversed;
--        - the two-admin authorization (0203 approval_* columns) can only be
--          recorded by approve_admin_action for the request's own pending
--          authorize_withdrawal request, by the approving super admin, and
--          never changes afterwards; a pending request cannot become
--          'processing' without it (added 2026-11-04 audit);
--        - once a transfer may exist (a transfer code, or 'processing'
--          with a reference) a request cannot be cancelled or rejected,
--          and with a transfer code it cannot return to pending.
--   2. A BEFORE DELETE trigger: a request with payout history (a
--      reference, a transfer code, or any status other than pending,
--      rejected or cancelled) cannot be deleted. In-app account deletion
--      is a soft delete (0134), so it is unaffected; a hard delete of a
--      paid organizer's auth user, which cascades, now fails instead of
--      erasing the payout record.
--   3. admin_payout_integrity_report(): read-only, admins only. Lists every
--      request whose status and money disagree, including the four
--      incident requests and every unresolved payout_exceptions row.
--      admin_list_payout_exceptions() (0202) is unchanged; the API's
--      report-only Paystack check keeps using it.
--
-- No balance, ledger row or request is changed by applying this file.
-- Undo (0205 only): supabase/rollback/undo_0205.sql.

-- ---------------------------------------------------------------------------
-- Prerequisites: 0202 and 0203 applied (objects only; no body pinning).
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF to_regclass('public.payout_exceptions') IS NULL
     OR to_regprocedure('public.admin_list_payout_exceptions()') IS NULL THEN
    RAISE EXCEPTION '0205: apply 0202 first (payout_exceptions / admin_list_payout_exceptions missing)';
  END IF;
  IF to_regprocedure('public.execute_withdrawal_authorization(uuid)') IS NULL THEN
    RAISE EXCEPTION '0205: apply 0203 first (execute_withdrawal_authorization missing)';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Did cancelling this request put its money back?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payout_cancel_returned_funds(p_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Pre-0202 admin_cancel_processing_payout wrote a cancelled_payout_refund
  -- ledger row; 0202's cancel (no transfer only) writes no ledger row but
  -- logs cancel_processing_payout. A raw UPDATE leaves neither.
  SELECT EXISTS (SELECT 1 FROM public.organizer_transactions t
                  WHERE t.withdrawal_request_id = p_request_id AND t.type = 'cancelled_payout_refund')
      OR EXISTS (SELECT 1 FROM public.admin_logs l
                  WHERE l.action = 'cancel_processing_payout' AND l.details->>'request_id' = p_request_id::text)
$function$;
REVOKE ALL ON FUNCTION public.payout_cancel_returned_funds(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. The payout state machine (replaces 0202's transfer guard)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.organizer_withdrawal_requests_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_has_transfer boolean := OLD.transfer_code IS NOT NULL;
BEGIN
  IF NEW.organizer_id IS DISTINCT FROM OLD.organizer_id OR NEW.amount_kobo IS DISTINCT FROM OLD.amount_kobo THEN
    RAISE EXCEPTION 'Withdrawal %: its owner and amount cannot be changed', OLD.id;
  END IF;
  IF OLD.transfer_code IS NOT NULL AND NEW.transfer_code IS DISTINCT FROM OLD.transfer_code THEN
    RAISE EXCEPTION 'Withdrawal %: its Paystack transfer code cannot be changed or cleared', OLD.id;
  END IF;
  IF OLD.paystack_reference IS NOT NULL AND NEW.paystack_reference IS DISTINCT FROM OLD.paystack_reference THEN
    RAISE EXCEPTION 'Withdrawal %: its Paystack reference cannot be changed or cleared', OLD.id;
  END IF;

  -- Two-admin authorization (0203) cannot be forged, altered or erased by a
  -- raw UPDATE. Once set it never changes. It can only be set inside
  -- approve_admin_action for this request's own pending authorize_withdrawal
  -- request, by the super admin approving it, who is not the requester.
  IF NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.approval_requested_by IS DISTINCT FROM OLD.approval_requested_by
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_recipient_code IS DISTINCT FROM OLD.approved_recipient_code THEN
    IF OLD.approved_by IS NOT NULL OR OLD.approval_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'Withdrawal %: its two-admin authorization cannot be changed or cleared', OLD.id;
    END IF;
    IF NEW.approved_by IS NULL OR NEW.approval_request_id IS NULL OR NEW.approved_recipient_code IS NULL
       OR NEW.approved_by IS DISTINCT FROM auth.uid() OR NOT public.is_super_admin()
       OR NOT EXISTS (SELECT 1 FROM public.admin_action_requests q
                       WHERE q.id = NEW.approval_request_id AND q.action_type = 'authorize_withdrawal'
                         AND q.target_id = OLD.id AND q.status = 'pending'
                         AND q.requested_by = NEW.approval_requested_by
                         AND q.requested_by IS DISTINCT FROM NEW.approved_by) THEN
      RAISE EXCEPTION 'Withdrawal %: a two-admin authorization can only be recorded by approve_admin_action for its own authorize_withdrawal request', OLD.id;
    END IF;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Once a transfer may exist, only Paystack's outcome ends the request.
  IF NEW.status IN ('cancelled', 'rejected', 'pending')
     AND (v_has_transfer
          OR (NEW.status <> 'pending' AND OLD.status = 'processing' AND OLD.paystack_reference IS NOT NULL)) THEN
    RAISE EXCEPTION 'Withdrawal %: a Paystack transfer exists or may exist (%), so it cannot be set to %; only Paystack''s outcome (completed, failed, reversed) can end it. Use Reconcile.',
      OLD.id, COALESCE(OLD.transfer_code, OLD.paystack_reference), NEW.status;
  END IF;

  -- Only an authorized request may be claimed for Paystack (0203's claim
  -- enforces this; this stops a raw UPDATE from skipping it).
  IF OLD.status = 'pending' AND NEW.status = 'processing' AND NEW.approved_by IS NULL THEN
    RAISE EXCEPTION 'Withdrawal %: it needs two-admin authorization before it can be claimed for payment', OLD.id;
  END IF;

  -- Final states stay final.
  IF OLD.status IN ('failed', 'rejected', 'reversed')
     OR (OLD.status = 'completed' AND NEW.status <> 'reversed')
     OR (OLD.status = 'cancelled' AND NEW.status <> 'completed') THEN
    RAISE EXCEPTION 'Withdrawal %: a final status cannot change (% -> %)', OLD.id, OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'reversed' AND OLD.status <> 'completed' THEN
    RAISE EXCEPTION 'Withdrawal %: only a completed request can be reversed (it is %)', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.organizer_withdrawal_requests_guard() FROM PUBLIC, anon, authenticated;

-- One guard, not two: 0202's transfer guard is a subset of the rules above.
DROP TRIGGER IF EXISTS organizer_withdrawal_transfer_guard ON public.organizer_withdrawal_requests;
DROP FUNCTION IF EXISTS public.organizer_withdrawal_transfer_guard();

DROP TRIGGER IF EXISTS organizer_withdrawal_requests_guard ON public.organizer_withdrawal_requests;
CREATE TRIGGER organizer_withdrawal_requests_guard
  BEFORE UPDATE ON public.organizer_withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.organizer_withdrawal_requests_guard();

-- ---------------------------------------------------------------------------
-- 2. Payout history cannot be deleted
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.organizer_withdrawal_requests_no_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF OLD.transfer_code IS NOT NULL OR OLD.paystack_reference IS NOT NULL
     OR OLD.status NOT IN ('pending', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'Withdrawal %: it has payout history and cannot be deleted', OLD.id;
  END IF;
  RETURN OLD;
END;
$function$;
REVOKE ALL ON FUNCTION public.organizer_withdrawal_requests_no_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organizer_withdrawal_requests_no_delete ON public.organizer_withdrawal_requests;
CREATE TRIGGER organizer_withdrawal_requests_no_delete
  BEFORE DELETE ON public.organizer_withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.organizer_withdrawal_requests_no_delete();

-- ---------------------------------------------------------------------------
-- 3. Integrity report (read-only, admins only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_payout_integrity_report()
 RETURNS TABLE(request_id uuid, organizer_id uuid, amount_kobo bigint, status text,
               transfer_code text, paystack_reference text, issue text, detail text)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN QUERY
  WITH r AS (
    SELECT q.*,
           EXISTS (SELECT 1 FROM public.organizer_transactions t
                    WHERE t.withdrawal_request_id = q.id AND t.type = 'payout') AS has_payout_row,
           public.payout_cancel_returned_funds(q.id) AS returned
      FROM public.organizer_withdrawal_requests q
  )
  SELECT r.id, r.organizer_id, r.amount_kobo, r.status, r.transfer_code, r.paystack_reference, x.issue, x.detail
    FROM r
    CROSS JOIN LATERAL (VALUES
      (CASE WHEN r.status IN ('cancelled', 'rejected', 'failed') AND r.transfer_code IS NOT NULL
                 AND NOT r.has_payout_row AND NOT r.returned
            THEN 'transfer_on_' || r.status || '_request_funds_not_returned' END,
       'A Paystack transfer exists, no payout is recorded, and the money was not returned to the balance. Ask Paystack (Check payout exceptions); if it was paid, record it through the dual-control adjustment (D10).'),
      (CASE WHEN r.status IN ('cancelled', 'rejected', 'failed') AND r.transfer_code IS NOT NULL
                 AND NOT r.has_payout_row AND r.returned
            THEN 'transfer_on_' || r.status || '_request_funds_returned' END,
       'A Paystack transfer exists and the money was returned to the balance. If Paystack paid it, the organizer was paid twice.'),
      (CASE WHEN r.status = 'completed' AND NOT r.has_payout_row
            THEN 'completed_without_ledger_payout' END,
       'Completed with no linked payout ledger row.'),
      (CASE WHEN r.status = 'processing' AND r.updated_at < now() - interval '1 day'
            THEN 'processing_over_a_day' END,
       'Ask Paystack (Reconcile) for the outcome.')
    ) AS x(issue, detail)
   WHERE x.issue IS NOT NULL
  UNION ALL
  SELECT e.request_id, e.organizer_id, e.amount_kobo, q.status, q.transfer_code, q.paystack_reference,
         'exception_' || e.kind,
         'Recorded by complete_organizer_payout at ' || e.detected_at || '; no money was moved. Unresolved.'
    FROM public.payout_exceptions e
    JOIN public.organizer_withdrawal_requests q ON q.id = e.request_id
   WHERE e.resolved_at IS NULL
  UNION ALL
  SELECT NULL::uuid, t.organizer_id, t.amount_kobo, NULL::text, NULL::text, NULL::text,
         'ledger_payout_without_request',
         'Payout ledger row ' || t.id || ' (' || COALESCE(t.description, '') || ') is linked to no withdrawal request.'
    FROM public.organizer_transactions t
   WHERE t.type = 'payout' AND t.withdrawal_request_id IS NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_payout_integrity_report() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_payout_integrity_report() TO authenticated;
