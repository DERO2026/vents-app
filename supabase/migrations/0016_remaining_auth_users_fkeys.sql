-- Adds the remaining foreign keys referencing auth.users that exist on
-- InsForge but were missing from this schema's original migration - the
-- original FK migration pass apparently dropped every reference targeting
-- auth.users specifically (as opposed to public.users), across these 9
-- constraints on 7 tables. Same category of gap as
-- 0014_conversation_requests_fkeys.sql and
-- 0015_organizer_requests_withdrawal_fkeys.sql, discovered by a full FK
-- diff during the pre-cutover audit and confirmed zero violations
-- read-only before applying.

ALTER TABLE public.users
  ADD CONSTRAINT users_id_fkey
  FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.users
  ADD CONSTRAINT users_deleted_by_fkey
  FOREIGN KEY (deleted_by) REFERENCES auth.users (id);

ALTER TABLE public.events
  ADD CONSTRAINT events_deleted_by_fkey
  FOREIGN KEY (deleted_by) REFERENCES auth.users (id);

ALTER TABLE public.direct_messages
  ADD CONSTRAINT direct_messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.direct_messages
  ADD CONSTRAINT direct_messages_recipient_id_fkey
  FOREIGN KEY (recipient_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.message_reactions
  ADD CONSTRAINT message_reactions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.organizer_bank_accounts
  ADD CONSTRAINT organizer_bank_accounts_organizer_id_fkey
  FOREIGN KEY (organizer_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.organizer_transactions
  ADD CONSTRAINT organizer_transactions_organizer_id_fkey
  FOREIGN KEY (organizer_id) REFERENCES auth.users (id) ON DELETE CASCADE;

ALTER TABLE public.organizer_wallets
  ADD CONSTRAINT organizer_wallets_organizer_id_fkey
  FOREIGN KEY (organizer_id) REFERENCES auth.users (id) ON DELETE CASCADE;
