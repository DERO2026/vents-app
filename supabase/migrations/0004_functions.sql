-- Functions and RPCs, verbatim from the live InsForge database (155
-- functions, corrected from the originally-stated 154). Business logic is
-- preserved exactly as audited — no rewrites, only three targeted fixes:
-- (1) auth.users.email_verified (an InsForge-specific column) replaced with
-- Supabase's standard email_confirmed_at IS NOT NULL in the 3 functions that
-- referenced it (add_bank_account_confirmed, admin_get_new_user_stats,
-- check_user_exists, is_email_verified, reclaim_unverified_signup — 7 call
-- sites across 5 functions); (2) topologically reordered by dependency so a
-- fresh apply succeeds in one pass — the original alphabetical export order
-- put several LANGUAGE sql functions before functions they call (e.g.
-- admin_pending_request_count before is_super_admin), which fails because
-- SQL-language functions validate references at CREATE time (unlike
-- plpgsql, which defers). No cycles were found. (3) handle_new_user()
-- referenced auth.users.metadata (InsForge-specific, and confirmed empty
-- for every single InsForge user during the auth audit) — replaced with
-- Supabase's raw_app_meta_data, identical behavior since both were/are
-- always empty in practice. This bug shipped silently in the original
-- apply (plpgsql doesn't validate column references until the trigger
-- actually fires) and was only caught when the first real INSERT into
-- auth.users happened, during the auth-migration script's --apply run —
-- fixed live on Supabase first, then backported here so a fresh apply of
-- this file doesn't reintroduce it. (4) All 11 functions that called
-- InsForge's realtime.publish(channel, event, payload) — which does not
-- exist on Supabase under any name/signature, confirmed by querying
-- Supabase's live `realtime` schema directly — rewritten to Supabase's
-- actual realtime.send(payload, event, topic, private) with arguments
-- reordered and private=false (preserves InsForge's observed
-- no-extra-authorization behavior). Topic names, event names, and payload
-- contents are unchanged — every consumer confirmed via the frontend audit
-- to treat these as invalidation signals, not payload-driven rendering, so
-- this is a pure signature fix, not a behavior change. Affected:
-- notify_admin_stats_payout, notify_admin_stats_signup,
-- notify_admin_stats_transaction, notify_door_checkin, notify_door_scan,
-- notify_door_ticket, notify_new_direct_message, notify_new_notification,
-- notify_organizer_events_event, notify_organizer_events_ticket, and
-- notify_vc_update (kept despite having zero confirmed consumers, per
-- explicit instruction — harmless to keep Supabase-compatible). This bug
-- blocked core writes outright (every INSERT/UPDATE on the 10 tables these
-- triggers cover failed with "function realtime.publish(...) does not
-- exist"), not just live-update UI — discovered when the auth-migration
-- script's first real signup insert hit it.
--
-- EXECUTE privileges are NOT set here; see 0011_grants.sql, which is the
-- authoritative, live-verified privilege reconstruction (Postgres grants
-- EXECUTE to PUBLIC by default on every CREATE FUNCTION, so until 0011 runs
-- these are all wide open — do not apply 0004 without 0011 in the same
-- deploy).

-- Function: _vc_deduct
CREATE OR REPLACE FUNCTION public._vc_deduct(p_user_id uuid, p_amount integer, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_balance integer;
BEGIN
  SELECT COALESCE(balance, 0) INTO v_balance
  FROM public.vents_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_balance IS NULL OR v_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient Vents Cents balance';
  END IF;

  UPDATE public.vents_wallets
  SET balance = balance - p_amount, updated_at = now()
  WHERE user_id = p_user_id;

  -- amount must be > 0; type 'spend', status 'spent'
  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at, reference_id)
  VALUES (p_user_id, p_amount, 'spend', 'spent', now(), gen_random_uuid());
END;
$function$
;

-- Function: activate_event_promotion
CREATE OR REPLACE FUNCTION public.activate_event_promotion(p_event_id uuid, p_plan_type text, p_duration_days integer, p_payment_ref text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id  uuid := auth.uid();
  v_owner_id uuid;
  v_end_date timestamptz;
  v_inserted integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_plan_type NOT IN ('boosted', 'featured', 'trending') THEN
    RAISE EXCEPTION 'Invalid plan_type';
  END IF;
  IF p_duration_days NOT IN (3, 7, 14, 30) THEN
    RAISE EXCEPTION 'Invalid duration';
  END IF;
  IF p_payment_ref IS NULL OR trim(p_payment_ref) = '' THEN
    RAISE EXCEPTION 'payment_ref is required';
  END IF;

  SELECT organizer_id INTO v_owner_id FROM public.events WHERE id = p_event_id;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_owner_id <> v_user_id THEN
    RAISE EXCEPTION 'You do not own this event';
  END IF;

  v_end_date := now() + make_interval(days => p_duration_days);

  INSERT INTO public.event_promotions (event_id, organizer_id, plan_type, start_date, end_date, status, payment_ref)
  VALUES (p_event_id, v_user_id, p_plan_type, now(), v_end_date, 'active', p_payment_ref)
  ON CONFLICT (payment_ref) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN; -- replayed reference — already activated, no-op
  END IF;

  -- Only 'featured' grants Featured-section placement. 'trending' and
  -- 'boosted' still legitimately raise an event's sort position within
  -- Explore (App.tsx's promotionPlanMap priority ordering, unaffected by
  -- this migration) — that's a real, honest "promoted placement" — but
  -- neither can buy their way into the Featured or Trending sections
  -- themselves.
  IF p_plan_type = 'featured' THEN
    UPDATE public.events SET is_featured = true, featured_until = v_end_date WHERE id = p_event_id;
  END IF;
END;
$function$
;

-- Function: actor_role
CREATE OR REPLACE FUNCTION public.actor_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN auth.uid() = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN 'root'
    ELSE (SELECT role FROM public.users WHERE id = auth.uid())
  END;
$function$
;

-- Function: admin_send_broadcast
CREATE OR REPLACE FUNCTION public.admin_send_broadcast(p_title text, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin_id uuid;
  v_count    int;
BEGIN
  v_admin_id := auth.uid();
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = v_admin_id AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can send broadcasts';
  END IF;

  INSERT INTO public.notifications (id, user_id, type, title, body, read, icon, created_at)
  SELECT
    gen_random_uuid(),
    u.id,
    'broadcast',
    p_title,
    p_body,
    false,
    '📢',
    now()
  FROM public.users u
  WHERE u.role <> 'admin';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.admin_logs (id, admin_id, action, target_user_id, details, created_at)
  VALUES (
    gen_random_uuid(),
    v_admin_id,
    'broadcast_sent',
    NULL,
    jsonb_build_object('title', p_title, 'body', p_body, 'recipients', v_count),
    now()
  );

  RETURN jsonb_build_object('success', true, 'recipients', v_count);
END;
$function$
;

-- Function: admin_broadcast
CREATE OR REPLACE FUNCTION public.admin_broadcast(p_title text, p_body text, p_type text DEFAULT 'announcement'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN public.admin_send_broadcast(p_title, p_body);
END;
$function$
;

-- Function: assert_recent_auth
CREATE OR REPLACE FUNCTION public.assert_recent_auth()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_iat bigint;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  BEGIN
    v_iat := (auth.jwt() ->> 'iat')::bigint;
  EXCEPTION WHEN others THEN v_iat := NULL; END;
  IF v_iat IS NULL OR (extract(epoch FROM now())::bigint - v_iat) > 300 THEN
    RAISE EXCEPTION 'PASSWORD_CONFIRMATION_REQUIRED';
  END IF;
END; $function$
;

-- Function: add_bank_account_confirmed
CREATE OR REPLACE FUNCTION public.add_bank_account_confirmed(p_bank_name text, p_bank_code text, p_account_number text, p_account_name text, p_recipient_code text)
 RETURNS organizer_bank_accounts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.organizer_bank_accounts;
  v_existing public.organizer_bank_accounts;
  v_active_count integer;
  v_has_default boolean;
BEGIN
  PERFORM public.assert_recent_auth();
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid AND email_confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Please verify your email first';
  END IF;

  SELECT * INTO v_existing FROM public.organizer_bank_accounts
  WHERE organizer_id = v_uid AND account_number = p_account_number;

  -- Editing an already-active account, or reactivating a soft-deleted one
  -- with the same account number, is never blocked by the 3-account cap —
  -- the cap only applies to genuinely NEW active accounts.
  IF v_existing IS NULL OR NOT v_existing.is_active THEN
    SELECT count(*) INTO v_active_count FROM public.organizer_bank_accounts
    WHERE organizer_id = v_uid AND is_active;
    IF v_active_count >= 3 THEN
      RAISE EXCEPTION 'You can link at most 3 bank accounts. Remove one before adding another.';
    END IF;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                 WHERE organizer_id = v_uid AND is_default AND is_active) INTO v_has_default;

  INSERT INTO public.organizer_bank_accounts
    (organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_default, is_active, updated_at)
  VALUES
    (v_uid, p_bank_name, p_bank_code, p_account_number, p_account_name, p_recipient_code, NOT v_has_default, true, now())
  ON CONFLICT (organizer_id, account_number) DO UPDATE SET
    bank_name = EXCLUDED.bank_name, bank_code = EXCLUDED.bank_code,
    account_name = EXCLUDED.account_name, recipient_code = EXCLUDED.recipient_code,
    -- Re-adding a previously-removed account brings it back as active; if
    -- the organizer currently has no active default at all (e.g. this was
    -- their only account), make it the default again.
    is_active = true,
    is_default = organizer_bank_accounts.is_default OR NOT v_has_default,
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END; $function$
;

-- Function: block_user
CREATE OR REPLACE FUNCTION public.block_user(p_blocked_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_uid = p_blocked_id THEN RAISE EXCEPTION 'You cannot block yourself'; END IF;
  INSERT INTO public.blocked_users (blocker_id, blocked_id) VALUES (v_uid, p_blocked_id)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;
END; $function$
;

-- Function: boost_event_vc
CREATE OR REPLACE FUNCTION public.boost_event_vc(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- Verify user owns this event
  IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id AND organizer_id = v_uid) THEN
    RAISE EXCEPTION 'Event not found or not yours';
  END IF;

  PERFORM _vc_deduct(v_uid, 1000, 'Event boost (3 days)');

  INSERT INTO vc_event_boosts (event_id, user_id, expires_at)
  VALUES (p_event_id, v_uid, now() + INTERVAL '3 days')
  ON CONFLICT (event_id, user_id) DO UPDATE
  SET expires_at = GREATEST(vc_event_boosts.expires_at, now()) + INTERVAL '3 days',
      boosted_at = now();
END;
$function$
;

-- Function: check_and_clear_pending_vc
CREATE OR REPLACE FUNCTION public.check_and_clear_pending_vc()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  -- Activate pending VC where 14 days have passed and ticket not refunded
  UPDATE public.vc_transactions t
  SET status = 'active'
  WHERE t.user_id = v_uid
    AND t.status = 'pending'
    AND t.earned_at < now() - INTERVAL '14 days'
    AND (
      t.reference_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.tickets tk
        WHERE tk.id = t.reference_id
          AND tk.payment_status = 'refunded'
      )
    );

  -- Cancel pending VC where the triggering ticket was refunded
  UPDATE public.vc_transactions t
  SET status = 'cancelled'
  WHERE t.user_id = v_uid
    AND t.status = 'pending'
    AND EXISTS (
      SELECT 1 FROM public.tickets tk
      WHERE tk.id = t.reference_id
        AND tk.payment_status = 'refunded'
    );
END;
$function$
;

-- Function: check_rate_limit
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_max_attempts integer, p_window_seconds integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_window bigint := floor(extract(epoch FROM now()) / p_window_seconds)::bigint;
  v_count  integer;
BEGIN
  INSERT INTO public.rate_limits (key, window_start, count)
  VALUES (p_key, v_window, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET count = public.rate_limits.count + 1
  RETURNING count INTO v_count;

  IF random() < 0.02 THEN
    DELETE FROM public.rate_limits WHERE window_start < v_window - 10;
  END IF;

  IF v_count > p_max_attempts THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0429';
  END IF;
END;
$function$
;

-- Function: check_signups_enabled
CREATE OR REPLACE FUNCTION public.check_signups_enabled()
 RETURNS void
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  IF (SELECT disable_signups FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'signups_disabled';
  END IF;
END;
$function$
;

-- Function: check_user_exists
CREATE OR REPLACE FUNCTION public.check_user_exists(p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_username text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb := '{}';
BEGIN
  IF p_email IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'email_taken',
      EXISTS (
        SELECT 1 FROM public.users u
        JOIN auth.users au ON au.id = u.id
        WHERE u.email = lower(trim(p_email)) AND au.email_confirmed_at IS NOT NULL
      )
    );
  END IF;
  IF p_phone IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'phone_taken',
      EXISTS (
        SELECT 1 FROM public.users u
        JOIN auth.users au ON au.id = u.id
        WHERE u.phone_number = trim(p_phone) AND au.email_confirmed_at IS NOT NULL
      )
    );
  END IF;
  IF p_username IS NOT NULL THEN
    v_result := v_result || jsonb_build_object(
      'username_taken',
      EXISTS (
        SELECT 1 FROM public.users u
        JOIN auth.users au ON au.id = u.id
        WHERE u.username = lower(trim(p_username)) AND au.email_confirmed_at IS NOT NULL
      )
    );
  END IF;
  RETURN v_result;
END;
$function$
;

-- Function: claim_profile_bonus
CREATE OR REPLACE FUNCTION public.claim_profile_bonus()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id    uuid    := auth.uid();
  v_has_avatar boolean;
  v_has_bio    boolean;
  v_has_phone  boolean;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  IF EXISTS (SELECT 1 FROM public.vc_bonuses WHERE user_id = v_user_id AND bonus_type = 'profile_complete') THEN
    RETURN jsonb_build_object('success', false, 'message', 'Profile bonus already claimed');
  END IF;

  SELECT
    (avatar_url IS NOT NULL AND avatar_url <> ''),
    (bio IS NOT NULL AND length(trim(bio)) >= 10),
    (phone_number IS NOT NULL AND phone_number <> '')
  INTO v_has_avatar, v_has_bio, v_has_phone
  FROM public.users WHERE id = v_user_id;

  IF NOT (v_has_avatar AND v_has_bio AND v_has_phone) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Complete your profile first (photo, bio ≥10 chars, phone)');
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, earned_at)
  VALUES (v_user_id, 100, 'earn', 'active', now());

  INSERT INTO public.vc_bonuses (user_id, bonus_type)
  VALUES (v_user_id, 'profile_complete')
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('success', true, 'vc_awarded', 100);
END;
$function$
;

-- Function: clear_conversation
CREATE OR REPLACE FUNCTION public.clear_conversation(p_other_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.conversation_clears (user_id, other_user_id, cleared_at)
  VALUES (auth.uid(), p_other_user_id, now())
  ON CONFLICT (user_id, other_user_id) DO UPDATE SET cleared_at = now();
END;
$function$
;

-- Function: client_ip
CREATE OR REPLACE FUNCTION public.client_ip()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  h jsonb;
  v text;
BEGIN
  BEGIN
    h := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF h IS NULL THEN RETURN NULL; END IF;

  v := COALESCE(h->>'x-forwarded-for', h->>'x-real-ip', h->>'cf-connecting-ip');
  IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;

  -- x-forwarded-for is "client, proxy1, proxy2" — keep the first hop.
  RETURN btrim(split_part(v, ',', 1));
END; $function$
;

-- Function: check_auth_rate_limit
CREATE OR REPLACE FUNCTION public.check_auth_rate_limit(p_action text, p_identifier text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF p_action NOT IN ('login', 'signup', 'password_reset') THEN
    RAISE EXCEPTION 'Invalid action';
  END IF;

  PERFORM public.check_rate_limit('auth:' || p_action || ':id:' || lower(coalesce(p_identifier, '')), 5, 300);
  PERFORM public.check_rate_limit('auth:' || p_action || ':ip:' || public.client_ip(), 20, 300);
END;
$function$
;

-- Function: complete_organizer_payout
CREATE OR REPLACE FUNCTION public.complete_organizer_payout(p_request_id text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
  v_bank_name text;
  v_account_number text;
  v_account_name text;
  v_rows int;
BEGIN
  SELECT r.id, r.organizer_id, r.amount_kobo, r.status, b.bank_name, b.account_number, b.account_name
    INTO v_id, v_organizer_id, v_amount_kobo, v_status, v_bank_name, v_account_number, v_account_name
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id::text = p_request_id OR r.transfer_code = p_request_id OR r.paystack_reference = p_request_id
  FOR UPDATE OF r;

  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_status = 'completed' THEN
    RETURN QUERY
    SELECT 'already_completed'::text, u.email, u.full_name, v_amount_kobo
    FROM public.users u WHERE u.id = v_organizer_id;
    RETURN;
  END IF;

  -- Matched by the exact row id found above — not by amount/status, which
  -- could otherwise also match a sibling request for the same amount.
  UPDATE public.organizer_withdrawal_requests
  SET status = 'completed', updated_at = now()
  WHERE id = v_id AND status IN ('pending', 'processing');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- Lost the race to a concurrent call (or webhook retry) between our
    -- initial locked read and here -- someone else already finalized this
    -- request. Do NOT touch the wallet/ledger a second time.
    RETURN QUERY
    SELECT 'already_completed'::text, u.email, u.full_name, v_amount_kobo
    FROM public.users u WHERE u.id = v_organizer_id;
    RETURN;
  END IF;

  UPDATE public.organizer_wallets
  SET pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      total_withdrawn_kobo = COALESCE(total_withdrawn_kobo, 0) + v_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions
    (organizer_id, type, amount_kobo, description, withdrawal_request_id, metadata)
  VALUES (
    v_organizer_id, 'payout', v_amount_kobo,
    'Withdrawal to ' || COALESCE(v_bank_name, 'bank account') || ' — completed',
    v_id,
    jsonb_build_object('bank_name', v_bank_name, 'account_number', v_account_number, 'account_name', v_account_name)
  );

  RETURN QUERY
  SELECT 'completed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$
;

-- Function: complete_referral
CREATE OR REPLACE FUNCTION public.complete_referral(p_referrer_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_referred_id uuid := auth.uid();
  v_referrer_id uuid;
  v_new_row_id  uuid;
  v_referred_name text;
BEGIN
  IF v_referred_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Not authenticated');
  END IF;

  SELECT id INTO v_referrer_id
  FROM public.users
  WHERE upper(substr(id::text, 1, 8)) = upper(p_referrer_code)
  LIMIT 1;

  IF v_referrer_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid referral code');
  END IF;

  IF v_referrer_id = v_referred_id THEN
    RETURN jsonb_build_object('success', false, 'message', 'Cannot use your own code');
  END IF;

  -- 150 VC to the new user immediately. This INSERT is the real
  -- idempotency gate: vc_transactions_referral_dedup_idx makes a second
  -- concurrent/duplicate call for the same (referred, referrer) pair
  -- conflict here and insert nothing, so only one caller ever proceeds
  -- past this point — no separate read-then-write race window.
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (v_referred_id, 150, 'referral', 'active', v_referrer_id, now())
  ON CONFLICT (user_id, reference_id) WHERE type = 'referral' DO NOTHING
  RETURNING id INTO v_new_row_id;

  IF v_new_row_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Referral already applied');
  END IF;

  -- 300 VC to referrer pending 14 days (pending rows don't trigger wallet
  -- update). Guarded by the same unique index, scoped to the referrer's
  -- own user_id — belt-and-suspenders, since reaching this line already
  -- implies the line above won the race for this referral event.
  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (v_referrer_id, 300, 'referral', 'pending', v_referred_id, now())
  ON CONFLICT (user_id, reference_id) WHERE type = 'referral' DO NOTHING;

  INSERT INTO public.referrals (referrer_id, invitee_email, status)
  VALUES (
    v_referrer_id,
    (SELECT email FROM auth.users WHERE id = v_referred_id LIMIT 1),
    'joined'
  )
  ON CONFLICT DO NOTHING;

  SELECT COALESCE(full_name, username, 'Someone') INTO v_referred_name
  FROM public.users WHERE id = v_referred_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_referred_id, 'promo', 'Referral Bonus', '+150 Vents Cents added to your wallet for joining via a referral link.', false, '🎉');

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_referrer_id, 'promo', 'Referral Joined', v_referred_name || ' joined using your referral link! 300 Vents Cents pending (available in 14 days).', false, '🤝');

  RETURN jsonb_build_object('success', true, 'awarded_to_you', 150, 'referrer_pending', 300);
END;
$function$
;

-- Function: create_pending_purchase
CREATE OR REPLACE FUNCTION public.create_pending_purchase(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_promo_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id      uuid := auth.uid();
  v_event        record;
  v_ticket_obj   jsonb;
  v_unit_price   numeric;
  v_discount_pct numeric := 0;
  v_promo        public.promo_codes;
  v_count        integer;
  v_amount_kobo  bigint;
  v_payment_ref  text;
  v_promo_norm   text;
  v_attendees_hash text;
  v_existing     record;
BEGIN
  IF (SELECT disable_purchases FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'purchases_disabled';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public.check_rate_limit('ticket_purchase_intent:' || v_user_id::text, 8, 60);

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  SELECT price, ticket_types, deleted_at, status, event_date, hidden_by_admin
  INTO v_event
  FROM public.events
  WHERE id = p_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_event.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This event has been removed and is no longer accepting purchases';
  END IF;
  IF v_event.status <> 'live' THEN
    RAISE EXCEPTION 'This event is not currently open for ticket purchases';
  END IF;
  IF v_event.hidden_by_admin THEN
    RAISE EXCEPTION 'This event is not currently open for ticket purchases';
  END IF;
  IF v_event.event_date::date < current_date THEN
    RAISE EXCEPTION 'This event has already ended';
  END IF;

  IF v_event.ticket_types IS NOT NULL AND jsonb_array_length(v_event.ticket_types) > 0 THEN
    SELECT tt INTO v_ticket_obj
    FROM jsonb_array_elements(v_event.ticket_types) AS tt
    WHERE tt->>'name' = p_ticket_type
    LIMIT 1;

    IF v_ticket_obj IS NULL THEN
      RAISE EXCEPTION 'Ticket type not found';
    END IF;

    v_unit_price := (v_ticket_obj->>'price')::numeric;
  ELSE
    v_unit_price := COALESCE(v_event.price, 0);
  END IF;

  IF v_unit_price IS NULL OR v_unit_price < 0 THEN
    RAISE EXCEPTION 'This ticket type has an invalid price and cannot be purchased';
  END IF;

  v_promo_norm := NULLIF(upper(trim(p_promo_code)), '');
  IF v_promo_norm IS NOT NULL THEN
    SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = v_promo_norm;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid promo code';
    END IF;
    IF NOT v_promo.is_active THEN
      RAISE EXCEPTION 'This promo code is no longer active';
    END IF;
    IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < now() THEN
      RAISE EXCEPTION 'This promo code has expired';
    END IF;
    IF v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses THEN
      RAISE EXCEPTION 'This promo code has reached its usage limit';
    END IF;

    v_discount_pct := v_promo.discount_percentage;
  END IF;

  v_amount_kobo := round(v_unit_price * v_count * (1.05 - v_discount_pct / 100) * 100)::bigint;
  v_attendees_hash := md5(p_attendees::text);

  SELECT * INTO v_existing FROM public.pending_purchases
   WHERE user_id = v_user_id AND event_id = p_event_id AND ticket_type = p_ticket_type
     AND attendees_hash = v_attendees_hash
     AND promo_code IS NOT DISTINCT FROM v_promo_norm
     AND status = 'pending'
     AND created_at > now() - interval '30 minutes'
   ORDER BY created_at DESC
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('payment_ref', v_existing.payment_ref, 'amount_kobo', v_existing.amount_kobo);
  END IF;

  v_payment_ref := 'VNT-' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.pending_purchases
    (event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status)
  VALUES
    (p_event_id, v_user_id, p_ticket_type, p_attendees, v_attendees_hash, v_promo_norm, v_amount_kobo, v_payment_ref, 'pending');

  RETURN jsonb_build_object('payment_ref', v_payment_ref, 'amount_kobo', v_amount_kobo);
END;
$function$
;

-- Function: create_referral
CREATE OR REPLACE FUNCTION public.create_referral(p_invitee_email text, p_email_hash text, p_fingerprint text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_uid UUID := auth.uid(); v_total INT; v_recent INT; BEGIN IF v_uid IS NULL THEN RETURN 'unauthorized'; END IF; SELECT COUNT(*) INTO v_total FROM referrals WHERE referrer_id = v_uid; IF v_total >= 20 THEN RETURN 'limit_reached'; END IF; SELECT COUNT(*) INTO v_recent FROM referrals WHERE referrer_id = v_uid AND created_at > now() - INTERVAL '24 hours'; IF v_recent >= 3 THEN RETURN 'velocity_cap'; END IF; IF p_fingerprint IS NOT NULL AND p_fingerprint != '' THEN INSERT INTO device_fingerprints(user_id, fingerprint) VALUES (v_uid, p_fingerprint) ON CONFLICT (user_id, fingerprint) DO NOTHING; END IF; IF p_email_hash IS NOT NULL AND p_email_hash != '' THEN IF EXISTS (SELECT 1 FROM referred_emails WHERE email_hash = p_email_hash) THEN RETURN 'already_referred'; END IF; INSERT INTO referred_emails(email_hash, referrer_id) VALUES (p_email_hash, v_uid); END IF; INSERT INTO referrals(referrer_id, invitee_email, status) VALUES (v_uid, p_invitee_email, 'pending'); RETURN NULL; END; $function$
;

-- Function: credit_organizer_wallet
CREATE OR REPLACE FUNCTION public.credit_organizer_wallet(p_organizer_id uuid, p_amount_kobo bigint, p_description text DEFAULT NULL::text, p_ticket_sale_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'credit_organizer_wallet: amount must be positive';
  END IF;

  IF p_organizer_id IS NULL THEN
    RAISE EXCEPTION 'credit_organizer_wallet: organizer_id is required';
  END IF;

  IF p_ticket_sale_id IS NULL THEN
    RAISE EXCEPTION 'credit_organizer_wallet: a verified ticket_sale_id is required';
  END IF;

  SELECT t.id, e.organizer_id, t.payment_status
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_sale_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_organizer_wallet: ticket % does not exist', p_ticket_sale_id;
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM p_organizer_id THEN
    RAISE EXCEPTION 'credit_organizer_wallet: ticket % does not belong to organizer %', p_ticket_sale_id, p_organizer_id;
  END IF;

  IF v_ticket.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'credit_organizer_wallet: ticket % is not paid (status=%)', p_ticket_sale_id, v_ticket.payment_status;
  END IF;

  -- Idempotent: a given ticket sale can only ever generate one credit.
  IF EXISTS (
    SELECT 1 FROM public.organizer_transactions
    WHERE ticket_sale_id = p_ticket_sale_id AND type = 'credit'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo)
  VALUES (p_organizer_id, p_amount_kobo, p_amount_kobo)
  ON CONFLICT (organizer_id) DO UPDATE
    SET balance_kobo      = organizer_wallets.balance_kobo + p_amount_kobo,
        total_earned_kobo = organizer_wallets.total_earned_kobo + p_amount_kobo,
        updated_at        = now();

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id)
  VALUES (p_organizer_id, 'credit', p_amount_kobo, p_description, p_ticket_sale_id);
END;
$function$
;

-- Function: confirm_ticket_payment
CREATE OR REPLACE FUNCTION public.confirm_ticket_payment(p_reference text, p_amount_kobo bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id         uuid;
  v_total_amount    numeric;
  v_discount_pct    numeric;
  v_promo_code      text;
  v_ticket_type     text;
  v_organizer_id    uuid;
  v_event_id        uuid;
  v_event_title     text;
  v_expected_kobo   bigint;
  v_credit_kobo     bigint;
  v_ticket_count    integer;
  v_first_ticket_id uuid;
  v_paid_count      integer;
BEGIN
  PERFORM 1 FROM public.tickets WHERE payment_ref = p_reference FOR UPDATE;

  SELECT t.user_id, sum(t.amount), max(t.discount_percentage), max(t.promo_code),
         max(t.ticket_type), e.organizer_id, e.id, max(e.title),
         count(*), min(t.id::text)::uuid, count(*) FILTER (WHERE t.payment_status = 'paid')
    INTO v_user_id, v_total_amount, v_discount_pct, v_promo_code,
         v_ticket_type, v_organizer_id, v_event_id, v_event_title,
         v_ticket_count, v_first_ticket_id, v_paid_count
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.payment_ref = p_reference
   GROUP BY t.user_id, e.organizer_id, e.id;

  IF v_ticket_count IS NULL OR v_ticket_count = 0 THEN
    RETURN 'not_found';
  END IF;

  IF v_paid_count = v_ticket_count THEN
    RETURN 'already_paid';
  END IF;

  v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;
  IF p_amount_kobo < v_expected_kobo THEN
    RETURN 'amount_mismatch:' || v_expected_kobo::text || ':' || p_amount_kobo::text;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid'
   WHERE payment_ref = p_reference AND payment_status <> 'paid';

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    v_credit_kobo := floor(v_total_amount * 100)::bigint;
    PERFORM public.credit_organizer_wallet(
      v_organizer_id,
      v_credit_kobo,
      'Ticket sale: ' || v_ticket_type || ' x' || v_ticket_count,
      v_first_ticket_id
    );
  END IF;

  IF v_promo_code IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE upper(code) = v_promo_code;
  END IF;

  IF v_total_amount > 0 THEN
    INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
    VALUES (v_user_id, 50, 'earn', 'active', v_first_ticket_id, now())
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_user_id,
    'booking',
    'Ticket confirmed! 🎉',
    'Your ' || v_ticket_count || ' ' || v_ticket_type || ' ticket(s) for ' || v_event_title || ' ' ||
      CASE WHEN v_ticket_count = 1 THEN 'is' ELSE 'are' END || ' confirmed.',
    false,
    '🎟️',
    jsonb_build_object('eventId', v_event_id)
  );

  IF v_total_amount > 0 AND v_organizer_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
    VALUES (
      v_organizer_id,
      'sale',
      'New sale! 💰',
      v_ticket_count || 'x ' || v_ticket_type || ' sold for ' || v_event_title || '.',
      false,
      '💰',
      jsonb_build_object('eventId', v_event_id, 'screen', 'sales-analytics')
    );
  END IF;

  RETURN 'confirmed';
END;
$function$
;

-- Function: delete_own_account
CREATE OR REPLACE FUNCTION public.delete_own_account()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_user RECORD;
  v_wallet_note jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_user FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  IF v_user.status = 'deleted' THEN RAISE EXCEPTION 'Account already deleted'; END IF;

  IF v_user.email IS NOT NULL AND v_user.email <> '' THEN
    INSERT INTO public.deleted_emails (email) VALUES (lower(trim(v_user.email))) ON CONFLICT DO NOTHING;
  END IF;
  IF v_user.phone_number IS NOT NULL AND trim(v_user.phone_number) <> '' THEN
    INSERT INTO public.deleted_phones (phone) VALUES (trim(v_user.phone_number)) ON CONFLICT DO NOTHING;
  END IF;

  UPDATE public.tickets SET status = 'cancelled'
  WHERE user_id = v_uid AND status NOT IN ('active', 'used', 'cancelled');

  DELETE FROM public.blocked_users WHERE blocker_id = v_uid OR blocked_id = v_uid;

  DELETE FROM public.direct_messages WHERE sender_id = v_uid OR recipient_id = v_uid;
  DELETE FROM public.conversation_clears WHERE user_id = v_uid OR other_user_id = v_uid;

  DELETE FROM public.device_push_tokens WHERE user_id = v_uid;

  DELETE FROM public.highlights WHERE user_id = v_uid;

  DELETE FROM public.organizer_reviews WHERE reviewer_id = v_uid OR organizer_id = v_uid;

  DELETE FROM public.reports WHERE reporter_id = v_uid;

  DELETE FROM public.vc_transactions WHERE user_id = v_uid;

  DELETE FROM public.notifications WHERE user_id = v_uid;

  DELETE FROM public.saved_events WHERE user_id = v_uid;

  SELECT jsonb_build_object('balance_kobo', balance_kobo, 'pending_kobo', pending_kobo)
    INTO v_wallet_note
  FROM public.organizer_wallets WHERE organizer_id = v_uid;

  DELETE FROM public.referred_emails WHERE referred_by = v_uid OR email = v_user.email;

  UPDATE public.users SET
    status         = 'deleted',
    deleted_at     = now(),
    original_email = email,
    email          = 'deleted_' || v_uid || '@deleted.vents',
    username       = 'deleted_' || left(v_uid::text, 8),
    full_name      = NULL,
    avatar_url     = NULL,
    cover_url      = NULL,
    bio            = NULL,
    phone_number   = NULL
  WHERE id = v_uid;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (v_uid, 'account_deleted', v_uid, jsonb_build_object('deleted_at', now(), 'wallet_at_deletion', v_wallet_note));

  UPDATE auth.users
  SET email = 'deleted_' || v_uid || '@deleted.vents', updated_at = now()
  WHERE id = v_uid;
END; $function$
;

-- Function: door_stats
CREATE OR REPLACE FUNCTION public.door_stats(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT jsonb_build_object(
    'total',              c.total,
    'checked_in',         c.checked_in,
    'remaining',           GREATEST(0, c.total - c.checked_in),
    'attendance_pct',      CASE WHEN c.total > 0
                                THEN round(c.checked_in::numeric * 100 / c.total)::int
                                ELSE 0 END,
    'duplicate_attempts',  COALESCE(s.duplicate_attempts, 0),
    'invalid_attempts',    COALESCE(s.invalid_attempts, 0)
  )
  FROM (
    SELECT count(*) FILTER (WHERE status = 'active')                      AS total,
           count(*) FILTER (WHERE status = 'active' AND checked_in)       AS checked_in
    FROM public.tickets WHERE event_id = p_event_id
  ) c
  CROSS JOIN (
    SELECT count(*) FILTER (WHERE result = 'duplicate')                        AS duplicate_attempts,
           count(*) FILTER (WHERE result IN ('invalid', 'wrong_event', 'refunded', 'cancelled')) AS invalid_attempts
    FROM public.scan_log WHERE event_id = p_event_id
  ) s;
$function$
;

-- Function: email_exists
CREATE OR REPLACE FUNCTION public.email_exists(p_email text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users WHERE email = lower(trim(p_email))
  );
END;
$function$
;

-- Function: fail_organizer_payout
CREATE OR REPLACE FUNCTION public.fail_organizer_payout(p_request_id text, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
  v_rows int;
BEGIN
  SELECT id, organizer_id, amount_kobo, status INTO v_id, v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id::text = p_request_id OR transfer_code = p_request_id OR paystack_reference = p_request_id
  FOR UPDATE;

  IF v_organizer_id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  IF v_status IN ('completed', 'failed', 'rejected') THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  -- Matched by the exact row id found above (same fix as complete_organizer_payout).
  UPDATE public.organizer_withdrawal_requests
  SET status = 'failed', admin_note = COALESCE(p_reason, admin_note), updated_at = now()
  WHERE id = v_id AND status IN ('pending', 'processing');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY SELECT 'already_finalized'::text, NULL::text, NULL::text, NULL::bigint;
    RETURN;
  END IF;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  RETURN QUERY
  SELECT 'failed'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END;
$function$
;

-- Function: fail_ticket_refund
CREATE OR REPLACE FUNCTION public.fail_ticket_refund(p_refund_id text, p_reason text)
 RETURNS TABLE(status text, actor_email text, actor_name text, event_title text, ticket_type text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  SELECT t.id, t.user_id, t.ticket_type, t.payment_status, t.refund_initiated_by, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.refund_id = p_refund_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid', status = 'active', refund_id = NULL
   WHERE id = v_ticket.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    v_ticket.refund_initiated_by, 'refund_ticket_failed', v_ticket.user_id,
    jsonb_build_object('ticket_id', v_ticket.id, 'refund_id', p_refund_id, 'reason', p_reason),
    'webhook'
  );

  RETURN QUERY
  SELECT 'reverted'::text, u.email, u.full_name, v_ticket.event_title, v_ticket.ticket_type
    FROM public.users u WHERE u.id = v_ticket.refund_initiated_by;
END;
$function$
;

-- Function: feature_in_people_vc
CREATE OR REPLACE FUNCTION public.feature_in_people_vc()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  PERFORM public._vc_deduct(v_uid, 150, 'Featured in People (3 days)');

  UPDATE public.users
  SET vc_featured_until = GREATEST(COALESCE(vc_featured_until, now()), now()) + INTERVAL '3 days'
  WHERE id = v_uid;
END;
$function$
;

-- Function: finalize_ticket_refund
CREATE OR REPLACE FUNCTION public.finalize_ticket_refund(p_refund_id text)
 RETURNS TABLE(status text, buyer_email text, buyer_name text, event_title text, ticket_type text, refunded_amount_kobo bigint, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket       record;
  v_owed_kobo    bigint;
  v_wallet_bal   bigint;
  v_actual_debit bigint;
  v_refund_kobo  bigint;
BEGIN
  SELECT t.id, t.user_id, t.amount, t.discount_percentage, t.ticket_type, t.payment_status,
         t.refund_initiated_by, t.refund_reason, e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.refund_id = p_refund_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status = 'refunded' THEN
    RETURN QUERY SELECT 'already_refunded'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::bigint, NULL::text;
    RETURN;
  END IF;

  -- Buyer-facing amount for the confirmation email -- the fee-inclusive
  -- figure Paystack actually refunded, same formula phase 1 used to decide
  -- how much to send Paystack (not v_ticket.amount, which is the
  -- organizer's fee-excluded share and would understate what the buyer
  -- gets back).
  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  UPDATE public.tickets SET payment_status = 'refunded' WHERE id = v_ticket.id;

  -- Reverse exactly what credit_organizer_wallet originally credited for
  -- this ticket (organizer keeps the full ticket price, no fee skim -- see
  -- organizer-full-ticket-payout.sql), clamped at the wallet's current
  -- balance under a row lock so a concurrent credit/debit on the same
  -- wallet can't race this. Any shortfall (organizer already withdrew some
  -- or all of it) is written to admin_logs rather than silently dropped.
  IF v_ticket.amount > 0 AND v_ticket.organizer_id IS NOT NULL THEN
    v_owed_kobo := floor(v_ticket.amount * 100)::bigint;

    SELECT balance_kobo INTO v_wallet_bal
      FROM public.organizer_wallets
     WHERE organizer_id = v_ticket.organizer_id
       FOR UPDATE;

    v_actual_debit := LEAST(COALESCE(v_wallet_bal, 0), v_owed_kobo);

    IF v_actual_debit > 0 THEN
      UPDATE public.organizer_wallets
         SET balance_kobo = balance_kobo - v_actual_debit, updated_at = now()
       WHERE organizer_id = v_ticket.organizer_id;

      INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id)
      VALUES (
        v_ticket.organizer_id, 'refund', v_actual_debit,
        'Refund: ' || v_ticket.ticket_type ||
          CASE WHEN v_actual_debit < v_owed_kobo
               THEN ' (wallet balance covered ' || v_actual_debit || ' of ' || v_owed_kobo || ' kobo owed)'
               ELSE '' END,
        v_ticket.id
      );
    END IF;

    IF v_actual_debit < v_owed_kobo THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        v_ticket.refund_initiated_by, 'refund_wallet_shortfall', v_ticket.organizer_id,
        jsonb_build_object(
          'ticket_id', v_ticket.id, 'owed_kobo', v_owed_kobo, 'recovered_kobo', v_actual_debit,
          'shortfall_kobo', v_owed_kobo - v_actual_debit
        ),
        'webhook'
      );
    END IF;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    v_ticket.user_id, 'booking', 'Ticket refunded',
    'Your refund for the ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been processed.',
    false, '💸'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    v_ticket.refund_initiated_by, 'refund_ticket_finalized', v_ticket.user_id,
    jsonb_build_object('ticket_id', v_ticket.id, 'refund_id', p_refund_id),
    'webhook'
  );

  RETURN QUERY
  SELECT 'finalized'::text, u.email, u.full_name, v_ticket.event_title, v_ticket.ticket_type,
         v_refund_kobo, v_ticket.refund_reason
    FROM public.users u WHERE u.id = v_ticket.user_id;
END;
$function$
;

-- Function: generate_ticket_token
CREATE OR REPLACE FUNCTION public.generate_ticket_token(p_ticket_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_owner      uuid;
  v_event_id   uuid;
  v_event_date timestamptz;
  v_secret     text;
  v_expires    timestamptz;
  v_payload    jsonb;
  v_encoded    text;
  v_sig        text;
BEGIN
  SELECT t.user_id, t.event_id, e.event_date
    INTO v_owner, v_event_id, v_event_date
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;
  IF auth.uid() IS NULL OR auth.uid() <> v_owner THEN
    RAISE EXCEPTION 'Not authorized to sign this ticket';
  END IF;

  SELECT value INTO v_secret FROM private.app_secrets WHERE key = 'ticket_hmac_v2';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Ticket signing secret is not configured';
  END IF;

  -- Valid through the event day + a 2-day grace (late entry / after-parties),
  -- floored at now()+2d so a pass minted for a past-dated or undated event is
  -- never already-expired the instant it is issued.
  v_expires := GREATEST(COALESCE(v_event_date, now()) + interval '2 days', now() + interval '2 days');

  v_payload := jsonb_build_object(
    'ticketId',    p_ticket_id::text,
    'eventId',     v_event_id::text,
    'purchaserId', v_owner::text,
    'issuedAt',    to_char(now()     AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'expiresAt',   to_char(v_expires AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'nonce',       encode(public.gen_random_bytes(12), 'hex'),
    'version',     '2'
  );

  -- base64url(payloadJson): standard base64, strip Postgres' 76-col newlines,
  -- map +/ to -_ and drop = padding (URL-safe, JWT-style).
  v_encoded := rtrim(translate(replace(encode(convert_to(v_payload::text, 'UTF8'), 'base64'), chr(10), ''), '+/', '-_'), '=');
  v_sig := encode(public.hmac(v_encoded, v_secret, 'sha256'), 'hex');
  RETURN v_encoded || '.' || v_sig;
END;
$function$
;

-- Function: finalize_pending_purchase
CREATE OR REPLACE FUNCTION public.finalize_pending_purchase(p_payment_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row           public.pending_purchases%ROWTYPE;
  v_event         record;
  v_ticket_obj    jsonb;
  v_unit_price    numeric;
  v_discount_pct  numeric := 0;
  v_effective     numeric;
  v_status        text;
  v_attendee      jsonb;
  v_ticket_id     uuid;
  v_ticket_ids    uuid[] := ARRAY[]::uuid[];
  v_count         integer;
  v_promo         public.promo_codes;
  v_event_sold    integer;
  v_type_sold     integer;
  v_type_limit    integer;
  v_result        jsonb := '[]'::jsonb;
  v_id            uuid;
BEGIN
  SELECT * INTO v_row FROM public.pending_purchases WHERE payment_ref = p_payment_ref FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending purchase not found for reference %', p_payment_ref;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() <> v_row.user_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_row.status = 'completed' THEN
    SELECT array_agg(id) INTO v_ticket_ids FROM public.tickets
     WHERE payment_ref = p_payment_ref AND status = 'active';
  ELSE
    IF (SELECT disable_purchases FROM public.app_config LIMIT 1) THEN
      RAISE EXCEPTION 'purchases_disabled';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(v_row.event_id::text, 0));

    SELECT price, ticket_types, ticket_goal, deleted_at, status, event_date, hidden_by_admin
    INTO v_event
    FROM public.events
    WHERE id = v_row.event_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Event not found';
    END IF;
    IF v_event.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'This event has been removed and is no longer accepting purchases';
    END IF;
    IF v_event.status <> 'live' THEN
      RAISE EXCEPTION 'This event is not currently open for ticket purchases';
    END IF;
    IF v_event.hidden_by_admin THEN
      RAISE EXCEPTION 'This event is not currently open for ticket purchases';
    END IF;
    IF v_event.event_date::date < current_date THEN
      RAISE EXCEPTION 'This event has already ended';
    END IF;

    IF v_event.ticket_types IS NOT NULL AND jsonb_array_length(v_event.ticket_types) > 0 THEN
      SELECT tt INTO v_ticket_obj
      FROM jsonb_array_elements(v_event.ticket_types) AS tt
      WHERE tt->>'name' = v_row.ticket_type
      LIMIT 1;

      IF v_ticket_obj IS NULL THEN
        RAISE EXCEPTION 'Ticket type not found';
      END IF;

      v_unit_price := (v_ticket_obj->>'price')::numeric;
    ELSE
      v_unit_price := COALESCE(v_event.price, 0);
    END IF;

    IF v_unit_price IS NULL OR v_unit_price < 0 THEN
      RAISE EXCEPTION 'This ticket type has an invalid price and cannot be purchased';
    END IF;

    v_count := jsonb_array_length(v_row.attendees);

    IF v_event.ticket_goal IS NOT NULL AND v_event.ticket_goal > 0 THEN
      SELECT count(*) INTO v_event_sold FROM public.tickets WHERE event_id = v_row.event_id AND status = 'active';
      IF v_event_sold + v_count > v_event.ticket_goal THEN
        RAISE EXCEPTION 'Only % ticket(s) remaining for this event', GREATEST(0, v_event.ticket_goal - v_event_sold);
      END IF;
    END IF;

    IF v_ticket_obj IS NOT NULL AND v_ticket_obj ? 'quantity' THEN
      v_type_limit := NULLIF(v_ticket_obj->>'quantity', '')::integer;
      IF v_type_limit IS NOT NULL AND v_type_limit > 0 THEN
        SELECT count(*) INTO v_type_sold
        FROM public.tickets
        WHERE event_id = v_row.event_id AND ticket_type = v_row.ticket_type AND status = 'active';

        IF v_type_sold + v_count > v_type_limit THEN
          RAISE EXCEPTION 'Only % % ticket(s) remaining', GREATEST(0, v_type_limit - v_type_sold), v_row.ticket_type;
        END IF;
      END IF;
    END IF;

    IF v_row.promo_code IS NOT NULL THEN
      SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = v_row.promo_code;
      -- A promo that goes invalid between create_pending_purchase and
      -- finalize (expired, exhausted) is intentionally NOT re-blocked here —
      -- the buyer already paid the discounted amount at the price quoted
      -- when payment was taken; rejecting now would strand a paid buyer with
      -- no ticket over a promo bookkeeping detail. current_uses is still
      -- incremented below when found, same as before.
      IF FOUND THEN
        v_discount_pct := v_promo.discount_percentage;
      END IF;
    END IF;

    v_effective := v_unit_price * (1 - v_discount_pct / 100);
    v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;

    FOR v_attendee IN SELECT * FROM jsonb_array_elements(v_row.attendees)
    LOOP
      IF NULLIF(trim(v_attendee->>'name'), '') IS NULL THEN
        RAISE EXCEPTION 'Each attendee must have a name';
      END IF;

      INSERT INTO public.tickets
        (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status,
         holder_name, holder_email, holder_phone, promo_code, discount_percentage)
      VALUES
        (v_row.event_id, v_row.user_id, 1, v_row.ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
         trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''), NULLIF(trim(v_attendee->>'phone'), ''),
         CASE WHEN v_promo.id IS NOT NULL THEN v_row.promo_code ELSE NULL END, v_discount_pct)
      RETURNING id INTO v_ticket_id;

      v_ticket_ids := array_append(v_ticket_ids, v_ticket_id);
    END LOOP;

    IF v_status = 'paid' AND v_promo.id IS NOT NULL THEN
      UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE id = v_promo.id;
    END IF;

    UPDATE public.pending_purchases SET status = 'completed' WHERE id = v_row.id;
  END IF;

  IF v_ticket_ids IS NOT NULL THEN
    FOREACH v_id IN ARRAY v_ticket_ids LOOP
      IF auth.uid() IS NOT NULL THEN
        v_result := v_result || jsonb_build_object('ticket_id', v_id, 'token', public.generate_ticket_token(v_id));
      ELSE
        v_result := v_result || jsonb_build_object('ticket_id', v_id, 'token', NULL);
      END IF;
    END LOOP;
  END IF;

  RETURN v_result;
END;
$function$
;

-- Function: get_account_status
CREATE OR REPLACE FUNCTION public.get_account_status(p_email text)
 RETURNS TABLE(status text, banned_until timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT status, banned_until
  FROM public.users
  WHERE lower(email) = lower(p_email)
  LIMIT 1;
$function$
;

-- Function: get_event_ticket_type_availability
CREATE OR REPLACE FUNCTION public.get_event_ticket_type_availability(p_event_id uuid)
 RETURNS TABLE(ticket_type text, sold_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT t.ticket_type, count(*)::integer AS sold_count
  FROM public.tickets t
  WHERE t.event_id = p_event_id AND t.status = 'active'
  GROUP BY t.ticket_type;
$function$
;

-- Function: get_event_trending_scores
CREATE OR REPLACE FUNCTION public.get_event_trending_scores(p_event_ids uuid[])
 RETURNS TABLE(event_id uuid, trending_score numeric, recent_sold integer, total_sold integer, save_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH recent AS (
    SELECT t.event_id, count(*)::integer AS recent_sold
    FROM public.tickets t
    WHERE t.event_id = ANY(p_event_ids) AND t.status = 'active' AND t.created_at > now() - interval '72 hours'
    GROUP BY t.event_id
  ),
  total AS (
    SELECT t.event_id, count(*)::integer AS total_sold
    FROM public.tickets t
    WHERE t.event_id = ANY(p_event_ids) AND t.status = 'active'
    GROUP BY t.event_id
  ),
  saves AS (
    SELECT s.event_id, count(*)::integer AS save_count
    FROM public.saved_events s
    WHERE s.event_id = ANY(p_event_ids)
    GROUP BY s.event_id
  )
  SELECT
    e.id,
    -- Weighted: recent velocity (last 72h) counts 5x, lifetime sales 2x,
    -- saves 1x — momentum matters more than a stale total for "trending
    -- right now". Extend here with view_count/share_count terms if that
    -- tracking is ever added; none exists in this schema today.
    (COALESCE(recent.recent_sold, 0) * 5.0
     + COALESCE(total.total_sold, 0) * 2.0
     + COALESCE(saves.save_count, 0) * 1.0)::numeric AS trending_score,
    COALESCE(recent.recent_sold, 0),
    COALESCE(total.total_sold, 0),
    COALESCE(saves.save_count, 0)
  FROM public.events e
  LEFT JOIN recent ON recent.event_id = e.id
  LEFT JOIN total ON total.event_id = e.id
  LEFT JOIN saves ON saves.event_id = e.id
  WHERE e.id = ANY(p_event_ids);
$function$
;

-- Function: get_my_vc_balance
CREATE OR REPLACE FUNCTION public.get_my_vc_balance()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id        uuid := auth.uid();
  v_expired_amount int  := 0;
  v_balance        int  := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('spendable', 0, 'expired_this_call', 0);
  END IF;

  -- Mark expired earn rows and sum their amounts
  WITH expired AS (
    UPDATE public.vc_transactions
    SET status = 'expired'
    WHERE user_id = v_user_id
      AND type IN ('earn', 'referral')
      AND status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < now()
    RETURNING amount
  )
  SELECT COALESCE(SUM(amount), 0) INTO v_expired_amount FROM expired;

  -- Deduct expired VC from wallet balance
  IF v_expired_amount > 0 THEN
    UPDATE public.vents_wallets
    SET balance    = GREATEST(0, balance - v_expired_amount),
        updated_at = now()
    WHERE user_id = v_user_id;
  END IF;

  -- Return current wallet balance (0 if wallet row doesn't exist yet)
  SELECT COALESCE(balance, 0) INTO v_balance
  FROM public.vents_wallets
  WHERE user_id = v_user_id;

  RETURN jsonb_build_object(
    'spendable',          v_balance,
    'expired_this_call',  v_expired_amount
  );
END;
$function$
;

-- Function: get_pending_push_notifications
CREATE OR REPLACE FUNCTION public.get_pending_push_notifications(p_limit integer DEFAULT 200)
 RETURNS TABLE(notification_id uuid, user_id uuid, title text, body text, push_data jsonb, token text, platform text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT n.id, n.user_id, n.title, n.body, n.push_data, d.token, d.platform
    FROM public.notifications n
    LEFT JOIN public.device_push_tokens d ON d.user_id = n.user_id
   WHERE n.push_sent = false
   ORDER BY n.created_at
   LIMIT p_limit;
$function$
;

-- Function: get_public_profiles
CREATE OR REPLACE FUNCTION public.get_public_profiles()
 RETURNS TABLE(id uuid, full_name text, username text, avatar_url text, cover_url text, is_verified boolean, state text, role text, interests text[], bio text, vc_badge text, last_active_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    id,
    full_name,
    username,
    avatar_url,
    cover_url,
    is_verified,
    state,
    CASE WHEN role = 'admin' THEN 'organizer' ELSE role END AS role,
    interests,
    bio,
    vc_badge,
    last_active_at
  FROM public.users
  WHERE deleted_at IS NULL;
$function$
;

-- Function: handle_new_user
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_role text;
BEGIN
  v_role := CASE
    WHEN NEW.raw_app_meta_data->>'role' = 'organizer' THEN 'organizer'
    ELSE 'attendee'
  END;
  INSERT INTO public.users (id, email, role)
  VALUES (NEW.id, NEW.email, v_role);
  RETURN NEW;
END;
$function$
;

-- Function: heartbeat_presence
CREATE OR REPLACE FUNCTION public.heartbeat_presence()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  UPDATE public.users SET last_active_at = now() WHERE id = auth.uid();
$function$
;

-- Function: is_email_verified
CREATE OR REPLACE FUNCTION public.is_email_verified()
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT (email_confirmed_at IS NOT NULL) FROM auth.users WHERE id = auth.uid();
$function$
;

-- Function: is_organizer
CREATE OR REPLACE FUNCTION public.is_organizer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('organizer', 'organiser', 'admin')
  );
$function$
;

-- Function: is_root
CREATE OR REPLACE FUNCTION public.is_root()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT auth.uid() = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid;
$function$
;

-- Function: is_admin
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT public.is_root()
     OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'sub-admin'));
$function$
;

-- Function: admin_claim_payout_for_processing
CREATE OR REPLACE FUNCTION public.admin_claim_payout_for_processing(p_request_id uuid)
 RETURNS TABLE(request_id uuid, organizer_id uuid, amount_kobo bigint, recipient_code text, status text, claimed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_claimed_id uuid;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  -- The atomic claim: exactly one concurrent caller can win this UPDATE for
  -- a given request_id, because Postgres serializes UPDATEs to the same row.
  UPDATE public.organizer_withdrawal_requests
  SET status = 'processing', resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id AND status = 'pending'
  RETURNING id INTO v_claimed_id;

  IF v_claimed_id IS NOT NULL THEN
    INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
    VALUES (auth.uid(), 'claim_payout_for_processing', jsonb_build_object('request_id', p_request_id), public.actor_role());
  END IF;

  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, b.recipient_code, r.status, (v_claimed_id IS NOT NULL)
  FROM public.organizer_withdrawal_requests r
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.id = p_request_id;
END;
$function$
;

-- Function: admin_get_new_user_stats
CREATE OR REPLACE FUNCTION public.admin_get_new_user_stats()
 RETURNS TABLE(new_this_week bigint, new_this_month bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    count(*) FILTER (WHERE u.created_at >= now() - interval '7 days')::bigint AS new_this_week,
    count(*) FILTER (WHERE u.created_at >= now() - interval '30 days')::bigint AS new_this_month
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  WHERE au.email_confirmed_at IS NOT NULL;
END;
$function$
;

-- Function: admin_get_vc_aggregates
CREATE OR REPLACE FUNCTION public.admin_get_vc_aggregates()
 RETURNS TABLE(circulation numeric, total_txns bigint, credits bigint, debits bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized'; END IF;
  RETURN QUERY
  SELECT
    (SELECT coalesce(sum(balance), 0) FROM public.vents_wallets)::numeric AS circulation,
    (SELECT count(*) FROM public.vc_transactions)::bigint AS total_txns,
    (SELECT count(*) FROM public.vc_transactions WHERE type IN ('earn', 'referral') AND status = 'active')::bigint AS credits,
    (SELECT count(*) FROM public.vc_transactions WHERE type = 'spend' AND status = 'spent')::bigint AS debits;
END; $function$
;

-- Function: admin_get_verification_stats
CREATE OR REPLACE FUNCTION public.admin_get_verification_stats()
 RETURNS TABLE(pending_count bigint, approved_today bigint, rejected_today bigint, avg_review_hours numeric, total_verified bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    count(*) FILTER (WHERE r.status = 'pending')::bigint AS pending_count,
    count(*) FILTER (WHERE r.status = 'approved' AND r.reviewed_at >= date_trunc('day', now()))::bigint AS approved_today,
    count(*) FILTER (WHERE r.status = 'rejected' AND r.reviewed_at >= date_trunc('day', now()))::bigint AS rejected_today,
    round(avg(EXTRACT(EPOCH FROM (r.reviewed_at - r.created_at)) / 3600.0) FILTER (WHERE r.reviewed_at IS NOT NULL), 1) AS avg_review_hours,
    count(*) FILTER (WHERE r.status = 'approved')::bigint AS total_verified
  FROM public.organizer_verification_requests r;
END;
$function$
;

-- Function: admin_list_organizer_verifications
CREATE OR REPLACE FUNCTION public.admin_list_organizer_verifications(p_status text DEFAULT 'pending'::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(request_id uuid, user_id uuid, full_name text, email text, phone_number text, state text, avatar_url text, is_verified boolean, company_name text, cac_number text, owner_name text, registration_date date, business_email text, business_phone text, business_address text, document_url text, status text, admin_note text, reviewed_at timestamp with time zone, created_at timestamp with time zone, total_count bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.user_id, u.full_name, u.email, u.phone_number, u.state,
    u.avatar_url, u.is_verified,
    r.company_name, r.cac_number, r.owner_name, r.registration_date,
    r.business_email, r.business_phone, r.business_address, r.document_url,
    r.status, r.admin_note, r.reviewed_at, r.created_at,
    count(*) OVER()::bigint AS total_count
  FROM public.organizer_verification_requests r
  JOIN public.users u ON u.id = r.user_id
  WHERE (p_status IS NULL OR p_status = 'all' OR r.status = p_status)
    AND (
      p_search IS NULL OR trim(p_search) = '' OR
      r.company_name ILIKE '%' || p_search || '%' OR
      r.cac_number ILIKE '%' || p_search || '%' OR
      u.full_name ILIKE '%' || p_search || '%' OR
      u.email ILIKE '%' || p_search || '%'
    )
  ORDER BY r.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END; $function$
;

-- Function: admin_release_payout_claim
CREATE OR REPLACE FUNCTION public.admin_release_payout_claim(p_request_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'pending', updated_at = now()
  WHERE id = p_request_id AND status = 'processing' AND transfer_code IS NULL;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'release_payout_claim', jsonb_build_object('request_id', p_request_id, 'reason', p_reason), public.actor_role());
END;
$function$
;

-- Function: admin_set_event_featured
CREATE OR REPLACE FUNCTION public.admin_set_event_featured(p_event_id uuid, p_featured boolean, p_duration_days integer DEFAULT 14)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_end_date timestamptz;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;
  IF p_featured AND (p_duration_days IS NULL OR p_duration_days <= 0 OR p_duration_days > 90) THEN
    RAISE EXCEPTION 'Duration must be between 1 and 90 days';
  END IF;

  IF p_featured THEN
    v_end_date := now() + make_interval(days => p_duration_days);
    UPDATE public.events SET is_featured = true, featured_until = v_end_date WHERE id = p_event_id;
  ELSE
    UPDATE public.events SET is_featured = false, featured_until = NULL WHERE id = p_event_id;
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  SELECT auth.uid(), CASE WHEN p_featured THEN 'feature_event' ELSE 'unfeature_event' END,
         e.organizer_id, jsonb_build_object('event_id', p_event_id, 'featured', p_featured, 'duration_days', p_duration_days),
         public.actor_role()
  FROM public.events e WHERE e.id = p_event_id;
END;
$function$
;

-- Function: attach_ticket_refund_id
CREATE OR REPLACE FUNCTION public.attach_ticket_refund_id(p_ticket_id uuid, p_refund_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_status       text;
  v_user_id      uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT e.organizer_id, t.payment_status, t.user_id INTO v_organizer_id, v_status, v_user_id
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Ticket is not awaiting a refund (status: %)', v_status;
  END IF;

  UPDATE public.tickets SET refund_id = p_refund_id WHERE id = p_ticket_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'attach_ticket_refund_id', v_user_id,
          jsonb_build_object('ticket_id', p_ticket_id, 'refund_id', p_refund_id), public.actor_role());
END;
$function$
;

-- Function: get_event_ticket_stats
CREATE OR REPLACE FUNCTION public.get_event_ticket_stats(p_event_ids uuid[])
 RETURNS TABLE(event_id uuid, sold_count integer, sold_quantity integer, pending_count integer, cancelled_count integer, refunded_count integer, revenue_kobo bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    t.event_id,
    count(*) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid')::integer AS sold_count,
    COALESCE(sum(t.quantity) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid'), 0)::integer AS sold_quantity,
    count(*) FILTER (WHERE t.status = 'active' AND t.payment_status = 'pending')::integer AS pending_count,
    count(*) FILTER (WHERE t.status = 'cancelled' AND t.payment_status <> 'refunded')::integer AS cancelled_count,
    count(*) FILTER (WHERE t.payment_status = 'refunded')::integer AS refunded_count,
    CASE WHEN e.organizer_id = auth.uid() OR public.is_admin()
      THEN COALESCE(sum(t.amount * 100) FILTER (WHERE t.status = 'active' AND t.payment_status = 'paid'), 0)::bigint
      ELSE NULL
    END AS revenue_kobo
  FROM public.tickets t
  JOIN public.events e ON e.id = t.event_id
  WHERE t.event_id = ANY(p_event_ids)
  GROUP BY t.event_id, e.organizer_id;
$function$
;

-- Function: get_organizer_events_overview
CREATE OR REPLACE FUNCTION public.get_organizer_events_overview()
 RETURNS TABLE(id uuid, title text, description text, location text, event_date timestamp with time zone, price numeric, ticket_goal integer, ticket_types jsonb, status text, is_18_plus boolean, created_at timestamp with time zone, sold_count integer, sold_quantity integer, pending_count integer, cancelled_count integer, refunded_count integer, revenue_kobo bigint, checked_in_count integer, is_ended boolean, is_sold_out boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_organizer uuid := auth.uid();
BEGIN
  IF v_organizer IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  WITH my_events AS (
    SELECT * FROM public.events WHERE organizer_id = v_organizer AND deleted_at IS NULL
  ),
  stats AS (
    SELECT * FROM public.get_event_ticket_stats((SELECT array_agg(my_events.id) FROM my_events))
  ),
  checkins_agg AS (
    SELECT ci.event_id, count(*)::integer AS checked_in_count
    FROM public.checkins ci
    WHERE ci.event_id IN (SELECT my_events.id FROM my_events)
    GROUP BY ci.event_id
  )
  SELECT
    e.id, e.title, e.description, e.location, e.event_date,
    e.price, e.ticket_goal, e.ticket_types, e.status, e.is_18_plus, e.created_at,
    COALESCE(s.sold_count, 0), COALESCE(s.sold_quantity, 0), COALESCE(s.pending_count, 0),
    COALESCE(s.cancelled_count, 0), COALESCE(s.refunded_count, 0), COALESCE(s.revenue_kobo, 0),
    COALESCE(ck.checked_in_count, 0),
    (e.event_date < now()),
    (e.ticket_goal > 0 AND COALESCE(s.sold_quantity, 0) >= e.ticket_goal)
  FROM my_events e
  LEFT JOIN stats s ON s.event_id = e.id
  LEFT JOIN checkins_agg ck ON ck.event_id = e.id
  ORDER BY e.created_at DESC;
END;
$function$
;

-- Function: is_event_door_manager
CREATE OR REPLACE FUNCTION public.is_event_door_manager(p_event_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.events e WHERE e.id = p_event_id AND e.organizer_id = auth.uid())
      OR public.is_admin()
      OR auth.uid() = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid;
$function$
;

-- Function: get_door_stats
CREATE OR REPLACE FUNCTION public.get_door_stats(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_event_door_manager(p_event_id) THEN
    RAISE EXCEPTION 'Not authorized for this event''s door';
  END IF;
  RETURN public.door_stats(p_event_id);
END;
$function$
;

-- Function: get_event_attendees
CREATE OR REPLACE FUNCTION public.get_event_attendees(p_event_id uuid, p_search text DEFAULT NULL::text, p_filter text DEFAULT 'all'::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(ticket_id uuid, holder_name text, holder_email text, buyer_phone text, ticket_type text, status text, payment_status text, amount numeric, checked_in boolean, checked_in_at timestamp with time zone, is_manual_override boolean, gate_name text, purchased_at timestamp with time zone, order_ref text, user_id uuid, buyer_name text, avatar_url text, scanner_name text, device_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_q text := NULLIF(trim(coalesce(p_search, '')), '');
BEGIN
  IF NOT public.is_event_door_manager(p_event_id) THEN
    RAISE EXCEPTION 'Not authorized for this event''s door';
  END IF;

  RETURN QUERY
  SELECT t.id, t.holder_name, t.holder_email, u.phone_number,
         t.ticket_type, t.status, t.payment_status, t.amount,
         t.checked_in, t.checked_in_at, COALESCE(ci.is_manual_override, false),
         ci.gate_name, t.created_at, t.payment_ref,
         t.user_id, u.full_name, u.avatar_url,
         su.full_name, ci.device_id
  FROM public.tickets t
  LEFT JOIN public.checkins ci ON ci.ticket_id = t.id
  LEFT JOIN public.users u     ON u.id = t.user_id
  LEFT JOIN public.users su    ON su.id = ci.scanned_by
  WHERE t.event_id = p_event_id
    AND (
      p_filter = 'all'
      OR (p_filter = 'checked_in' AND t.checked_in)
      OR (p_filter = 'pending'    AND t.status = 'active' AND NOT t.checked_in)
      OR (p_filter = 'vip'        AND t.ticket_type ILIKE '%vip%')
      OR (p_filter = 'regular'    AND t.ticket_type NOT ILIKE '%vip%')
      OR (p_filter = 'refunded'   AND t.status = 'refunded')
      OR (p_filter = 'cancelled'  AND t.status = 'cancelled')
    )
    AND (
      v_q IS NULL
      OR t.holder_name  ILIKE '%' || v_q || '%'
      OR t.holder_email ILIKE '%' || v_q || '%'
      OR u.phone_number ILIKE '%' || v_q || '%'
      OR u.full_name    ILIKE '%' || v_q || '%'
      OR t.id::text = v_q
    )
  ORDER BY t.checked_in_at DESC NULLS LAST, t.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200))
  OFFSET GREATEST(0, p_offset);
END;
$function$
;

-- Function: get_recent_checkins
CREATE OR REPLACE FUNCTION public.get_recent_checkins(p_event_id uuid, p_limit integer DEFAULT 25)
 RETURNS TABLE(checkin_id uuid, ticket_id uuid, holder_name text, ticket_type text, checked_in_at timestamp with time zone, gate_name text, is_manual_override boolean, scanned_by uuid, scanner_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_event_door_manager(p_event_id) THEN
    RAISE EXCEPTION 'Not authorized for this event''s door';
  END IF;

  RETURN QUERY
  SELECT ci.id, ci.ticket_id, t.holder_name, t.ticket_type,
         ci.checked_in_at, ci.gate_name, ci.is_manual_override,
         ci.scanned_by, su.full_name
  FROM public.checkins ci
  JOIN public.tickets t  ON t.id = ci.ticket_id
  LEFT JOIN public.users su ON su.id = ci.scanned_by
  WHERE ci.event_id = p_event_id
  ORDER BY ci.checked_in_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
END;
$function$
;

-- Function: get_scan_log
CREATE OR REPLACE FUNCTION public.get_scan_log(p_event_id uuid, p_result text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, ticket_id uuid, holder_name text, ticket_type text, scanned_by uuid, scanner_name text, result text, reason text, message text, device_id text, gate_name text, is_manual_override boolean, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_event_door_manager(p_event_id) THEN
    RAISE EXCEPTION 'Not authorized for this event''s door';
  END IF;

  RETURN QUERY
  SELECT l.id, l.ticket_id, t.holder_name, t.ticket_type,
         l.scanned_by, su.full_name, l.result, l.reason, l.message,
         l.device_id, l.gate_name, l.is_manual_override, l.created_at
  FROM public.scan_log l
  LEFT JOIN public.tickets t ON t.id = l.ticket_id
  LEFT JOIN public.users su  ON su.id = l.scanned_by
  WHERE l.event_id = p_event_id
    AND (p_result IS NULL OR l.result = p_result)
  ORDER BY l.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200))
  OFFSET GREATEST(0, p_offset);
END;
$function$
;

-- Function: is_super_admin
CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT public.is_root()
     OR EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin');
$function$
;

-- Function: admin_list_action_requests
CREATE OR REPLACE FUNCTION public.admin_list_action_requests(p_status text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, action_type text, target_type text, target_id uuid, target_label text, payload jsonb, previous_values jsonb, requested_changes jsonb, requested_by uuid, requested_by_name text, requested_by_role text, status text, reviewed_by uuid, reviewed_by_name text, review_reason text, requested_at timestamp with time zone, reviewed_at timestamp with time zone, seen_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  RETURN QUERY
  SELECT r.id, r.action_type, r.target_type, r.target_id, r.target_label,
         r.payload, r.previous_values, r.requested_changes,
         r.requested_by, ru.full_name, r.requested_by_role,
         r.status, r.reviewed_by, vu.full_name, r.review_reason,
         r.requested_at, r.reviewed_at, r.seen_at
  FROM public.admin_action_requests r
  LEFT JOIN public.users ru ON ru.id = r.requested_by
  LEFT JOIN public.users vu ON vu.id = r.reviewed_by
  WHERE (p_status IS NULL OR r.status = p_status)
    AND (public.is_super_admin() OR r.requested_by = auth.uid())
  ORDER BY r.requested_at DESC;
END;
$function$
;

-- Function: admin_list_push_tokens
CREATE OR REPLACE FUNCTION public.admin_list_push_tokens(p_user_id uuid)
 RETURNS TABLE(token text, platform text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;
  RETURN QUERY
  SELECT t.token, t.platform
  FROM public.device_push_tokens t
  WHERE t.user_id = p_user_id;
END; $function$
;

-- Function: admin_mark_all_requests_seen
CREATE OR REPLACE FUNCTION public.admin_mark_all_requests_seen()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  UPDATE public.admin_action_requests SET seen_at = now() WHERE seen_at IS NULL;
END;
$function$
;

-- Function: admin_mark_request_seen
CREATE OR REPLACE FUNCTION public.admin_mark_request_seen(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  UPDATE public.admin_action_requests SET seen_at = now() WHERE id = p_request_id AND seen_at IS NULL;
END;
$function$
;

-- Function: admin_pending_request_count
CREATE OR REPLACE FUNCTION public.admin_pending_request_count()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE WHEN public.is_super_admin()
    THEN (SELECT count(*)::int FROM public.admin_action_requests WHERE status = 'pending')
    ELSE 0 END;
$function$
;

-- Function: admin_prune_push_token
CREATE OR REPLACE FUNCTION public.admin_prune_push_token(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;
  DELETE FROM public.device_push_tokens WHERE token = p_token;
END; $function$
;

-- Function: admin_reinstate_user
CREATE OR REPLACE FUNCTION public.admin_reinstate_user(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  UPDATE public.users SET status = 'active', banned_until = NULL, deleted_at = NULL, deleted_by = NULL, reason = NULL WHERE id = p_user_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reinstate_user', p_user_id, '{}'::jsonb, public.actor_role());
END; $function$
;

-- Function: admin_set_user_role
CREATE OR REPLACE FUNCTION public.admin_set_user_role(p_user_id uuid, p_new_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_target_role text;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)',
      COALESCE((SELECT role FROM public.users WHERE id = auth.uid()), 'none');
  END IF;

  IF p_new_role = 'sub-admin' THEN
    IF NOT public.is_root() THEN
      RAISE EXCEPTION 'Only Root can assign the Sub-Admin role';
    END IF;
  ELSIF p_new_role NOT IN ('attendee', 'organizer') THEN
    RAISE EXCEPTION 'Invalid role: % (allowed: attendee, organizer, sub-admin [Root only])', p_new_role;
  END IF;

  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin role cannot be changed';
  END IF;

  SELECT role INTO v_target_role FROM public.users WHERE id = p_user_id;

  UPDATE public.users SET role = p_new_role WHERE id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'role_change',
    p_user_id,
    jsonb_build_object('old_role', v_target_role, 'new_role', p_new_role),
    public.actor_role()
  );
END;
$function$
;

-- Function: admin_soft_delete_user
CREATE OR REPLACE FUNCTION public.admin_soft_delete_user(p_user_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN RAISE EXCEPTION 'Root account cannot be deleted'; END IF;
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot delete your own account this way — use Settings > Delete Account instead'; END IF;
  UPDATE public.users SET status = 'deleted', deleted_at = now(), deleted_by = auth.uid(), reason = p_reason WHERE id = p_user_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'delete_user', p_user_id, jsonb_build_object('reason', p_reason), public.actor_role());
END;
$function$
;

-- Function: admin_suspend_user
CREATE OR REPLACE FUNCTION public.admin_suspend_user(p_user_id uuid, p_banned_until timestamp with time zone, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none'); END IF;
  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN RAISE EXCEPTION 'Root account cannot be suspended'; END IF;
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot suspend your own account'; END IF;
  UPDATE public.users SET status = 'suspended', banned_until = p_banned_until WHERE id = p_user_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'suspend_user', p_user_id, jsonb_build_object('banned_until', p_banned_until, 'reason', p_reason), public.actor_role());
END;
$function$
;

-- Function: admin_unsuspend_user
CREATE OR REPLACE FUNCTION public.admin_unsuspend_user(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_super_admin() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  UPDATE public.users SET status = 'active', banned_until = NULL WHERE id = p_user_id;
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'unsuspend_user', p_user_id, '{}'::jsonb, public.actor_role());
END; $function$
;

-- Function: cleanup_orphaned_records
CREATE OR REPLACE FUNCTION public.cleanup_orphaned_records()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_tickets_cancelled int := 0;
  v_saves_removed int := 0;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)',
      COALESCE((SELECT role FROM public.users WHERE id = auth.uid()), 'none');
  END IF;

  WITH updated AS (
    UPDATE public.tickets SET status = 'cancelled'
    WHERE status = 'active'
      AND NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = tickets.event_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_tickets_cancelled FROM updated;

  WITH deleted AS (
    DELETE FROM public.saved_events
    WHERE NOT EXISTS (SELECT 1 FROM public.events e WHERE e.id = saved_events.event_id)
    RETURNING 1
  )
  SELECT count(*) INTO v_saves_removed FROM deleted;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'orphan_cleanup', NULL, jsonb_build_object(
    'tickets_cancelled', v_tickets_cancelled,
    'saves_removed', v_saves_removed
  ), public.actor_role());

  RETURN jsonb_build_object(
    'tickets_cancelled', v_tickets_cancelled,
    'saves_removed', v_saves_removed
  );
END;
$function$
;

-- Function: is_admin_or_root
CREATE OR REPLACE FUNCTION public.is_admin_or_root()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT public.is_super_admin();
$function$
;

-- Function: admin_approve_organizer_verification
CREATE OR REPLACE FUNCTION public.admin_approve_organizer_verification(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid; v_company text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  SELECT user_id, company_name INTO v_user_id, v_company
  FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;

  UPDATE public.organizer_verification_requests
  SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;
  UPDATE public.users SET is_verified = true WHERE id = v_user_id;

  -- In-app notification (Task 6).
  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_user_id, 'promo', 'Brand Verified ✓',
          COALESCE(v_company, 'Your organization') || ' has been verified. Your verified badge is now live across Vents.',
          false, '🛡️');

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'approve_organizer_verification', v_user_id,
          jsonb_build_object('request_id', p_request_id), public.actor_role());
END; $function$
;

-- Function: admin_cancel_processing_payout
CREATE OR REPLACE FUNCTION public.admin_cancel_processing_payout(p_request_id uuid, p_reason text)
 RETURNS TABLE(status text, organizer_email text, organizer_name text, amount_kobo bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_amount_kobo bigint;
  v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests
  WHERE id = p_request_id;

  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status <> 'processing' THEN RAISE EXCEPTION 'Only requests in Processing status can be cancelled (current status: %)', v_status; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'cancelled', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo,
      pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo),
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, withdrawal_request_id)
  VALUES (v_organizer_id, 'cancelled_payout_refund', v_amount_kobo,
          'Payout request cancelled by admin, funds returned — ' || p_reason, p_request_id);

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'cancel_processing_payout', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN QUERY
  SELECT 'cancelled'::text, u.email, u.full_name, v_amount_kobo
  FROM public.users u WHERE u.id = v_organizer_id;
END; $function$
;

-- Function: admin_credit_vents_cents
CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(p_user_id uuid, p_amount numeric, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_amount <= 0 THEN
    RETURN 'invalid_amount';
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (p_user_id, p_amount::integer, 'earn', 'active', gen_random_uuid(), now());

  INSERT INTO public.vents_wallets (user_id, balance)
  VALUES (p_user_id, p_amount::integer)
  ON CONFLICT (user_id) DO UPDATE
    SET balance = public.vents_wallets.balance + p_amount::integer, updated_at = now();

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Credited',
    p_amount || ' Vents Cents have been added to your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  -- Previously the ONLY VC admin action that didn't write an audit row —
  -- admin_debit_vents_cents already did (Block 19 audit logging expansion).
  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'admin_vc_credit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason), public.actor_role());

  RETURN 'ok';
END;
$function$
;

-- Function: admin_debit_vents_cents
CREATE OR REPLACE FUNCTION public.admin_debit_vents_cents(p_user_id uuid, p_amount integer, p_reason text DEFAULT 'Admin debit'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_balance integer;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  PERFORM public._vc_deduct(p_user_id, p_amount, p_reason);

  SELECT balance INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Adjusted',
    p_amount || ' Vents Cents have been removed from your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'admin_vc_debit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason), public.actor_role());

  RETURN jsonb_build_object('debited', p_amount, 'target_balance', v_balance);
END;
$function$
;

-- Function: admin_health_ping
CREATE OR REPLACE FUNCTION public.admin_health_ping()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_count bigint;
  v_event_count bigint;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  SELECT count(*) INTO v_user_count FROM public.users;
  SELECT count(*) INTO v_event_count FROM public.events;

  RETURN jsonb_build_object(
    'status', 'ok',
    'server_time', now(),
    'users_reachable', v_user_count,
    'events_reachable', v_event_count
  );
END;
$function$
;

-- Function: admin_hide_event
CREATE OR REPLACE FUNCTION public.admin_hide_event(p_event_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  UPDATE public.events
  SET hidden_by_admin = true,
      hidden_at       = now(),
      hidden_by       = auth.uid()
  WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (
    auth.uid(),
    'hide_event',
    jsonb_build_object('event_id', p_event_id, 'reason', p_reason),
    public.actor_role()
  );
END;
$function$
;

-- Function: admin_list_pending_payouts
CREATE OR REPLACE FUNCTION public.admin_list_pending_payouts()
 RETURNS TABLE(request_id uuid, organizer_id uuid, organizer_name text, organizer_email text, organizer_phone text, amount_kobo bigint, bank_name text, account_number text, account_name text, recipient_code text, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.organizer_id, u.full_name, u.email, u.phone_number,
    r.amount_kobo, b.bank_name, b.account_number, b.account_name, b.recipient_code,
    r.status, r.created_at
  FROM public.organizer_withdrawal_requests r
  JOIN public.users u ON u.id = r.organizer_id
  JOIN public.organizer_bank_accounts b ON b.id = r.bank_account_id
  WHERE r.status IN ('pending', 'processing')
  ORDER BY r.created_at ASC;
END; $function$
;

-- Function: admin_list_processing_payouts
CREATE OR REPLACE FUNCTION public.admin_list_processing_payouts()
 RETURNS TABLE(request_id uuid, organizer_id uuid, amount_kobo bigint, transfer_code text, paystack_reference text, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.organizer_id, r.amount_kobo, r.transfer_code, r.paystack_reference, r.updated_at
  FROM public.organizer_withdrawal_requests r
  WHERE r.status = 'processing'
  ORDER BY r.updated_at ASC;
END; $function$
;

-- Function: admin_mark_payout_processing
CREATE OR REPLACE FUNCTION public.admin_mark_payout_processing(p_request_id uuid, p_paystack_reference text, p_transfer_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET paystack_reference = p_paystack_reference, transfer_code = p_transfer_code, updated_at = now()
  WHERE id = p_request_id AND status = 'processing';

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'approve_payout_request',
          jsonb_build_object('request_id', p_request_id, 'transfer_code', p_transfer_code),
          public.actor_role());
END;
$function$
;

-- Function: admin_reinstate_event
CREATE OR REPLACE FUNCTION public.admin_reinstate_event(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  UPDATE public.events
  SET hidden_by_admin = false,
      hidden_at       = NULL,
      hidden_by       = NULL
  WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (
    auth.uid(),
    'reinstate_event',
    jsonb_build_object('event_id', p_event_id),
    public.actor_role()
  );
END;
$function$
;

-- Function: admin_reject_organizer_payout
CREATE OR REPLACE FUNCTION public.admin_reject_organizer_payout(p_request_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_organizer_id uuid; v_amount_kobo bigint; v_status text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF (SELECT disable_payouts FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'payouts_disabled';
  END IF;

  SELECT organizer_id, amount_kobo, status INTO v_organizer_id, v_amount_kobo, v_status
  FROM public.organizer_withdrawal_requests WHERE id = p_request_id;
  IF v_organizer_id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_status NOT IN ('pending') THEN RAISE EXCEPTION 'Only pending requests can be rejected'; END IF;

  UPDATE public.organizer_withdrawal_requests
  SET status = 'rejected', admin_note = p_reason, resolved_by = auth.uid(), updated_at = now()
  WHERE id = p_request_id;
  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo + v_amount_kobo, pending_kobo = GREATEST(0, pending_kobo - v_amount_kobo), updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_payout_request', v_organizer_id,
          jsonb_build_object('request_id', p_request_id, 'amount_kobo', v_amount_kobo, 'reason', p_reason),
          public.actor_role());

  RETURN 'rejected';
END; $function$
;

-- Function: admin_reject_organizer_verification
CREATE OR REPLACE FUNCTION public.admin_reject_organizer_verification(p_request_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT user_id INTO v_user_id FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;

  UPDATE public.organizer_verification_requests
  SET status = 'rejected', admin_note = p_reason, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;

  -- In-app notification (Task 7) — includes the reason and invites resubmission.
  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (v_user_id, 'promo', 'Verification Not Approved',
          'Your brand verification request was not approved. Reason: ' || p_reason ||
          ' — you can correct the issue and submit a new request.',
          false, '⚠️');

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_organizer_verification', v_user_id,
          jsonb_build_object('request_id', p_request_id, 'reason', p_reason), public.actor_role());
END; $function$
;

-- Function: admin_restore_deleted_event
CREATE OR REPLACE FUNCTION public.admin_restore_deleted_event(p_event_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  UPDATE public.events
     SET deleted_at = NULL, deleted_by = NULL, reason = NULL, status = 'live'
   WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (auth.uid(), 'restore_event', jsonb_build_object('event_id', p_event_id), public.actor_role());
END;
$function$
;

-- Function: admin_revert_stuck_refund
CREATE OR REPLACE FUNCTION public.admin_revert_stuck_refund(p_ticket_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  SELECT id, user_id, payment_status INTO v_ticket
    FROM public.tickets
   WHERE id = p_ticket_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Only tickets awaiting refund can be reverted (current status: %)', v_ticket.payment_status;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid', status = 'active', refund_id = NULL
   WHERE id = p_ticket_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'admin_revert_stuck_refund', v_ticket.user_id,
    jsonb_build_object('ticket_id', p_ticket_id, 'reason', p_reason),
    public.actor_role()
  );

  RETURN 'reverted';
END;
$function$
;

-- Function: admin_toggle_user_verified
CREATE OR REPLACE FUNCTION public.admin_toggle_user_verified(p_user_id uuid, p_verified boolean, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_old_verified boolean;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin verification cannot be changed';
  END IF;

  SELECT is_verified INTO v_old_verified FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  UPDATE public.users SET is_verified = p_verified WHERE id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'toggle_verification',
    p_user_id,
    jsonb_build_object('old_verified', v_old_verified, 'new_verified', p_verified, 'reason', p_reason),
    public.actor_role()
  );
END;
$function$
;

-- Function: lift_expired_bans
CREATE OR REPLACE FUNCTION public.lift_expired_bans()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.users
  SET status = 'active', banned_until = NULL
  WHERE status = 'suspended'
    AND banned_until IS NOT NULL
    AND banned_until < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$
;

-- Function: lock_admin_root_role
CREATE OR REPLACE FUNCTION public.lock_admin_root_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- If this is the root admin account, force role back to 'admin' on any UPDATE
  IF NEW.id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' AND NEW.role <> 'admin' THEN
    NEW.role := 'admin';
  END IF;
  RETURN NEW;
END;
$function$
;

-- Function: log_organizer_promotion
CREATE OR REPLACE FUNCTION public.log_organizer_promotion(p_user_id uuid, p_email text, p_username text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Only write if the caller really is the target and is an organizer
  IF auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'caller must be the target user';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id AND role IN ('organizer', 'organiser')
  ) THEN
    RAISE EXCEPTION 'user is not an organizer';
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (
    p_user_id,
    'organizer_promoted',
    p_user_id,
    jsonb_build_object(
      'email',       p_email,
      'username',    p_username,
      'promoted_at', now()
    )
  );
END;
$function$
;

-- Function: log_scan_attempt
CREATE OR REPLACE FUNCTION public.log_scan_attempt(p_event_id uuid, p_ticket_id uuid, p_scanned_by uuid, p_result text, p_reason text, p_message text, p_device_id text, p_gate_name text, p_is_manual boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.scan_log
    (event_id, ticket_id, scanned_by, result, reason, message, device_id, gate_name, is_manual_override)
  VALUES
    (p_event_id, p_ticket_id, p_scanned_by, p_result, p_reason, p_message, p_device_id, p_gate_name, p_is_manual);
END;
$function$
;

-- Function: mark_notifications_pushed
CREATE OR REPLACE FUNCTION public.mark_notifications_pushed(p_ids uuid[])
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  UPDATE public.notifications SET push_sent = true WHERE id = ANY(p_ids);
$function$
;

-- Function: my_latest_organizer_verification
CREATE OR REPLACE FUNCTION public.my_latest_organizer_verification()
 RETURNS TABLE(request_id uuid, status text, admin_note text, created_at timestamp with time zone, reviewed_at timestamp with time zone, company_name text, cac_number text, owner_name text, registration_date date, business_email text, business_phone text, business_address text, document_url text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT r.id, r.status, r.admin_note, r.created_at, r.reviewed_at,
    r.company_name, r.cac_number, r.owner_name, r.registration_date,
    r.business_email, r.business_phone, r.business_address, r.document_url
  FROM public.organizer_verification_requests r
  WHERE r.user_id = v_user_id
  ORDER BY r.created_at DESC
  LIMIT 1;
END; $function$
;

-- Function: notify_admin_stats_payout
CREATE OR REPLACE FUNCTION public.notify_admin_stats_payout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('source', 'payout', 'id', NEW.id, 'status', NEW.status, 'updated_at', NEW.updated_at),
    'admin_stats_changed',
    'admin:stats',
    false
  );
  RETURN NEW;
END;
$function$
;

-- Function: notify_admin_stats_signup
CREATE OR REPLACE FUNCTION public.notify_admin_stats_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('source', 'signup', 'id', NEW.id, 'created_at', NEW.created_at),
    'admin_stats_changed',
    'admin:stats',
    false
  );
  RETURN NEW;
END;
$function$
;

-- Function: notify_admin_stats_transaction
CREATE OR REPLACE FUNCTION public.notify_admin_stats_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('source', 'transaction', 'id', NEW.id, 'type', NEW.type, 'created_at', NEW.created_at),
    'admin_stats_changed',
    'admin:stats',
    false
  );
  RETURN NEW;
END;
$function$
;

-- Function: notify_door_checkin
CREATE OR REPLACE FUNCTION public.notify_door_checkin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'checkin_id', NEW.id,
      'ticket_id', NEW.ticket_id,
      'is_manual_override', NEW.is_manual_override,
      'checked_in_at', NEW.checked_in_at
    ),
    'checkin',
    'door:' || NEW.event_id::text,
    false
  );
  RETURN NEW;
END;
$function$
;

-- Function: notify_door_scan
CREATE OR REPLACE FUNCTION public.notify_door_scan()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NEW.event_id IS NOT NULL THEN
    PERFORM realtime.send(
      jsonb_build_object('result', NEW.result, 'is_manual_override', NEW.is_manual_override, 'created_at', NEW.created_at),
      'scan_attempt',
      'door:' || NEW.event_id::text,
      false
    );
  END IF;
  RETURN NEW;
END;
$function$
;

-- Function: notify_door_ticket
CREATE OR REPLACE FUNCTION public.notify_door_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('ticket_id', NEW.id, 'status', NEW.status),
    'ticket',
    'door:' || NEW.event_id::text,
    false
  );
  RETURN NEW;
END;
$function$
;

-- Function: notify_event_update
CREATE OR REPLACE FUNCTION public.notify_event_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  IF NEW.event_date IS DISTINCT FROM OLD.event_date
     OR NEW.start_time IS DISTINCT FROM OLD.start_time
     OR NEW.end_time IS DISTINCT FROM OLD.end_time
     OR NEW.location IS DISTINCT FROM OLD.location
  THEN
    FOR v_ticket IN
      SELECT DISTINCT user_id FROM public.tickets
       WHERE event_id = NEW.id AND status = 'active'
    LOOP
      INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
      VALUES (
        v_ticket.user_id,
        'event_update',
        'Event details changed',
        NEW.title || ' has updated date, time, or location — check the latest details.',
        '📅',
        jsonb_build_object('eventId', NEW.id)
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$
;

-- Function: notify_new_direct_message
CREATE OR REPLACE FUNCTION public.notify_new_direct_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'id',           NEW.id,
      'sender_id',    NEW.sender_id,
      'recipient_id', NEW.recipient_id,
      'body',         NEW.body,
      'created_at',   NEW.created_at
    ),
    'new_message',
    'user:' || NEW.recipient_id::text,
    false
  );
  RETURN NEW;
END;
$function$
;

-- Function: notify_new_notification
CREATE OR REPLACE FUNCTION public.notify_new_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'id',         NEW.id,
      'user_id',    NEW.user_id,
      'type',       NEW.type,
      'created_at', NEW.created_at
    ),
    'new_notification',
    'user:' || NEW.user_id::text,
    false
  );
  RETURN NEW;
END;
$function$
;

-- Function: notify_organizer_events_event
CREATE OR REPLACE FUNCTION public.notify_organizer_events_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  IF NEW.organizer_id IS NOT NULL THEN
    PERFORM realtime.send(
      jsonb_build_object('event_id', NEW.id),
      'event_changed',
      'organizer-events:' || NEW.organizer_id::text,
      false
    );
  END IF;
  RETURN NEW;
END;
$function$
;

-- Function: notify_organizer_events_ticket
CREATE OR REPLACE FUNCTION public.notify_organizer_events_ticket()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE v_organizer_id uuid;
BEGIN
  SELECT organizer_id INTO v_organizer_id FROM public.events WHERE id = NEW.event_id;
  IF v_organizer_id IS NOT NULL THEN
    PERFORM realtime.send(
      jsonb_build_object('event_id', NEW.event_id),
      'tickets_changed',
      'organizer-events:' || v_organizer_id::text,
      false
    );
  END IF;
  RETURN NEW;
END;
$function$
;

-- Function: notify_user
CREATE OR REPLACE FUNCTION public.notify_user(p_user_id uuid, p_type text, p_title text, p_body text, p_icon text DEFAULT '🔔'::text, p_push_data jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
  VALUES (p_user_id, p_type, p_title, p_body, p_icon, p_push_data);
END;
$function$
;

-- Function: notify_user
CREATE OR REPLACE FUNCTION public.notify_user(p_user_id uuid, p_type text, p_title text, p_body text, p_icon text DEFAULT '🔔'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  INSERT INTO public.notifications (user_id, type, title, body, icon)
  VALUES (p_user_id, p_type, p_title, p_body, p_icon);
END;
$function$
;

-- Function: notify_vc_update
CREATE OR REPLACE FUNCTION public.notify_vc_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object('user_id', NEW.user_id, 'amount', NEW.amount, 'type', NEW.type),
    'vc_updated',
    'user:' || NEW.user_id::text,
    false
  );
  RETURN NEW;
END;
$function$
;

-- Function: promote_to_organizer
CREATE OR REPLACE FUNCTION public.promote_to_organizer()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_role text;
BEGIN
  v_id := auth.uid();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_id;

  -- Only allow promotion from attendee/user; block admin escalation
  IF v_role = 'admin' THEN
    RAISE EXCEPTION 'Admin role cannot be changed';
  END IF;

  -- Directly update bypassing the trigger restriction for attendee->organizer
  UPDATE public.users SET role = 'organizer' WHERE id = v_id;
END;
$function$
;

-- Function: check_user_role_update
CREATE OR REPLACE FUNCTION public.check_user_role_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- SECURITY DEFINER functions run as their owner (not 'authenticated'),
  -- so they bypass this check entirely.
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  -- Block ALL direct role changes via REST for authenticated users.
  -- Promotion must go through promote_to_organizer() or admin_set_user_role().
  IF OLD.role IS DISTINCT FROM NEW.role THEN
    RAISE EXCEPTION 'Role changes must go through the proper promotion or admin function';
  END IF;

  RETURN NEW;
END;
$function$
;

-- Function: protect_admin_tier_status_columns
CREATE OR REPLACE FUNCTION public.protect_admin_tier_status_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_caller_role text;
  v_action text;
BEGIN
  -- Acting on your own account is always allowed — this trigger exists to
  -- stop OTHERS from altering an account's status, not to restrict
  -- self-service actions like delete_own_account.
  IF auth.uid() IS NOT NULL AND OLD.id = auth.uid() THEN
    RETURN NEW;
  END IF;

  -- Root's status/banned_until/deleted_at can never be touched by anyone
  -- else, full stop.
  IF OLD.id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root account status cannot be modified';
  END IF;

  SELECT role INTO v_caller_role FROM public.users WHERE id = auth.uid();

  -- Banning/suspending/deleting/restoring ANY account (not just other
  -- Admin/Sub-Admin accounts) is a Super Admin action.
  IF v_caller_role = 'sub-admin' THEN
    RAISE EXCEPTION 'Sub-Admins cannot modify account status — Super Admin (Admin/Root) required';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_action := CASE
      WHEN NEW.banned_until IS DISTINCT FROM OLD.banned_until AND NEW.banned_until IS NOT NULL THEN 'ban_user'
      WHEN NEW.banned_until IS DISTINCT FROM OLD.banned_until AND NEW.banned_until IS NULL THEN 'unban_user'
      WHEN NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL THEN 'delete_user'
      WHEN NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NULL THEN 'restore_user'
      WHEN NEW.status IS DISTINCT FROM OLD.status THEN 'status_change'
      ELSE NULL
    END;

    IF v_action IS NOT NULL THEN
      INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
      VALUES (
        auth.uid(), v_action, OLD.id,
        jsonb_build_object(
          'old_status', OLD.status, 'new_status', NEW.status,
          'old_banned_until', OLD.banned_until, 'new_banned_until', NEW.banned_until
        ),
        public.actor_role()
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$
;

-- Function: protect_event_promotion_columns
CREATE OR REPLACE FUNCTION public.protect_event_promotion_columns()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  IF OLD.is_featured IS DISTINCT FROM NEW.is_featured THEN
    RAISE EXCEPTION 'is_featured can only be changed via activate_event_promotion()';
  END IF;
  IF OLD.featured_until IS DISTINCT FROM NEW.featured_until THEN
    RAISE EXCEPTION 'featured_until can only be changed via activate_event_promotion()';
  END IF;
  IF OLD.hidden_by_admin IS DISTINCT FROM NEW.hidden_by_admin THEN
    RAISE EXCEPTION 'hidden_by_admin can only be changed by an admin';
  END IF;

  RETURN NEW;
END;
$function$
;

-- Function: prune_push_token
CREATE OR REPLACE FUNCTION public.prune_push_token(p_token text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  DELETE FROM public.device_push_tokens WHERE token = p_token;
$function$
;

-- Function: purchase_badge
CREATE OR REPLACE FUNCTION public.purchase_badge(p_badge_type text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid        uuid    := auth.uid();
  v_cost       integer;
  v_tier_order text[]  := ARRAY['bronze','silver','gold','platinum','elite','legend'];
  v_current_idx integer;
  v_new_idx     integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF p_badge_type NOT IN ('bronze','silver','gold','platinum','elite','legend') THEN
    RAISE EXCEPTION 'Invalid badge type: %', p_badge_type;
  END IF;

  v_cost := CASE p_badge_type
    WHEN 'bronze'   THEN 300
    WHEN 'silver'   THEN 800
    WHEN 'gold'     THEN 2000
    WHEN 'platinum' THEN 5000
    WHEN 'elite'    THEN 12000
    WHEN 'legend'   THEN 25000
    ELSE 0
  END;

  SELECT array_position(v_tier_order, vc_badge) INTO v_current_idx
  FROM public.users WHERE id = v_uid;

  v_new_idx := array_position(v_tier_order, p_badge_type);

  IF v_current_idx IS NOT NULL AND v_new_idx < v_current_idx THEN
    RAISE EXCEPTION 'Cannot downgrade badge';
  END IF;

  PERFORM public._vc_deduct(v_uid, v_cost, 'Badge: ' || p_badge_type);

  UPDATE public.users SET vc_badge = p_badge_type WHERE id = v_uid;

  INSERT INTO public.vc_bonuses (user_id, bonus_type) VALUES (v_uid, 'badge_' || p_badge_type)
  ON CONFLICT (user_id, bonus_type) DO UPDATE SET granted_at = now();
END;
$function$
;

-- Function: protect_trust_signal_columns
CREATE OR REPLACE FUNCTION public.protect_trust_signal_columns()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  IF OLD.is_verified IS DISTINCT FROM NEW.is_verified THEN
    RAISE EXCEPTION 'is_verified can only be changed via organizer verification approval';
  END IF;
  IF OLD.vc_badge IS DISTINCT FROM NEW.vc_badge THEN
    RAISE EXCEPTION 'vc_badge can only be changed via purchase_badge()';
  END IF;
  IF OLD.vc_featured_until IS DISTINCT FROM NEW.vc_featured_until THEN
    RAISE EXCEPTION 'vc_featured_until can only be changed via feature_in_people_vc()';
  END IF;

  RETURN NEW;
END;
$function$
;

-- Function: purchase_ticket
CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user_id       uuid := auth.uid();
  v_event         record;
  v_ticket_obj    jsonb;
  v_unit_price    numeric;
  v_discount_pct  numeric := 0;
  v_effective     numeric;
  v_status        text;
  v_attendee      jsonb;
  v_ticket_id     uuid;
  v_ticket_ids    uuid[] := ARRAY[]::uuid[];
  v_count         integer;
  v_promo         public.promo_codes;
  v_existing_ids  uuid[];
  v_event_sold    integer;
  v_type_sold     integer;
  v_type_limit    integer;
BEGIN
  IF (SELECT disable_purchases FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'purchases_disabled';
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public.check_rate_limit('ticket_purchase:' || v_user_id::text, 8, 60);

  v_count := jsonb_array_length(p_attendees);
  IF v_count < 1 OR v_count > 10 THEN
    RAISE EXCEPTION 'Attendee count must be between 1 and 10';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));

  -- Idempotency keyed on the actual payment reference being retried, not
  -- merely "this user has some active ticket for this event".
  SELECT array_agg(id) INTO v_existing_ids
  FROM public.tickets
  WHERE event_id = p_event_id AND user_id = v_user_id AND payment_ref = p_payment_ref AND status = 'active';

  IF v_existing_ids IS NOT NULL THEN
    RETURN v_existing_ids;
  END IF;

  SELECT price, ticket_types, ticket_goal, deleted_at, status, event_date, hidden_by_admin
  INTO v_event
  FROM public.events
  WHERE id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  IF v_event.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This event has been removed and is no longer accepting purchases';
  END IF;

  IF v_event.status <> 'live' THEN
    RAISE EXCEPTION 'This event is not currently open for ticket purchases';
  END IF;

  IF v_event.hidden_by_admin THEN
    RAISE EXCEPTION 'This event is not currently open for ticket purchases';
  END IF;

  IF v_event.event_date::date < current_date THEN
    RAISE EXCEPTION 'This event has already ended';
  END IF;

  IF v_event.ticket_types IS NOT NULL AND jsonb_array_length(v_event.ticket_types) > 0 THEN
    SELECT tt INTO v_ticket_obj
    FROM jsonb_array_elements(v_event.ticket_types) AS tt
    WHERE tt->>'name' = p_ticket_type
    LIMIT 1;

    IF v_ticket_obj IS NULL THEN
      RAISE EXCEPTION 'Ticket type not found';
    END IF;

    v_unit_price := (v_ticket_obj->>'price')::numeric;
  ELSE
    v_unit_price := COALESCE(v_event.price, 0);
  END IF;

  IF v_unit_price IS NULL OR v_unit_price < 0 THEN
    RAISE EXCEPTION 'This ticket type has an invalid price and cannot be purchased';
  END IF;

  IF v_event.ticket_goal IS NOT NULL AND v_event.ticket_goal > 0 THEN
    SELECT count(*) INTO v_event_sold FROM public.tickets WHERE event_id = p_event_id AND status = 'active';
    IF v_event_sold + v_count > v_event.ticket_goal THEN
      RAISE EXCEPTION 'Only % ticket(s) remaining for this event', GREATEST(0, v_event.ticket_goal - v_event_sold);
    END IF;
  END IF;

  IF v_ticket_obj IS NOT NULL AND v_ticket_obj ? 'quantity' THEN
    v_type_limit := NULLIF(v_ticket_obj->>'quantity', '')::integer;
    IF v_type_limit IS NOT NULL AND v_type_limit > 0 THEN
      SELECT count(*) INTO v_type_sold
      FROM public.tickets
      WHERE event_id = p_event_id AND ticket_type = p_ticket_type AND status = 'active';

      IF v_type_sold + v_count > v_type_limit THEN
        RAISE EXCEPTION 'Only % % ticket(s) remaining', GREATEST(0, v_type_limit - v_type_sold), p_ticket_type;
      END IF;
    END IF;
  END IF;

  IF p_promo_code IS NOT NULL AND trim(p_promo_code) <> '' THEN
    SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = upper(trim(p_promo_code));

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid promo code';
    END IF;
    IF NOT v_promo.is_active THEN
      RAISE EXCEPTION 'This promo code is no longer active';
    END IF;
    IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < now() THEN
      RAISE EXCEPTION 'This promo code has expired';
    END IF;
    IF v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses THEN
      RAISE EXCEPTION 'This promo code has reached its usage limit';
    END IF;

    v_discount_pct := v_promo.discount_percentage;
  END IF;

  v_effective := v_unit_price * (1 - v_discount_pct / 100);
  v_status := CASE WHEN v_effective = 0 THEN 'paid' ELSE 'pending' END;

  FOR v_attendee IN SELECT * FROM jsonb_array_elements(p_attendees)
  LOOP
    IF NULLIF(trim(v_attendee->>'name'), '') IS NULL THEN
      RAISE EXCEPTION 'Each attendee must have a name';
    END IF;

    INSERT INTO public.tickets
      (event_id, user_id, quantity, ticket_type, amount, payment_ref, payment_status, status,
       holder_name, holder_email, holder_phone, promo_code, discount_percentage)
    VALUES
      (p_event_id, v_user_id, 1, p_ticket_type, v_unit_price, p_payment_ref, v_status, 'active',
       trim(v_attendee->>'name'), NULLIF(trim(v_attendee->>'email'), ''), NULLIF(trim(v_attendee->>'phone'), ''),
       CASE WHEN v_promo.id IS NOT NULL THEN upper(trim(p_promo_code)) ELSE NULL END, v_discount_pct)
    RETURNING id INTO v_ticket_id;

    v_ticket_ids := array_append(v_ticket_ids, v_ticket_id);
  END LOOP;

  IF v_status = 'paid' AND v_promo.id IS NOT NULL THEN
    UPDATE public.promo_codes SET current_uses = current_uses + 1 WHERE id = v_promo.id;
  END IF;

  RETURN v_ticket_ids;
END;
$function$
;

-- Function: purchase_ticket_with_tokens
CREATE OR REPLACE FUNCTION public.purchase_ticket_with_tokens(p_event_id uuid, p_ticket_type text, p_attendees jsonb, p_payment_ref text, p_promo_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ids uuid[];
  v_id uuid;
  v_result jsonb := '[]'::jsonb;
BEGIN
  -- Reuse the audited, idempotent purchase path exactly as-is.
  v_ids := public.purchase_ticket(p_event_id, p_ticket_type, p_attendees, p_payment_ref, p_promo_code);

  IF v_ids IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  -- Sign each freshly-created ticket in the same transaction (the rows are
  -- already visible here), returning {ticket_id, token} pairs.
  FOREACH v_id IN ARRAY v_ids LOOP
    v_result := v_result || jsonb_build_object(
      'ticket_id', v_id,
      'token', public.generate_ticket_token(v_id)
    );
  END LOOP;

  RETURN v_result;
END;
$function$
;

-- Function: reclaim_unverified_signup
CREATE OR REPLACE FUNCTION public.reclaim_unverified_signup(p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_username text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_count integer := 0;
BEGIN
  WITH stale AS (
    SELECT au.id
    FROM auth.users au
    JOIN public.users u ON u.id = au.id
    WHERE au.email_confirmed_at IS NULL
      AND au.created_at < now() - interval '3 minutes'
      AND (
        (p_email IS NOT NULL AND u.email = lower(trim(p_email)))
        OR (p_phone IS NOT NULL AND trim(p_phone) <> '' AND u.phone_number = trim(p_phone))
        OR (p_username IS NOT NULL AND u.username = lower(trim(p_username)))
      )
  ), deleted AS (
    DELETE FROM auth.users WHERE id IN (SELECT id FROM stale) RETURNING id
  )
  SELECT count(*) INTO v_count FROM deleted;

  RETURN v_count;
END;
$function$
;

-- Function: referral_count_today
CREATE OR REPLACE FUNCTION public.referral_count_today(p_user_id uuid)
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COUNT(*) FROM public.referrals
  WHERE referrer_id = p_user_id
    AND created_at > now() - interval '24 hours';
$function$
;

-- Function: refund_ticket
CREATE OR REPLACE FUNCTION public.refund_ticket(p_ticket_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket      record;
  v_refund_kobo bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A refund reason is required';
  END IF;

  SELECT t.id, t.payment_ref, t.payment_status, t.status, t.amount, t.discount_percentage,
         t.ticket_type, t.user_id, t.checked_in, e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND auth.uid() <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    RAISE EXCEPTION 'Only the event organizer or an admin can refund this ticket';
  END IF;

  IF v_ticket.payment_status = 'refunded' THEN
    RETURN jsonb_build_object('status', 'already_refunded', 'ticket_id', v_ticket.id);
  END IF;

  IF v_ticket.payment_status = 'refund_pending' THEN
    RETURN jsonb_build_object(
      'status', 'refund_pending', 'ticket_id', v_ticket.id, 'payment_ref', v_ticket.payment_ref
    );
  END IF;

  IF v_ticket.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'Only paid tickets can be refunded (current status: %)', v_ticket.payment_status;
  END IF;

  -- Buyer's paid share for this ticket, service fee included -- the
  -- per-ticket version of the group formula confirm_ticket_payment sums
  -- (CheckoutScreen.tsx: total = subtotal * (1.05 - discount%/100)). Summed
  -- across every ticket sharing a payment_ref this equals the group total
  -- that was actually charged, so refunding one ticket at a time out of a
  -- multi-attendee purchase never over- or under-refunds what Paystack
  -- actually collected.
  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;

  -- Free ticket: nothing was ever charged or credited to the organizer, so
  -- finalize immediately -- no Paystack call needed, nothing to reverse.
  IF v_ticket.amount <= 0 OR v_refund_kobo <= 0 THEN
    UPDATE public.tickets
       SET payment_status = 'refunded', status = 'cancelled',
           refund_reason = p_reason, refund_initiated_by = auth.uid()
     WHERE id = v_ticket.id;

    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (
      v_ticket.user_id, 'booking', 'Ticket refunded',
      'Your ' || v_ticket.ticket_type || ' ticket for ' || v_ticket.event_title || ' has been refunded. Reason: ' || p_reason,
      false, '💸'
    );

    INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
    VALUES (
      auth.uid(), 'refund_ticket', v_ticket.user_id,
      jsonb_build_object('ticket_id', v_ticket.id, 'reason', p_reason, 'amount_kobo', 0),
      public.actor_role()
    );

    RETURN jsonb_build_object('status', 'refunded', 'ticket_id', v_ticket.id, 'amount_kobo', 0);
  END IF;

  UPDATE public.tickets
     SET payment_status = 'refund_pending', status = 'cancelled',
         refund_reason = p_reason, refund_initiated_by = auth.uid()
   WHERE id = v_ticket.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'refund_ticket_initiated', v_ticket.user_id,
    jsonb_build_object(
      'ticket_id', v_ticket.id, 'reason', p_reason, 'amount_kobo', v_refund_kobo,
      'checked_in', v_ticket.checked_in
    ),
    public.actor_role()
  );

  RETURN jsonb_build_object(
    'status', 'refund_pending',
    'ticket_id', v_ticket.id,
    'payment_ref', v_ticket.payment_ref,
    'amount_kobo', v_refund_kobo,
    'user_id', v_ticket.user_id
  );
END;
$function$
;

-- Function: register_push_token
CREATE OR REPLACE FUNCTION public.register_push_token(p_user_id uuid, p_token text, p_platform text DEFAULT 'android'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Only the authenticated user may register a token for themselves.
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized to register a token for this user';
  END IF;
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RAISE EXCEPTION 'Empty push token';
  END IF;

  INSERT INTO public.device_push_tokens (user_id, token, platform, last_seen)
  VALUES (p_user_id, p_token, COALESCE(NULLIF(p_platform, ''), 'android'), now())
  ON CONFLICT (token) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        last_seen = now();
END; $function$
;

-- Function: reject_admin_action
CREATE OR REPLACE FUNCTION public.reject_admin_action(p_request_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  UPDATE public.admin_action_requests
     SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_reason = p_reason, seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_rejected', CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type, 'requested_by', r.requested_by,
                             'reason', p_reason, 'target_label', r.target_label, 'reviewer_ip', public.client_ip()),
          public.actor_role());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (r.requested_by, 'broadcast', 'Your request has been rejected',
          format('Your request (%s) was rejected.%s', COALESCE(r.target_label, r.action_type),
                 CASE WHEN p_reason IS NOT NULL AND p_reason <> '' THEN ' Reason: ' || p_reason ELSE '' END), false, '❌');

  RETURN to_jsonb(r);
END; $function$
;

-- Function: reject_injection_patterns
CREATE OR REPLACE FUNCTION public.reject_injection_patterns(p_label text, p_text text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
  IF p_text IS NULL THEN RETURN; END IF;
  IF p_text ~* '<script\y|<iframe\y|javascript:|on\w+\s*=\s*["'']' THEN
    RAISE EXCEPTION '% contains disallowed content', p_label;
  END IF;
END;
$function$
;

-- Function: remove_bank_account_confirmed
CREATE OR REPLACE FUNCTION public.remove_bank_account_confirmed(p_account_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_was_default boolean; v_next uuid;
BEGIN
  PERFORM public.assert_recent_auth();
  SELECT is_default INTO v_was_default FROM public.organizer_bank_accounts
  WHERE id = p_account_id AND organizer_id = v_uid AND is_active;
  IF v_was_default IS NULL THEN RAISE EXCEPTION 'Bank account not found'; END IF;

  UPDATE public.organizer_bank_accounts
  SET is_active = false, is_default = false, updated_at = now()
  WHERE id = p_account_id AND organizer_id = v_uid;

  IF v_was_default THEN
    SELECT id INTO v_next FROM public.organizer_bank_accounts
    WHERE organizer_id = v_uid AND is_active ORDER BY created_at DESC LIMIT 1;
    IF v_next IS NOT NULL THEN
      UPDATE public.organizer_bank_accounts SET is_default = true, updated_at = now() WHERE id = v_next;
    END IF;
    UPDATE public.events SET payout_account_id = v_next
    WHERE organizer_id = v_uid AND payout_account_id = p_account_id;
  END IF;
END; $function$
;

-- Function: remove_push_tokens_for_user
CREATE OR REPLACE FUNCTION public.remove_push_tokens_for_user(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  DELETE FROM public.device_push_tokens WHERE user_id = p_user_id;
END; $function$
;

-- Function: request_admin_action
CREATE OR REPLACE FUNCTION public.request_admin_action(p_action_type text, p_target_type text, p_target_id uuid, p_target_label text, p_payload jsonb DEFAULT '{}'::jsonb, p_previous_values jsonb DEFAULT NULL::jsonb, p_requested_changes jsonb DEFAULT NULL::jsonb, p_device text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.admin_action_requests;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required to submit an action request';
  END IF;

  INSERT INTO public.admin_action_requests (
    action_type, target_type, target_id, target_label, payload,
    previous_values, requested_changes, requested_by, requested_by_role, device, ip
  ) VALUES (
    p_action_type, p_target_type, p_target_id, p_target_label, COALESCE(p_payload, '{}'::jsonb),
    p_previous_values, p_requested_changes, auth.uid(), public.actor_role(), p_device,
    public.client_ip()
  ) RETURNING * INTO v_row;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_requested',
          CASE WHEN p_target_type = 'user' THEN p_target_id ELSE NULL END,
          jsonb_build_object('request_id', v_row.id, 'action_type', p_action_type,
                             'target_type', p_target_type, 'target_id', p_target_id,
                             'target_label', p_target_label,
                             'device', p_device, 'ip', v_row.ip),
          public.actor_role());

  RETURN to_jsonb(v_row);
END; $function$
;

-- Function: request_organizer_payout
CREATE OR REPLACE FUNCTION public.request_organizer_payout(p_amount_kobo bigint, p_bank_account_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid := auth.uid();
  v_balance      bigint;
  v_request_id   uuid;
  v_account      public.organizer_bank_accounts;
BEGIN
  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before requesting a withdrawal';
  END IF;

  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'Invalid amount';
  END IF;

  SELECT * INTO v_account FROM public.organizer_bank_accounts
  WHERE id = p_bank_account_id AND organizer_id = v_organizer_id
    AND is_active AND recipient_code IS NOT NULL;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'Bank account not verified';
  END IF;

  SELECT balance_kobo INTO v_balance
  FROM public.organizer_wallets
  WHERE organizer_id = v_organizer_id
  FOR UPDATE;

  IF v_balance IS NULL OR v_balance < p_amount_kobo THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  UPDATE public.organizer_wallets
  SET balance_kobo = balance_kobo - p_amount_kobo,
      pending_kobo = pending_kobo + p_amount_kobo,
      updated_at = now()
  WHERE organizer_id = v_organizer_id;

  INSERT INTO public.organizer_withdrawal_requests
    (organizer_id, amount_kobo, bank_account_id, status, bank_name, bank_code, account_number, account_name)
  VALUES
    (v_organizer_id, p_amount_kobo, p_bank_account_id, 'pending',
     v_account.bank_name, v_account.bank_code, v_account.account_number, v_account.account_name)
  RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$function$
;

-- Function: resolve_username_to_email
CREATE OR REPLACE FUNCTION public.resolve_username_to_email(p_username text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_email text;
BEGIN
  SELECT email INTO v_email
  FROM public.users
  WHERE username = lower(trim(p_username))
  LIMIT 1;
  RETURN v_email;
END;
$function$
;

-- Function: respond_to_message_request
CREATE OR REPLACE FUNCTION public.respond_to_message_request(p_requester_id uuid, p_action text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_recipient uuid := auth.uid();
  v_req public.conversation_requests;
BEGIN
  IF v_recipient IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_action NOT IN ('accept', 'decline') THEN
    RAISE EXCEPTION 'Invalid action';
  END IF;

  SELECT * INTO v_req FROM public.conversation_requests
  WHERE requester_id = p_requester_id AND recipient_id = v_recipient AND status = 'pending'
  FOR UPDATE;

  IF v_req IS NULL THEN
    RAISE EXCEPTION 'No pending request from this user';
  END IF;

  UPDATE public.conversation_requests
  SET status = CASE WHEN p_action = 'accept' THEN 'accepted' ELSE 'declined' END,
      responded_at = now()
  WHERE id = v_req.id;

  IF p_action = 'accept' THEN
    INSERT INTO public.notifications (user_id, type, title, body, icon)
    VALUES
      (v_req.requester_id, 'social', 'Message request accepted', 'You can now message each other.', '💬'),
      (v_req.recipient_id, 'social', 'Messaging enabled', 'You can now message each other.', '💬');
  END IF;
END;
$function$
;

-- Function: run_event_reminder_sweep
CREATE OR REPLACE FUNCTION public.run_event_reminder_sweep()
 RETURNS TABLE(reminders_24h integer, reminders_1h integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_count_24h integer := 0;
  v_count_1h  integer := 0;
  v_row       record;
BEGIN
  FOR v_row IN
    SELECT t.id AS ticket_id, t.user_id, e.id AS event_id, e.title, e.event_date
      FROM public.tickets t
      JOIN public.events e ON e.id = t.event_id
     WHERE t.status = 'active'
       AND t.payment_status = 'paid'
       AND e.event_date > now()
       AND e.event_date <= now() + interval '24 hours'
       AND e.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.event_reminder_log l
          WHERE l.ticket_id = t.id AND l.kind = '24h'
       )
  LOOP
    INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
    VALUES (
      v_row.user_id, 'reminder', 'Tomorrow: ' || v_row.title,
      v_row.title || ' is happening in about 24 hours. Get ready!', '⏰',
      jsonb_build_object('eventId', v_row.event_id)
    );
    INSERT INTO public.event_reminder_log (ticket_id, kind) VALUES (v_row.ticket_id, '24h');
    v_count_24h := v_count_24h + 1;
  END LOOP;

  FOR v_row IN
    SELECT t.id AS ticket_id, t.user_id, e.id AS event_id, e.title, e.event_date
      FROM public.tickets t
      JOIN public.events e ON e.id = t.event_id
     WHERE t.status = 'active'
       AND t.payment_status = 'paid'
       AND e.event_date > now()
       AND e.event_date <= now() + interval '1 hour'
       AND e.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.event_reminder_log l
          WHERE l.ticket_id = t.id AND l.kind = '1h'
       )
  LOOP
    INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
    VALUES (
      v_row.user_id, 'reminder', 'Starting soon: ' || v_row.title,
      v_row.title || ' starts in about an hour!', '⏰',
      jsonb_build_object('eventId', v_row.event_id)
    );
    INSERT INTO public.event_reminder_log (ticket_id, kind) VALUES (v_row.ticket_id, '1h');
    v_count_1h := v_count_1h + 1;
  END LOOP;

  RETURN QUERY SELECT v_count_24h, v_count_1h;
END;
$function$
;

-- Function: scan_reason_to_result
CREATE OR REPLACE FUNCTION public.scan_reason_to_result(p_reason text, p_message text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN p_reason = 'already_scanned' THEN 'duplicate'
    WHEN p_reason IN ('wrong_organizer', 'payload_mismatch') THEN 'wrong_event'
    WHEN p_reason = 'not_active' AND p_message ILIKE '%refund%' THEN 'refunded'
    WHEN p_reason = 'not_active' AND p_message ILIKE '%cancel%' THEN 'cancelled'
    ELSE 'invalid'
  END;
$function$
;

-- Function: manual_check_in
CREATE OR REPLACE FUNCTION public.manual_check_in(p_ticket_id uuid, p_actor_id uuid, p_device_id text DEFAULT NULL::text, p_gate_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
  v_reason text;
  v_message text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to check in as this user';
  END IF;

  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  PERFORM public.check_rate_limit('manual_checkin:' || p_actor_id::text, 30, 10);

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type,
         t.checked_in, t.checked_in_at, t.scanner_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    v_reason := 'not_found'; v_message := 'Ticket not found in system.';
    PERFORM public.log_scan_attempt(NULL, p_ticket_id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF NOT public.is_event_door_manager(v_ticket.event_id) THEN
    v_reason := 'wrong_organizer'; v_message := 'This ticket belongs to a different organizer''s event.';
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'wrong_event', v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.status <> 'active' THEN
    v_reason := 'not_active'; v_message := 'This ticket is ' || v_ticket.status || ', not active.';
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id,
      public.scan_reason_to_result(v_reason, v_message), v_reason, v_message, p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already checked in.', p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already checked in.',
      'checked_in_at', v_ticket.checked_in_at, 'scanner_id', v_ticket.scanner_id,
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already checked in.', p_device_id, p_gate_name, true);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already checked in.',
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  INSERT INTO public.checkins
    (ticket_id, event_id, user_id, scanned_by, checked_in_at, device_id, gate_name, is_manual_override)
  VALUES
    (v_ticket.id, v_ticket.event_id, v_ticket.user_id, p_actor_id, now(), p_device_id, p_gate_name, true)
  ON CONFLICT (ticket_id) DO NOTHING;

  PERFORM public.log_scan_attempt(v_ticket.event_id, v_ticket.id, p_actor_id, 'valid', NULL, NULL, p_device_id, p_gate_name, true);

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now(),
    'is_manual_override', true,
    'stats', public.door_stats(v_ticket.event_id)
  );
END;
$function$
;

-- Function: search_direct_messages
CREATE OR REPLACE FUNCTION public.search_direct_messages(p_query text, p_other_user_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF direct_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF coalesce(trim(p_query), '') = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT * FROM public.direct_messages dm
  WHERE (dm.sender_id = v_user OR dm.recipient_id = v_user)
    AND coalesce(dm.deleted_by_sender, false) = false
    AND dm.body ILIKE '%' || p_query || '%'
    AND (
      p_other_user_id IS NULL
      OR dm.sender_id = p_other_user_id OR dm.recipient_id = p_other_user_id
    )
  ORDER BY dm.created_at DESC
  LIMIT 100;
END;
$function$
;

-- Function: search_events_fuzzy
CREATE OR REPLACE FUNCTION public.search_events_fuzzy(p_query text, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_exclude_18_plus boolean DEFAULT false)
 RETURNS TABLE(id uuid, title text, description text, image_url text, location text, event_date timestamp with time zone, price numeric, category text, categories text[], organizer_id uuid, created_at timestamp with time zone, ticket_types jsonb, ticket_goal integer, is_featured boolean, featured_until timestamp with time zone, is_18_plus boolean, organizer_name text, organizer_vc_badge text, match_score real)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_words text[];
  v_limit integer := LEAST(GREATEST(coalesce(p_limit, 20), 1), 50);
  v_offset integer := GREATEST(coalesce(p_offset, 0), 0);
  v_dob date;
  v_exclude_18_plus boolean;
BEGIN
  SELECT array_agg(DISTINCT w) INTO v_words
  FROM unnest(regexp_split_to_array(unaccent(lower(trim(coalesce(p_query, '')))), '\s+')) AS w
  WHERE w <> '';

  IF v_words IS NULL OR array_length(v_words, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Server-derived, not client-supplied: no session, no date_of_birth on
  -- file, or under 18 all fail closed to "exclude".
  IF auth.uid() IS NULL THEN
    v_exclude_18_plus := true;
  ELSE
    SELECT date_of_birth INTO v_dob FROM public.users WHERE public.users.id = auth.uid();
    v_exclude_18_plus := v_dob IS NULL OR date_part('year', age(v_dob)) < 18;
  END IF;

  RETURN QUERY
  SELECT
    e.id, e.title, e.description, e.image_url, e.location, e.event_date,
    e.price, e.category, e.categories, e.organizer_id, e.created_at,
    e.ticket_types, e.ticket_goal, e.is_featured, e.featured_until, e.is_18_plus,
    COALESCE(u.username, u.full_name) AS organizer_name,
    u.vc_badge AS organizer_vc_badge,
    m.score AS match_score
  FROM public.events e
  LEFT JOIN public.users u ON u.id = e.organizer_id
  CROSS JOIN LATERAL (
    SELECT unaccent(lower(
      e.title || ' ' || coalesce(e.location, '') || ' ' || coalesce(e.category, '') || ' ' ||
      array_to_string(coalesce(e.categories, ARRAY[]::text[]), ' ') || ' ' ||
      coalesce(u.username, '') || ' ' || coalesce(u.full_name, '')
    )) AS haystack
  ) hay
  CROSS JOIN LATERAL (
    SELECT
      bool_and(per_word.matched) AS all_words_matched,
      avg(per_word.best_score)::real AS score
    FROM (
      SELECT
        EXISTS (
          SELECT 1 FROM (
            SELECT w AS term
            UNION
            SELECT s.synonym FROM public.search_synonyms s WHERE s.term = w
          ) expanded
          WHERE hay.haystack ILIKE '%' || replace(replace(replace(expanded.term, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'
             OR word_similarity(expanded.term, hay.haystack) > 0.35
        ) AS matched,
        GREATEST(
          (
            SELECT MAX(word_similarity(expanded.term, hay.haystack))
            FROM (
              SELECT w AS term
              UNION
              SELECT s.synonym FROM public.search_synonyms s WHERE s.term = w
            ) expanded
          ),
          CASE WHEN hay.haystack ILIKE '%' || replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\' THEN 1.0 ELSE 0.0 END
        ) AS best_score
      FROM unnest(v_words) w
    ) per_word
  ) m
  WHERE e.hidden_by_admin = false
    AND e.deleted_at IS NULL
    AND e.status IN ('live', 'published')
    AND e.event_date >= now()
    AND (NOT v_exclude_18_plus OR e.is_18_plus = false)
    AND m.all_words_matched
  ORDER BY m.score DESC, e.is_featured DESC, e.event_date ASC
  LIMIT v_limit OFFSET v_offset;
END;
$function$
;

-- Function: send_direct_message
CREATE OR REPLACE FUNCTION public.send_direct_message(p_recipient_id uuid, p_body text DEFAULT ''::text, p_event_id uuid DEFAULT NULL::uuid, p_image_url text DEFAULT NULL::text, p_media_type text DEFAULT NULL::text, p_reply_to_id uuid DEFAULT NULL::uuid)
 RETURNS direct_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_sender uuid := auth.uid();
  v_req public.conversation_requests;
  v_msg public.direct_messages;
  v_has_history boolean;
  v_sender_name text;
  v_preview text;
BEGIN
  IF v_sender IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_recipient_id = v_sender THEN
    RAISE EXCEPTION 'Cannot message yourself';
  END IF;
  IF coalesce(trim(p_body), '') = '' AND p_image_url IS NULL THEN
    RAISE EXCEPTION 'Message cannot be empty';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.blocked_users
    WHERE (blocker_id = p_recipient_id AND blocked_id = v_sender)
       OR (blocker_id = v_sender AND blocked_id = p_recipient_id)
  ) THEN
    RAISE EXCEPTION 'blocked';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(least(v_sender, p_recipient_id)::text || greatest(v_sender, p_recipient_id)::text, 0));

  SELECT * INTO v_req FROM public.conversation_requests
  WHERE (requester_id = v_sender AND recipient_id = p_recipient_id)
     OR (requester_id = p_recipient_id AND recipient_id = v_sender)
  LIMIT 1;

  IF v_req IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.direct_messages
      WHERE (sender_id = v_sender AND recipient_id = p_recipient_id)
         OR (sender_id = p_recipient_id AND recipient_id = v_sender)
    ) INTO v_has_history;

    INSERT INTO public.conversation_requests (requester_id, recipient_id, status, responded_at)
    VALUES (v_sender, p_recipient_id, CASE WHEN v_has_history THEN 'accepted' ELSE 'pending' END, CASE WHEN v_has_history THEN now() ELSE NULL END)
    RETURNING * INTO v_req;
  ELSIF v_req.status = 'declined' THEN
    RAISE EXCEPTION 'This user is not accepting messages from you right now';
  ELSIF v_req.status = 'pending' AND v_req.requester_id = p_recipient_id THEN
    UPDATE public.conversation_requests
    SET status = 'accepted', responded_at = now()
    WHERE id = v_req.id;

    INSERT INTO public.notifications (user_id, type, title, body, icon)
    VALUES
      (v_req.requester_id, 'social', 'Message request accepted', 'You can now message each other.', '💬'),
      (v_req.recipient_id, 'social', 'Messaging enabled', 'You can now message each other.', '💬');
  END IF;

  INSERT INTO public.direct_messages (sender_id, recipient_id, event_id, body, image_url, media_type, reply_to_id)
  VALUES (v_sender, p_recipient_id, p_event_id, coalesce(p_body, ''), p_image_url, p_media_type, p_reply_to_id)
  RETURNING * INTO v_msg;

  -- NEW: push-eligible notification for the recipient. Only when the
  -- request is already 'accepted' (a still-'pending' first message sits in
  -- the recipient's Message Requests inbox, not their main chat list — a
  -- push for that would deep-link somewhere the tap can't actually resolve
  -- to a normal conversation yet).
  IF v_req.status = 'accepted' THEN
    SELECT coalesce(full_name, username, 'Someone') INTO v_sender_name
      FROM public.users WHERE id = v_sender;
    v_preview := CASE
      WHEN p_image_url IS NOT NULL AND coalesce(trim(p_body), '') = '' THEN '📷 Photo'
      WHEN length(coalesce(p_body, '')) > 80 THEN left(p_body, 77) || '...'
      ELSE coalesce(p_body, '')
    END;
    INSERT INTO public.notifications (user_id, type, title, body, icon, push_data)
    VALUES (
      p_recipient_id,
      'message',
      v_sender_name,
      v_preview,
      '💬',
      jsonb_build_object('userId', v_sender, 'screen', 'chat')
    );
  END IF;

  RETURN v_msg;
END;
$function$
;

-- Function: send_event_reminders
CREATE OR REPLACE FUNCTION public.send_event_reminders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ BEGIN INSERT INTO public.notifications (user_id, type, title, body, icon) SELECT t.user_id, 'event_reminder', 'Event Tomorrow', 'Your event ' || e.title || ' is tomorrow! Don''t forget your ticket.', 'ticket' FROM public.tickets t JOIN public.events e ON e.id = t.event_id WHERE e.start_date BETWEEN now() AND now() + interval '25 hours' AND e.start_date > now() + interval '23 hours' AND NOT EXISTS ( SELECT 1 FROM public.notifications n WHERE n.user_id = t.user_id AND n.type = 'event_reminder' AND n.created_at > now() - interval '24 hours' ); END; $function$
;

-- Function: set_default_bank_account_confirmed
CREATE OR REPLACE FUNCTION public.set_default_bank_account_confirmed(p_account_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  PERFORM public.assert_recent_auth();
  IF NOT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                 WHERE id = p_account_id AND organizer_id = v_uid AND is_active) THEN
    RAISE EXCEPTION 'Bank account not found';
  END IF;
  UPDATE public.organizer_bank_accounts SET is_default = false, updated_at = now()
  WHERE organizer_id = v_uid AND is_default AND id <> p_account_id;
  UPDATE public.organizer_bank_accounts SET is_default = true, updated_at = now()
  WHERE id = p_account_id;
END; $function$
;

-- Function: set_event_payout_account
CREATE OR REPLACE FUNCTION public.set_event_payout_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.payout_account_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      SELECT id INTO NEW.payout_account_id FROM public.organizer_bank_accounts
      WHERE organizer_id = NEW.organizer_id AND is_default AND is_active LIMIT 1;
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                   WHERE id = NEW.payout_account_id AND organizer_id = NEW.organizer_id AND is_active) THEN
      RAISE EXCEPTION 'payout_account_id must be one of your own active bank accounts';
    END IF;
  END IF;
  RETURN NEW;
END; $function$
;

-- Function: set_referral_pending_until
CREATE OR REPLACE FUNCTION public.set_referral_pending_until()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.pending_until := NEW.created_at + INTERVAL '14 days';
  RETURN NEW;
END;
$function$
;

-- Function: set_signup_role
CREATE OR REPLACE FUNCTION public.set_signup_role(p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_current_role text;
BEGIN
  v_id := auth.uid();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_role NOT IN ('organizer', 'attendee') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  SELECT role INTO v_current_role FROM public.users WHERE id = v_id;
  IF v_current_role = 'admin' THEN
    RAISE EXCEPTION 'Admin role cannot be changed';
  END IF;

  UPDATE public.users SET role = p_role WHERE id = v_id;
END;
$function$
;

-- Function: soft_delete_event
CREATE OR REPLACE FUNCTION public.soft_delete_event(p_event_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_owner   uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT organizer_id INTO v_owner FROM public.events WHERE id = p_event_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_owner <> v_user_id AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'You do not have permission to delete this event';
  END IF;

  UPDATE public.events
     SET deleted_at = now(),
         deleted_by = v_user_id,
         reason = p_reason,
         status = 'draft'
   WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (v_user_id, 'delete_event',
          jsonb_build_object('event_id', p_event_id, 'reason', p_reason),
          public.actor_role());
END;
$function$
;

-- Function: approve_admin_action
CREATE OR REPLACE FUNCTION public.approve_admin_action(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  CASE r.action_type
    WHEN 'organizer_verification_approve' THEN PERFORM public.admin_approve_organizer_verification((r.payload->>'request_id')::uuid);
    WHEN 'organizer_verification_reject'  THEN PERFORM public.admin_reject_organizer_verification((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'hide_event'             THEN PERFORM public.admin_hide_event(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_event'        THEN PERFORM public.admin_reinstate_event(r.target_id);
    WHEN 'soft_delete_event'      THEN PERFORM public.soft_delete_event(r.target_id, r.payload->>'reason');
    WHEN 'restore_deleted_event'  THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    WHEN 'set_user_role'          THEN PERFORM public.admin_set_user_role(r.target_id, r.payload->>'new_role');
    WHEN 'suspend_user'           THEN PERFORM public.admin_suspend_user(r.target_id, NULLIF(r.payload->>'banned_until','')::timestamptz, r.payload->>'reason');
    WHEN 'unsuspend_user'         THEN PERFORM public.admin_unsuspend_user(r.target_id);
    WHEN 'soft_delete_user'       THEN PERFORM public.admin_soft_delete_user(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_user'         THEN PERFORM public.admin_reinstate_user(r.target_id);
    WHEN 'toggle_user_verified'   THEN PERFORM public.admin_toggle_user_verified(r.target_id, (r.payload->>'verified')::boolean, r.payload->>'reason');
    WHEN 'credit_vents_cents'     THEN PERFORM public.admin_credit_vents_cents(r.target_id, (r.payload->>'amount')::numeric, r.payload->>'reason');
    WHEN 'debit_vents_cents'      THEN PERFORM public.admin_debit_vents_cents(r.target_id, (r.payload->>'amount')::integer, r.payload->>'reason');
    WHEN 'approve_payout'         THEN PERFORM public.admin_mark_payout_processing((r.payload->>'request_id')::uuid, r.payload->>'paystack_reference', r.payload->>'transfer_code');
    WHEN 'reject_payout'          THEN PERFORM public.admin_reject_organizer_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'cancel_payout'          THEN PERFORM public.admin_cancel_processing_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    ELSE RAISE EXCEPTION 'No executor mapped for action_type: %', r.action_type;
  END CASE;

  UPDATE public.admin_action_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_approved', CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type, 'requested_by', r.requested_by,
                             'target_label', r.target_label, 'reviewer_ip', public.client_ip(),
                             'previous_values', r.previous_values, 'requested_changes', r.requested_changes),
          public.actor_role());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (r.requested_by, 'broadcast', 'Your request has been approved',
          format('Your request (%s) was approved and executed.', COALESCE(r.target_label, r.action_type)), false, '✅');

  RETURN to_jsonb(r);
END; $function$
;

-- Function: submit_organizer_review
CREATE OR REPLACE FUNCTION public.submit_organizer_review(p_organizer_id uuid, p_rating smallint, p_body text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_reviewer uuid := auth.uid();
  v_has_ticket boolean;
BEGIN
  IF v_reviewer IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_reviewer = p_organizer_id THEN RAISE EXCEPTION 'You cannot review yourself'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM tickets t
    JOIN events e ON e.id = t.event_id
    WHERE t.user_id = v_reviewer
      AND e.organizer_id = p_organizer_id
      AND t.status = 'active'
  ) INTO v_has_ticket;

  IF NOT v_has_ticket THEN
    RAISE EXCEPTION 'You must attend an event by this organizer before leaving a review';
  END IF;

  INSERT INTO organizer_reviews (organizer_id, reviewer_id, rating, body)
  VALUES (p_organizer_id, v_reviewer, p_rating, trim(p_body))
  ON CONFLICT (organizer_id, reviewer_id) DO UPDATE
    SET rating = EXCLUDED.rating, body = EXCLUDED.body, created_at = now();
END;
$function$
;

-- Function: submit_organizer_verification
CREATE OR REPLACE FUNCTION public.submit_organizer_verification(p_company_name text, p_cac_number text, p_business_address text, p_document_url text, p_owner_name text, p_registration_date date, p_business_email text, p_business_phone text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_user_id AND role = 'organizer') THEN
    RAISE EXCEPTION 'Only organizers can request brand verification';
  END IF;

  IF trim(coalesce(p_company_name, '')) = '' THEN RAISE EXCEPTION 'Business name is required'; END IF;
  IF trim(coalesce(p_cac_number, '')) = '' THEN RAISE EXCEPTION 'CAC number is required'; END IF;
  IF trim(coalesce(p_business_address, '')) = '' THEN RAISE EXCEPTION 'Business address is required'; END IF;
  IF trim(coalesce(p_owner_name, '')) = '' THEN RAISE EXCEPTION 'Owner name is required'; END IF;
  IF p_registration_date IS NULL OR p_registration_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'A valid registration date is required';
  END IF;
  IF trim(coalesce(p_business_email, '')) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'A valid business email is required';
  END IF;
  IF trim(coalesce(p_business_phone, '')) = '' THEN RAISE EXCEPTION 'Business phone is required'; END IF;
  IF trim(coalesce(p_document_url, '')) = '' THEN RAISE EXCEPTION 'A certificate document is required'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.organizer_verification_requests
    WHERE user_id = v_user_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'You already have a pending verification request';
  END IF;

  INSERT INTO public.organizer_verification_requests
    (user_id, company_name, cac_number, business_address, document_url,
     owner_name, registration_date, business_email, business_phone)
  VALUES (v_user_id, trim(p_company_name), trim(p_cac_number), trim(p_business_address), p_document_url,
          trim(p_owner_name), p_registration_date, lower(trim(p_business_email)), trim(p_business_phone))
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'You already have a pending verification request';
END; $function$
;

-- Function: toggle_message_reaction
CREATE OR REPLACE FUNCTION public.toggle_message_reaction(p_message_id uuid, p_emoji text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_deleted int;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.direct_messages
    WHERE id = p_message_id AND (sender_id = v_user OR recipient_id = v_user)
  ) THEN
    RAISE EXCEPTION 'Message not found';
  END IF;

  DELETE FROM public.message_reactions
  WHERE message_id = p_message_id AND user_id = v_user AND emoji = p_emoji;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted > 0 THEN
    RETURN false; -- removed
  END IF;

  INSERT INTO public.message_reactions (message_id, user_id, emoji)
  VALUES (p_message_id, v_user, p_emoji);
  RETURN true; -- added
END;
$function$
;

-- Function: trg_sync_vc_to_wallet
CREATE OR REPLACE FUNCTION public.trg_sync_vc_to_wallet()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.type IN ('earn', 'referral') AND NEW.status = 'active' THEN
    INSERT INTO public.vents_wallets (user_id, balance, updated_at)
    VALUES (NEW.user_id, NEW.amount, now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance    = vents_wallets.balance + NEW.amount,
          updated_at = now();
  ELSIF NEW.type = 'spend' AND NEW.status = 'active' THEN
    UPDATE public.vents_wallets
    SET balance    = GREATEST(0, balance - NEW.amount),
        updated_at = now()
    WHERE user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$function$
;

-- Function: unblock_user
CREATE OR REPLACE FUNCTION public.unblock_user(p_blocked_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  DELETE FROM public.blocked_users WHERE blocker_id = v_uid AND blocked_id = p_blocked_id;
END; $function$
;

-- Function: upsert_organizer_bank_account
CREATE OR REPLACE FUNCTION public.upsert_organizer_bank_account(p_bank_name text, p_bank_code text, p_account_number text, p_account_name text, p_recipient_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT public.is_email_verified() THEN
    RAISE EXCEPTION 'Please verify your email before adding a payout bank account';
  END IF;

  INSERT INTO public.organizer_bank_accounts
    (organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, updated_at)
  VALUES
    (v_organizer_id, p_bank_name, p_bank_code, p_account_number, p_account_name, p_recipient_code, now())
  ON CONFLICT (organizer_id) DO UPDATE
    SET bank_name = EXCLUDED.bank_name,
        bank_code = EXCLUDED.bank_code,
        account_number = EXCLUDED.account_number,
        account_name = EXCLUDED.account_name,
        recipient_code = EXCLUDED.recipient_code,
        updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$
;

-- Function: upsert_privacy_settings
CREATE OR REPLACE FUNCTION public.upsert_privacy_settings(p_profile_visible text DEFAULT 'everyone'::text, p_can_message text DEFAULT 'everyone'::text, p_show_in_search boolean DEFAULT true, p_show_attended_events boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.user_privacy_settings(user_id, profile_visible, can_message, show_in_search, show_attended_events)
  VALUES (auth.uid(), p_profile_visible, p_can_message, p_show_in_search, p_show_attended_events)
  ON CONFLICT (user_id) DO UPDATE SET
    profile_visible = EXCLUDED.profile_visible,
    can_message = EXCLUDED.can_message,
    show_in_search = EXCLUDED.show_in_search,
    show_attended_events = EXCLUDED.show_attended_events,
    updated_at = now();
END;
$function$
;

-- Function: validate_event_ticket_types
CREATE OR REPLACE FUNCTION public.validate_event_ticket_types()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_tt jsonb;
  v_price numeric;
  v_qty numeric;
BEGIN
  IF NEW.ticket_types IS NULL THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.ticket_types) <> 'array' THEN
    RAISE EXCEPTION 'ticket_types must be a JSON array';
  END IF;

  FOR v_tt IN SELECT * FROM jsonb_array_elements(NEW.ticket_types)
  LOOP
    IF NULLIF(trim(v_tt->>'name'), '') IS NULL THEN
      RAISE EXCEPTION 'Each ticket type must have a name';
    END IF;

    IF NOT (v_tt ? 'price') OR NULLIF(v_tt->>'price', '') IS NULL THEN
      RAISE EXCEPTION 'Ticket type "%" is missing a price', v_tt->>'name';
    END IF;

    BEGIN
      v_price := (v_tt->>'price')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Ticket type "%" has an invalid price', v_tt->>'name';
    END;

    IF v_price < 0 OR v_price > 100000000 THEN
      RAISE EXCEPTION 'Ticket type "%" price must be between 0 and 100,000,000', v_tt->>'name';
    END IF;

    IF v_tt ? 'quantity' AND NULLIF(v_tt->>'quantity', '') IS NOT NULL THEN
      BEGIN
        v_qty := (v_tt->>'quantity')::numeric;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Ticket type "%" has an invalid quantity', v_tt->>'name';
      END;

      IF v_qty <= 0 OR v_qty > 1000000 OR v_qty <> floor(v_qty) THEN
        RAISE EXCEPTION 'Ticket type "%" quantity must be a whole number between 1 and 1,000,000', v_tt->>'name';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$
;

-- Function: validate_events_input
CREATE OR REPLACE FUNCTION public.validate_events_input()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF length(NEW.title) < 1 OR length(NEW.title) > 200 THEN
    RAISE EXCEPTION 'Event title must be between 1 and 200 characters';
  END IF;
  IF NEW.description IS NOT NULL AND length(NEW.description) > 5000 THEN
    RAISE EXCEPTION 'Event description must be 5000 characters or fewer';
  END IF;
  IF length(NEW.location) < 1 OR length(NEW.location) > 200 THEN
    RAISE EXCEPTION 'Event location must be between 1 and 200 characters';
  END IF;
  IF NEW.image_url IS NOT NULL AND NEW.image_url <> '' AND NEW.image_url !~* '^https?://' THEN
    RAISE EXCEPTION 'image_url must be an http(s) URL';
  END IF;

  PERFORM public.reject_injection_patterns('title', NEW.title);
  PERFORM public.reject_injection_patterns('description', NEW.description);
  PERFORM public.reject_injection_patterns('location', NEW.location);

  RETURN NEW;
END;
$function$
;

-- Function: validate_promo_code
CREATE OR REPLACE FUNCTION public.validate_promo_code(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_promo public.promo_codes;
  v_key   text;
BEGIN
  -- Callable anonymously (no auth.uid() check in this function), so a
  -- scripted code-guessing loop can't be keyed on a user id -- fall back
  -- to auth.uid() when logged in (tighter, per-account) and the observed
  -- client IP otherwise.
  v_key := COALESCE(auth.uid()::text, public.client_ip());
  PERFORM public.check_rate_limit('promo_check:' || v_key, 15, 60);

  IF p_code IS NULL OR trim(p_code) = '' THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'Enter a promo code.');
  END IF;

  SELECT * INTO v_promo FROM public.promo_codes WHERE upper(code) = upper(trim(p_code));

  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'Invalid promo code.');
  END IF;

  IF NOT v_promo.is_active THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'This promo code is no longer active.');
  END IF;

  IF v_promo.expires_at IS NOT NULL AND v_promo.expires_at < now() THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'This promo code has expired.');
  END IF;

  IF v_promo.max_uses IS NOT NULL AND v_promo.current_uses >= v_promo.max_uses THEN
    RETURN jsonb_build_object('valid', false, 'reason', 'This promo code has reached its usage limit.');
  END IF;

  RETURN jsonb_build_object('valid', true, 'discount_percentage', v_promo.discount_percentage);
END;
$function$
;

-- Function: validate_users_input
CREATE OR REPLACE FUNCTION public.validate_users_input()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.full_name IS NOT NULL AND length(NEW.full_name) > 100 THEN
    RAISE EXCEPTION 'Full name must be 100 characters or fewer';
  END IF;
  IF NEW.bio IS NOT NULL AND length(NEW.bio) > 500 THEN
    RAISE EXCEPTION 'Bio must be 500 characters or fewer';
  END IF;

  PERFORM public.reject_injection_patterns('full_name', NEW.full_name);
  PERFORM public.reject_injection_patterns('bio', NEW.bio);

  RETURN NEW;
END;
$function$
;

-- Function: verify_entry_pass
CREATE OR REPLACE FUNCTION public.verify_entry_pass(p_ticket_id text, p_actor_id uuid, p_device_id text DEFAULT NULL::text, p_gate_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_secret       text;
  v_seg1         text;
  v_seg2         text;
  v_expected_sig text;
  v_payload      jsonb;
  v_raw_id       text;
  v_ticket       record;
  v_log_event_id uuid;
  v_reason       text;
  v_message      text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_actor_id THEN
    RAISE EXCEPTION 'Not authorized to scan as this user';
  END IF;

  IF (SELECT disable_scanning FROM public.app_config LIMIT 1) THEN
    RAISE EXCEPTION 'scanning_disabled';
  END IF;

  PERFORM public.check_rate_limit('qr_scan:' || p_actor_id::text, 30, 10);

  IF p_ticket_id IS NULL OR strpos(p_ticket_id, '.') = 0 THEN
    v_reason := 'unsigned_ticket';
    v_message := 'This ticket is missing its cryptographic signature and cannot be accepted. Ask the attendee to reopen their ticket (online) and rescan.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  v_seg1 := split_part(p_ticket_id, '.', 1);
  v_seg2 := split_part(p_ticket_id, '.', 2);

  IF v_seg1 ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    v_reason := 'legacy_token';
    v_message := 'This pass uses an outdated format. Ask the attendee to reopen their ticket (online) to refresh it, then rescan.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  SELECT value INTO v_secret FROM private.app_secrets WHERE key = 'ticket_hmac_v2';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'Ticket verification secret is not configured';
  END IF;

  v_expected_sig := encode(public.hmac(v_seg1, v_secret, 'sha256'), 'hex');
  IF v_seg2 IS DISTINCT FROM v_expected_sig THEN
    v_reason := 'invalid_signature';
    v_message := 'This QR code failed cryptographic verification.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  BEGIN
    v_payload := convert_from(
      decode(translate(v_seg1, '-_', '+/') || repeat('=', (4 - length(v_seg1) % 4) % 4), 'base64'),
      'UTF8'
    )::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_reason := 'invalid_token';
    v_message := 'This QR code could not be read.';
    PERFORM public.log_scan_attempt(NULL, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END;

  -- From here on the payload is readable, so its eventId (unverified against
  -- the ticket yet, but still the attendee's claimed event) lets us attribute
  -- the log entry to the right event's dashboard even when the check below
  -- fails before a ticket row is loaded.
  BEGIN
    v_log_event_id := (v_payload->>'eventId')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_log_event_id := NULL;
  END;

  IF (v_payload->>'version') IS DISTINCT FROM '2' THEN
    v_reason := 'invalid_token';
    v_message := 'Unsupported ticket version.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF (v_payload->>'expiresAt') IS NULL
     OR (v_payload->>'expiresAt')::timestamptz < now() THEN
    v_reason := 'expired';
    v_message := 'This ticket pass has expired.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  v_raw_id := v_payload->>'ticketId';

  SELECT t.id, t.event_id, t.user_id, t.status, t.ticket_type,
         t.checked_in, t.checked_in_at, t.scanner_id,
         e.organizer_id, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id::text = v_raw_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    v_reason := 'not_found';
    v_message := 'Ticket not found in system.';
    PERFORM public.log_scan_attempt(v_log_event_id, NULL, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  -- Now that the real ticket is loaded, prefer its authoritative event_id for
  -- logging over the unverified payload claim.
  v_log_event_id := v_ticket.event_id;

  IF (v_payload->>'eventId') IS DISTINCT FROM v_ticket.event_id::text
     OR (v_payload->>'purchaserId') IS DISTINCT FROM v_ticket.user_id::text THEN
    v_reason := 'payload_mismatch';
    v_message := 'This ticket pass does not match its event record.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'invalid', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.organizer_id IS DISTINCT FROM p_actor_id
     AND NOT public.is_admin()
     AND p_actor_id <> 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832'::uuid THEN
    v_reason := 'wrong_organizer';
    v_message := 'This ticket belongs to a different organizer''s event.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'wrong_event', v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.status <> 'active' THEN
    v_reason := 'not_active';
    v_message := 'This ticket is ' || v_ticket.status || ', not active.';
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id,
      public.scan_reason_to_result(v_reason, v_message), v_reason, v_message, p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'message', v_message);
  END IF;

  IF v_ticket.checked_in THEN
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already scanned.', p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'checked_in_at', v_ticket.checked_in_at, 'scanner_id', v_ticket.scanner_id,
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  -- ATOMIC check-in: the tickets flag, the ledger row, and the scan log all
  -- commit together in this one SECURITY DEFINER call's transaction. The
  -- `WHERE checked_in = false` re-check + ON CONFLICT DO NOTHING below is what
  -- actually makes a race between two simultaneous scans of the same ticket
  -- safe -- the FOR UPDATE row lock above already serializes concurrent
  -- scanners against this same ticket row, so only one commits the flip.
  UPDATE public.tickets
     SET checked_in = true, checked_in_at = now(), scanner_id = p_actor_id
   WHERE id = v_ticket.id AND checked_in = false;

  IF NOT FOUND THEN
    PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'duplicate', 'already_scanned',
      'This ticket was already scanned.', p_device_id, p_gate_name, false);
    RETURN jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This ticket was already scanned.',
      'stats', public.door_stats(v_ticket.event_id));
  END IF;

  INSERT INTO public.checkins
    (ticket_id, event_id, user_id, scanned_by, checked_in_at, device_id, gate_name, is_manual_override)
  VALUES
    (v_ticket.id, v_ticket.event_id, v_ticket.user_id, p_actor_id, now(), p_device_id, p_gate_name, false)
  ON CONFLICT (ticket_id) DO NOTHING;

  PERFORM public.log_scan_attempt(v_log_event_id, v_ticket.id, p_actor_id, 'valid', NULL, NULL, p_device_id, p_gate_name, false);

  RETURN jsonb_build_object(
    'ok', true,
    'holder_name', COALESCE((SELECT full_name FROM public.users WHERE id = v_ticket.user_id), 'Verified Attendee'),
    'ticket_type', v_ticket.ticket_type,
    'event_title', v_ticket.event_title,
    'checked_in_at', now(),
    'is_manual_override', false,
    'stats', public.door_stats(v_ticket.event_id)
  );
END;
$function$
;

-- Function: whoami_admin
CREATE OR REPLACE FUNCTION public.whoami_admin()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT jsonb_build_object(
    'uid',            auth.uid(),
    'role',           (SELECT role FROM public.users WHERE id = auth.uid()),
    'is_root',        public.is_root(),
    'is_admin',       public.is_admin(),
    'is_super_admin', public.is_super_admin()
  );
$function$
;
