-- ─────────────────────────────────────────────────────────────────────────
-- Google Play reviewer test account — promotion + demo data.
-- Not a schema migration, run manually (see note in
-- 01-cleanup-junk-events.sql).
-- ─────────────────────────────────────────────────────────────────────────
--
-- PREREQUISITE — do this first, outside SQL:
-- Sign up for a real VENTS account through the app itself, normally, using
-- the email below (or your own choice — just update it here to match).
-- This is not optional: auth.users is InsForge's own auth table with
-- proper password hashing and email verification. There's no safe way to
-- fabricate a working login via raw SQL — any script that tried would
-- either produce a login that doesn't actually work, or require storing a
-- real password insecurely. Sign up through the app, verify the email,
-- then run this script to turn that ordinary account into a fully-stocked
-- organizer profile for review purposes.
--
-- Suggested email: playstore-reviewer@getvents.com
-- (Google's own guidance: use an email/account you control long-term —
-- reviewers may return to re-test after the initial submission.)

DO $$
DECLARE
  v_user_id uuid;
  v_event_id uuid;
  v_ticket_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'playstore-reviewer@getvents.com';
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No signed-up user found for playstore-reviewer@getvents.com — sign up through the app first, THEN run this script.';
  END IF;

  -- ── Promote to organizer + verified badge ────────────────────────────
  -- is_verified is the CAC/business-document "verified organizer" badge —
  -- setting it directly here for the reviewer account skips the real
  -- document-upload flow, which is correct: this account represents what
  -- an already-approved organizer's experience looks like, not a test of
  -- the approval flow itself.
  UPDATE public.users
  SET role = 'organizer',
      full_name = 'VENTS Reviewer',
      username = 'vents_reviewer',
      is_verified = true,
      bio = 'Official Play Store review account.'
  WHERE id = v_user_id;

  -- ── Give it a wallet with a real-looking balance ─────────────────────
  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo, pending_kobo)
  VALUES (v_user_id, 4550000, 5000000, 0)
  ON CONFLICT (organizer_id) DO UPDATE
    SET balance_kobo = EXCLUDED.balance_kobo,
        total_earned_kobo = EXCLUDED.total_earned_kobo,
        pending_kobo = EXCLUDED.pending_kobo;

  -- ── One event this account organizes (in addition to whatever
  -- scripts/02-seed-showcase-events.sql already attached to it) ────────
  INSERT INTO public.events (
    organizer_id, title, description, category, location, event_date,
    start_time, end_time, price, ticket_types, ticket_goal, status,
    is_featured, image_url, cover_url
  ) VALUES (
    v_user_id,
    'VENTS Reviewer Demo Event',
    'A sample event used to demonstrate the organizer experience — ticket sales, check-in, and payouts.',
    'Conferences',
    'Eko Convention Centre, Victoria Island, Lagos',
    (now() + interval '30 days')::date + interval '10 hours',
    '10:00', '16:00',
    2000,
    -- Free tier included on purpose — see the note at the bottom of this
    -- file on why a $0 ticket, not a payment bypass, is how a reviewer
    -- should be able to complete checkout end-to-end.
    '[
      {"id":"standard","name":"Standard","price":2000,"description":"General admission","available":100},
      {"id":"free","name":"Reviewer Access","price":0,"description":"Complimentary access for testing/review","available":50}
    ]'::jsonb,
    100, 'live', false,
    'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=1200&q=80',
    'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?w=1600&q=80'
  )
  RETURNING id INTO v_event_id;

  -- ── A dummy PAID ticket + matching wallet transaction, so "My Tickets"
  -- and "Transaction History" both have real-looking content instead of
  -- empty states ────────────────────────────────────────────────────────
  INSERT INTO public.tickets (
    event_id, user_id, quantity, status, payment_status, amount,
    ticket_type, payment_ref, holder_name, holder_email, created_at
  ) VALUES (
    v_event_id, v_user_id, 1, 'active', 'paid', 2000,
    'Standard', 'DEMO-REVIEWER-0001', 'VENTS Reviewer',
    'playstore-reviewer@getvents.com', now() - interval '3 days'
  )
  RETURNING id INTO v_ticket_id;

  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description, ticket_sale_id)
  VALUES (v_user_id, 'credit', 210000, 'Ticket sale: Standard x1 (demo)', v_ticket_id);

  -- ── A demo notification so the bell icon isn't empty on first open ───
  PERFORM public.notify_user(
    v_user_id, 'booking', 'Ticket confirmed! 🎉',
    'Your Standard ticket for VENTS Reviewer Demo Event is confirmed.', '🎟️'
  );
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- On payment bypasses — deliberately NOT implemented, here's why:
-- ─────────────────────────────────────────────────────────────────────────
-- The original ask included "bypass or sandbox flags so this test account
-- can complete checkouts without failing real payment gateway checks."
-- That's not something to build as a code-level special case, and it isn't
-- necessary here:
--
-- 1. confirm_ticket_payment (the RPC that marks a ticket paid and credits
--    the organizer wallet) was ALREADY hardened this session against
--    exactly this class of bug — it used to be reachable by any
--    authenticated client with a self-chosen reference/amount before
--    being locked to project_admin-only, callable exclusively from the
--    Paystack webhook. Carving out a hardcoded exception for one user id
--    inside that function re-opens the same hole for anyone who discovers
--    or leaks that account's credentials — free tickets and fake
--    withdrawable wallet balance, indistinguishable from the fraud path
--    that lockdown migration closed.
-- 2. It's also unnecessary. Two standard, safe ways for a reviewer to
--    complete a purchase end-to-end without a bypass:
--      a) A $0 ticket tier (added above, "Reviewer Access") — the normal
--         checkout code path for a free ticket never touches Paystack at
--         all (see CheckoutScreen.tsx / paystack.ts), so there's nothing
--         to fail.
--      b) Paystack's own TEST MODE — swap VITE_PAYSTACK_PUBLIC_KEY for a
--         pk_test_ key on a preview/staging deploy (never production) and
--         use Paystack's published test card numbers. This exercises the
--         REAL payment code path, which is a better review/QA signal than
--         a bypass that skips it.
-- If Play Store's own review process specifically asks for reviewer
-- login credentials (Play Console → App content → App access), give them
-- this account's email/password directly — that's the intended mechanism,
-- not a payment bypass.

