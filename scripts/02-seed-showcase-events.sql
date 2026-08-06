-- ─────────────────────────────────────────────────────────────────────────
-- Seeds 8 realistic, high-quality events so the feed looks vibrant for
-- Play Store reviewers and early users — not a schema migration, run
-- manually (see note in 01-cleanup-junk-events.sql).
-- ─────────────────────────────────────────────────────────────────────────
-- PREREQUISITE: run scripts/03-reviewer-test-account.sql FIRST (or supply
-- any other real organizer_id below) — this script attaches all seed
-- events to that organizer so the reviewer's own account has a populated
-- "My Events" tab, not just a populated public feed.
--
-- Dates are set relative to today via `now()` so this script stays valid
-- whenever it's actually run, rather than hardcoding dates that go stale.
-- Image URLs are Unsplash CDN links, picked for category relevance — spot
-- check that each still resolves before relying on this for an actual
-- review submission, and swap in your own real event photography once
-- you have it. Hotlinking a third party's CDN indefinitely for your core
-- app content is fine for a launch-day seed but isn't something to leave
-- in place long-term.

DO $$
DECLARE
  v_organizer_id uuid;
BEGIN
  SELECT id INTO v_organizer_id
  FROM public.users
  WHERE username = 'testerboy';

  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'No user found with username ''testerboy''. Run scripts/03-reviewer-test-account.sql first, or replace v_organizer_id below with any real organizer''s id.';
  END IF;

  INSERT INTO public.events (
    organizer_id, title, description, category, location, event_date,
    start_time, end_time, price, ticket_types, ticket_goal, status,
    is_featured, image_url, is_18_plus
  ) VALUES
  (
    v_organizer_id,
    'Lagos Live: Afrobeats Night',
    'An electric night of live Afrobeats featuring some of Lagos'' rising stars, full band, and a dance floor that doesn''t quit. Doors open early — arrive by 9pm to catch the opening set.',
    'Music',
    'Muri Okunola Park, Victoria Island, Lagos',
    (now() + interval '18 days')::date + interval '20 hours',
    '20:00', '02:00',
    5000,
    '[
      {"id":"regular","name":"Regular","price":5000,"description":"General admission","available":300},
      {"id":"vip","name":"VIP","price":15000,"description":"Front-of-stage access + free drink","available":60}
    ]'::jsonb,
    500, 'live', true,
    'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=1200&q=80',
    false
  ),
  (
    v_organizer_id,
    'Abuja Tech Summit 2026',
    'A full day of talks and workshops on AI, fintech, and building for the Nigerian market — with founders from Paystack, Flutterwave, and Andela sharing what actually worked. Includes lunch and a networking session.',
    'Technology',
    'Transcorp Hilton, Abuja',
    (now() + interval '32 days')::date + interval '9 hours',
    '09:00', '17:00',
    10000,
    '[
      {"id":"standard","name":"Standard","price":10000,"description":"Full-day access, lunch included","available":400},
      {"id":"student","name":"Student","price":3000,"description":"Valid student ID required at check-in","available":100}
    ]'::jsonb,
    500, 'live', true,
    'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=1200&q=80',
    false
  ),
  (
    v_organizer_id,
    'Taste of Lagos: Street Food Festival',
    'Over 40 vendors serving the best of Nigerian street food — suya, small chops, jollof from five different states arguing over whose is best. Live DJ, kids'' zone, free entry.',
    'Food & Drinks',
    'Landmark Beach, Victoria Island, Lagos',
    (now() + interval '11 days')::date + interval '12 hours',
    '12:00', '21:00',
    0,
    '[
      {"id":"free","name":"Free Entry","price":0,"description":"Food and drinks purchased separately from vendors","available":2000}
    ]'::jsonb,
    2000, 'live', true,
    'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=1200&q=80',
    false
  ),
  (
    v_organizer_id,
    'Naija Comedy Slam',
    'Four of Nigeria''s sharpest stand-up comedians, one stage, zero mercy. Hosted by a surprise MC. 18+ due to language.',
    'Comedy Shows',
    'Terra Kulture, Victoria Island, Lagos',
    (now() + interval '9 days')::date + interval '19 hours 30 minutes',
    '19:30', '22:30',
    7500,
    '[
      {"id":"regular","name":"Regular","price":7500,"description":"General seating","available":200},
      {"id":"front-row","name":"Front Row","price":18000,"description":"First 3 rows, meet-and-greet after the show","available":30}
    ]'::jsonb,
    250, 'live', false,
    'https://images.unsplash.com/photo-1541224468614-9ae2e5a29ae6?w=1200&q=80',
    true
  ),
  (
    v_organizer_id,
    'Contemporary Nigerian Art Exhibition',
    'A curated showcase of contemporary work from ten emerging Nigerian artists — painting, sculpture, and mixed media. Opening night includes a guided walkthrough with the curator.',
    'Arts & Culture',
    'Nike Art Gallery, Lekki, Lagos',
    (now() + interval '25 days')::date + interval '11 hours',
    '11:00', '18:00',
    2000,
    '[
      {"id":"general","name":"General Admission","price":2000,"description":"Access for the full day","available":150}
    ]'::jsonb,
    150, 'live', false,
    'https://images.unsplash.com/photo-1531913764164-f85c52e6e654?w=1200&q=80',
    false
  ),
  (
    v_organizer_id,
    'Lagos 5-a-Side Football Championship',
    'A weekend-long 5-a-side tournament open to teams across Lagos — cash prize for the winning squad, food vendors on site, spectators welcome free of charge.',
    'Sports & Wellness',
    'Teslim Balogun Stadium, Surulere, Lagos',
    (now() + interval '40 days')::date + interval '8 hours',
    '08:00', '18:00',
    1000,
    '[
      {"id":"spectator","name":"Spectator Pass","price":1000,"description":"Weekend spectator access","available":800},
      {"id":"team","name":"Team Entry","price":25000,"description":"Registers one 5-a-side team (up to 8 players)","available":32}
    ]'::jsonb,
    800, 'live', false,
    'https://images.unsplash.com/photo-1489944440615-453fc2b6a9a9?w=1200&q=80',
    false
  ),
  (
    v_organizer_id,
    'Founders & Funders: Lagos Pitch Night',
    'Six early-stage Nigerian startups pitch to a panel of active investors, live. Open networking before and after — bring business cards.',
    'Business & Finance',
    'The Zone Tech Park, Gbagada, Lagos',
    (now() + interval '21 days')::date + interval '17 hours',
    '17:00', '20:00',
    5000,
    '[
      {"id":"attendee","name":"Attendee","price":5000,"description":"Includes the networking reception","available":180}
    ]'::jsonb,
    180, 'live', false,
    'https://images.unsplash.com/photo-1560439514-4e9645039924?w=1200&q=80',
    false
  ),
  (
    v_organizer_id,
    'Detty December Countdown Party',
    'The city''s biggest countdown party — three DJs, a live saxophonist, and a midnight fireworks display over the water. Early bird pricing ends soon.',
    'Nightlife',
    'Bay Lounge, Lekki Phase 1, Lagos',
    (now() + interval '55 days')::date + interval '21 hours',
    '21:00', '04:00',
    8000,
    '[
      {"id":"early-bird","name":"Early Bird","price":8000,"description":"Limited quantity, price rises closer to the date","available":150},
      {"id":"regular","name":"Regular","price":12000,"description":"General admission","available":350},
      {"id":"table","name":"VIP Table (4 seats)","price":80000,"description":"Reserved table, bottle service","available":15}
    ]'::jsonb,
    515, 'live', true,
    'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=1200&q=80',
    true
  );
END $$;
