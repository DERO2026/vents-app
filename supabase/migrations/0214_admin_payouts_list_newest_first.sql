-- 0214: Admin Payouts list -- newest first, keyset pagination, and every
-- action the server allows, computed by the server.
--
-- Problems in 0213's admin_list_withdrawals (fixed here; nothing else changes):
--   1. Ordering: open requests came OLDEST first, and in 'all' every open
--      request sat above every closed one. A new withdrawal landed at the
--      bottom of the list. Now every scope is created_at DESC, id DESC.
--   2. No pagination: one LIMIT (the screen asked for 200). Rows past it were
--      unreachable. Now a keyset cursor (p_before_created_at, p_before_id),
--      the last row of the previous page, returns the next page; id breaks
--      ties, so no row is skipped or repeated when timestamps are equal.
--   3. Missing action flags the screen needed and guessed at:
--        can_forward    review may forward (admin_review_withdrawal refuses
--                       'forward' on an inactive/unverified bank account);
--        can_reconcile  processing: full admins and the VENTS Admin can ask
--                       Paystack (reconcile-payouts / admin_list_processing_payouts);
--        can_cancel     processing with no transfer code and no reference
--                       (admin_cancel_processing_payout, 0202, refuses otherwise);
--        can_request_bank_change  pending, unapproved, never sent: any admin
--                       may ask to move it to another verified account of the
--                       same user (0207; a super admin approves). The screen
--                       hid this from sub-admins.
--        bank_problem   missing | inactive | unverified | changed_since_approval.
--      Each mirrors the function that performs the action; those functions
--      are NOT changed and still decide.
--   4. The bank action note told sub-admins to "Reject", which they cannot do.
--
-- No table, row, amount, balance, ledger entry, grant to another function,
-- or financial rule changes. The function is read-only (STABLE). One index
-- for the new ordering.
--
-- Signature: (text, integer) becomes (text, integer, timestamptz, uuid) with
-- defaults, so existing calls with { p_scope, p_limit } keep working.
-- Prerequisite: 0213. One transaction; idempotent.
-- Rollback: supabase/rollback/undo_0214.sql (undo 0214 before undoing 0213).

DO $pre$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('public.admin_authorize_and_claim_payout(uuid,bigint,text,text)') IS NULL THEN
    RAISE EXCEPTION '0214 requires 0213 (admin_authorize_and_claim_payout is missing)';
  END IF;
  IF to_regprocedure('public.admin_list_withdrawals(text,integer,timestamptz,uuid)') IS NOT NULL THEN
    RETURN;  -- already applied; the CREATE below replaces it with the same body
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.admin_list_withdrawals(text,integer)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION '0214: admin_list_withdrawals(text, integer) is missing';
  END IF;
  -- Drift guard: exactly 0213's body (md5 of prosrc as 0213 creates it).
  IF md5(v_src) <> '1f7936a662d93b405a6be30eb903bf79' THEN
    RAISE EXCEPTION '0214: admin_list_withdrawals is not the 0213 version (md5 %); stop and compare it with 0213', md5(v_src);
  END IF;
END
$pre$;

CREATE INDEX IF NOT EXISTS idx_org_withdraw_created_id ON public.organizer_withdrawal_requests USING btree (created_at DESC, id DESC);

DROP FUNCTION IF EXISTS public.admin_list_withdrawals(text, integer);
DROP FUNCTION IF EXISTS public.admin_list_withdrawals(text, integer, timestamptz, uuid);

CREATE FUNCTION public.admin_list_withdrawals(p_scope text DEFAULT 'open', p_limit integer DEFAULT 100,
                                              p_before_created_at timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL)
 RETURNS TABLE(request_id uuid, organizer_id uuid, organizer_name text, organizer_email text, organizer_phone text,
               amount_kobo bigint, status text, stage text, next_action text,
               bank_name text, account_number_masked text, account_number text, account_name text,
               bank_account_active boolean, account_verified boolean,
               wallet_balance_kobo bigint, wallet_pending_kobo bigint,
               created_at timestamptz, updated_at timestamptz, withdrawal_reference text, admin_note text,
               reviews jsonb, has_current_review boolean,
               approved_by uuid, approved_by_name text, approved_at timestamptz, approval_current boolean,
               authorized_by_name text, authorized_at timestamptz,
               paystack_reference text, transfer_started boolean, pin_required boolean,
               can_review boolean, can_approve boolean, can_authorize_pay boolean, can_reject boolean,
               action_note text,
               can_forward boolean, can_reconcile boolean, can_cancel boolean, can_request_bank_change boolean,
               bank_problem text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_root boolean;
  v_full boolean;
  v_paused boolean;
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('open', 'closed', 'all') THEN RAISE EXCEPTION 'scope must be open, closed or all'; END IF;
  IF p_before_id IS NOT NULL AND p_before_created_at IS NULL THEN
    RAISE EXCEPTION 'p_before_id needs p_before_created_at (the last row of the previous page)';
  END IF;
  v_root := public.is_root();
  v_full := public.is_admin_or_root();
  v_paused := public.payouts_disabled();
  RETURN QUERY
  WITH base AS (
    SELECT r.*
      FROM public.organizer_withdrawal_requests r
     WHERE CASE p_scope WHEN 'open' THEN r.status IN ('pending', 'processing')
                        WHEN 'closed' THEN r.status NOT IN ('pending', 'processing')
                        ELSE true END
       -- [0214] keyset page: strictly after the previous page's last row.
       AND (p_before_created_at IS NULL
            OR r.created_at < p_before_created_at
            OR (r.created_at = p_before_created_at AND p_before_id IS NOT NULL AND r.id < p_before_id))
     -- [0214] newest first in every scope; id breaks ties so pages never overlap.
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  ), x AS (
    SELECT b.*,
           ba.id AS ba_id, ba.is_active AS ba_active, ba.recipient_code AS ba_recipient,
           ou.full_name AS o_name, ou.username AS o_username, ou.email AS o_email, ou.phone_number AS o_phone,
           au.full_name AS a_name, au.username AS a_username,
           ow.balance_kobo AS w_balance, ow.pending_kobo AS w_pending,
           cr.decision AS cr_decision,
           pa.created_at AS pa_at, pu.full_name AS pa_name, pu.username AS pa_username,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'reviewer_name', COALESCE(NULLIF(btrim(vu.full_name), ''), vu.username, 'An admin'),
                     'reviewer_tier', v.reviewer_tier, 'decision', v.decision, 'note', v.note,
                     'created_at', v.created_at,
                     'current', (v.amount_kobo = b.amount_kobo AND v.bank_account_id = b.bank_account_id
                                 AND v.recipient_code IS NOT DISTINCT FROM ba.recipient_code AND COALESCE(ba.is_active, false)))
                     ORDER BY v.created_at), '[]'::jsonb)
              FROM public.withdrawal_reviews v LEFT JOIN public.users vu ON vu.id = v.reviewer_id
             WHERE v.request_id = b.id) AS rv
      FROM base b
      LEFT JOIN public.organizer_bank_accounts ba ON ba.id = b.bank_account_id
      LEFT JOIN public.users ou ON ou.id = b.organizer_id
      LEFT JOIN public.users au ON au.id = b.approved_by
      LEFT JOIN public.organizer_wallets ow ON ow.organizer_id = b.organizer_id
      LEFT JOIN LATERAL public.withdrawal_current_review(b.id) cr ON true
      LEFT JOIN public.payout_authorizations pa ON pa.id = b.payout_authorization_id
      LEFT JOIN public.users pu ON pu.id = pa.admin_id
  ), y AS (
    SELECT x.*,
           (COALESCE(x.ba_active, false) AND x.ba_recipient IS NOT NULL) AS bank_ok,
           (x.approved_by IS NOT NULL AND COALESCE(x.ba_active, false)
            AND x.ba_recipient IS NOT DISTINCT FROM x.approved_recipient_code
            AND x.bank_account_id IS NOT DISTINCT FROM COALESCE(x.approved_bank_account_id, x.bank_account_id)) AS appr_ok,
           public.payout_stage(x.status, x.approved_by, x.cr_decision) AS stg
      FROM x
  )
  SELECT y.id, y.organizer_id,
         COALESCE(NULLIF(btrim(y.o_name), ''), y.o_username), y.o_email, y.o_phone,
         y.amount_kobo, y.status, y.stg,
         CASE
           WHEN y.status = 'processing' THEN 'paystack'
           WHEN y.status <> 'pending' THEN NULL
           WHEN y.stg = 'pending_review' THEN 'review_or_vents_admin'
           ELSE 'vents_admin'
         END,
         y.bank_name, public.mask_account_number(y.account_number),
         CASE WHEN v_full THEN y.account_number END,
         y.account_name, COALESCE(y.ba_active, false), (y.ba_recipient IS NOT NULL),
         y.w_balance, y.w_pending,
         y.created_at, y.updated_at, public.payout_transfer_reference(y.id), y.admin_note,
         y.rv, (y.cr_decision IS NOT NULL),
         y.approved_by, COALESCE(NULLIF(btrim(y.a_name), ''), y.a_username), y.approved_at, y.appr_ok,
         COALESCE(NULLIF(btrim(y.pa_name), ''), y.pa_username), y.pa_at,
         y.paystack_reference, (y.transfer_code IS NOT NULL),
         (y.status = 'pending' AND y.approved_by IS NOT NULL),
         -- can_review: admins and sub-admins (not the VENTS Admin), before approval
         (y.status = 'pending' AND y.approved_by IS NULL AND NOT v_root AND y.organizer_id <> v_uid),
         -- can_approve: the VENTS Admin only
         (v_root AND y.status = 'pending' AND y.approved_by IS NULL AND y.organizer_id <> v_uid AND y.bank_ok AND NOT v_paused),
         -- can_authorize_pay: the VENTS Admin only, with the PIN
         (v_root AND y.status = 'pending' AND y.approved_by IS NOT NULL AND y.appr_ok AND y.organizer_id <> v_uid AND NOT v_paused),
         -- can_reject: full admins and the VENTS Admin (admin_reject_organizer_payout, unchanged)
         (y.status = 'pending' AND v_full AND NOT v_paused),
         CASE
           WHEN y.status = 'processing' THEN 'Sent to Paystack. It is marked paid only when Paystack confirms the transfer.'
           WHEN y.status <> 'pending' THEN NULL
           WHEN y.organizer_id = v_uid THEN 'This is your own withdrawal; you cannot review, approve or pay it.'
           WHEN v_paused THEN 'Payouts are paused (kill switch): nothing can be approved, paid or rejected until they are resumed.'
           WHEN y.approved_by IS NOT NULL AND NOT y.appr_ok THEN 'The bank account changed after approval. Reject it so the user can request again.'
           WHEN NOT y.bank_ok AND v_full THEN 'The bank account is missing, inactive or not verified by Paystack, so nothing can be sent to it. Move it to a verified account or reject it so the user can request again.'
           WHEN NOT y.bank_ok THEN 'The bank account is missing, inactive or not verified by Paystack, so it cannot be forwarded or paid. Recommend rejection.'
           WHEN y.approved_by IS NOT NULL AND v_root THEN 'Approved. Authorize & Pay with your 10-digit Admin Payout PIN.'
           WHEN y.approved_by IS NOT NULL THEN 'Approved by the VENTS Admin. Only the VENTS Admin can authorize the payment.'
           WHEN v_root AND y.stg = 'forwarded_to_vents_admin' THEN 'Reviewed and forwarded to you. Check the review, then approve or reject.'
           WHEN v_root AND y.stg = 'rejection_recommended' THEN 'A reviewer recommends rejecting this. Check the review, then approve or reject.'
           WHEN v_root THEN 'Not reviewed yet. You can review and approve it directly.'
           WHEN y.stg = 'pending_review' THEN 'Review it and forward it to the VENTS Admin, or recommend rejection.'
           ELSE 'Waiting for the VENTS Admin. You can add another review.'
         END,
         -- [0214] can_forward: admin_review_withdrawal refuses 'forward' unless
         -- the bank account is active and Paystack-verified.
         (y.status = 'pending' AND y.approved_by IS NULL AND NOT v_root AND y.organizer_id <> v_uid AND y.bank_ok),
         -- [0214] can_reconcile: ask Paystack (reconcile-payouts reads
         -- admin_list_processing_payouts: full admins and the VENTS Admin).
         (y.status = 'processing' AND v_full),
         -- [0214] can_cancel: admin_cancel_processing_payout (0202) only when no
         -- Paystack transfer can exist (no transfer code and no reference).
         (y.status = 'processing' AND v_full AND NOT v_paused AND y.transfer_code IS NULL AND y.paystack_reference IS NULL),
         -- [0214] can_request_bank_change: admin_request_withdrawal_bank_reassignment
         -- (0207; any admin, a super admin approves): pending, not approved,
         -- never sent to Paystack, not the caller's own withdrawal.
         (y.status = 'pending' AND y.approved_by IS NULL AND y.paystack_reference IS NULL AND y.transfer_code IS NULL
          AND y.organizer_id <> v_uid),
         -- [0214] bank_problem: why a transfer cannot go to this account.
         CASE
           WHEN y.status <> 'pending' THEN NULL
           WHEN y.ba_id IS NULL THEN 'missing'
           WHEN NOT COALESCE(y.ba_active, false) THEN 'inactive'
           WHEN y.ba_recipient IS NULL THEN 'unverified'
           WHEN y.approved_by IS NOT NULL AND NOT y.appr_ok THEN 'changed_since_approval'
         END
    FROM y
   ORDER BY y.created_at DESC, y.id DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_list_withdrawals(text, integer, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_withdrawals(text, integer, timestamptz, uuid) TO authenticated;

DO $post$
BEGIN
  IF to_regprocedure('public.admin_list_withdrawals(text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION '0214: the old two-argument admin_list_withdrawals still exists (ambiguous calls)';
  END IF;
  IF has_function_privilege('anon', 'public.admin_list_withdrawals(text,integer,timestamptz,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0214: anon can execute admin_list_withdrawals';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.admin_list_withdrawals(text,integer,timestamptz,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0214: authenticated cannot execute admin_list_withdrawals';
  END IF;
  IF position('ORDER BY y.created_at DESC, y.id DESC' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.admin_list_withdrawals(text,integer,timestamptz,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0214: admin_list_withdrawals is not ordered newest first';
  END IF;
END
$post$;
