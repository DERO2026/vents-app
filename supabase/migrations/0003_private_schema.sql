-- private.app_secrets — holds the ticket-QR HMAC v2 signing secret. This
-- table does NOT exist in the automated schema export (export tooling only
-- covers the `public` schema) and was reconstructed by hand from
-- migrations/20260715120000_crypto-signed-qr-tickets-v2.sql.
CREATE TABLE IF NOT EXISTS private.app_secrets (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.app_secrets FROM PUBLIC;
REVOKE ALL ON private.app_secrets FROM anon, authenticated;

-- ── DO NOT regenerate this secret. ──────────────────────────────────────────
-- Every ticket QR currently in an attendee's hand was signed with the value
-- already live in InsForge's private.app_secrets ('ticket_hmac_v2'). If this
-- migration inserts a freshly random value instead, every unscanned ticket
-- issued before cutover fails signature verification at the door.
--
-- At actual cutover time: read the live value with
--   INSFORGE: npx @insforge/cli db query --unrestricted \
--     "SELECT value FROM private.app_secrets WHERE key='ticket_hmac_v2'"
-- and insert that EXACT value here via a secure channel (never commit it to
-- git, never paste it into a chat log) — e.g. run the INSERT by hand through
-- psql against Supabase, or via a one-time secrets-manager-backed script.
--
-- The placeholder below is intentionally NOT executed automatically; this
-- migration only creates the table. Uncomment and fill in at cutover:
--
-- INSERT INTO private.app_secrets (key, value)
-- VALUES ('ticket_hmac_v2', '<PASTE EXACT VALUE FROM LIVE INSFORGE HERE>')
-- ON CONFLICT (key) DO NOTHING;
