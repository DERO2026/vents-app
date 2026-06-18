-- Add payment tracking columns to the tickets table
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS payment_ref    TEXT,
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
  ADD COLUMN IF NOT EXISTS amount         NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ticket_type    TEXT;

-- Index for payment_ref lookups (Paystack webhook verification)
CREATE INDEX IF NOT EXISTS idx_tickets_payment_ref ON public.tickets(payment_ref);
