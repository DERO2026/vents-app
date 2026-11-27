# Shared builder for the Batch 1 money suites (sourced, not executed).
#
# Builds, in the caller's throwaway database, the same 0193..0213 stack the
# payout-authorization suite builds: the live helpers captured from
# production (2026-10-30) plus migrations 0201, 0202, 0203, 0205-0213 applied
# in order. The caller must define: SCRIPT_DIR, MIG, PSQL (array), pg(),
# expect_ok().
#
# Local only: every statement runs through the caller's PSQL, which the
# caller has already pinned to a local Unix-socket server and a
# vents_local_pg_* database.

build_money_stack() {
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
  for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
    "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
  done
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
  "${PSQL[@]}" -q -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-live-payout-extras.sql" >/dev/null
  "${PSQL[@]}" -q -c "SET vents.migration_local_test = 'on';" -f "$MIG/0202_payout_engine_safety.sql" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
  "${PSQL[@]}" -q <<'SQL'
GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.request_organizer_payout(bigint, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_organizer_payout(bigint, uuid, text) TO authenticated;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone_number text;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT COALESCE(NULLIF(current_setting('test.jwt', true), ''), '{}')::jsonb $$;
GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;
SQL
  "${PSQL[@]}" -q -c "$(awk '/^-- Function: assert_recent_auth$/{f=1;next} f&&/^-- Function:/{exit} f' "$MIG/0004_functions.sql")"
  for m in 0203_earnings_policies 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment \
           0208_ticket_fee_1_5_3_5 0209_representative_referral_links 0210_referral_connections \
           0211_withdrawal_pin_and_two_admin_approval 0212_old_app_withdrawal_update_required; do
    expect_ok "$m applies" "$(cat "$MIG/$m.sql")"
  done
  "${PSQL[@]}" -q -c "REVOKE ALL ON FUNCTION public.admin_claim_payout_for_processing(uuid) FROM PUBLIC, anon; GRANT EXECUTE ON FUNCTION public.admin_claim_payout_for_processing(uuid) TO authenticated, project_admin;"
  expect_ok "0213 applies" "$(cat "$MIG/0213_vents_admin_payout_authorization.sql")"
}

# build_ticket_stack: the ticket purchase / transfer stack the ticket-
# integrity suite builds (0201..0217, event cancellation 0218/0219, the
# verbatim ticket and transfer functions in schema-ticket-integrity.sql, the
# repository's grants and the production shape of events/tickets RLS), plus
# 0064's transfer-fee refund functions and 0226 payment exceptions. Caller
# provides the same helpers as build_money_stack.
build_ticket_stack() {
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
  for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
    "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
  done
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
  "${PSQL[@]}" -q -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-live-payout-extras.sql" >/dev/null
  "${PSQL[@]}" -q -c "SET vents.migration_local_test = 'on';" -f "$MIG/0202_payout_engine_safety.sql" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
  for m in 0203_earnings_policies 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment 0208_ticket_fee_1_5_3_5 \
           0209_representative_referral_links 0210_referral_connections 0216_representative_rewards_free_events_never_qualify 0217_representative_reward_fixed_50000; do
    "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null 2>&1
  done
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-event-cancellation.sql" >/dev/null
  "${PSQL[@]}" -q <<'SQL'
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text), public.confirm_ticket_payment_via_wallet(text),
  public.refund_ticket(uuid,text), public.soft_delete_event(uuid,text), public.attach_ticket_refund_id(uuid,text),
  public.admin_revert_stuck_refund(uuid,text) TO authenticated;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS reason text;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO authenticated;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS select_events ON public.events;
DROP POLICY IF EXISTS update_events ON public.events;
CREATE POLICY select_events ON public.events FOR SELECT TO public USING (((deleted_at IS NULL) OR (organizer_id = ( SELECT auth.uid() AS uid)) OR public.is_admin()));
CREATE POLICY update_events ON public.events FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = organizer_id) OR public.is_admin())) WITH CHECK (((( SELECT auth.uid() AS uid) = organizer_id) OR public.is_admin()));
GRANT SELECT ON public.tickets TO authenticated;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tickets_local_read ON public.tickets;
CREATE POLICY tickets_local_read ON public.tickets FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin()
  OR EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND e.organizer_id = auth.uid()));
SQL
  expect_ok "0218 applies" "$(cat "$MIG/0218_event_cancellation_workflow.sql")"
  expect_ok "0219 applies" "$(cat "$MIG/0219_event_cancellation_safety_fixes.sql")"
  "${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-ticket-integrity.sql" >/dev/null
  "${PSQL[@]}" -q <<'SQL'
DO $r$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'project_admin') THEN CREATE ROLE project_admin; END IF; END $r$;
GRANT USAGE ON SCHEMA public TO project_admin;
REVOKE ALL ON FUNCTION public.purchase_ticket(uuid,text,jsonb,text,text), public.purchase_ticket_with_tokens(uuid,text,jsonb,text,text),
  public.generate_ticket_token(uuid), public.verify_entry_pass(text,uuid,text,text), public.manual_check_in(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.purchase_ticket(uuid,text,jsonb,text,text), public.purchase_ticket_with_tokens(uuid,text,jsonb,text,text)
  TO anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.generate_ticket_token(uuid), public.verify_entry_pass(text,uuid,text,text), public.manual_check_in(uuid,uuid,text,text)
  TO authenticated, project_admin;
REVOKE ALL ON FUNCTION public.initiate_ticket_transfer(uuid,text), public.accept_ticket_transfer(uuid), public.initiate_transfer_fee_payment(uuid),
  public.confirm_transfer_fee_payment(text,bigint) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.initiate_ticket_transfer(uuid,text), public.accept_ticket_transfer(uuid), public.initiate_transfer_fee_payment(uuid)
  TO authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.confirm_transfer_fee_payment(text,bigint) TO project_admin;
REVOKE ALL ON FUNCTION public.compute_transfer_fee_kobo(numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_transfer_fee_kobo(numeric) TO authenticated, project_admin;
SQL
  # 0043's owner lookup and 0064's refund bookkeeping functions (verbatim).
  local f
  for f in get_transfer_fee_payment_owner; do
    "${PSQL[@]}" -q -c "$(awk "/^CREATE OR REPLACE FUNCTION public.$f\\(/,/^\\\$function\\\$/" "$MIG/0043_ticket_transfer_fee.sql");"
  done
  for f in attach_transfer_fee_refund_id mark_transfer_fee_refund_initiation_failed finalize_transfer_fee_refund fail_transfer_fee_refund; do
    "${PSQL[@]}" -q -c "$(awk "/^CREATE OR REPLACE FUNCTION public.$f\\(/,/^\\\$function\\\$/" "$MIG/0064_ticket_transfer_fee_refund.sql");"
  done
  "${PSQL[@]}" -q -c "$(grep -E '^(REVOKE|GRANT) .*(get_transfer_fee_payment_owner)' "$MIG/0043_ticket_transfer_fee.sql")" \
                  -c "$(grep -E '^(REVOKE|GRANT) .*(attach_transfer_fee_refund_id|mark_transfer_fee_refund_initiation_failed|finalize_transfer_fee_refund|fail_transfer_fee_refund)' "$MIG/0064_ticket_transfer_fee_refund.sql")"
  expect_ok "0226 applies" "$(cat "$MIG/0226_payment_exceptions.sql")"
}
