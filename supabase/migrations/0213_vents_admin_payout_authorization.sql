-- 0213: VENTS Admin payout authority with a 10-digit Admin Payout PIN.
--
-- Owner decision 2026-11-10 ("VENTS PAYOUT SYSTEM — complete redesign"):
-- the VENTS Super Admin (the root account, public.is_root()) is the sole
-- final payout authority. Replaces 0211's "two different admins" rule.
--
--   Path A  pending_review -> vents_admin_approved -> processing -> paid
--   Path B  pending_review -> forwarded_to_vents_admin (a sub-admin's or an
--           admin's review) -> vents_admin_approved -> processing -> paid
--   Review is optional and advisory; it never authorizes anything.
--
-- What changes (no money, balance, ledger, fee, minimum or hold changes; no
-- existing request, approval or PIN row is modified):
--   1. withdrawal_reviews: optional, immutable reviews by admins and
--      sub-admins (forward to VENTS Admin, or recommend rejection), each
--      bound to the amount and bank recipient reviewed.
--   2. admin_payout_pins / admin_payout_pin_events: the 10-digit VENTS Admin
--      Payout PIN (bcrypt cost 12, bound to the root user id), attempt
--      counters, locks, audit trail. Closed to every client role.
--   3. payout_authorizations: one immutable row per PIN-verified payout,
--      bound to the request, amount, bank account, recipient, the root
--      admin, a unique idempotency key and the database transaction that
--      consumed it. The withdrawal guard refuses pending -> processing
--      unless such a row was created in the SAME transaction, so no other
--      path (old claim, raw UPDATE, Admin Actions) can start a transfer.
--   4. admin_approve_withdrawal_for_payment (root only) records the
--      approval; admin_authorize_and_claim_payout (root only, PIN) claims it
--      for Paystack in one transaction.
--   5. The 0211 two-admin functions are closed (admin_first_approve_withdrawal,
--      admin_approve_withdrawal, admin_cancel_withdrawal_first_approval, the
--      authorize_withdrawal Admin Action); admin_claim_payout_for_processing
--      is revoked from every client role; admin_release_payout_claim is
--      root only.
--   6. admin_list_withdrawals (new columns) and admin_payout_overview give
--      every screen the same server-computed stages and totals.
--
-- Rejecting stays as before (admin_reject_organizer_payout: full admins and
-- root). Sub-admins cannot reject; their review can recommend it.
--
-- Prerequisites: 0211 and 0212. One transaction; idempotent.
-- Rollback: supabase/rollback/undo_0213.sql.

DO $pre$
DECLARE
  v_guard text := md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.organizer_withdrawal_requests_guard()'::regprocedure));
  v_exec  text := md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.execute_withdrawal_authorization(uuid)'::regprocedure));
  v_mine  text := md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.get_my_withdrawals(integer)'::regprocedure));
BEGIN
  IF to_regprocedure('public.request_organizer_payout_core(bigint,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '0213 requires 0212 (request_organizer_payout_core is missing)';
  END IF;
  IF to_regprocedure('public.admin_list_withdrawals(text,integer)') IS NULL THEN
    RAISE EXCEPTION '0213 requires 0211 (admin_list_withdrawals is missing)';
  END IF;
  -- Drift guard: the bodies this migration replaces must be 0211's (or 0213's on a re-run).
  IF v_guard NOT IN ('03cd98dc83d83b72868355f5ffcc04c0')
     AND position('[0213]' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.organizer_withdrawal_requests_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0213: organizer_withdrawal_requests_guard differs from 0211 (md5 %); stop and investigate', v_guard;
  END IF;
  IF v_exec NOT IN ('c46d5a83fb7e95941a157b3300883ff0')
     AND position('[0213]' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.execute_withdrawal_authorization(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0213: execute_withdrawal_authorization differs from 0211 (md5 %); stop and investigate', v_exec;
  END IF;
  IF v_mine NOT IN ('ea9e7fd6ad208af211d40a2786c4ad9d')
     AND position('[0213]' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_my_withdrawals(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0213: get_my_withdrawals differs from 0211 (md5 %); stop and investigate', v_mine;
  END IF;
  -- The VENTS Super Admin is the root account; notifications to it use its id.
  IF position('c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.is_root()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0213: is_root() no longer names the expected VENTS root account; stop and investigate';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- Shared
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vents_root_user_id()
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$ SELECT 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid $function$;

CREATE OR REPLACE FUNCTION public.admin_payout_pin_policy()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT jsonb_build_object('length', 10, 'max_attempts', 5, 'lock_minutes', 30, 'max_lockouts', 3,
                            'change_pause_minutes', 60, 'authorization_seconds', 120);
$function$;

-- 'root' (the VENTS Super Admin), 'admin', 'sub' or NULL.
CREATE OR REPLACE FUNCTION public.payout_admin_tier(p_user uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE
           WHEN p_user IS NULL THEN NULL
           WHEN p_user = public.vents_root_user_id() THEN 'root'
           WHEN u.role = 'admin' THEN 'admin'
           WHEN u.role = 'sub-admin' THEN 'sub'
         END
    FROM (SELECT 1) one
    LEFT JOIN public.users u ON u.id = p_user;
$function$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.withdrawal_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES public.organizer_withdrawal_requests(id) ON DELETE RESTRICT,
  reviewer_id     uuid NOT NULL,
  reviewer_tier   text NOT NULL CHECK (reviewer_tier IN ('admin', 'sub')),
  decision        text NOT NULL CHECK (decision IN ('forwarded', 'rejection_recommended')),
  note            text NOT NULL CHECK (length(btrim(note)) BETWEEN 3 AND 1000),
  amount_kobo     bigint NOT NULL,
  bank_account_id uuid,
  recipient_code  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS withdrawal_reviews_request_idx ON public.withdrawal_reviews (request_id, created_at DESC);
ALTER TABLE public.withdrawal_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.withdrawal_reviews FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.withdrawal_reviews IS
  'Optional reviews of a withdrawal by an admin or sub-admin (0213): forward to VENTS Admin or recommend rejection. Advisory only; immutable.';

CREATE TABLE IF NOT EXISTS public.admin_payout_pins (
  user_id          uuid PRIMARY KEY,
  pin_hash         text NOT NULL,
  failed_attempts  integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  lockouts         integer NOT NULL DEFAULT 0 CHECK (lockouts >= 0),
  locked_until     timestamptz,
  must_reset       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  changed_at       timestamptz NOT NULL DEFAULT now(),
  last_failed_at   timestamptz,
  last_verified_at timestamptz
);
ALTER TABLE public.admin_payout_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_payout_pins FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.admin_payout_pins IS
  'VENTS Admin Payout PIN (0213): bcrypt hash bound to the root user id. Never readable by any client; only the 0213 functions use it.';

CREATE TABLE IF NOT EXISTS public.admin_payout_pin_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL,
  event      text NOT NULL CHECK (event IN ('created', 'changed', 'verified', 'failed', 'locked', 'reset_required')),
  request_id uuid,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_payout_pin_events_user_idx ON public.admin_payout_pin_events (user_id, created_at DESC);
ALTER TABLE public.admin_payout_pin_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_payout_pin_events FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.payout_authorizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES public.organizer_withdrawal_requests(id) ON DELETE RESTRICT,
  admin_id        uuid NOT NULL,
  amount_kobo     bigint NOT NULL CHECK (amount_kobo > 0),
  bank_account_id uuid NOT NULL,
  recipient_code  text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  txid            bigint NOT NULL DEFAULT txid_current(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS payout_authorizations_request_idx ON public.payout_authorizations (request_id, created_at DESC);
ALTER TABLE public.payout_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payout_authorizations FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.payout_authorizations IS
  'One row per PIN-verified VENTS Admin payout (0213), consumed by the claim in the same transaction. Immutable.';

-- Immutable audit rows (reviews, authorizations).
CREATE OR REPLACE FUNCTION public.payout_audit_row_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION '% rows are an audit trail and cannot be changed or deleted', TG_TABLE_NAME;
END;
$function$;
REVOKE ALL ON FUNCTION public.payout_audit_row_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS withdrawal_reviews_immutable ON public.withdrawal_reviews;
CREATE TRIGGER withdrawal_reviews_immutable BEFORE UPDATE OR DELETE ON public.withdrawal_reviews
  FOR EACH ROW EXECUTE FUNCTION public.payout_audit_row_immutable();
DROP TRIGGER IF EXISTS payout_authorizations_immutable ON public.payout_authorizations;
CREATE TRIGGER payout_authorizations_immutable BEFORE UPDATE OR DELETE ON public.payout_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.payout_audit_row_immutable();

ALTER TABLE public.organizer_withdrawal_requests ADD COLUMN IF NOT EXISTS approved_bank_account_id uuid;
ALTER TABLE public.organizer_withdrawal_requests ADD COLUMN IF NOT EXISTS payout_authorization_id uuid;
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizer_withdrawal_requests_payout_authorization_fk') THEN
    ALTER TABLE public.organizer_withdrawal_requests
      ADD CONSTRAINT organizer_withdrawal_requests_payout_authorization_fk
      FOREIGN KEY (payout_authorization_id) REFERENCES public.payout_authorizations(id);
  END IF;
END
$fk$;

-- [0213] An approval is the VENTS Admin's alone (0203 required an approving
-- admin AND a different requesting admin). Still never the withdrawer, and a
-- recorded forwarding reviewer is neither the approver nor the withdrawer.
ALTER TABLE public.organizer_withdrawal_requests DROP CONSTRAINT IF EXISTS organizer_withdrawal_requests_two_admins;
ALTER TABLE public.organizer_withdrawal_requests DROP CONSTRAINT IF EXISTS organizer_withdrawal_requests_approval_parties;
ALTER TABLE public.organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_approval_parties
  CHECK (approved_by IS NULL OR (approved_by <> organizer_id
         AND (approval_requested_by IS NULL OR (approval_requested_by <> approved_by AND approval_requested_by <> organizer_id))));

-- ---------------------------------------------------------------------------
-- The withdrawal guard ([0213] marks what changes from 0211)
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

  -- The payout approval cannot be forged, altered or erased. Once set it
  -- never changes. [0213] It is recorded only by the VENTS Super Admin
  -- (root) for this request's current bank account (was: two admins via
  -- approve_admin_action).
  IF NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.approval_requested_by IS DISTINCT FROM OLD.approval_requested_by
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approved_recipient_code IS DISTINCT FROM OLD.approved_recipient_code
     OR NEW.approved_bank_account_id IS DISTINCT FROM OLD.approved_bank_account_id THEN
    IF OLD.approved_by IS NOT NULL OR OLD.approval_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'Withdrawal %: its payout approval cannot be changed or cleared', OLD.id;
    END IF;
    IF NEW.approved_by IS NULL OR NEW.approved_recipient_code IS NULL OR NEW.approval_request_id IS NOT NULL
       OR NEW.approved_by IS DISTINCT FROM auth.uid() OR NOT public.is_root()
       OR NEW.approved_bank_account_id IS DISTINCT FROM OLD.bank_account_id
       OR OLD.status <> 'pending' OR OLD.organizer_id = NEW.approved_by THEN
      RAISE EXCEPTION 'Withdrawal %: a payout approval can only be recorded by the VENTS Admin (admin_approve_withdrawal_for_payment)', OLD.id;
    END IF;
  END IF;

  -- [0213] The PIN authorization is set only when the request is claimed.
  IF NEW.payout_authorization_id IS DISTINCT FROM OLD.payout_authorization_id
     AND NOT (OLD.status = 'pending' AND NEW.status = 'processing') THEN
    RAISE EXCEPTION 'Withdrawal %: its payout authorization can only be set when it is claimed for payment', OLD.id;
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

  -- [0213] Claiming for Paystack needs the VENTS Admin's approval AND a PIN
  -- authorization created in this same transaction for exactly this
  -- request, amount, bank account and recipient (was: any approval).
  IF OLD.status = 'pending' AND NEW.status = 'processing' THEN
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'Withdrawal %: it needs the VENTS Admin''s approval before it can be claimed for payment', OLD.id;
    END IF;
    IF NEW.payout_authorization_id IS NULL OR NOT public.is_root() OR NOT EXISTS (
         SELECT 1 FROM public.payout_authorizations a
           JOIN public.organizer_bank_accounts b ON b.id = OLD.bank_account_id AND b.is_active
          WHERE a.id = NEW.payout_authorization_id
            AND a.request_id = OLD.id
            AND a.admin_id = auth.uid()
            AND a.txid = txid_current()
            AND a.expires_at > clock_timestamp()
            AND a.amount_kobo = OLD.amount_kobo
            AND a.bank_account_id = OLD.bank_account_id
            AND a.recipient_code = b.recipient_code
            AND a.recipient_code = NEW.approved_recipient_code) THEN
      RAISE EXCEPTION 'Withdrawal %: a payout needs the VENTS Admin Payout PIN (admin_authorize_and_claim_payout)', OLD.id;
    END IF;
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

-- ---------------------------------------------------------------------------
-- The 0211 two-admin path is closed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.execute_withdrawal_authorization(p_admin_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- [0213] Withdrawals are approved by the VENTS Admin on the Payouts screen.
  RAISE EXCEPTION 'Withdrawal approvals moved to Payouts: the VENTS Admin approves and pays with the Admin Payout PIN (0213)';
END;
$function$;
REVOKE ALL ON FUNCTION public.execute_withdrawal_authorization(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.authorize_withdrawal_first_approval_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.action_type IS DISTINCT FROM 'authorize_withdrawal' THEN
    RETURN NEW;
  END IF;
  -- [0213]
  RAISE EXCEPTION 'Withdrawal approvals moved to Payouts: review or forward the withdrawal there (0213)';
END;
$function$;

-- Any first approval still open from 0211 is closed (nothing it approved
-- remains valid under 0213). No money or withdrawal row changes.
UPDATE public.admin_action_requests
   SET status = 'rejected', reviewed_at = now(),
       review_reason = 'Closed by 0213: withdrawals are now approved by the VENTS Admin on the Payouts screen',
       seen_at = COALESCE(seen_at, now())
 WHERE action_type = 'authorize_withdrawal' AND status = 'pending';

REVOKE EXECUTE ON FUNCTION public.admin_first_approve_withdrawal(uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_approve_withdrawal(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_cancel_withdrawal_first_approval(uuid, text) FROM PUBLIC, anon, authenticated;
-- The old claim (no PIN). The guard refuses it anyway; no client role may call it.
REVOKE EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid) FROM PUBLIC, anon, authenticated;
DO $revoke_pa$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_admin') THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid) FROM project_admin';
  END IF;
END
$revoke_pa$;

-- Releasing a claim (Paystack confirmed nothing was sent) is for the VENTS Admin only.
DO $release$
DECLARE
  v_def text := pg_get_functiondef('public.admin_release_payout_claim(uuid,text)'::regprocedure);
  v_old constant text := 'IF NOT public.is_admin() THEN RAISE EXCEPTION ''Admin access required''; END IF;';
  v_new constant text := 'IF NOT public.is_root() THEN RAISE EXCEPTION ''VENTS Admin access required''; END IF; -- [0213] was is_admin()';
BEGIN
  IF position('[0213]' IN v_def) > 0 THEN RETURN; END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION '0213: admin_release_payout_claim is not the expected version';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$release$;

-- The user is told VENTS reviews the request (was: "two VENTS admins").
DO $notice$
DECLARE
  v_def text := pg_get_functiondef('public.request_withdrawal(bigint,uuid,text,text)'::regprocedure);
  v_old1 constant text := ' is waiting for review by two VENTS admins. You can follow it in your wallet.''';
  v_new1 constant text := ' is waiting for review by VENTS. You can follow it in your wallet.''';
  v_old2 constant text := '''stage'', ''pending_first_approval''';
  v_new2 constant text := '''stage'', ''pending_review''';
BEGIN
  IF position(v_new1 IN v_def) > 0 THEN RETURN; END IF;
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1
     OR (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
    RAISE EXCEPTION '0213: request_withdrawal is not the expected 0211/0212 version';
  END IF;
  EXECUTE replace(replace(v_def, v_old1, v_new1), v_old2, v_new2);
END
$notice$;

-- ---------------------------------------------------------------------------
-- Stages
-- ---------------------------------------------------------------------------
-- The latest review whose amount and bank recipient are still the request's.
CREATE OR REPLACE FUNCTION public.withdrawal_current_review(p_request_id uuid)
 RETURNS public.withdrawal_reviews
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT v.*
    FROM public.withdrawal_reviews v
    JOIN public.organizer_withdrawal_requests r ON r.id = v.request_id
    JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id AND b.is_active
   WHERE v.request_id = p_request_id
     AND v.amount_kobo = r.amount_kobo
     AND v.bank_account_id = r.bank_account_id
     AND v.recipient_code IS NOT DISTINCT FROM b.recipient_code
   ORDER BY v.created_at DESC
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.payout_stage(p_status text, p_approved_by uuid, p_review_decision text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_status
           WHEN 'pending' THEN CASE WHEN p_approved_by IS NOT NULL THEN 'vents_admin_approved'
                                    WHEN p_review_decision = 'forwarded' THEN 'forwarded_to_vents_admin'
                                    WHEN p_review_decision = 'rejection_recommended' THEN 'rejection_recommended'
                                    ELSE 'pending_review' END
           WHEN 'processing' THEN 'processing'
           WHEN 'completed' THEN 'paid'
           ELSE p_status
         END;
$function$;

-- ---------------------------------------------------------------------------
-- Review (optional): admins and sub-admins, never the VENTS Admin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_review_withdrawal(p_request_id uuid, p_amount_kobo bigint, p_decision text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_tier text;
  w public.organizer_withdrawal_requests;
  v_recipient text;
  v_decision text;
  v_name text;
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF public.is_root() THEN
    RAISE EXCEPTION 'The VENTS Admin approves or rejects directly; reviews are for other admins and sub-admins';
  END IF;
  v_tier := public.payout_admin_tier(v_uid);
  IF v_tier NOT IN ('admin', 'sub') THEN RAISE EXCEPTION 'Admin access required'; END IF;
  v_decision := CASE p_decision WHEN 'forward' THEN 'forwarded' WHEN 'recommend_reject' THEN 'rejection_recommended' END;
  IF v_decision IS NULL THEN RAISE EXCEPTION 'decision must be forward or recommend_reject'; END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 3 OR length(btrim(p_note)) > 1000 THEN
    RAISE EXCEPTION 'Add a review note (3 to 1000 characters)';
  END IF;
  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.status <> 'pending' THEN RAISE EXCEPTION 'Withdrawal request is %, not pending', w.status; END IF;
  IF w.approved_by IS NOT NULL THEN RAISE EXCEPTION 'The VENTS Admin has already approved this withdrawal'; END IF;
  IF w.organizer_id = v_uid THEN RAISE EXCEPTION 'You cannot review your own withdrawal'; END IF;
  IF p_amount_kobo IS DISTINCT FROM w.amount_kobo THEN
    RAISE EXCEPTION 'The amount reviewed (%) does not match the request (%)', p_amount_kobo, w.amount_kobo;
  END IF;
  SELECT b.recipient_code INTO v_recipient FROM public.organizer_bank_accounts b
   WHERE b.id = w.bank_account_id AND b.is_active;
  IF v_recipient IS NULL AND v_decision = 'forwarded' THEN
    RAISE EXCEPTION 'The withdrawal''s bank account is inactive or unverified; recommend rejecting it instead';
  END IF;

  INSERT INTO public.withdrawal_reviews (request_id, reviewer_id, reviewer_tier, decision, note, amount_kobo, bank_account_id, recipient_code)
  VALUES (w.id, v_uid, v_tier, v_decision, btrim(p_note), w.amount_kobo, w.bank_account_id, v_recipient);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (v_uid, 'withdrawal_reviewed', w.organizer_id,
          jsonb_build_object('request_id', w.id, 'decision', v_decision, 'amount_kobo', w.amount_kobo, 'reviewer_tier', v_tier),
          public.actor_role());

  SELECT COALESCE(NULLIF(btrim(u.full_name), ''), u.username, 'A user') INTO v_name FROM public.users u WHERE u.id = w.organizer_id;
  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (public.vents_root_user_id(), 'sale',
          CASE WHEN v_decision = 'forwarded' THEN 'Withdrawal forwarded for your approval' ELSE 'Withdrawal flagged for rejection' END,
          COALESCE(v_name, 'A user') || ' · ' || public.withdrawal_naira(w.amount_kobo)
            || CASE WHEN v_decision = 'forwarded' THEN ' was reviewed and forwarded to you.' ELSE ' was reviewed; the reviewer recommends rejecting it.' END,
          false, 'wallet', jsonb_build_object('screen', 'admin_payouts', 'type', 'withdrawal_review', 'request_id', w.id, 'decision', v_decision));

  RETURN jsonb_build_object('request_id', w.id, 'stage', public.payout_stage(w.status, NULL, v_decision));
END;
$function$;

-- ---------------------------------------------------------------------------
-- Approve for payment: the VENTS Admin only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_approve_withdrawal_for_payment(p_request_id uuid, p_amount_kobo bigint, p_note text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  w public.organizer_withdrawal_requests;
  v_recipient text;
  v_review public.withdrawal_reviews;
BEGIN
  IF v_uid IS NULL OR NOT public.is_root() THEN RAISE EXCEPTION 'VENTS Admin access required'; END IF;
  IF public.payouts_disabled() THEN RAISE EXCEPTION 'payouts_disabled'; END IF;
  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.status <> 'pending' THEN RAISE EXCEPTION 'Withdrawal request is %, not pending', w.status; END IF;
  IF w.approved_by IS NOT NULL THEN RAISE EXCEPTION 'This withdrawal is already approved for payment'; END IF;
  IF w.organizer_id = v_uid THEN RAISE EXCEPTION 'You cannot approve your own withdrawal'; END IF;
  IF p_amount_kobo IS DISTINCT FROM w.amount_kobo THEN
    RAISE EXCEPTION 'The amount reviewed (%) does not match the request (%)', p_amount_kobo, w.amount_kobo;
  END IF;
  SELECT b.recipient_code INTO v_recipient FROM public.organizer_bank_accounts b
   WHERE b.id = w.bank_account_id AND b.is_active;
  IF v_recipient IS NULL THEN
    RAISE EXCEPTION 'The withdrawal''s bank account is inactive or has no verified Paystack recipient; reject it so the user can request again';
  END IF;
  v_review := public.withdrawal_current_review(w.id);

  UPDATE public.organizer_withdrawal_requests
     SET approved_by = v_uid, approved_at = now(), approved_recipient_code = v_recipient,
         approved_bank_account_id = w.bank_account_id,
         approval_requested_by = CASE WHEN v_review.decision = 'forwarded' THEN v_review.reviewer_id END,
         updated_at = now()
   WHERE id = w.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (v_uid, 'withdrawal_approved_for_payment', w.organizer_id,
          jsonb_build_object('request_id', w.id, 'amount_kobo', w.amount_kobo, 'bank_account_id', w.bank_account_id,
                             'review_id', v_review.id, 'review_decision', v_review.decision,
                             'note', NULLIF(btrim(COALESCE(p_note, '')), '')),
          public.actor_role());
  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (w.organizer_id, 'sale', 'Withdrawal approved',
          'Your withdrawal of ' || public.withdrawal_naira(w.amount_kobo)
            || ' was approved by VENTS. It will be sent to your bank shortly.',
          false, 'wallet', jsonb_build_object('screen', 'wallet', 'type', 'withdrawal', 'request_id', w.id, 'stage', 'vents_admin_approved'));
  RETURN jsonb_build_object('request_id', w.id, 'stage', 'vents_admin_approved');
END;
$function$;

-- ---------------------------------------------------------------------------
-- VENTS Admin Payout PIN
-- ---------------------------------------------------------------------------
DO $pgcrypto0213$
DECLARE
  v_schema text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
  END IF;
  SELECT n.nspname INTO v_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto';
  EXECUTE format($f$
CREATE OR REPLACE FUNCTION public.admin_payout_pin_hash(p_user uuid, p_pin text)
 RETURNS text
 LANGUAGE sql
 VOLATILE
 SET search_path TO ''
AS $b$
  SELECT %1$I.crypt('vents_admin_payout:' || p_user::text || ':' || p_pin, %1$I.gen_salt('bf', 12));
$b$;$f$, v_schema);
  EXECUTE format($f$
CREATE OR REPLACE FUNCTION public.admin_payout_pin_matches(p_user uuid, p_pin text, p_hash text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $b$
  SELECT p_hash IS NOT NULL AND p_pin IS NOT NULL
     AND %1$I.crypt('vents_admin_payout:' || p_user::text || ':' || p_pin, p_hash) = p_hash;
$b$;$f$, v_schema);
END
$pgcrypto0213$;

CREATE OR REPLACE FUNCTION public.admin_payout_pin_is_weak(p_pin text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT p_pin ~ '^(.{1,5})\1+$'                                  -- 0000000000, 1212121212, 1234512345 ...
      OR position(p_pin IN '01234567890123456789') > 0            -- 0123456789, 3456789012 ...
      OR position(p_pin IN '98765432109876543210') > 0;           -- 9876543210 ...
$function$;

CREATE OR REPLACE FUNCTION public.admin_payout_pin_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  p public.admin_payout_pins;
  pol jsonb := public.admin_payout_pin_policy();
  v_pause timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_root() THEN RAISE EXCEPTION 'VENTS Admin access required'; END IF;
  SELECT * INTO p FROM public.admin_payout_pins WHERE user_id = auth.uid();
  IF NOT FOUND THEN
    RETURN jsonb_build_object('has_pin', false, 'locked', false, 'locked_until', NULL, 'must_reset', false,
                              'attempts_left', (pol->>'max_attempts')::int, 'payouts_paused_until', NULL,
                              'length', (pol->>'length')::int);
  END IF;
  v_pause := CASE WHEN p.changed_at > p.created_at THEN p.changed_at + make_interval(mins => (pol->>'change_pause_minutes')::int) END;
  RETURN jsonb_build_object(
    'has_pin', true,
    'locked', p.must_reset OR COALESCE(p.locked_until > now(), false),
    'locked_until', CASE WHEN p.locked_until > now() THEN p.locked_until END,
    'must_reset', p.must_reset,
    'attempts_left', GREATEST((pol->>'max_attempts')::int - p.failed_attempts, 0),
    'payouts_paused_until', CASE WHEN v_pause > now() THEN v_pause END,
    'changed_at', p.changed_at,
    'length', (pol->>'length')::int);
END;
$function$;

-- Create, change or reset (forgotten or locked) the PIN. Always needs the
-- account password entered in the last 5 minutes: the API confirms it with a
-- fresh sign-in and calls this with that session. A change pauses payouts
-- for an hour. The VENTS account is notified every time.
CREATE OR REPLACE FUNCTION public.admin_set_payout_pin(p_pin text, p_pin_confirm text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_had boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT public.is_root() THEN RAISE EXCEPTION 'VENTS Admin access required'; END IF;
  IF NOT public.withdrawal_password_recently_confirmed() THEN
    RAISE EXCEPTION 'PASSWORD_CONFIRMATION_REQUIRED';
  END IF;
  IF p_pin IS NULL OR p_pin !~ '^[0-9]{10}$' THEN
    RAISE EXCEPTION 'The Admin Payout PIN must be exactly 10 digits';
  END IF;
  IF p_pin_confirm IS DISTINCT FROM p_pin THEN RAISE EXCEPTION 'The two PINs do not match'; END IF;
  IF public.admin_payout_pin_is_weak(p_pin) THEN
    RAISE EXCEPTION 'That PIN is too easy to guess (repeated or sequential digits). Choose another';
  END IF;
  SELECT true INTO v_had FROM public.admin_payout_pins WHERE user_id = v_uid FOR UPDATE;
  v_had := COALESCE(v_had, false);
  INSERT INTO public.admin_payout_pins (user_id, pin_hash)
  VALUES (v_uid, public.admin_payout_pin_hash(v_uid, p_pin))
  ON CONFLICT (user_id) DO UPDATE
     SET pin_hash = EXCLUDED.pin_hash, failed_attempts = 0, lockouts = 0, locked_until = NULL,
         must_reset = false, changed_at = now();
  INSERT INTO public.admin_payout_pin_events (user_id, event) VALUES (v_uid, CASE WHEN v_had THEN 'changed' ELSE 'created' END);
  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (v_uid, CASE WHEN v_had THEN 'admin_payout_pin_changed' ELSE 'admin_payout_pin_created' END, '{}'::jsonb, public.actor_role());
  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (v_uid, 'sale',
          CASE WHEN v_had THEN 'Admin Payout PIN changed' ELSE 'Admin Payout PIN created' END,
          CASE WHEN v_had
               THEN 'The VENTS Admin Payout PIN was changed. Payouts are paused for one hour. If you did not do this, change your password now.'
               ELSE 'The VENTS Admin Payout PIN was created. It is required for every payout. VENTS will never ask you for it.' END,
          false, 'wallet', jsonb_build_object('screen', 'admin_payouts', 'type', 'admin_payout_pin', 'event', CASE WHEN v_had THEN 'changed' ELSE 'created' END));
  RETURN public.admin_payout_pin_status();
END;
$function$;

-- Internal: checks the PIN, records the outcome, returns a result (never
-- raises), so the caller can return it and the counters are committed.
CREATE OR REPLACE FUNCTION public.admin_payout_pin_check(p_user uuid, p_pin text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  p public.admin_payout_pins;
  pol jsonb := public.admin_payout_pin_policy();
  v_max int := (pol->>'max_attempts')::int;
  v_pause timestamptz;
BEGIN
  SELECT * INTO p FROM public.admin_payout_pins WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pin_not_set', 'message', 'Create the Admin Payout PIN first');
  END IF;
  IF p.must_reset THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pin_reset_required',
                              'message', 'The Admin Payout PIN is locked after too many wrong attempts. Reset it with your password');
  END IF;
  IF p.locked_until > now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pin_locked', 'locked_until', p.locked_until,
                              'message', 'Too many wrong PINs. Try again after ' || to_char(p.locked_until AT TIME ZONE 'Africa/Lagos', 'HH24:MI') || ' (Lagos time)');
  END IF;
  v_pause := CASE WHEN p.changed_at > p.created_at THEN p.changed_at + make_interval(mins => (pol->>'change_pause_minutes')::int) END;
  IF v_pause > now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pin_recently_changed', 'paused_until', v_pause,
                              'message', 'The Admin Payout PIN was changed recently. Payouts resume at '
                                         || to_char(v_pause AT TIME ZONE 'Africa/Lagos', 'HH24:MI') || ' (Lagos time)');
  END IF;
  IF p_pin IS NOT NULL AND p_pin ~ '^[0-9]{10}$' AND public.admin_payout_pin_matches(p_user, p_pin, p.pin_hash) THEN
    UPDATE public.admin_payout_pins SET failed_attempts = 0, lockouts = 0, locked_until = NULL, last_verified_at = now()
     WHERE user_id = p_user;
    INSERT INTO public.admin_payout_pin_events (user_id, event, request_id) VALUES (p_user, 'verified', p_request_id);
    RETURN jsonb_build_object('ok', true);
  END IF;

  p.failed_attempts := p.failed_attempts + 1;
  IF p.failed_attempts >= v_max THEN
    p.lockouts := p.lockouts + 1;
    IF p.lockouts >= (pol->>'max_lockouts')::int THEN
      UPDATE public.admin_payout_pins
         SET failed_attempts = 0, lockouts = p.lockouts, locked_until = NULL, must_reset = true, last_failed_at = now()
       WHERE user_id = p_user;
      INSERT INTO public.admin_payout_pin_events (user_id, event, request_id, details)
      VALUES (p_user, 'reset_required', p_request_id, jsonb_build_object('lockouts', p.lockouts));
      INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
      VALUES (p_user, 'sale', 'Admin Payout PIN locked',
              'The VENTS Admin Payout PIN was entered wrongly too many times and is locked until it is reset with your password. If this was not you, change your password now.',
              false, 'wallet', jsonb_build_object('screen', 'admin_payouts', 'type', 'admin_payout_pin', 'event', 'reset_required'));
      RETURN jsonb_build_object('ok', false, 'code', 'pin_reset_required',
                                'message', 'Too many wrong PINs. The Admin Payout PIN is locked: reset it with your password');
    END IF;
    UPDATE public.admin_payout_pins
       SET failed_attempts = 0, lockouts = p.lockouts,
           locked_until = now() + make_interval(mins => (pol->>'lock_minutes')::int), last_failed_at = now()
     WHERE user_id = p_user
     RETURNING locked_until INTO p.locked_until;
    INSERT INTO public.admin_payout_pin_events (user_id, event, request_id, details)
    VALUES (p_user, 'locked', p_request_id, jsonb_build_object('lockouts', p.lockouts));
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (p_user, 'sale', 'Admin Payout PIN locked',
            'The VENTS Admin Payout PIN was entered wrongly 5 times. Payouts are locked for 30 minutes. If this was not you, change your password now.',
            false, 'wallet', jsonb_build_object('screen', 'admin_payouts', 'type', 'admin_payout_pin', 'event', 'locked'));
    RETURN jsonb_build_object('ok', false, 'code', 'pin_locked', 'locked_until', p.locked_until,
                              'message', 'Too many wrong PINs. Payouts are locked for ' || (pol->>'lock_minutes') || ' minutes');
  END IF;
  UPDATE public.admin_payout_pins SET failed_attempts = p.failed_attempts, last_failed_at = now() WHERE user_id = p_user;
  INSERT INTO public.admin_payout_pin_events (user_id, event, request_id, details)
  VALUES (p_user, 'failed', p_request_id, jsonb_build_object('attempt', p.failed_attempts));
  RETURN jsonb_build_object('ok', false, 'code', 'wrong_pin', 'attempts_left', v_max - p.failed_attempts,
                            'message', 'Wrong PIN. ' || (v_max - p.failed_attempts) || ' attempt'
                                       || CASE WHEN v_max - p.failed_attempts = 1 THEN '' ELSE 's' END || ' left');
END;
$function$;

-- ---------------------------------------------------------------------------
-- Authorize & Pay: the VENTS Admin, the PIN, one withdrawal, one transaction
-- ---------------------------------------------------------------------------
-- Returns {ok:false, code, message} for anything the VENTS Admin can act on
-- (the PIN counters are committed); {ok:true, claimed:true, ...} when this
-- call claimed the request for Paystack (the API then sends the one
-- transfer with the fixed reference); {ok:true, claimed:false, replayed:true}
-- when the same idempotency key was already used for this request (no
-- second transfer). Raises for callers who are not the VENTS Admin.
CREATE OR REPLACE FUNCTION public.admin_authorize_and_claim_payout(p_request_id uuid, p_amount_kobo bigint, p_pin text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  a public.payout_authorizations;
  w public.organizer_withdrawal_requests;
  v_recipient text;
  v_check jsonb;
  v_auth_id uuid;
  v_ref text;
  pol jsonb := public.admin_payout_pin_policy();
BEGIN
  IF v_uid IS NULL OR NOT public.is_root() THEN RAISE EXCEPTION 'VENTS Admin access required'; END IF;
  IF public.payouts_disabled() THEN RAISE EXCEPTION 'payouts_disabled'; END IF;
  IF v_key !~ '^[A-Za-z0-9_-]{16,100}$' THEN RAISE EXCEPTION 'A payout idempotency key (16 to 100 letters, digits, - or _) is required'; END IF;

  -- The same key again: the earlier result, never a second claim.
  SELECT * INTO a FROM public.payout_authorizations WHERE idempotency_key = v_key;
  IF FOUND THEN
    IF a.request_id <> p_request_id OR a.admin_id <> v_uid THEN
      RAISE EXCEPTION 'This payout authorization key was already used for another withdrawal';
    END IF;
    SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = p_request_id;
    RETURN jsonb_build_object('ok', true, 'claimed', false, 'replayed', true, 'request_id', w.id,
                              'status', w.status, 'reference', w.paystack_reference);
  END IF;

  -- Lock order everywhere: the withdrawal, then the PIN.
  SELECT * INTO w FROM public.organizer_withdrawal_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal request not found'; END IF;
  IF w.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_pending', 'status', w.status, 'reference', w.paystack_reference,
                              'message', 'This withdrawal is ' || w.status || ', not waiting for payment');
  END IF;
  IF w.organizer_id = v_uid THEN RAISE EXCEPTION 'You cannot pay your own withdrawal'; END IF;
  IF w.approved_by IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_approved', 'message', 'Approve this withdrawal for payment first');
  END IF;
  IF p_amount_kobo IS DISTINCT FROM w.amount_kobo THEN
    RAISE EXCEPTION 'The amount authorized (%) does not match the request (%)', p_amount_kobo, w.amount_kobo;
  END IF;
  SELECT b.recipient_code INTO v_recipient FROM public.organizer_bank_accounts b
   WHERE b.id = w.bank_account_id AND b.is_active;
  IF v_recipient IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bank_inactive',
                              'message', 'The bank account is inactive or unverified. Reject this withdrawal so the user can request again');
  END IF;
  IF v_recipient IS DISTINCT FROM w.approved_recipient_code
     OR w.bank_account_id IS DISTINCT FROM COALESCE(w.approved_bank_account_id, w.bank_account_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'bank_changed',
                              'message', 'The bank account changed after approval. Reject this withdrawal so the user can request again');
  END IF;

  v_check := public.admin_payout_pin_check(v_uid, p_pin, w.id);
  IF NOT COALESCE((v_check->>'ok')::boolean, false) THEN RETURN v_check; END IF;

  INSERT INTO public.payout_authorizations (request_id, admin_id, amount_kobo, bank_account_id, recipient_code, idempotency_key, expires_at)
  VALUES (w.id, v_uid, w.amount_kobo, w.bank_account_id, v_recipient, v_key,
          clock_timestamp() + make_interval(secs => (pol->>'authorization_seconds')::int))
  RETURNING id INTO v_auth_id;

  v_ref := COALESCE(w.paystack_reference, public.payout_transfer_reference(w.id));
  UPDATE public.organizer_withdrawal_requests
     SET status = 'processing', resolved_by = v_uid, paystack_reference = v_ref,
         payout_authorization_id = v_auth_id, updated_at = now()
   WHERE id = w.id AND status = 'pending';

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (v_uid, 'payout_authorized', w.organizer_id,
          jsonb_build_object('request_id', w.id, 'authorization_id', v_auth_id, 'amount_kobo', w.amount_kobo,
                             'bank_account_id', w.bank_account_id, 'reference', v_ref),
          public.actor_role());

  RETURN jsonb_build_object('ok', true, 'claimed', true, 'request_id', w.id, 'organizer_id', w.organizer_id,
                            'amount_kobo', w.amount_kobo, 'recipient_code', v_recipient, 'reference', v_ref,
                            'authorization_id', v_auth_id);
END;
$function$;

-- ---------------------------------------------------------------------------
-- One authoritative view for every screen
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_list_withdrawals(text, integer);
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

-- Server-computed totals over EVERY withdrawal (not a browser page).
CREATE OR REPLACE FUNCTION public.admin_payout_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  WITH s AS (
    SELECT public.payout_stage(r.status, r.approved_by, (public.withdrawal_current_review(r.id)).decision) AS stage,
           r.amount_kobo
      FROM public.organizer_withdrawal_requests r
  )
  SELECT jsonb_build_object(
           'stages', COALESCE((SELECT jsonb_object_agg(stage, jsonb_build_object('count', n, 'amount_kobo', k))
                                 FROM (SELECT stage, count(*) n, sum(amount_kobo) k FROM s GROUP BY stage) g), '{}'::jsonb),
           'outstanding_kobo', COALESCE((SELECT sum(amount_kobo) FROM s WHERE stage IN ('pending_review', 'forwarded_to_vents_admin', 'rejection_recommended', 'vents_admin_approved', 'processing')), 0),
           'outstanding_count', (SELECT count(*) FROM s WHERE stage IN ('pending_review', 'forwarded_to_vents_admin', 'rejection_recommended', 'vents_admin_approved', 'processing')),
           'processing_kobo', COALESCE((SELECT sum(amount_kobo) FROM s WHERE stage = 'processing'), 0),
           'paid_kobo', COALESCE((SELECT sum(amount_kobo) FROM s WHERE stage = 'paid'), 0),
           'wallet_pending_kobo', COALESCE((SELECT sum(pending_kobo) FROM public.organizer_wallets), 0),
           'is_vents_admin', public.is_root(),
           'viewer_tier', public.payout_admin_tier(auth.uid()),
           'payouts_disabled', public.payouts_disabled(),
           'computed_at', now())
    INTO v;
  RETURN v;
END;
$function$;

-- The user's own withdrawals: the review stages stay internal.
CREATE OR REPLACE FUNCTION public.get_my_withdrawals(p_limit integer DEFAULT 50)
 RETURNS TABLE(request_id uuid, amount_kobo bigint, status text, stage text, bank_name text,
               account_number_masked text, created_at timestamptz, updated_at timestamptz, note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- [0213] pending_review / vents_admin_approved / processing / paid / ...
  SELECT r.id, r.amount_kobo, r.status,
         CASE WHEN r.status = 'pending' AND r.approved_by IS NULL THEN 'pending_review'
              ELSE public.payout_stage(r.status, r.approved_by, NULL) END,
         r.bank_name, public.mask_account_number(r.account_number), r.created_at, r.updated_at,
         CASE WHEN r.status IN ('rejected', 'failed', 'cancelled', 'reversed') THEN NULLIF(btrim(r.admin_note), '') END
    FROM public.organizer_withdrawal_requests r
   WHERE r.organizer_id = auth.uid()
   ORDER BY r.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
$function$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.vents_root_user_id(), public.admin_payout_pin_policy(), public.payout_admin_tier(uuid),
  public.withdrawal_current_review(uuid), public.payout_stage(text, uuid, text),
  public.admin_payout_pin_hash(uuid, text), public.admin_payout_pin_matches(uuid, text, text),
  public.admin_payout_pin_is_weak(text), public.admin_payout_pin_check(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_review_withdrawal(uuid, bigint, text, text),
  public.admin_approve_withdrawal_for_payment(uuid, bigint, text),
  public.admin_payout_pin_status(), public.admin_set_payout_pin(text, text),
  public.admin_authorize_and_claim_payout(uuid, bigint, text, text),
  public.admin_list_withdrawals(text, integer), public.admin_payout_overview(), public.get_my_withdrawals(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_withdrawal(uuid, bigint, text, text),
  public.admin_approve_withdrawal_for_payment(uuid, bigint, text),
  public.admin_payout_pin_status(), public.admin_set_payout_pin(text, text),
  public.admin_authorize_and_claim_payout(uuid, bigint, text, text),
  public.admin_list_withdrawals(text, integer), public.admin_payout_overview(), public.get_my_withdrawals(integer)
  TO authenticated;

DO $post$
BEGIN
  IF has_function_privilege('authenticated', 'public.admin_claim_payout_for_processing(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admin_approve_withdrawal(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admin_first_approve_withdrawal(uuid,bigint)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'public.admin_payout_pins', 'SELECT')
     OR has_table_privilege('authenticated', 'public.payout_authorizations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.withdrawal_reviews', 'INSERT') THEN
    RAISE EXCEPTION '0213: a client role can still reach a closed payout path';
  END IF;
END
$post$;
