-- 0215 (wallet transfers) production preflight. READ ONLY.
--
-- One statement, one JSON result: {"read_only":"on", "blockers":[...],
-- "checks":{...}, "baseline":{...}, "timing":{...}}. Apply 0215 only when
-- "blockers" is empty. Any error from this script is also a STOP.
--
-- Safety:
--   * BEGIN TRANSACTION READ ONLY: PostgreSQL rejects any INSERT, UPDATE,
--     DELETE, DDL, nextval() or other write inside it; the result proves it
--     with "read_only":"on". It ends with ROLLBACK.
--   * Reads only catalogs and counts/sums. No user-defined function is
--     called, so no function body can write or log on our behalf.
--   * The output holds no names, usernames, emails, IDs or query text:
--     counts and sums only. (The server may still write its own connection
--     or statement log lines; that is not a database change.)
--   * lock_timeout / statement_timeout are SET LOCAL: this transaction only.
--
-- Run with the Supabase MCP execute_sql (or the SQL editor, or psql),
-- as the same role that will apply 0215.
BEGIN TRANSACTION READ ONLY;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
WITH
fn_names(n) AS (VALUES ('wallet_transfers_disabled'), ('admin_set_wallet_transfers_enabled'), ('wallet_transfer_policy'),
  ('wallet_transfers_immutable'), ('wallet_transfer_account_ok'), ('wallet_display_name'), ('find_wallet_transfer_recipient'),
  ('get_my_wallet_transfer_status'), ('transfer_wallet_funds'), ('get_my_wallet_transfer')),
idx_names(n) AS (VALUES ('wallet_transfers_sender_key_idx'), ('wallet_transfers_sender_created_idx'), ('wallet_transfers_recipient_created_idx'),
  ('user_wallet_transactions_transfer_out_ref_idx'), ('user_wallet_transactions_transfer_in_ref_idx'), ('users_lower_username_idx')),
req_fn(sig, want) AS (VALUES ('public.withdrawal_pin_check(uuid,text)', 'jsonb'), ('public.withdrawal_naira(bigint)', NULL),
  ('public.check_rate_limit(text,integer,integer)', NULL), ('public.is_root()', 'boolean'), ('public.is_email_verified()', 'boolean'),
  ('public.actor_role()', 'text'), ('auth.uid()', 'uuid'), ('gen_random_uuid()', 'uuid')),
req_col(t, c) AS (VALUES
  ('users','id'),('users','status'),('users','banned_until'),('users','deleted_at'),('users','created_at'),('users','is_verified'),
  ('users','username'),('users','full_name'),('users','avatar_url'),
  ('user_wallets','user_id'),('user_wallets','balance_kobo'),('user_wallets','updated_at'),
  ('user_wallet_transactions','user_id'),('user_wallet_transactions','type'),('user_wallet_transactions','amount_kobo'),
  ('user_wallet_transactions','description'),('user_wallet_transactions','reference_id'),('user_wallet_transactions','metadata'),
  ('user_wallet_transactions','created_at'),
  ('withdrawal_pins','user_id'),('withdrawal_pins','reset_at'),('withdrawal_pins','pin_hash'),('withdrawal_pins','must_reset'),('withdrawal_pins','locked_until'),
  ('admin_logs','admin_id'),('admin_logs','action'),('admin_logs','details'),('admin_logs','actor_role'),
  ('notifications','user_id'),('notifications','type'),('notifications','title'),('notifications','body'),('notifications','read'),
  ('notifications','icon'),('notifications','push_data')),
ledger_check AS (
  SELECT array_agg(m[1] ORDER BY m[1]) AS types
    FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') m
   WHERE c.conrelid = to_regclass('public.user_wallet_transactions') AND c.conname = 'user_wallet_transactions_type_check'),
ledger_types AS (SELECT type, count(*) AS n, sum(amount_kobo) AS kobo FROM public.user_wallet_transactions GROUP BY type),
notif_check AS (
  SELECT count(*) AS n, bool_or(pg_get_constraintdef(oid) ~ '''sale''') AS has_sale
    FROM pg_constraint WHERE conrelid = to_regclass('public.notifications') AND contype = 'c'
     AND pg_get_constraintdef(oid) ~* '\mtype\M'),
ledger_sums AS (SELECT user_id, sum(CASE WHEN type = 'spend' THEN -amount_kobo ELSE amount_kobo END) AS s
                  FROM public.user_wallet_transactions GROUP BY user_id),
c AS (
  SELECT
    current_setting('transaction_read_only') AS read_only,
    (SELECT types FROM ledger_check) AS ledger_check_types,
    (SELECT array_agg(type ORDER BY type) FROM ledger_types) AS ledger_types_in_use,
    (SELECT array_agg(sig ORDER BY sig) FROM req_fn WHERE to_regprocedure(sig) IS NULL) AS missing_functions,
    (SELECT array_agg(sig || ' returns ' || pg_get_function_result(to_regprocedure(sig)) ORDER BY sig) FROM req_fn
      WHERE want IS NOT NULL AND to_regprocedure(sig) IS NOT NULL AND pg_get_function_result(to_regprocedure(sig)) <> want) AS wrong_return_types,
    (SELECT array_agg(t || '.' || c ORDER BY t, c) FROM req_col
      WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = req_col.t AND ic.column_name = req_col.c)) AS missing_columns,
    to_regclass('public.app_config') IS NOT NULL AS app_config_exists,
    EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = to_regclass('public.user_wallets') AND i.indisunique AND i.indpred IS NULL
             AND i.indnkeyatts = 1 AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('public.user_wallets') AND attname = 'user_id')) AS user_wallets_user_id_unique,
    EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = to_regclass('public.users') AND i.indisunique AND i.indpred IS NULL
             AND i.indnkeyatts = 1 AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('public.users') AND attname = 'id')) AS users_id_unique,
    (SELECT n FROM notif_check) AS notifications_type_checks,
    COALESCE((SELECT has_sale FROM notif_check), true) AS notifications_allow_sale,
    to_regclass('public.wallet_transfers') IS NOT NULL AS wallet_transfers_exists,
    (SELECT array_agg(n ORDER BY n) FROM idx_names WHERE to_regclass('public.' || n) IS NOT NULL) AS existing_0215_indexes,
    (SELECT array_agg(p.oid::regprocedure::text ORDER BY 1) FROM pg_proc p JOIN fn_names f ON f.n = p.proname
      WHERE p.pronamespace = 'public'::regnamespace) AS existing_0215_functions,
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'wallet_transfers_immutable') AS existing_0215_trigger,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_config' AND column_name = 'disable_wallet_transfers') AS existing_0215_column,
    (SELECT count(*) FROM public.app_config) AS app_config_rows,
    has_table_privilege('authenticated', 'public.user_wallets', 'UPDATE') OR has_table_privilege('authenticated', 'public.user_wallets', 'INSERT')
      OR has_table_privilege('authenticated', 'public.user_wallet_transactions', 'INSERT') OR has_table_privilege('authenticated', 'public.user_wallet_transactions', 'UPDATE')
      OR has_table_privilege('anon', 'public.user_wallets', 'UPDATE') OR has_table_privilege('anon', 'public.user_wallet_transactions', 'INSERT') AS client_can_write_wallet_money,
    (SELECT array_agg(relname ORDER BY relname) FROM pg_class
      WHERE oid IN (to_regclass('public.users'), to_regclass('public.user_wallet_transactions'), to_regclass('public.app_config'))
        AND NOT pg_has_role(current_user, relowner, 'USAGE')) AS tables_current_role_cannot_alter
)
SELECT jsonb_pretty(jsonb_build_object(
  'read_only', c.read_only,
  'checked_at', now(),
  'role', current_user,
  'database', current_database(),
  'server_version', current_setting('server_version'),
  'in_recovery', pg_is_in_recovery(),
  'blockers', to_jsonb(array_remove(ARRAY[
    CASE WHEN c.read_only <> 'on' THEN 'Q1 not a read-only transaction' END,
    CASE WHEN c.ledger_check_types IS DISTINCT FROM ARRAY['deposit','refund','spend','vc_conversion'] THEN 'Q2 ledger type CHECK is not exactly deposit/refund/spend/vc_conversion' END,
    CASE WHEN NOT (COALESCE(c.ledger_types_in_use, '{}') <@ ARRAY['deposit','refund','spend','vc_conversion']) THEN 'Q3 ledger holds a type outside the four' END,
    CASE WHEN c.missing_functions IS NOT NULL THEN 'Q4 required function missing' END,
    CASE WHEN c.wrong_return_types IS NOT NULL THEN 'Q4 required function has an unexpected return type' END,
    CASE WHEN c.missing_columns IS NOT NULL OR NOT c.app_config_exists THEN 'Q5 required table or column missing' END,
    CASE WHEN NOT c.user_wallets_user_id_unique THEN 'Q5 user_wallets(user_id) is not unique (ON CONFLICT (user_id) would fail at runtime)' END,
    CASE WHEN NOT c.users_id_unique THEN 'Q5 users(id) is not unique (foreign keys need it)' END,
    CASE WHEN NOT c.notifications_allow_sale THEN 'Q6 notifications type CHECK does not allow ''sale''' END,
    CASE WHEN c.wallet_transfers_exists OR c.existing_0215_indexes IS NOT NULL OR c.existing_0215_functions IS NOT NULL
              OR c.existing_0215_trigger OR c.existing_0215_column THEN 'Q7 an object 0215 creates already exists (partial apply or name collision; undo_0215 would drop it)' END,
    CASE WHEN c.app_config_rows <> 1 THEN 'Q8 app_config does not have exactly one row' END,
    CASE WHEN c.client_can_write_wallet_money THEN 'Q12 a client role can write wallet money directly (security issue; 0215 post-check would also abort)' END,
    CASE WHEN c.tables_current_role_cannot_alter IS NOT NULL THEN 'Q13 this role cannot ALTER a table 0215 changes' END
  ], NULL)),
  'checks', jsonb_build_object(
    'Q2_ledger_check_types', c.ledger_check_types,
    'Q3_ledger_types_in_use', c.ledger_types_in_use,
    'Q4_missing_functions', c.missing_functions,
    'Q4_wrong_return_types', c.wrong_return_types,
    'Q5_missing_columns', c.missing_columns,
    'Q5_user_wallets_user_id_unique', c.user_wallets_user_id_unique,
    'Q5_users_id_unique', c.users_id_unique,
    'Q6_notifications_type_checks', c.notifications_type_checks,
    'Q6_notifications_allow_sale', c.notifications_allow_sale,
    'Q7_wallet_transfers_exists', c.wallet_transfers_exists,
    'Q7_existing_indexes', c.existing_0215_indexes,
    'Q7_existing_functions', c.existing_0215_functions,
    'Q7_existing_trigger', c.existing_0215_trigger,
    'Q7_existing_switch_column', c.existing_0215_column,
    'Q8_app_config_rows', c.app_config_rows,
    'Q12_client_can_write_wallet_money', c.client_can_write_wallet_money,
    'Q13_tables_role_cannot_alter', c.tables_current_role_cannot_alter),
  'baseline', jsonb_build_object(
    'Q9_user_wallets', (SELECT jsonb_build_object('count', count(*), 'sum_kobo', COALESCE(sum(balance_kobo), 0)) FROM public.user_wallets),
    'Q9_ledger_by_type', (SELECT jsonb_object_agg(type, jsonb_build_object('count', n, 'sum_kobo', kobo)) FROM ledger_types),
    'Q9_wallets_not_equal_ledger', (SELECT count(*) FROM public.user_wallets w LEFT JOIN ledger_sums l ON l.user_id = w.user_id WHERE w.balance_kobo <> COALESCE(l.s, 0)),
    'Q9_organizer_wallets', (SELECT jsonb_build_object('count', count(*), 'sum_kobo', COALESCE(sum(balance_kobo), 0)) FROM public.organizer_wallets),
    'Q10_duplicate_case_username_groups', (SELECT count(*) FROM (SELECT 1 FROM public.users WHERE username IS NOT NULL GROUP BY lower(username) HAVING count(*) > 1) d),
    'Q10_users_in_those_groups', (SELECT COALESCE(sum(k), 0) FROM (SELECT count(*) AS k FROM public.users WHERE username IS NOT NULL GROUP BY lower(username) HAVING count(*) > 1) d)),
  'timing', jsonb_build_object(
    'Q11_users_rows', (SELECT count(*) FROM public.users),
    'Q11_ledger_rows', (SELECT count(*) FROM public.user_wallet_transactions),
    'Q11_users_bytes', pg_total_relation_size('public.users'),
    'Q11_ledger_bytes', pg_total_relation_size('public.user_wallet_transactions'),
    'Q11_other_sessions_in_transaction_over_30s', (SELECT count(*) FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND datname = current_database() AND xact_start < now() - interval '30 seconds'),
    'Q11_other_locks_on_0215_tables', (SELECT count(*) FROM pg_locks l WHERE l.pid <> pg_backend_pid()
       AND l.relation IN (to_regclass('public.users'), to_regclass('public.user_wallet_transactions'), to_regclass('public.app_config'), to_regclass('public.user_wallets'))),
    'Q11_waiting_lock_requests', (SELECT count(*) FROM pg_locks WHERE NOT granted))
)) AS preflight
FROM c;
ROLLBACK;
