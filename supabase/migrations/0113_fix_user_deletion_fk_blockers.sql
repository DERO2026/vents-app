-- Fix: Supabase Dashboard -> Authentication -> Users -> Delete User fails
-- with "Database error deleting user" for any account that has ever
-- touched the app (bought a ticket, been paid for, reviewed a provider,
-- had a pending purchase, etc).
--
-- Root cause (confirmed live via pg_constraint, not guessed): public.users
-- has a CASCADE FK to auth.users(id), so a Dashboard hard-delete of an
-- auth.users row cascades into deleting the matching public.users row --
-- which then has to satisfy every FK that points AT public.users (or, for
-- a few columns, directly at auth.users). 16 of those FKs were declared
-- with the default ON DELETE NO ACTION, i.e. RESTRICT: any one matching
-- row in any of those tables blocks the whole deletion with a bare
-- "foreign key constraint" error, which Supabase's Admin API surfaces to
-- the Dashboard only as the generic "Database error deleting user".
--
-- The app's own supported deletion path, admin_soft_delete_user() (and
-- the end-user "Settings > Delete Account" flow it points to), never
-- touches auth.users or these FKs at all -- it soft-deletes
-- (status='deleted', preserving every row), which is why it already works
-- today and is the correct, unchanged path for a real user with financial
-- history. This migration only unblocks the separate, harder
-- Dashboard-level hard-delete, which is the right tool for a genuinely
-- disposable/test account with no real money attached.
--
-- Each of the 16 blocking FKs is reclassified individually, not blanket-
-- CASCADEd, per its actual meaning:
--
-- SET NULL (pure "who did this" attribution -- the record has value on
-- its own and must survive; nothing here is financial):
--   app_config.updated_by, events.hidden_by, events.deleted_by,
--   users.deleted_by, organizer_requests.reviewed_by,
--   organizer_withdrawal_requests.resolved_by, tickets.payer_id,
--   tickets.refund_initiated_by, service_bookings.refund_initiated_by,
--   vc_withdrawal_requests.resolved_by
--
-- CASCADE (the row's own core identity, already NOT NULL so SET NULL is
-- not even possible for most of these -- deleting the account correctly
-- takes the row with it, exactly like tickets.user_id/service_providers.
-- user_id/organizer_reviews.reviewer_id already do):
--   pending_purchases.user_id, pending_purchases.payer_id (transient,
--   never a finalized financial record), ticket_transfers.to_user_id,
--   ticket_transfers.from_user_id (NOT NULL), service_bookings.customer_id
--   (NOT NULL), provider_reviews.reviewer_id (NOT NULL)
--
-- Left UNCHANGED (still NO ACTION, deliberately): user_wallets.user_id,
-- user_wallet_transactions.user_id, wallet_deposit_attempts.user_id,
-- vc_withdrawal_requests.user_id, organizer_withdrawal_requests.organizer_id
-- (the public.users-referencing one). These are real financial ledgers/
-- balances and requests for payout of real money -- a user with any row
-- in these tables MUST continue to fail a hard delete and be routed to
-- admin_soft_delete_user() instead. A genuinely empty/disposable test
-- account has zero rows in all five of these anyway, so this does not
-- block the stated goal.

ALTER TABLE public.app_config DROP CONSTRAINT app_config_updated_by_fkey;
ALTER TABLE public.app_config ADD CONSTRAINT app_config_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.events DROP CONSTRAINT events_hidden_by_fkey;
ALTER TABLE public.events ADD CONSTRAINT events_hidden_by_fkey
  FOREIGN KEY (hidden_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.events DROP CONSTRAINT events_deleted_by_fkey;
ALTER TABLE public.events ADD CONSTRAINT events_deleted_by_fkey
  FOREIGN KEY (deleted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.users DROP CONSTRAINT users_deleted_by_fkey;
ALTER TABLE public.users ADD CONSTRAINT users_deleted_by_fkey
  FOREIGN KEY (deleted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.organizer_requests DROP CONSTRAINT organizer_requests_reviewed_by_fkey;
ALTER TABLE public.organizer_requests ADD CONSTRAINT organizer_requests_reviewed_by_fkey
  FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.organizer_withdrawal_requests DROP CONSTRAINT organizer_withdrawal_requests_resolved_by_fkey;
ALTER TABLE public.organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.tickets DROP CONSTRAINT tickets_payer_id_fkey;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_payer_id_fkey
  FOREIGN KEY (payer_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.tickets DROP CONSTRAINT tickets_refund_initiated_by_fkey;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_refund_initiated_by_fkey
  FOREIGN KEY (refund_initiated_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.service_bookings DROP CONSTRAINT service_bookings_refund_initiated_by_fkey;
ALTER TABLE public.service_bookings ADD CONSTRAINT service_bookings_refund_initiated_by_fkey
  FOREIGN KEY (refund_initiated_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.vc_withdrawal_requests DROP CONSTRAINT vc_withdrawal_requests_resolved_by_fkey;
ALTER TABLE public.vc_withdrawal_requests ADD CONSTRAINT vc_withdrawal_requests_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.pending_purchases DROP CONSTRAINT pending_purchases_user_id_fkey;
ALTER TABLE public.pending_purchases ADD CONSTRAINT pending_purchases_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.pending_purchases DROP CONSTRAINT pending_purchases_payer_id_fkey;
ALTER TABLE public.pending_purchases ADD CONSTRAINT pending_purchases_payer_id_fkey
  FOREIGN KEY (payer_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.ticket_transfers DROP CONSTRAINT ticket_transfers_to_user_id_fkey;
ALTER TABLE public.ticket_transfers ADD CONSTRAINT ticket_transfers_to_user_id_fkey
  FOREIGN KEY (to_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.ticket_transfers DROP CONSTRAINT ticket_transfers_from_user_id_fkey;
ALTER TABLE public.ticket_transfers ADD CONSTRAINT ticket_transfers_from_user_id_fkey
  FOREIGN KEY (from_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.service_bookings DROP CONSTRAINT service_bookings_customer_id_fkey;
ALTER TABLE public.service_bookings ADD CONSTRAINT service_bookings_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.provider_reviews DROP CONSTRAINT provider_reviews_reviewer_id_fkey;
ALTER TABLE public.provider_reviews ADD CONSTRAINT provider_reviews_reviewer_id_fkey
  FOREIGN KEY (reviewer_id) REFERENCES public.users(id) ON DELETE CASCADE;
