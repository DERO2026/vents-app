-- 0239 production precheck. READ ONLY. Reports whether migration 0239
-- (transfer-fee payments on the live baseline) would apply: the exact
-- refusals 0239's own precheck makes, as rows. Reads only catalog metadata.
-- Never writes. Not run against production without the owner's approval.
--
--   READY   the condition 0239 requires holds
--   BLOCKED it does not: 0239 would refuse (nothing would change)
--
-- Order: 0226 -> 0239 -> 0234 -> 0240.
-- Tested locally: scripts/local-pg-test/run-transfer-fee-live-0239-verification.sh
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
WITH fn AS (
  SELECT proname, md5(replace(prosrc, E'\r', '')) AS md5 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
),
checks(item, ok, detail) AS (
  VALUES
  ('confirm_transfer_fee_payment is the reviewed live version',
   EXISTS (SELECT 1 FROM fn WHERE proname = 'confirm_transfer_fee_payment' AND md5 = '5baaac006d1757b42b2f587315ce6a3f'),
   'live ' || COALESCE((SELECT string_agg(md5, ',') FROM fn WHERE proname = 'confirm_transfer_fee_payment'), 'missing')),
  ('initiate_transfer_fee_payment is 0043''s',
   EXISTS (SELECT 1 FROM fn WHERE proname = 'initiate_transfer_fee_payment' AND md5 = '02f938d7ac659268b73ce822752ef400'),
   'live ' || COALESCE((SELECT string_agg(md5, ',') FROM fn WHERE proname = 'initiate_transfer_fee_payment'), 'missing')),
  ('get_transfer_fee_payment_owner is 0043''s',
   EXISTS (SELECT 1 FROM fn WHERE proname = 'get_transfer_fee_payment_owner' AND md5 = '2984c22524a9bb1a1b21a9960447491c'),
   'live ' || COALESCE((SELECT string_agg(md5, ',') FROM fn WHERE proname = 'get_transfer_fee_payment_owner'), 'missing')),
  ('0226 applied (payment_exceptions, record_payment_exception)',
   to_regclass('public.payment_exceptions') IS NOT NULL
     AND to_regprocedure('public.record_payment_exception(text,text,text,text,bigint,bigint,text)') IS NOT NULL, ''),
  ('0233 / 0239 not applied (no ticket_transfer_fee_attempts)', to_regclass('public.ticket_transfer_fee_attempts') IS NULL, ''),
  ('0064 not applied (no ticket_transfers.fee_refund_* columns)',
   NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ticket_transfers'
                AND column_name LIKE 'fee\_refund\_%'), ''),
  ('0234 not applied yet (no payment_exceptions.transfer_id / refund_status)',
   NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_exceptions'
                AND column_name IN ('transfer_id', 'refund_status')), '')
)
SELECT item, CASE WHEN ok THEN 'READY' ELSE 'BLOCKED' END AS status, detail FROM checks
ORDER BY item;
ROLLBACK;
