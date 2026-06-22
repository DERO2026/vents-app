ALTER TABLE public.direct_messages
  ADD COLUMN IF NOT EXISTS duration_seconds integer;
