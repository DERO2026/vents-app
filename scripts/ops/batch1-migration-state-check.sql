-- Batch 1 production migration-state check (0226, 0233-0238). READ ONLY.
--
-- What it does: reports, for each migration, whether it is APPLIED, MISSING
-- or PARTIAL (some of its objects present, some not), whether every function
-- it installs is byte-identical to the repository's version (md5 of the
-- function body, the same fingerprint the migrations pin), whether the
-- database is in the exact state each not-yet-applied migration expects
-- (READY / BLOCKED), and the AZ-09 payout-reject check. One result table.
--
-- What it never does: write, apply, undo, lock tables, or print secrets. It
-- runs inside a READ ONLY transaction (any write would be refused by
-- PostgreSQL) that is rolled back at the end, with short statement and lock
-- timeouts. It reads only catalog metadata (functions, policies, constraints,
-- privileges) and, if present, the names in Supabase's migration history.
-- It reads no table rows, no user data and no secrets.
--
-- How to run (owner, after authorizing it): Supabase dashboard -> SQL editor
-- -> paste this whole file -> Run. Or locally:
--   psql "<connection string from your password manager>" -X -f scripts/ops/batch1-migration-state-check.sql
-- (never paste the connection string into chat or a committed file).
--
-- Reading the result: section 'summary' has one row per migration.
--   APPLIED  every structural marker present        MISSING  none present
--   PARTIAL  some present: STOP, do not apply anything; send the full output
-- section 'checksum': MATCHES / DIFFERS / absent per function
-- section 'precheck': READY / BLOCKED for each migration not yet applied
-- Tested locally: scripts/local-pg-test/run-batch1-migration-state-check-verification.sh

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';

WITH
fn AS (
  SELECT p.proname, md5(replace(p.prosrc, E'\r', '')) AS md5, p.prosrc
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
),
events_select AS (
  SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS qual
    FROM pg_policy WHERE polrelid = to_regclass('public.events')
),
reviews_pol AS (
  SELECT polname, pg_get_expr(polwithcheck, polrelid) AS chk
    FROM pg_policy WHERE polrelid = to_regclass('public.organizer_reviews')
),
markers(migration, item, present) AS (
  VALUES
  ('0226', 'table payment_exceptions',                 to_regclass('public.payment_exceptions') IS NOT NULL),
  ('0226', 'function record_payment_exception',        EXISTS (SELECT 1 FROM fn WHERE proname = 'record_payment_exception')),
  ('0226', 'function mark_payment_exception_ticketed', EXISTS (SELECT 1 FROM fn WHERE proname = 'mark_payment_exception_ticketed')),
  ('0226', 'function admin_list_payment_exceptions',   EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_list_payment_exceptions')),
  ('0226', 'function admin_resolve_payment_exception', EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_resolve_payment_exception')),

  ('0233', 'table ticket_transfer_fee_attempts',       to_regclass('public.ticket_transfer_fee_attempts') IS NOT NULL),
  ('0233', 'function record_transfer_fee_payment_exception', EXISTS (SELECT 1 FROM fn WHERE proname = 'record_transfer_fee_payment_exception')),
  ('0233', 'column payment_exceptions.transfer_id',    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_exceptions' AND column_name = 'transfer_id')),
  ('0233', 'kind check allows ticket_transfer_fee',    EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_exceptions_kind_check' AND pg_get_constraintdef(oid) LIKE '%ticket_transfer_fee%')),
  ('0233', 'initiate_transfer_fee_payment records attempts', EXISTS (SELECT 1 FROM fn WHERE proname = 'initiate_transfer_fee_payment' AND prosrc LIKE '%ticket_transfer_fee_attempts%')),
  ('0233', 'confirm_transfer_fee_payment reads attempts',    EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_transfer_fee_payment' AND prosrc LIKE '%ticket_transfer_fee_attempts%')),

  ('0234', 'column payment_exceptions.refund_status',  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_exceptions' AND column_name = 'refund_status')),
  ('0234', 'function admin_request_payment_exception_refund',    EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_request_payment_exception_refund')),
  ('0234', 'function execute_payment_exception_refund_approval', EXISTS (SELECT 1 FROM fn WHERE proname = 'execute_payment_exception_refund_approval')),
  ('0234', 'function start_payment_exception_refund',            EXISTS (SELECT 1 FROM fn WHERE proname = 'start_payment_exception_refund')),
  ('0234', 'function attach_payment_exception_refund_id',        EXISTS (SELECT 1 FROM fn WHERE proname = 'attach_payment_exception_refund_id')),
  ('0234', 'function admin_revert_payment_exception_refund',     EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_revert_payment_exception_refund')),
  ('0234', 'function finalize_payment_exception_refund',         EXISTS (SELECT 1 FROM fn WHERE proname = 'finalize_payment_exception_refund')),
  ('0234', 'function fail_payment_exception_refund',             EXISTS (SELECT 1 FROM fn WHERE proname = 'fail_payment_exception_refund')),
  ('0234', 'approve_admin_action runs the refund executor',      EXISTS (SELECT 1 FROM fn WHERE proname = 'approve_admin_action' AND prosrc LIKE '%execute_payment_exception_refund_approval%')),
  ('0234', 'request_admin_action accepts refund_payment_exception', EXISTS (SELECT 1 FROM fn WHERE proname = 'request_admin_action' AND prosrc LIKE '%''refund_payment_exception''%')),
  ('0234', 'admin_list_payment_exceptions returns refund state', EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.admin_list_payment_exceptions(text,integer,integer)') AND pg_get_function_result(oid) LIKE '%refund_request_status%')),

  ('0235', 'anon cannot execute boost_event_vc',          NOT COALESCE(has_function_privilege('anon', to_regprocedure('public.boost_event_vc(uuid)'), 'EXECUTE'), true)),
  ('0235', 'authenticated cannot execute boost_event_vc', NOT COALESCE(has_function_privilege('authenticated', to_regprocedure('public.boost_event_vc(uuid)'), 'EXECUTE'), true)),

  ('0236', 'function user_holds_ticket_for_event',     EXISTS (SELECT 1 FROM fn WHERE proname = 'user_holds_ticket_for_event')),
  ('0236', 'select_events uses the privacy rule',      EXISTS (SELECT 1 FROM events_select WHERE polname = 'select_events' AND qual LIKE '%user_holds_ticket_for_event%' AND qual LIKE '%draft%')),

  ('0237', 'function user_attended_organizer_event',   EXISTS (SELECT 1 FROM fn WHERE proname = 'user_attended_organizer_event')),
  ('0237', 'review insert requires attendance',        EXISTS (SELECT 1 FROM reviews_pol WHERE polname = 'organizer_reviews_insert' AND chk LIKE '%user_attended_organizer_event%')),
  ('0237', 'review update requires attendance',        EXISTS (SELECT 1 FROM reviews_pol WHERE polname = 'organizer_reviews_update' AND chk LIKE '%user_attended_organizer_event%')),

  ('0238', 'confirm_transfer_fee_payment queues refunds', EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_transfer_fee_payment' AND prosrc LIKE '%[0238]%' AND prosrc NOT LIKE '%:refund_claimed%')),
  ('0238', 'reason check allows transfer_not_completed', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_exceptions_reason_check' AND pg_get_constraintdef(oid) LIKE '%transfer_not_completed%')),
  ('0238', 'finalize_payment_exception_refund updates transfers', EXISTS (SELECT 1 FROM fn WHERE proname = 'finalize_payment_exception_refund' AND prosrc LIKE '%[0238]%')),
  ('0238', 'fail_payment_exception_refund updates transfers',     EXISTS (SELECT 1 FROM fn WHERE proname = 'fail_payment_exception_refund' AND prosrc LIKE '%[0238]%'))
),
summary AS (
  SELECT migration,
         CASE WHEN bool_and(present) THEN 'APPLIED' WHEN NOT bool_or(present) THEN 'MISSING' ELSE 'PARTIAL' END AS state,
         count(*) FILTER (WHERE present) || '/' || count(*) || ' markers present' AS detail
    FROM markers GROUP BY migration
),
-- Accepted fingerprints: this migration's version, or a later Batch 1
-- migration's deliberate replacement of it.
checks(migration, fn_name, accepted, note) AS (
  VALUES
  ('0226', 'record_payment_exception',        ARRAY['d90c9a74fee3d35fd91f18b98dc6fa13'], ''),
  ('0226', 'mark_payment_exception_ticketed', ARRAY['082375d732fb8201c1cb2e59d5cd861c'], ''),
  ('0226', 'admin_list_payment_exceptions',   ARRAY['9e7cb373db3327cd27443bba4b729987', 'ff5fd380acfac8a81677f3e08e50b86a'], '0226, or 0234 version'),
  ('0226', 'admin_resolve_payment_exception', ARRAY['87be17ca4555c4a1a53792aa991b1af1', '8382ec387a39ba135f10681736a985d2'], '0226, or 0234 version'),
  ('0233', 'record_transfer_fee_payment_exception', ARRAY['21109f21dfc8d19f9bd23017b9420af0'], ''),
  ('0233', 'initiate_transfer_fee_payment',   ARRAY['4d0b0a76b62c83cc0b3c7efb11c0f345'], ''),
  ('0233', 'get_transfer_fee_payment_owner',  ARRAY['b492774804a4d925f6f79cde4f967cc9'], ''),
  ('0233', 'confirm_transfer_fee_payment',    ARRAY['99d89944166a06b9f6c44289634c2c7f', '8211137af27e224713b82f2f89d6454d'], '0233, or 0238 version'),
  ('0234', 'admin_request_payment_exception_refund',    ARRAY['97cd1de8e1727fa17e4fbece3ffddd78'], ''),
  ('0234', 'execute_payment_exception_refund_approval', ARRAY['13f9f4296d5b1157a63f92feb1c4818c'], ''),
  ('0234', 'start_payment_exception_refund',            ARRAY['d0b992441903722d28d6b3b5946b9242'], ''),
  ('0234', 'attach_payment_exception_refund_id',        ARRAY['ea0455eaa290c9b3a3212bb6983251c6'], ''),
  ('0234', 'admin_revert_payment_exception_refund',     ARRAY['d60ed33d26aa68198efa1776328e6afa'], ''),
  ('0234', 'finalize_payment_exception_refund',         ARRAY['5054801cd73750349ed99310519aaf8e', '937f2aeb15224742f6fba86653cdbaa4'], '0234, or 0238 version'),
  ('0234', 'fail_payment_exception_refund',             ARRAY['099e94c90aacac4e70bb6bc925cf94e2', '4057b9954d0883d7a0caf839962975de'], '0234, or 0238 version'),
  ('0236', 'user_holds_ticket_for_event',     ARRAY['fd5d12cf84f78cca1cd08c00ff3c913d'], ''),
  ('0237', 'user_attended_organizer_event',   ARRAY['1c29d5322730e429331a4b2b3cd04555'], ''),
  ('0238', 'confirm_transfer_fee_payment',    ARRAY['8211137af27e224713b82f2f89d6454d'], ''),
  ('0238', 'finalize_payment_exception_refund', ARRAY['937f2aeb15224742f6fba86653cdbaa4'], ''),
  ('0238', 'fail_payment_exception_refund',   ARRAY['4057b9954d0883d7a0caf839962975de'], '')
),
checksum AS (
  SELECT c.migration, c.fn_name,
         CASE WHEN f.md5 IS NULL THEN 'absent'
              WHEN f.md5 = ANY (c.accepted) THEN 'MATCHES'
              ELSE 'DIFFERS' END AS state,
         'live ' || COALESCE(f.md5, '-') || CASE WHEN c.note <> '' THEN ' (accepts ' || c.note || ')' ELSE '' END AS detail
    FROM checks c LEFT JOIN fn f ON f.proname = c.fn_name
),
cnt AS (
  SELECT
    (SELECT (length(prosrc) - length(replace(prosrc, E'      ELSIF r.action_type = ''reassign_withdrawal_bank_account'' THEN\n', ''))) / length(E'      ELSIF r.action_type = ''reassign_withdrawal_bank_account'' THEN\n') FROM fn WHERE proname = 'approve_admin_action') AS approve_anchor,
    (SELECT (length(prosrc) - length(replace(prosrc, '''reassign_withdrawal_bank_account''', ''))) / length('''reassign_withdrawal_bank_account''') FROM fn WHERE proname = 'request_admin_action') AS request_anchor,
    (SELECT count(*) FROM events_select WHERE polcmd IN ('r', '*')) AS events_select_policies,
    (SELECT regexp_replace(qual, '\s+', '', 'g') FROM events_select WHERE polname = 'select_events') AS events_qual
),
precheck(migration, item, ok) AS (
  SELECT '0233', '0226 present (payment_exceptions)', to_regclass('public.payment_exceptions') IS NOT NULL
  UNION ALL SELECT '0233', 'initiate/owner/confirm are the 0043/0064 versions 0233 is pinned to',
    (SELECT count(*) = 3 FROM fn WHERE (proname, md5) IN (('initiate_transfer_fee_payment', '02f938d7ac659268b73ce822752ef400'),
                                                       ('get_transfer_fee_payment_owner', '2984c22524a9bb1a1b21a9960447491c'),
                                                       ('confirm_transfer_fee_payment', '46f411874adac7e0f55192cc54539a2d')))
  UNION ALL SELECT '0234', 'list/resolve are the 0226 versions 0234 is pinned to',
    (SELECT count(*) = 2 FROM fn WHERE (proname, md5) IN (('admin_list_payment_exceptions', '9e7cb373db3327cd27443bba4b729987'),
                                                       ('admin_resolve_payment_exception', '87be17ca4555c4a1a53792aa991b1af1')))
  UNION ALL SELECT '0234', 'approve_admin_action has the 0207 anchor exactly once', (SELECT approve_anchor = 1 FROM cnt)
  UNION ALL SELECT '0234', 'request_admin_action has the 0207 anchor exactly once', (SELECT request_anchor = 1 FROM cnt)
  UNION ALL SELECT '0235', 'boost_event_vc(uuid) exists', to_regprocedure('public.boost_event_vc(uuid)') IS NOT NULL
  UNION ALL SELECT '0236', 'select_events is the 0008 policy',
    (SELECT events_qual = '((deleted_atISNULL)OR(organizer_id=(SELECTauth.uid()ASuid))ORis_admin())' FROM cnt)
  UNION ALL SELECT '0236', 'exactly one SELECT policy on events', (SELECT events_select_policies = 1 FROM cnt)
  UNION ALL SELECT '0237', 'organizer_reviews insert/update policies exist',
    (SELECT count(*) = 2 FROM reviews_pol WHERE polname IN ('organizer_reviews_insert', 'organizer_reviews_update'))
  UNION ALL SELECT '0238', 'confirm is the 0233 version 0238 is pinned to', EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_transfer_fee_payment' AND md5 = '99d89944166a06b9f6c44289634c2c7f')
  UNION ALL SELECT '0238', 'finalize/fail are the 0234 versions 0238 is pinned to',
    (SELECT count(*) = 2 FROM fn WHERE (proname, md5) IN (('finalize_payment_exception_refund', '5054801cd73750349ed99310519aaf8e'),
                                                       ('fail_payment_exception_refund', '099e94c90aacac4e70bb6bc925cf94e2')))
),
history AS (
  SELECT CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NULL THEN 'no supabase_migrations.schema_migrations table'
              ELSE COALESCE(array_to_string(xpath('/table/row/n/text()', query_to_xml(
                     'SELECT version || '' '' || COALESCE(name, '''') AS n FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 15',
                     false, false, ''))::text[], ' | '), '(empty)') END AS names
)
SELECT section, migration, item, status, detail FROM (
  SELECT 1 AS o, 'summary' AS section, s.migration, 'state' AS item, s.state AS status, s.detail FROM summary s
  UNION ALL SELECT 2, 'marker', m.migration, m.item, CASE WHEN m.present THEN 'present' ELSE 'absent' END, '' FROM markers m
  UNION ALL SELECT 3, 'checksum', c.migration, c.fn_name, c.state, c.detail FROM checksum c
  UNION ALL SELECT 4, 'precheck', p.migration, p.item,
                   CASE WHEN s.state = 'APPLIED' THEN 'n/a (applied)' WHEN COALESCE(p.ok, false) THEN 'READY' ELSE 'BLOCKED' END, ''
              FROM precheck p JOIN summary s USING (migration)
  UNION ALL SELECT 5, 'safety', 'AZ-09', 'admin_reject_organizer_payout claims atomically',
                   CASE WHEN EXISTS (SELECT 1 FROM fn WHERE proname = 'admin_reject_organizer_payout'
                                      AND prosrc LIKE '%WHERE id = p_request_id AND status = ''pending''%'
                                      AND prosrc LIKE '%RETURNING organizer_id, amount_kobo INTO v_organizer_id, v_amount_kobo%')
                        THEN 'OK' ELSE 'CHECK' END, 'must be OK; never apply 0187'
  UNION ALL SELECT 6, 'history', '-', 'last 15 entries of supabase_migrations (informational)', 'info', (SELECT names FROM history)
) r
ORDER BY o, migration, item;

ROLLBACK;
