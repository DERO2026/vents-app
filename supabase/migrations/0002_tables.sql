-- Tables (columns, defaults, CHECK constraints, PK) as they exist in the
-- live InsForge production database. Extracted via a read-only schema export
-- (no data), reordered so every CREATE TABLE runs before any cross-table
-- reference (foreign keys are applied separately in 0005 after every table
-- exists — the raw export interleaves them per-table, which is unsafe when a
-- table references one defined later in file order).

-- Table: admin_action_requests
CREATE TABLE IF NOT EXISTS admin_action_requests (id uuid NOT NULL DEFAULT gen_random_uuid(), action_type text NOT NULL, target_type text, target_id uuid, target_label text, payload jsonb NOT NULL DEFAULT '{}'::jsonb, previous_values jsonb, requested_changes jsonb, requested_by uuid NOT NULL, requested_by_role text, status text NOT NULL DEFAULT 'pending'::text, reviewed_by uuid, review_reason text, device text, ip text, requested_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz, seen_at timestamptz);

-- Table: admin_logs
CREATE TABLE IF NOT EXISTS admin_logs (id uuid NOT NULL DEFAULT gen_random_uuid(), admin_id uuid, action text NOT NULL, target_user_id uuid, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), actor_role text);

-- Table: app_config
CREATE TABLE IF NOT EXISTS app_config (id boolean NOT NULL DEFAULT true, maintenance_mode boolean NOT NULL DEFAULT false, broadcast_message text, updated_at timestamptz DEFAULT now(), updated_by uuid, vc_naira_per_1000 integer NOT NULL DEFAULT 500, vc_min_ticket_price integer NOT NULL DEFAULT 500, vc_max_redemption_pct integer NOT NULL DEFAULT 50, min_client_version text NOT NULL DEFAULT '1.1.0'::text, voice_notes_enabled boolean NOT NULL DEFAULT false, image_sharing_enabled boolean NOT NULL DEFAULT true, disable_purchases boolean NOT NULL DEFAULT false, disable_scanning boolean NOT NULL DEFAULT false, disable_signups boolean NOT NULL DEFAULT false, disable_payouts boolean NOT NULL DEFAULT false, disable_location_sharing boolean NOT NULL DEFAULT false);

-- Table: blocked_users
CREATE TABLE IF NOT EXISTS blocked_users (id uuid NOT NULL DEFAULT gen_random_uuid(), blocker_id uuid NOT NULL, blocked_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- Table: checkins
CREATE TABLE IF NOT EXISTS checkins (id uuid NOT NULL DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL, event_id uuid NOT NULL, scanned_by uuid, checked_in_at timestamptz NOT NULL DEFAULT now(), user_id uuid, device_id text, gate_name text, created_at timestamptz NOT NULL DEFAULT now(), is_manual_override boolean NOT NULL DEFAULT false);

-- Table: conversation_clears
CREATE TABLE IF NOT EXISTS conversation_clears (user_id uuid NOT NULL, other_user_id uuid NOT NULL, cleared_at timestamptz NOT NULL DEFAULT now());

-- Table: conversation_requests
CREATE TABLE IF NOT EXISTS conversation_requests (id uuid NOT NULL DEFAULT gen_random_uuid(), requester_id uuid NOT NULL, recipient_id uuid NOT NULL, status text NOT NULL DEFAULT 'pending'::text, created_at timestamptz NOT NULL DEFAULT now(), responded_at timestamptz);

-- Table: deleted_emails
CREATE TABLE IF NOT EXISTS deleted_emails (email text NOT NULL, deleted_at timestamptz DEFAULT now());

-- Table: deleted_phones
CREATE TABLE IF NOT EXISTS deleted_phones (phone text NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now());

-- Table: device_fingerprints
CREATE TABLE IF NOT EXISTS device_fingerprints (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- Table: device_push_tokens
CREATE TABLE IF NOT EXISTS device_push_tokens (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, token text NOT NULL, platform text NOT NULL DEFAULT 'android'::text, created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now());

-- Table: direct_messages
CREATE TABLE IF NOT EXISTS direct_messages (id uuid NOT NULL DEFAULT gen_random_uuid(), sender_id uuid NOT NULL, recipient_id uuid NOT NULL, event_id uuid, body text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), image_url text, media_type text, deleted_by_sender boolean DEFAULT false, duration_seconds integer, reply_to_id uuid);

-- Table: event_promotions
CREATE TABLE IF NOT EXISTS event_promotions (id uuid NOT NULL DEFAULT gen_random_uuid(), event_id uuid NOT NULL, organizer_id uuid NOT NULL, plan_type text NOT NULL, start_date timestamptz NOT NULL, end_date timestamptz NOT NULL, status text NOT NULL DEFAULT 'active'::text, created_at timestamptz NOT NULL DEFAULT now(), payment_ref text);

-- Table: event_reminder_log
CREATE TABLE IF NOT EXISTS event_reminder_log (id uuid NOT NULL DEFAULT gen_random_uuid(), ticket_id uuid NOT NULL, kind text NOT NULL, sent_at timestamptz NOT NULL DEFAULT now());

-- Table: events
CREATE TABLE IF NOT EXISTS events (id uuid NOT NULL DEFAULT gen_random_uuid(), title text NOT NULL, description text, image_url text, location text NOT NULL, event_date timestamptz NOT NULL, price numeric NOT NULL DEFAULT 0, category text, organizer_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), ticket_types jsonb DEFAULT '[]'::jsonb, ticket_goal integer NOT NULL DEFAULT 500, status text NOT NULL DEFAULT 'live'::text, is_featured boolean NOT NULL DEFAULT false, hidden_by_admin boolean NOT NULL DEFAULT false, hidden_at timestamptz, hidden_by uuid, is_18_plus boolean NOT NULL DEFAULT false, start_time text, end_time text, categories text[] DEFAULT '{}'::text[], featured_until timestamptz, deleted_at timestamptz, deleted_by uuid, reason text, gallery_urls text[] NOT NULL DEFAULT '{}'::text[], payout_account_id uuid, latitude double precision, longitude double precision, place_id text, end_date timestamptz, contact_phone text, show_phone boolean NOT NULL DEFAULT false);

-- Table: highlights
CREATE TABLE IF NOT EXISTS highlights (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, media_url text NOT NULL, media_type text NOT NULL DEFAULT 'image'::text, caption text, created_at timestamptz NOT NULL DEFAULT now(), group_id uuid DEFAULT gen_random_uuid(), sort_order integer NOT NULL DEFAULT 0);

-- Table: media_assets
CREATE TABLE IF NOT EXISTS media_assets (id uuid NOT NULL DEFAULT gen_random_uuid(), url text NOT NULL, storage_key text, thumbnail_url text, thumbnail_key text, width integer, height integer, file_size bigint, mime_type text, user_id uuid, event_id uuid, uploaded_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());

-- Table: message_reactions
CREATE TABLE IF NOT EXISTS message_reactions (id uuid NOT NULL DEFAULT gen_random_uuid(), message_id uuid NOT NULL, user_id uuid NOT NULL, emoji text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- Table: notifications
CREATE TABLE IF NOT EXISTS notifications (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, type text NOT NULL, title text NOT NULL, body text NOT NULL, read boolean NOT NULL DEFAULT false, icon text NOT NULL DEFAULT '🔔'::text, created_at timestamptz NOT NULL DEFAULT now(), push_sent boolean NOT NULL DEFAULT false, push_data jsonb);

-- Table: organizer_bank_accounts
CREATE TABLE IF NOT EXISTS organizer_bank_accounts (id uuid NOT NULL DEFAULT gen_random_uuid(), organizer_id uuid NOT NULL, bank_name text NOT NULL, account_number text NOT NULL, account_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), bank_code text, recipient_code text, is_default boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true);

-- Table: organizer_requests
CREATE TABLE IF NOT EXISTS organizer_requests (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, reason text, status text NOT NULL DEFAULT 'pending'::text, admin_note text, reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());

-- Table: organizer_reviews
CREATE TABLE IF NOT EXISTS organizer_reviews (id uuid NOT NULL DEFAULT gen_random_uuid(), organizer_id uuid NOT NULL, reviewer_id uuid NOT NULL, rating smallint NOT NULL, body text NOT NULL, created_at timestamptz DEFAULT now());

-- Table: organizer_transactions
CREATE TABLE IF NOT EXISTS organizer_transactions (id uuid NOT NULL DEFAULT gen_random_uuid(), organizer_id uuid NOT NULL, type text NOT NULL, amount_kobo bigint NOT NULL, description text, ticket_sale_id uuid, created_at timestamptz NOT NULL DEFAULT now(), withdrawal_request_id uuid, metadata jsonb);

-- Table: organizer_verification_requests
CREATE TABLE IF NOT EXISTS organizer_verification_requests (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, company_name text NOT NULL, cac_number text NOT NULL, business_address text NOT NULL, document_url text NOT NULL, status text NOT NULL DEFAULT 'pending'::text, admin_note text, reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), owner_name text NOT NULL, registration_date date NOT NULL, business_email text NOT NULL, business_phone text NOT NULL);

-- Table: organizer_wallets
CREATE TABLE IF NOT EXISTS organizer_wallets (id uuid NOT NULL DEFAULT gen_random_uuid(), organizer_id uuid NOT NULL, balance_kobo bigint NOT NULL DEFAULT 0, total_earned_kobo bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(), total_withdrawn_kobo bigint NOT NULL DEFAULT 0, pending_kobo bigint NOT NULL DEFAULT 0);

-- Table: organizer_withdrawal_requests
CREATE TABLE IF NOT EXISTS organizer_withdrawal_requests (id uuid NOT NULL DEFAULT gen_random_uuid(), organizer_id uuid NOT NULL, amount_kobo bigint NOT NULL, status text NOT NULL DEFAULT 'pending'::text, bank_account_id uuid, admin_note text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), paystack_reference text, transfer_code text, resolved_by uuid, bank_name text, bank_code text, account_number text, account_name text);

-- Table: pending_purchases
CREATE TABLE IF NOT EXISTS pending_purchases (id uuid NOT NULL DEFAULT gen_random_uuid(), event_id uuid NOT NULL, user_id uuid NOT NULL, ticket_type text NOT NULL, attendees jsonb NOT NULL, attendees_hash text NOT NULL, promo_code text, amount_kobo bigint NOT NULL, payment_ref text NOT NULL, status text NOT NULL DEFAULT 'pending'::text, created_at timestamptz NOT NULL DEFAULT now());

-- Table: promo_codes
CREATE TABLE IF NOT EXISTS promo_codes (id uuid NOT NULL DEFAULT gen_random_uuid(), code text NOT NULL, discount_percentage numeric NOT NULL, max_uses integer, current_uses integer NOT NULL DEFAULT 0, expires_at timestamptz, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());

-- Table: rate_limits
CREATE TABLE IF NOT EXISTS rate_limits (key text NOT NULL, window_start bigint NOT NULL, count integer NOT NULL DEFAULT 1);

-- Table: referrals
CREATE TABLE IF NOT EXISTS referrals (id uuid NOT NULL DEFAULT gen_random_uuid(), referrer_id uuid NOT NULL, invitee_email text NOT NULL, status text NOT NULL DEFAULT 'pending'::text, created_at timestamptz NOT NULL DEFAULT now(), pending_until timestamptz);

-- Table: referred_emails
CREATE TABLE IF NOT EXISTS referred_emails (email_hash text NOT NULL, referrer_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- Table: reports
CREATE TABLE IF NOT EXISTS reports (id uuid NOT NULL DEFAULT gen_random_uuid(), reporter_id uuid NOT NULL, target_type text NOT NULL, target_id uuid NOT NULL, reason text NOT NULL, details text, status text NOT NULL DEFAULT 'pending'::text, created_at timestamptz DEFAULT now());

-- Table: saved_events
CREATE TABLE IF NOT EXISTS saved_events (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, event_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- Table: scan_log
CREATE TABLE IF NOT EXISTS scan_log (id uuid NOT NULL DEFAULT gen_random_uuid(), event_id uuid, ticket_id uuid, scanned_by uuid, result text NOT NULL, reason text, message text, device_id text, gate_name text, is_manual_override boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());

-- Table: search_synonyms
CREATE TABLE IF NOT EXISTS search_synonyms (term text NOT NULL, synonym text NOT NULL);

-- Table: tickets
CREATE TABLE IF NOT EXISTS tickets (id uuid NOT NULL DEFAULT gen_random_uuid(), event_id uuid NOT NULL, user_id uuid NOT NULL, quantity integer NOT NULL, status text NOT NULL DEFAULT 'active'::text, created_at timestamptz NOT NULL DEFAULT now(), payment_ref text, payment_status text NOT NULL DEFAULT 'pending'::text, amount numeric NOT NULL DEFAULT 0, ticket_type text, checked_in boolean NOT NULL DEFAULT false, checked_in_at timestamptz, scanner_id uuid, holder_name text, holder_email text, promo_code text, discount_percentage numeric NOT NULL DEFAULT 0, refund_id text, refund_reason text, refund_initiated_by uuid, holder_phone text);

-- Table: user_privacy_settings
CREATE TABLE IF NOT EXISTS user_privacy_settings (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, profile_visible text NOT NULL DEFAULT 'everyone'::text, can_message text NOT NULL DEFAULT 'everyone'::text, show_in_search boolean NOT NULL DEFAULT true, show_attended_events boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

-- Table: users
CREATE TABLE IF NOT EXISTS users (id uuid NOT NULL, email text NOT NULL, full_name text, role text NOT NULL DEFAULT 'user'::text, avatar_url text, created_at timestamptz NOT NULL DEFAULT now(), username text, phone_number text, bio text, state text, status text NOT NULL DEFAULT 'active'::text, is_verified boolean NOT NULL DEFAULT false, banned_until timestamptz, interests text[] NOT NULL DEFAULT '{}'::text[], totp_secret text, totp_enabled boolean NOT NULL DEFAULT false, cover_url text, deleted_at timestamptz, original_email text, date_of_birth date, vc_badge text, vc_featured_until timestamptz, promotions_enabled boolean DEFAULT true, deleted_by uuid, reason text, last_active_at timestamptz);

-- Table: vc_bonuses
CREATE TABLE IF NOT EXISTS vc_bonuses (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, bonus_type text NOT NULL, granted_at timestamptz NOT NULL DEFAULT now());

-- Table: vc_event_boosts
CREATE TABLE IF NOT EXISTS vc_event_boosts (id uuid NOT NULL DEFAULT gen_random_uuid(), event_id uuid NOT NULL, user_id uuid NOT NULL, boosted_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT (now() + '3 days'::interval));

-- Table: vc_transactions
CREATE TABLE IF NOT EXISTS vc_transactions (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, amount integer NOT NULL, type text NOT NULL, status text NOT NULL DEFAULT 'active'::text, reference_id uuid, earned_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());

-- Table: vents_wallets
CREATE TABLE IF NOT EXISTS vents_wallets (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, balance integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
