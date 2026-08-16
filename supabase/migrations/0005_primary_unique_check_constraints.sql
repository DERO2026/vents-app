-- Primary keys, unique constraints, and CHECK constraints — all missing
-- from the InsForge automated schema export (it only emits columns,
-- indexes, foreign keys, RLS, triggers, and functions — NOT table-level
-- PRIMARY KEY / UNIQUE / CHECK constraints). Reconstructed from a live,
-- read-only query against the actual InsForge production database
-- (pg_constraint), not guessed. This is a real gap discovered mid-apply:
-- 0005_foreign_keys.sql failed on "no unique constraint matching given
-- keys for referenced table users" because nothing in 0002_tables.sql
-- declared users.id as a primary key.

-- Primary keys (42)
ALTER TABLE admin_action_requests ADD CONSTRAINT admin_action_requests_pkey PRIMARY KEY (id);
ALTER TABLE admin_logs ADD CONSTRAINT admin_logs_pkey PRIMARY KEY (id);
ALTER TABLE app_config ADD CONSTRAINT app_config_pkey PRIMARY KEY (id);
ALTER TABLE blocked_users ADD CONSTRAINT blocked_users_pkey PRIMARY KEY (id);
ALTER TABLE checkins ADD CONSTRAINT checkins_pkey PRIMARY KEY (id);
ALTER TABLE conversation_clears ADD CONSTRAINT conversation_clears_pkey PRIMARY KEY (user_id, other_user_id);
ALTER TABLE conversation_requests ADD CONSTRAINT conversation_requests_pkey PRIMARY KEY (id);
ALTER TABLE deleted_emails ADD CONSTRAINT deleted_emails_pkey PRIMARY KEY (email);
ALTER TABLE deleted_phones ADD CONSTRAINT deleted_phones_pkey PRIMARY KEY (phone);
ALTER TABLE device_fingerprints ADD CONSTRAINT device_fingerprints_pkey PRIMARY KEY (id);
ALTER TABLE device_push_tokens ADD CONSTRAINT device_push_tokens_pkey PRIMARY KEY (id);
ALTER TABLE direct_messages ADD CONSTRAINT direct_messages_pkey PRIMARY KEY (id);
ALTER TABLE event_promotions ADD CONSTRAINT event_promotions_pkey PRIMARY KEY (id);
ALTER TABLE event_reminder_log ADD CONSTRAINT event_reminder_log_pkey PRIMARY KEY (id);
ALTER TABLE events ADD CONSTRAINT events_pkey PRIMARY KEY (id);
ALTER TABLE highlights ADD CONSTRAINT highlights_pkey PRIMARY KEY (id);
ALTER TABLE media_assets ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_pkey PRIMARY KEY (id);
ALTER TABLE notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE organizer_bank_accounts ADD CONSTRAINT organizer_bank_accounts_pkey PRIMARY KEY (id);
ALTER TABLE organizer_requests ADD CONSTRAINT organizer_requests_pkey PRIMARY KEY (id);
ALTER TABLE organizer_reviews ADD CONSTRAINT organizer_reviews_pkey PRIMARY KEY (id);
ALTER TABLE organizer_transactions ADD CONSTRAINT organizer_transactions_pkey PRIMARY KEY (id);
ALTER TABLE organizer_verification_requests ADD CONSTRAINT organizer_verification_requests_pkey PRIMARY KEY (id);
ALTER TABLE organizer_wallets ADD CONSTRAINT organizer_wallets_pkey PRIMARY KEY (id);
ALTER TABLE organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_pkey PRIMARY KEY (id);
ALTER TABLE pending_purchases ADD CONSTRAINT pending_purchases_pkey PRIMARY KEY (id);
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_pkey PRIMARY KEY (id);
ALTER TABLE rate_limits ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (key, window_start);
ALTER TABLE referrals ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);
ALTER TABLE referred_emails ADD CONSTRAINT referred_emails_pkey PRIMARY KEY (email_hash);
ALTER TABLE reports ADD CONSTRAINT reports_pkey PRIMARY KEY (id);
ALTER TABLE saved_events ADD CONSTRAINT saved_events_pkey PRIMARY KEY (id);
ALTER TABLE scan_log ADD CONSTRAINT scan_log_pkey PRIMARY KEY (id);
ALTER TABLE search_synonyms ADD CONSTRAINT search_synonyms_pkey PRIMARY KEY (term);
ALTER TABLE tickets ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);
ALTER TABLE user_privacy_settings ADD CONSTRAINT user_privacy_settings_pkey PRIMARY KEY (id);
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE vc_bonuses ADD CONSTRAINT vc_bonuses_pkey PRIMARY KEY (id);
ALTER TABLE vc_event_boosts ADD CONSTRAINT vc_event_boosts_pkey PRIMARY KEY (id);
ALTER TABLE vc_transactions ADD CONSTRAINT vc_transactions_pkey PRIMARY KEY (id);
ALTER TABLE vents_wallets ADD CONSTRAINT vents_wallets_pkey PRIMARY KEY (id);

-- Unique constraints (18) — several are load-bearing for
-- business logic, not just data hygiene: organizer_wallets_organizer_id_key
-- is what ON CONFLICT (organizer_id) in credit_organizer_wallet() targets;
-- pending_purchases_payment_ref_key backs the payment-idempotency guarantee;
-- unique_checkin (tickets.ticket_id on checkins) is what makes a duplicate
-- door-scan structurally impossible, not just application-logic-prevented.
ALTER TABLE blocked_users ADD CONSTRAINT blocked_users_blocker_id_blocked_id_key UNIQUE (blocker_id, blocked_id);
ALTER TABLE checkins ADD CONSTRAINT unique_checkin UNIQUE (ticket_id);
ALTER TABLE conversation_requests ADD CONSTRAINT conversation_requests_unique_pair UNIQUE (requester_id, recipient_id);
ALTER TABLE device_push_tokens ADD CONSTRAINT device_push_tokens_token_key UNIQUE (token);
ALTER TABLE event_reminder_log ADD CONSTRAINT event_reminder_log_ticket_id_kind_key UNIQUE (ticket_id, kind);
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_unique_per_user UNIQUE (message_id, user_id, emoji);
ALTER TABLE organizer_reviews ADD CONSTRAINT organizer_reviews_organizer_id_reviewer_id_key UNIQUE (organizer_id, reviewer_id);
ALTER TABLE organizer_wallets ADD CONSTRAINT organizer_wallets_organizer_id_key UNIQUE (organizer_id);
ALTER TABLE pending_purchases ADD CONSTRAINT pending_purchases_payment_ref_key UNIQUE (payment_ref);
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_code_key UNIQUE (code);
ALTER TABLE saved_events ADD CONSTRAINT unique_user_saved_event UNIQUE (user_id, event_id);
ALTER TABLE user_privacy_settings ADD CONSTRAINT user_privacy_settings_user_id_key UNIQUE (user_id);
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE users ADD CONSTRAINT users_phone_number_key UNIQUE (phone_number);
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
ALTER TABLE vc_bonuses ADD CONSTRAINT vc_bonuses_user_id_bonus_type_key UNIQUE (user_id, bonus_type);
ALTER TABLE vc_event_boosts ADD CONSTRAINT vc_event_boosts_event_id_user_id_key UNIQUE (event_id, user_id);
ALTER TABLE vents_wallets ADD CONSTRAINT vents_wallets_user_id_key UNIQUE (user_id);

-- CHECK constraints (43)
ALTER TABLE admin_action_requests ADD CONSTRAINT admin_action_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE app_config ADD CONSTRAINT app_config_id_check CHECK ((id = true));
ALTER TABLE blocked_users ADD CONSTRAINT blocked_users_check CHECK ((blocker_id <> blocked_id));
ALTER TABLE conversation_requests ADD CONSTRAINT conversation_requests_no_self CHECK ((requester_id <> recipient_id));
ALTER TABLE conversation_requests ADD CONSTRAINT conversation_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])));
ALTER TABLE direct_messages ADD CONSTRAINT direct_messages_body_check CHECK (((image_url IS NOT NULL) OR ((char_length(body) > 0) AND (char_length(body) <= 2000))));
ALTER TABLE event_promotions ADD CONSTRAINT event_promotions_plan_type_check CHECK ((plan_type = ANY (ARRAY['featured'::text, 'trending'::text, 'boosted'::text])));
ALTER TABLE event_promotions ADD CONSTRAINT event_promotions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'expired'::text, 'pending'::text])));
ALTER TABLE event_reminder_log ADD CONSTRAINT event_reminder_log_kind_check CHECK ((kind = ANY (ARRAY['24h'::text, '1h'::text])));
ALTER TABLE events ADD CONSTRAINT events_end_date_after_start CHECK (((end_date IS NULL) OR (end_date >= event_date)));
ALTER TABLE events ADD CONSTRAINT events_price_check CHECK ((price >= (0)::numeric));
ALTER TABLE events ADD CONSTRAINT events_status_check CHECK ((status = ANY (ARRAY['live'::text, 'draft'::text])));
ALTER TABLE highlights ADD CONSTRAINT highlights_media_type_check CHECK ((media_type = ANY (ARRAY['image'::text, 'video'::text])));
ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_emoji_check CHECK (((char_length(emoji) >= 1) AND (char_length(emoji) <= 8)));
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK ((type = ANY (ARRAY['reminder'::text, 'booking'::text, 'promo'::text, 'social'::text, 'broadcast'::text, 'message'::text, 'sale'::text, 'event_update'::text])));
ALTER TABLE organizer_requests ADD CONSTRAINT organizer_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE organizer_reviews ADD CONSTRAINT organizer_reviews_body_check CHECK ((char_length(TRIM(BOTH FROM body)) >= 10));
ALTER TABLE organizer_reviews ADD CONSTRAINT organizer_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE organizer_transactions ADD CONSTRAINT organizer_transactions_amount_kobo_check CHECK ((amount_kobo > 0));
ALTER TABLE organizer_transactions ADD CONSTRAINT organizer_transactions_type_check CHECK ((type = ANY (ARRAY['credit'::text, 'debit'::text, 'payout'::text, 'cancelled_payout_refund'::text, 'refund'::text])));
ALTER TABLE organizer_verification_requests ADD CONSTRAINT organizer_verification_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE organizer_wallets ADD CONSTRAINT organizer_wallets_balance_kobo_check CHECK ((balance_kobo >= 0));
ALTER TABLE organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_amount_kobo_check CHECK ((amount_kobo > 0));
ALTER TABLE organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'rejected'::text, 'cancelled'::text])));
ALTER TABLE pending_purchases ADD CONSTRAINT pending_purchases_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text])));
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_discount_percentage_check CHECK (((discount_percentage > (0)::numeric) AND (discount_percentage <= (100)::numeric)));
ALTER TABLE referrals ADD CONSTRAINT referrals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'joined'::text])));
ALTER TABLE reports ADD CONSTRAINT reports_reason_check CHECK ((char_length(TRIM(BOTH FROM reason)) > 0));
ALTER TABLE reports ADD CONSTRAINT reports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'actioned'::text, 'dismissed'::text])));
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK ((target_type = ANY (ARRAY['event'::text, 'user'::text])));
ALTER TABLE scan_log ADD CONSTRAINT scan_log_result_check CHECK ((result = ANY (ARRAY['valid'::text, 'duplicate'::text, 'invalid'::text, 'wrong_event'::text, 'refunded'::text, 'cancelled'::text])));
ALTER TABLE tickets ADD CONSTRAINT tickets_payment_status_check CHECK ((payment_status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'refunded'::text, 'refund_pending'::text])));
ALTER TABLE tickets ADD CONSTRAINT tickets_quantity_check CHECK ((quantity > 0));
ALTER TABLE tickets ADD CONSTRAINT tickets_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text])));
ALTER TABLE user_privacy_settings ADD CONSTRAINT user_privacy_settings_can_message_check CHECK ((can_message = ANY (ARRAY['everyone'::text, 'followers'::text, 'nobody'::text])));
ALTER TABLE user_privacy_settings ADD CONSTRAINT user_privacy_settings_profile_visible_check CHECK ((profile_visible = ANY (ARRAY['everyone'::text, 'followers'::text, 'nobody'::text])));
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['user'::text, 'attendee'::text, 'organizer'::text, 'organiser'::text, 'admin'::text, 'sub-admin'::text])));
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleted'::text])));
ALTER TABLE users ADD CONSTRAINT users_vc_badge_check CHECK ((vc_badge = ANY (ARRAY['bronze'::text, 'silver'::text, 'gold'::text, 'platinum'::text, 'elite'::text, 'legend'::text])));
ALTER TABLE vc_transactions ADD CONSTRAINT vc_transactions_amount_check CHECK ((amount > 0));
ALTER TABLE vc_transactions ADD CONSTRAINT vc_transactions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'pending'::text, 'expired'::text, 'spent'::text, 'cancelled'::text])));
ALTER TABLE vc_transactions ADD CONSTRAINT vc_transactions_type_check CHECK ((type = ANY (ARRAY['earn'::text, 'spend'::text, 'refund'::text, 'referral'::text])));
ALTER TABLE vents_wallets ADD CONSTRAINT vents_wallets_balance_check CHECK ((balance >= 0));
