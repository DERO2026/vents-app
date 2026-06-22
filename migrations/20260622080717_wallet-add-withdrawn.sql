ALTER TABLE public.organizer_wallets
  ADD COLUMN IF NOT EXISTS total_withdrawn_kobo bigint NOT NULL DEFAULT 0;
