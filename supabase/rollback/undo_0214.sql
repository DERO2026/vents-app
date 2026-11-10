-- Undo 0214 (Admin Payouts list newest first, keyset pagination, new flags).
-- Restores 0213's admin_list_withdrawals(text, integer) verbatim (generated
-- from 0213_vents_admin_payout_authorization.sql) with 0213's grants, and
-- drops 0214's index. Read-only function: no money, wallet, ledger,
-- withdrawal, review, approval or PIN row is touched.
-- After this, the deployed screen falls back to its first page (it sends the
-- cursor only for "Load more"; see PayoutRequestsPanel).
-- Run undo_0214 before undo_0213.
-- Refuses unless the operator confirms: SET vents.rollback_confirm = 'undo-0214';
DO $guard$
BEGIN
  IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0214' THEN
    RAISE EXCEPTION 'undo_0214: set vents.rollback_confirm = ''undo-0214'' to confirm';
  END IF;
  IF to_regprocedure('public.admin_list_withdrawals(text,integer,timestamptz,uuid)') IS NULL THEN
    RAISE EXCEPTION 'undo_0214: 0214 is not applied';
  END IF;
END
$guard$;

DROP FUNCTION IF EXISTS public.admin_list_withdrawals(text, integer, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.admin_list_withdrawals(text, integer);
-- 0213 (verbatim)
CREATE FUNCTION public.admin_list_withdrawals(p_scope text DEFAULT 'open', p_limit integer DEFAULT 100)
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
               action_note text)
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
     ORDER BY CASE WHEN r.status IN ('pending', 'processing') THEN 0 ELSE 1 END,
              CASE WHEN r.status IN ('pending', 'processing') THEN r.created_at END ASC,
              r.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  ), x AS (
    SELECT b.*,
           ba.is_active AS ba_active, ba.recipient_code AS ba_recipient,
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
           WHEN NOT y.bank_ok THEN 'The bank account is inactive or unverified. Reject it so the user can request again.'
           WHEN y.approved_by IS NOT NULL AND v_root THEN 'Approved. Authorize & Pay with your 10-digit Admin Payout PIN.'
           WHEN y.approved_by IS NOT NULL THEN 'Approved by the VENTS Admin. Only the VENTS Admin can authorize the payment.'
           WHEN v_root AND y.stg = 'forwarded_to_vents_admin' THEN 'Reviewed and forwarded to you. Check the review, then approve or reject.'
           WHEN v_root AND y.stg = 'rejection_recommended' THEN 'A reviewer recommends rejecting this. Check the review, then approve or reject.'
           WHEN v_root THEN 'Not reviewed yet. You can review and approve it directly.'
           WHEN y.stg = 'pending_review' THEN 'Review it and forward it to the VENTS Admin, or recommend rejection.'
           ELSE 'Waiting for the VENTS Admin. You can add another review.'
         END
    FROM y
   ORDER BY CASE WHEN y.status IN ('pending', 'processing') THEN 0 ELSE 1 END,
            CASE WHEN y.status IN ('pending', 'processing') THEN y.created_at END ASC,
            y.created_at DESC;
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_list_withdrawals(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_withdrawals(text, integer) TO authenticated;
DROP INDEX IF EXISTS public.idx_org_withdraw_created_id;
