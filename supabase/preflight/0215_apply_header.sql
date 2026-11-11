-- Prepended (verbatim, nothing else) to supabase/migrations/0215_wallet_transfers.sql
-- when 0215 is applied. NOT a migration on its own; never run it alone.
--
-- SET LOCAL changes these timeouts for this one transaction only: no
-- production setting, role or session default changes. If the statements are
-- NOT running inside one transaction, SET LOCAL has no effect (PostgreSQL only
-- warns) and the migration would not be atomic either: the DO block below then
-- stops everything before the first DDL statement.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $apply_guard$
BEGIN
  IF current_setting('lock_timeout')::interval <> interval '5 seconds'
     OR current_setting('statement_timeout')::interval <> interval '60 seconds' THEN
    RAISE EXCEPTION '0215 apply: not running inside one transaction (SET LOCAL did not hold); nothing was applied';
  END IF;
END
$apply_guard$;
