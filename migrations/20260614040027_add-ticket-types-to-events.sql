-- Add ticket_types JSONB column to events table to store array of ticket types
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS ticket_types jsonb DEFAULT '[]'::jsonb;
