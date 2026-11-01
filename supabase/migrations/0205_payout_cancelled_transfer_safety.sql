-- 0205: payouts -- a paid transfer is never treated as cancelled money,
-- and withdrawal status can only move along the payout engine's rules.
--
-- STATUS: NOT APPLIED to production. Apply only after 0201 -> 0202 -> 0203,
-- in its own transaction, never with `supabase db push`. It refuses to run
-- unless complete_organizer_payout carries 0203's exact patched body.
--
-- Incident (evidence read-only from production, 2026-10-31; Paystack
-- outcome confirmed by the owner):
--   Requests 3aa0f8ff, f9fda363, 6ad1272d, 56b084bb (₦100 each, organizer
--   91b0afb4, 2026-07-09/10) were sent to Paystack LIVE and PAID (₦400,
--   plus ₦40 fees). VENTS shows them 'cancelled', with no ledger row and
--   no effect on total_withdrawn.
--
-- Root cause: migrations/20260713100000_admin-stats-and-payout-cleanup.sql
-- ("platform launch sweep") ran a raw
--     UPDATE organizer_withdrawal_requests SET status = 'cancelled' ...
--      WHERE status IN ('pending', 'processing')
-- for the test account. All four rows were 'processing' with a live
-- transfer_code. The statement bypassed every payout function: it did not
-- ask Paystack, return money, release pending or write a ledger row. All
-- four rows carry its admin_note and the same updated_at
-- (2026-07-12 23:41:28.542), with resolved_by NULL. The success webhooks
-- had not completed them before the sweep (no ledger row exists), so
-- after the sweep nothing ever could: complete_organizer_payout then
-- completed only 'pending'/'processing' rows.
--
-- Why 0202 alone is not safe for these rows: 0202's
-- complete_organizer_payout assumes a 'cancelled' row's money "was
-- returned to the balance" and takes it back from the available balance,
-- and 0203 turns any shortfall into an earnings_recoveries receivable. For
-- the sweep rows nothing was returned, so a replayed transfer.success
-- (e.g. "resend" in the Paystack dashboard) would charge the organizer a
-- second time for money they already received -- ₦400 out of the balance
-- that funds their other withdrawals. Production has exactly these four
-- 'cancelled' rows; all have a transfer and none has a refund ledger row.
--
-- This migration:
--   1. complete_organizer_payout takes money back from a cancelled request
--      only with positive evidence that the cancel returned it (a
--      'cancelled_payout_refund' ledger row, or 0202's
--      'cancel_processing_payout' admin log). Otherwise it moves no money,
--      creates no receivable, leaves the request as it is, logs
--      'payout_success_on_unrefunded_cancel' once, and returns
--      'needs_review'. Correcting the books is an owner decision (D3).
--   2. A trigger enforces the payout state machine on every UPDATE,
--      including raw SQL: a request with a Paystack transfer can never be
--      cancelled or rejected, final states stay final, and the transfer
--      reference, transfer code, amount and owner cannot be rewritten.
--   3. admin_payout_integrity_report(): read-only, admins only. It lists
--      every request whose status and money disagree, including these four.
--
-- No balance, ledger row or request is changed by applying this file.

-- ---------------------------------------------------------------------------
-- Prerequisite: 0203's complete_organizer_payout, byte for byte.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.complete_organizer_payout(text)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION '0205: complete_organizer_payout(text) does not exist';
  END IF;
  IF position('[0205]' IN v_src) > 0 THEN
    RETURN;  -- already applied
  END IF;
  IF position('[0203]' IN v_src) = 0 THEN
    RAISE EXCEPTION '0205: apply 0201, 0202 and 0203 first (complete_organizer_payout has no [0203] marker)';
  END IF;
  IF md5(v_src) <> 'dbcccdb9de313981b6ab81e899e3cd63' THEN
    RAISE EXCEPTION '0205: complete_organizer_payout differs from 0203''s body (md5 %); refusing', md5(v_src);
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1. Did cancelling this request put its money back?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payout_cancel_returned_funds(p_request_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- Pre-0202 admin_cancel_processing_payout wrote a cancelled_payout_refund
  -- ledger row; 0202's cancel writes no ledger row but logs
  -- cancel_processing_payout. A raw UPDATE leaves neither.
  SELECT EXISTS (SELECT 1 FROM public.organizer_transactions t
                  WHERE t.withdrawal_request_id = p_request_id AND t.type = 'cancelled_payout_refund')
      OR EXISTS (SELECT 1 FROM public.admin_logs l
                  WHERE l.action = 'cancel_processing_payout' AND l.details->>'request_id' = p_request_id::text)
$function$;
REVOKE ALL ON FUNCTION public.payout_cancel_returned_funds(uuid) FROM PUBLIC, anon, authenticated;

DO $patch$
DECLARE
  v_def text;
  -- The new check runs before the wallet row is locked and changed.
  v_anchor text := E'  SELECT w.balance_kobo INTO v_balance FROM public.organizer_wallets w\n';
  v_new text := E'  IF v_status = ''cancelled'' AND NOT public.payout_cancel_returned_funds(v_id) THEN\n'
    || E'    -- [0205] Nothing was returned when this request was cancelled (a raw\n'
    || E'    -- status edit, e.g. the 2026-07-12 sweep): the organizer already has\n'
    || E'    -- this money. Move nothing, create no receivable; flag it once.\n'
    || E'    IF NOT EXISTS (SELECT 1 FROM public.admin_logs l\n'
    || E'                    WHERE l.action = ''payout_success_on_unrefunded_cancel''\n'
    || E'                      AND l.details->>''request_id'' = v_id::text) THEN\n'
    || E'      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)\n'
    || E'      VALUES (auth.uid(), ''payout_success_on_unrefunded_cancel'', v_organizer_id,\n'
    || E'              jsonb_build_object(''request_id'', v_id, ''lookup_key'', p_request_id, ''amount_kobo'', v_amount_kobo,\n'
    || E'                                 ''note'', ''Paystack reports this transfer paid; the request was cancelled without returning funds. No balance or ledger change was made.''),\n'
    || E'              COALESCE(public.actor_role(), ''system:project_admin''));\n'
    || E'    END IF;\n'
    || E'    RETURN QUERY SELECT ''needs_review''::text, NULL::text, NULL::text, v_amount_kobo;\n'
    || E'    RETURN;\n'
    || E'  END IF;\n\n';
  v_n int;
BEGIN
  IF position('[0205]' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.complete_organizer_payout(text)'::regprocedure)) > 0 THEN
    RETURN;
  END IF;
  v_def := pg_get_functiondef('public.complete_organizer_payout(text)'::regprocedure);
  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0205: anchor found % times in complete_organizer_payout (expected 1)', v_n;
  END IF;
  v_def := replace(v_def, v_anchor, v_new || v_anchor);
  v_def := replace(v_def, E'AS $function$\n', E'AS $function$\n-- [0205] patched by 0205_payout_cancelled_transfer_safety.sql\n');
  EXECUTE v_def;
END
$patch$;

-- ---------------------------------------------------------------------------
-- 2. The payout state machine, enforced on every UPDATE (raw SQL included)
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
    RAISE EXCEPTION 'payout_guard: a withdrawal''s owner and amount cannot change (request %)', OLD.id;
  END IF;
  IF OLD.paystack_reference IS NOT NULL AND NEW.paystack_reference IS DISTINCT FROM OLD.paystack_reference THEN
    RAISE EXCEPTION 'payout_guard: the Paystack reference of request % cannot change', OLD.id;
  END IF;
  IF OLD.transfer_code IS NOT NULL AND NEW.transfer_code IS DISTINCT FROM OLD.transfer_code THEN
    RAISE EXCEPTION 'payout_guard: the Paystack transfer code of request % cannot change', OLD.id;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Final states. 'cancelled' may still become 'completed' through
  -- complete_organizer_payout (Paystack paid a request cancelled before 0202).
  IF OLD.status IN ('failed', 'rejected', 'reversed')
     OR (OLD.status = 'completed' AND NEW.status <> 'reversed')
     OR (OLD.status = 'cancelled' AND NEW.status <> 'completed') THEN
    RAISE EXCEPTION 'payout_guard: request % cannot go from % to %', OLD.id, OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'reversed' AND OLD.status <> 'completed' THEN
    RAISE EXCEPTION 'payout_guard: only a completed request can be reversed (request % is %)', OLD.id, OLD.status;
  END IF;

  -- Once a transfer may exist, only Paystack's outcome ends the request.
  IF NEW.status IN ('cancelled', 'rejected') THEN
    IF v_has_transfer OR (OLD.status = 'processing' AND OLD.paystack_reference IS NOT NULL) THEN
      RAISE EXCEPTION 'payout_guard: request % may have a Paystack transfer; it cannot be %. Reconcile it with Paystack instead.', OLD.id, NEW.status;
    END IF;
  END IF;
  IF OLD.status = 'processing' AND NEW.status = 'pending' AND (v_has_transfer OR NEW.transfer_code IS NOT NULL) THEN
    RAISE EXCEPTION 'payout_guard: request % has a Paystack transfer and cannot return to pending', OLD.id;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.organizer_withdrawal_requests_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organizer_withdrawal_requests_guard ON public.organizer_withdrawal_requests;
CREATE TRIGGER organizer_withdrawal_requests_guard
  BEFORE UPDATE ON public.organizer_withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.organizer_withdrawal_requests_guard();

-- Deleting a request would hide a transfer just as well.
CREATE OR REPLACE FUNCTION public.organizer_withdrawal_requests_no_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF OLD.transfer_code IS NOT NULL OR OLD.paystack_reference IS NOT NULL
     OR OLD.status NOT IN ('pending', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'payout_guard: request % has payout history and cannot be deleted', OLD.id;
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
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      (CASE WHEN r.status IN ('cancelled', 'rejected') AND r.transfer_code IS NOT NULL AND NOT r.returned
            THEN 'cancelled_with_transfer_funds_not_returned' END,
       'A Paystack transfer exists and the money was never returned to the balance. If Paystack paid it, record the payout (owner decision); if not, return the money.'),
      (CASE WHEN r.status IN ('cancelled', 'rejected') AND r.transfer_code IS NOT NULL AND r.returned
            THEN 'cancelled_with_transfer_funds_returned' END,
       'A Paystack transfer exists and the money was returned. If Paystack paid it, the organizer was paid twice.'),
      (CASE WHEN r.status = 'completed' AND NOT r.has_payout_row
            THEN 'completed_without_ledger_payout' END,
       'Completed with no linked payout ledger row.'),
      (CASE WHEN r.status = 'processing' AND r.updated_at < now() - interval '1 day'
            THEN 'processing_over_a_day' END,
       'Ask Paystack (Reconcile) for the outcome.'),
      (CASE WHEN EXISTS (SELECT 1 FROM public.admin_logs l
                          WHERE l.action = 'payout_success_on_unrefunded_cancel' AND l.details->>'request_id' = r.id::text)
            THEN 'paystack_success_received_after_cancel' END,
       'Paystack sent a success for this cancelled request after 0205; no money was moved.')
    ) AS x(issue, detail)
   WHERE x.issue IS NOT NULL
     AND public.is_admin()
  UNION ALL
  SELECT NULL::uuid, t.organizer_id, t.amount_kobo, NULL::text, NULL::text, NULL::text,
         'ledger_payout_without_request', 'Payout ledger row ' || t.id || ' (' || t.description || ') is linked to no withdrawal request.'
    FROM public.organizer_transactions t
   WHERE t.type = 'payout' AND t.withdrawal_request_id IS NULL
     AND public.is_admin()
$function$;
REVOKE ALL ON FUNCTION public.admin_payout_integrity_report() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_payout_integrity_report() TO authenticated;
