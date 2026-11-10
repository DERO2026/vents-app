-- Production end-to-end check of 0211 (and 0212). Everything below runs in ONE
-- statement that ends by RAISING an exception, so Postgres rolls back every
-- row it wrote (test users, wallets, PINs, requests, approvals, queued pg_net
-- pushes). Only test accounts (uuid ...e2xx, @example.invalid) are touched;
-- no real request, wallet or ledger row is read for writing, and Paystack is
-- never called (claim/complete/fail are database functions only).
DO $e2e$
DECLARE
  ORG   constant uuid := '00000000-0000-4000-8000-00000000e201';
  ADM   constant uuid := '00000000-0000-4000-8000-00000000e202';
  SUB   constant uuid := '00000000-0000-4000-8000-00000000e203';
  SUB2  constant uuid := '00000000-0000-4000-8000-00000000e204';
  PLAIN constant uuid := '00000000-0000-4000-8000-00000000e205';
  ADM2  constant uuid := '00000000-0000-4000-8000-00000000e206';
  OADM  constant uuid := '00000000-0000-4000-8000-00000000e207';
  BANK  constant uuid := '00000000-0000-4000-8000-00000000d201';
  BANK2 constant uuid := '00000000-0000-4000-8000-00000000d205';
  BANKO constant uuid := '00000000-0000-4000-8000-00000000d207';
  pw jsonb := jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch FROM now())::bigint));
  pw_old jsonb := jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch FROM now())::bigint - 3600));
  otp jsonb := jsonb_build_array(jsonb_build_object('method','otp','timestamp',extract(epoch FROM now())::bigint));
  W1 uuid; W2 uuid; W3 uuid; W5 uuid; W6 uuid; ref text; v text; report text; npass int; nfail int; i int;
  real_before text; real_after text;
BEGIN
  IF current_database() <> 'postgres' THEN RAISE EXCEPTION 'unexpected database'; END IF;

  CREATE TEMP TABLE e2e_res (n serial, name text, got text, exp text, ok boolean) ON COMMIT DROP;

  -- q(): run one statement as a signed-in user (role authenticated, JWT claims set).
  CREATE FUNCTION pg_temp.q(p_uid uuid, p_sql text, p_amr jsonb DEFAULT NULL, p_role text DEFAULT 'authenticated')
  RETURNS text LANGUAGE plpgsql AS $f$
  DECLARE v text;
  BEGIN
    PERFORM set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object(
      'sub', p_uid, 'role', p_role, 'aud', 'authenticated', 'amr', p_amr,
      'iat', extract(epoch FROM now())::bigint))::text, true);
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', p_role);
      EXECUTE p_sql INTO v;
      RESET ROLE;
      RETURN COALESCE(v, '<null>');
    EXCEPTION WHEN others THEN
      RESET ROLE;
      RETURN 'ERR:' || SQLERRM;
    END;
  END $f$;
  CREATE FUNCTION pg_temp.chk(p_name text, p_got text, p_exp text) RETURNS void LANGUAGE sql AS
    $f$ INSERT INTO e2e_res(name, got, exp, ok) VALUES (p_name, p_got, p_exp, p_got = p_exp) $f$;
  CREATE FUNCTION pg_temp.chk_like(p_name text, p_got text, p_pat text) RETURNS void LANGUAGE sql AS
    $f$ INSERT INTO e2e_res(name, got, exp, ok) VALUES (p_name, p_got, '~ ' || p_pat, p_got LIKE p_pat) $f$;
  CREATE FUNCTION pg_temp.wallet(p uuid) RETURNS text LANGUAGE sql AS
    $f$ SELECT balance_kobo || '/' || pending_kobo FROM public.organizer_wallets WHERE organizer_id = p $f$;
  CREATE FUNCTION pg_temp.wd(p uuid, amt bigint, bank uuid, pin text, k text) RETURNS text LANGUAGE sql AS
    $f$ SELECT pg_temp.q(p, format('SELECT COALESCE(r->>''code'', ''ok'') FROM (SELECT public.request_withdrawal(%s, %L, %L, %L) r) s', amt, bank, pin, k)) $f$;
  CREATE FUNCTION pg_temp.wd_id(p uuid, amt bigint, bank uuid, pin text, k text) RETURNS uuid LANGUAGE sql AS
    $f$ SELECT NULLIF(pg_temp.q(p, format('SELECT public.request_withdrawal(%s, %L, %L, %L)->>''request_id''', amt, bank, pin, k)), '<null>')::uuid $f$;
  CREATE FUNCTION pg_temp.stage(p uuid, w uuid) RETURNS text LANGUAGE sql AS
    $f$ SELECT pg_temp.q(p, format('SELECT stage FROM public.admin_list_withdrawals(''all'', 500) WHERE request_id = %L', w)) $f$;
  CREATE FUNCTION pg_temp.mystage(p uuid, w uuid) RETURNS text LANGUAGE sql AS
    $f$ SELECT pg_temp.q(p, format('SELECT stage FROM public.get_my_withdrawals() WHERE request_id = %L', w)) $f$;

  -- Fingerprint of every REAL withdrawal / approval / wallet row: must be identical at the end.
  real_before := (SELECT md5(string_agg(t::text, '|' ORDER BY id)) FROM public.organizer_withdrawal_requests t)
    || (SELECT md5(string_agg(t::text, '|' ORDER BY id)) FROM public.admin_action_requests t)
    || (SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM public.organizer_wallets t);

  -- ---------------- test accounts (rolled back) ----------------
  INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  SELECT u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
         'e2e-' || right(u::text, 4) || '@example.invalid', now(),
         jsonb_build_object('full_name', 'E2E ' || right(u::text, 4)), '{"provider":"email"}'::jsonb, now(), now()
    FROM unnest(ARRAY[ORG, ADM, SUB, SUB2, PLAIN, ADM2, OADM]) u;
  UPDATE public.users SET role = 'admin' WHERE id IN (ADM, ADM2, OADM);
  UPDATE public.users SET role = 'sub-admin' WHERE id IN (SUB, SUB2);
  UPDATE public.users SET is_organizer = true WHERE id IN (ORG, OADM);
  INSERT INTO public.organizer_bank_accounts (id, organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_active, is_default) VALUES
    (BANK, ORG, 'Test Bank', '000', '0000006789', 'E2E ORGANIZER', 'RCP_e2e_org', true, true),
    (BANK2, PLAIN, 'Test Bank', '000', '0000001111', 'E2E PLAIN', 'RCP_e2e_plain', true, true),
    (BANKO, OADM, 'Test Bank', '000', '0000002222', 'E2E ADMIN EARNER', 'RCP_e2e_oadm', true, true);
  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, pending_kobo, total_earned_kobo, on_hold_kobo)
  VALUES (ORG, 10000000, 0, 10000000, 0), (OADM, 2000000, 0, 2000000, 0)
  ON CONFLICT (organizer_id) DO UPDATE SET balance_kobo = EXCLUDED.balance_kobo, pending_kobo = 0, total_earned_kobo = EXCLUDED.total_earned_kobo, on_hold_kobo = 0;
  INSERT INTO public.organizer_transactions (organizer_id, type, amount_kobo, description)
  VALUES (ORG, 'credit', 10000000, 'e2e test credit'), (OADM, 'credit', 2000000, 'e2e test credit');

  PERFORM pg_temp.chk('payouts kill switch is off', public.payouts_disabled()::text, 'false');

  -- ---------------- 1. old paths closed ----------------
  -- Since 0212 the old entry point only tells old app builds to update.
  PERFORM pg_temp.chk_like('old app call: told to update the app, not "permission denied"',
    pg_temp.q(ORG, format('SELECT public.request_organizer_payout(500000, %L, %L)::text', BANK, 'bypass')), 'ERR:Please update VENTS to withdraw.%getvents.com.');
  PERFORM pg_temp.chk('...and it created no withdrawal and moved no money',
    (SELECT count(*)::text FROM public.organizer_withdrawal_requests WHERE organizer_id = ORG) || '/' || pg_temp.wallet(ORG), '0/10000000/0');
  PERFORM pg_temp.chk_like('clients cannot call the real function (request_organizer_payout_core)',
    pg_temp.q(ORG, format('SELECT public.request_organizer_payout_core(500000, %L, %L)::text', BANK, 'bypass')), 'ERR:permission denied for function request_organizer_payout_core%');
  PERFORM pg_temp.chk_like('anon cannot call request_withdrawal',
    pg_temp.q(NULL, format('SELECT public.request_withdrawal(500000, %L, %L, %L)::text', BANK, '7391', 'anon'), NULL, 'anon'), 'ERR:permission denied%');
  PERFORM pg_temp.chk_like('clients cannot insert withdrawal rows directly',
    pg_temp.q(ORG, format('INSERT INTO public.organizer_withdrawal_requests (organizer_id, amount_kobo, bank_account_id, status) VALUES (%L, 500000, %L, ''pending'') RETURNING id::text', ORG, BANK)), 'ERR:permission denied%');

  -- ---------------- 2. PIN create ----------------
  PERFORM pg_temp.chk('new user has no PIN', pg_temp.q(ORG, 'SELECT public.get_my_withdrawal_pin_status()->>''has_pin'''), 'false');
  PERFORM pg_temp.chk('withdrawing without a PIN is refused', pg_temp.wd(ORG, 500000, BANK, '1111', 'k0'), 'pin_not_set');
  PERFORM pg_temp.chk_like('PIN must be 4 digits', pg_temp.q(ORG, 'SELECT public.set_my_withdrawal_pin(''739'', ''739'')::text'), 'ERR:%exactly 4 digits%');
  PERFORM pg_temp.chk_like('PIN confirmation must match', pg_temp.q(ORG, 'SELECT public.set_my_withdrawal_pin(''7391'', ''7392'')::text'), 'ERR:%do not match%');
  PERFORM pg_temp.chk_like('weak PIN 1234 refused', pg_temp.q(ORG, 'SELECT public.set_my_withdrawal_pin(''1234'', ''1234'')::text'), 'ERR:%too easy to guess%');
  PERFORM pg_temp.chk_like('weak PIN 1111 refused', pg_temp.q(ORG, 'SELECT public.set_my_withdrawal_pin(''1111'', ''1111'')::text'), 'ERR:%too easy to guess%');
  PERFORM pg_temp.chk('PIN created', pg_temp.q(ORG, 'SELECT public.set_my_withdrawal_pin(''7391'', ''7391'')->>''has_pin'''), 'true');
  PERFORM pg_temp.chk_like('second create refused (change needs password)', pg_temp.q(ORG, 'SELECT public.set_my_withdrawal_pin(''5820'', ''5820'')::text'), 'ERR:%already have a withdrawal PIN%');
  PERFORM pg_temp.chk('stored as bcrypt cost 10, PIN not in hash',
    (SELECT (pin_hash LIKE '$2a$10$%' AND position('7391' IN pin_hash) = 0 AND length(pin_hash) = 60)::text FROM public.withdrawal_pins WHERE user_id = ORG), 'true');
  PERFORM pg_temp.chk_like('clients cannot read the PIN table', pg_temp.q(ORG, 'SELECT pin_hash FROM public.withdrawal_pins LIMIT 1'), 'ERR:permission denied%');
  PERFORM pg_temp.chk_like('clients cannot call the internal PIN check', pg_temp.q(ORG, format('SELECT public.withdrawal_pin_check(%L, ''7391'')::text', ORG)), 'ERR:permission denied%');
  PERFORM pg_temp.chk('PIN status never contains the PIN or hash',
    pg_temp.q(ORG, 'SELECT (position(''7391'' IN public.get_my_withdrawal_pin_status()::text) = 0 AND position(''$2a$'' IN public.get_my_withdrawal_pin_status()::text) = 0)::text'), 'true');
  PERFORM pg_temp.chk('"Withdrawal PIN created" notification', (SELECT count(*)::text FROM public.notifications WHERE user_id = ORG AND title = 'Withdrawal PIN created'), '1');

  -- ---------------- 3. wrong PIN, lock, reset required ----------------
  PERFORM pg_temp.chk('wrong PIN: 4 attempts left', pg_temp.q(ORG, format('SELECT public.request_withdrawal(500000, %L, ''0007'', ''w1'')->>''attempts_left''', BANK)), '4');
  PERFORM pg_temp.chk('wrong PIN moved no money and created no request',
    (SELECT count(*)::text FROM public.organizer_withdrawal_requests WHERE organizer_id = ORG) || '/' || pg_temp.wallet(ORG), '0/10000000/0');
  FOR i IN 2..4 LOOP PERFORM pg_temp.wd(ORG, 500000, BANK, '0007', 'w' || i); END LOOP;
  PERFORM pg_temp.chk('5th wrong PIN locks', pg_temp.wd(ORG, 500000, BANK, '0007', 'w5'), 'pin_locked');
  PERFORM pg_temp.chk('while locked the correct PIN is refused', pg_temp.wd(ORG, 500000, BANK, '7391', 'w6'), 'pin_locked');
  PERFORM pg_temp.chk('lock lasts 30 minutes',
    (SELECT (locked_until BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes')::text FROM public.withdrawal_pins WHERE user_id = ORG), 'true');
  FOR i IN 2..3 LOOP
    UPDATE public.withdrawal_pins SET locked_until = now() - interval '1 second' WHERE user_id = ORG;
    PERFORM pg_temp.wd(ORG, 500000, BANK, '0007', 'l' || i || x) FROM generate_series(1, 5) x;
  END LOOP;
  PERFORM pg_temp.chk('3rd lock in a row requires a reset', pg_temp.wd(ORG, 500000, BANK, '7391', 'w7'), 'pin_reset_required');
  PERFORM pg_temp.chk('"Withdrawal PIN locked" notification', (SELECT (count(*) >= 1)::text FROM public.notifications WHERE user_id = ORG AND title = 'Withdrawal PIN locked'), 'true');
  PERFORM pg_temp.chk('PIN events audited',
    (SELECT string_agg(DISTINCT event, ',' ORDER BY event) FROM public.withdrawal_pin_events WHERE user_id = ORG), 'created,failed,locked,reset_required');

  -- ---------------- 4. PIN recovery needs a password in the last 5 minutes ----------------
  PERFORM pg_temp.chk_like('reset with no password is refused', pg_temp.q(ORG, 'SELECT public.reset_my_withdrawal_pin(''5820'', ''5820'')::text'), 'ERR:%PASSWORD_CONFIRMATION_REQUIRED%');
  PERFORM pg_temp.chk_like('reset with a refreshed token (password 1h old) is refused', pg_temp.q(ORG, 'SELECT public.reset_my_withdrawal_pin(''5820'', ''5820'')::text', pw_old), 'ERR:%PASSWORD_CONFIRMATION_REQUIRED%');
  PERFORM pg_temp.chk_like('reset after an OTP sign-in is refused', pg_temp.q(ORG, 'SELECT public.reset_my_withdrawal_pin(''5820'', ''5820'')::text', otp), 'ERR:%PASSWORD_CONFIRMATION_REQUIRED%');
  PERFORM pg_temp.chk('reset with a password just entered works and unlocks', pg_temp.q(ORG, 'SELECT public.reset_my_withdrawal_pin(''5820'', ''5820'')->>''locked''', pw), 'false');
  PERFORM pg_temp.chk('old PIN no longer works', pg_temp.wd(ORG, 500000, BANK, '7391', 'w8'), 'wrong_pin');
  PERFORM pg_temp.chk('after a reset withdrawals pause 24h', pg_temp.wd(ORG, 500000, BANK, '5820', 'w9'), 'pin_recently_reset');
  PERFORM pg_temp.chk('"Withdrawal PIN changed" notification', (SELECT count(*)::text FROM public.notifications WHERE user_id = ORG AND title = 'Withdrawal PIN changed'), '1');
  PERFORM pg_temp.chk_like('assert_recent_auth refuses a fresh iat without password', pg_temp.q(ORG, 'SELECT public.assert_recent_auth()::text'), 'ERR:%PASSWORD_CONFIRMATION_REQUIRED%');
  PERFORM pg_temp.chk('assert_recent_auth accepts a password seconds old (no error)',
    (pg_temp.q(ORG, 'SELECT public.assert_recent_auth()::text', pw) NOT LIKE 'ERR:%')::text, 'true');
  UPDATE public.withdrawal_pins SET reset_at = now() - interval '24 hours 1 minute' WHERE user_id = ORG;

  -- ---------------- 5. requests ----------------
  PERFORM pg_temp.chk('below N100 refused', pg_temp.wd(ORG, 9999, BANK, '5820', 'm1'), 'amount_too_small');
  PERFORM pg_temp.chk_like('more than the balance refused', pg_temp.q(ORG, format('SELECT public.request_withdrawal(99999999, %L, ''5820'', ''m2'')::text', BANK)), 'ERR:%Insufficient balance%');
  PERFORM pg_temp.chk_like('another user''s bank account refused', pg_temp.q(ORG, format('SELECT public.request_withdrawal(500000, %L, ''5820'', ''m3'')::text', BANK2)), 'ERR:%Bank account not verified%');
  W1 := pg_temp.wd_id(ORG, 3000000, BANK, '5820', 'key-w1');
  PERFORM pg_temp.chk('correct PIN: request created, N30,000 to pending', (W1 IS NOT NULL)::text || '/' || pg_temp.wallet(ORG), 'true/7000000/3000000');
  PERFORM pg_temp.chk('retry with same key returns same request, no second debit', pg_temp.wd_id(ORG, 3000000, BANK, '5820', 'key-w1')::text || '/' || pg_temp.wallet(ORG), W1::text || '/7000000/3000000');
  PERFORM pg_temp.chk('identical request with a new key refused as duplicate', pg_temp.wd(ORG, 3000000, BANK, '5820', 'key-w1b'), 'duplicate_withdrawal');
  PERFORM pg_temp.chk('user history: pending first approval, account masked',
    pg_temp.q(ORG, format('SELECT stage || ''|'' || account_number_masked FROM public.get_my_withdrawals() WHERE request_id = %L', W1)), 'pending_first_approval|****6789');
  PERFORM pg_temp.chk('other users never see it', pg_temp.q(PLAIN, format('SELECT count(*)::text FROM public.get_my_withdrawals() WHERE request_id = %L', W1)), '0');

  -- ---------------- 6. two-admin approval ----------------
  PERFORM pg_temp.chk_like('non-admin cannot list withdrawals', pg_temp.q(PLAIN, 'SELECT count(*)::text FROM public.admin_list_withdrawals()'), 'ERR:%Admin access required%');
  PERFORM pg_temp.chk_like('non-admin cannot first-approve', pg_temp.q(PLAIN, format('SELECT public.admin_first_approve_withdrawal(%L, 3000000)::text', W1)), 'ERR:%Admin access required%');
  PERFORM pg_temp.chk_like('the withdrawing user cannot second-approve', pg_temp.q(ORG, format('SELECT public.admin_approve_withdrawal(%L)::text', W1)), 'ERR:%Admin access required%');
  PERFORM pg_temp.chk('stage pending_first_approval for sub-admin and admin', pg_temp.stage(SUB, W1) || '/' || pg_temp.stage(ADM, W1), 'pending_first_approval/pending_first_approval');
  PERFORM pg_temp.chk_like('nothing claimable for Paystack before approvals', pg_temp.q(ADM, format('SELECT claimed::text FROM public.admin_claim_payout_for_processing(%L)', W1)), 'ERR:%needs a second admin%');
  PERFORM pg_temp.chk_like('legacy admin_mark_payout_processing cannot bypass approvals',
    pg_temp.q(ADM, format('SELECT public.admin_mark_payout_processing(%L, ''TRF_e2e'', ''payout_x'')::text', W1)), 'ERR:%');
  PERFORM pg_temp.chk('...and the request is still pending first approval', pg_temp.stage(ADM, W1), 'pending_first_approval');
  PERFORM pg_temp.chk_like('first approval for a different amount refused', pg_temp.q(SUB, format('SELECT public.admin_first_approve_withdrawal(%L, 100)::text', W1)), 'ERR:%does not match%');
  PERFORM pg_temp.chk('sub-admin gives the first approval', (pg_temp.q(SUB, format('SELECT public.admin_first_approve_withdrawal(%L, 3000000)::text', W1)) NOT LIKE 'ERR:%')::text, 'true');
  PERFORM pg_temp.chk('stage pending_second_approval (both views) + user view',
    pg_temp.stage(SUB, W1) || '/' || pg_temp.stage(ADM, W1) || '/' || pg_temp.mystage(ORG, W1), 'pending_second_approval/pending_second_approval/pending_second_approval');
  PERFORM pg_temp.chk('first approval recorded the reviewed recipient',
    (SELECT payload->>'recipient_code' FROM public.admin_action_requests WHERE target_id = W1 AND status = 'pending'), 'RCP_e2e_org');
  PERFORM pg_temp.chk_like('a duplicate first approval is refused', pg_temp.q(ADM, format('SELECT public.admin_first_approve_withdrawal(%L, 3000000)::text', W1)), 'ERR:%already has a first approval%');
  PERFORM pg_temp.chk_like('...also via raw request_admin_action', pg_temp.q(ADM2, format('SELECT public.request_admin_action(''authorize_withdrawal'', ''withdrawal'', %L, ''x'', %L::jsonb)::text', W1, jsonb_build_object('request_id', W1, 'amount_kobo', 3000000))), 'ERR:%already has a first approval%');
  PERFORM pg_temp.chk_like('the first approver cannot give the second', pg_temp.q(SUB, format('SELECT public.admin_approve_withdrawal(%L)::text', W1)), 'ERR:%You gave the first approval%');
  PERFORM pg_temp.chk_like('two sub-admins cannot authorize alone', pg_temp.q(SUB2, format('SELECT public.admin_approve_withdrawal(%L)::text', W1)), 'ERR:%two sub-admins cannot authorize%');
  PERFORM pg_temp.chk_like('a sub-admin cannot approve via Admin Actions either',
    pg_temp.q(SUB2, format('SELECT public.approve_admin_action(%L)::text', (SELECT id FROM public.admin_action_requests WHERE target_id = W1 AND status = 'pending'))), 'ERR:%Super Admin access required%');
  PERFORM pg_temp.chk('sub-admin dashboard explains, no approve button',
    pg_temp.q(SUB2, format('SELECT can_second_approve::text || ''|'' || action_note FROM public.admin_list_withdrawals(''all'', 500) WHERE request_id = %L', W1)),
    'false|The first approval came from a sub-admin, so the second must come from a full admin.');
  PERFORM pg_temp.chk_like('still nothing claimable after one approval', pg_temp.q(ADM, format('SELECT claimed::text FROM public.admin_claim_payout_for_processing(%L)', W1)), 'ERR:%needs a second admin%');
  BEGIN
    UPDATE public.organizer_withdrawal_requests SET status = 'processing' WHERE id = W1;
    PERFORM pg_temp.chk('raw UPDATE to processing refused by the guard', 'updated', 'ERR');
  EXCEPTION WHEN others THEN
    PERFORM pg_temp.chk_like('raw UPDATE to processing refused by the guard', 'ERR:' || SQLERRM, 'ERR:%two-admin authorization%');
  END;
  PERFORM pg_temp.chk('full admin gives the second approval', pg_temp.q(ADM, format('SELECT public.admin_approve_withdrawal(%L)->>''stage''', W1)), 'approved');
  PERFORM pg_temp.chk('approved; both approvers recorded; first-approval request closed',
    pg_temp.stage(SUB, W1) || '/' || (SELECT (approval_requested_by = SUB AND approved_by = ADM AND approved_recipient_code = 'RCP_e2e_org')::text FROM public.organizer_withdrawal_requests WHERE id = W1)
    || '/' || (SELECT string_agg(status, ',') FROM public.admin_action_requests WHERE target_id = W1 AND action_type = 'authorize_withdrawal'),
    'approved/true/approved');
  PERFORM pg_temp.chk('user told it was approved', pg_temp.mystage(ORG, W1) || '/' || (SELECT count(*)::text FROM public.notifications WHERE user_id = ORG AND title = 'Withdrawal approved'), 'approved/1');
  PERFORM pg_temp.chk_like('a third approval is refused', pg_temp.q(ADM2, format('SELECT public.admin_approve_withdrawal(%L)::text', W1)), 'ERR:%already has both approvals%');
  PERFORM pg_temp.chk('admin and sub-admin see the same authoritative list',
    pg_temp.q(SUB2, 'SELECT md5(string_agg(request_id::text || stage || status || amount_kobo || COALESCE(first_approved_by::text, ''-'') || COALESCE(second_approved_by::text, ''-''), ''|'' ORDER BY request_id)) FROM public.admin_list_withdrawals(''all'', 500)'),
    pg_temp.q(ADM2, 'SELECT md5(string_agg(request_id::text || stage || status || amount_kobo || COALESCE(first_approved_by::text, ''-'') || COALESCE(second_approved_by::text, ''-''), ''|'' ORDER BY request_id)) FROM public.admin_list_withdrawals(''all'', 500)'));

  -- ---------------- 7. payout: one claim; paid only on Paystack success (DB only, Paystack never called) ----------------
  PERFORM pg_temp.chk('Pay now: first claim succeeds', pg_temp.q(ADM, format('SELECT claimed::text FROM public.admin_claim_payout_for_processing(%L)', W1)), 'true');
  PERFORM pg_temp.chk('a second Pay click does not claim again', pg_temp.q(ADM2, format('SELECT claimed::text FROM public.admin_claim_payout_for_processing(%L)', W1)), 'false');
  ref := (SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = W1);
  PERFORM pg_temp.chk('Paystack reference is payout_<request id without dashes>', ref, 'payout_' || replace(W1::text, '-', ''));
  PERFORM pg_temp.chk('processing (not paid) until Paystack confirms', pg_temp.stage(ADM, W1) || '/' || pg_temp.mystage(ORG, W1), 'processing/processing');
  PERFORM 1 FROM public.complete_organizer_payout(ref);
  PERFORM pg_temp.chk('transfer.success -> paid; pending cleared', pg_temp.mystage(ORG, W1) || '/' || pg_temp.wallet(ORG), 'paid/7000000/0');

  -- ---------------- 8. admin first + sub-admin second; Paystack failure returns the money ----------------
  W2 := pg_temp.wd_id(ORG, 1000000, BANK, '5820', 'key-w2');
  PERFORM pg_temp.q(ADM, format('SELECT public.admin_first_approve_withdrawal(%L, 1000000)::text', W2));
  PERFORM pg_temp.chk('sub-admin may give the second approval after a full admin', pg_temp.q(SUB, format('SELECT public.admin_approve_withdrawal(%L)->>''stage''', W2)), 'approved');
  PERFORM pg_temp.chk('claimed', pg_temp.q(SUB2, format('SELECT claimed::text FROM public.admin_claim_payout_for_processing(%L)', W2)), 'true');
  UPDATE public.organizer_withdrawal_requests SET transfer_code = 'TRF_e2e' WHERE id = W2;
  PERFORM 1 FROM public.fail_organizer_payout((SELECT paystack_reference FROM public.organizer_withdrawal_requests WHERE id = W2), 'e2e transfer.failed');
  PERFORM pg_temp.chk('transfer.failed -> failed, money back', pg_temp.mystage(ORG, W2) || '/' || pg_temp.wallet(ORG), 'failed/7000000/0');

  -- ---------------- 9. rejection ----------------
  W3 := pg_temp.wd_id(ORG, 2000000, BANK, '5820', 'key-w3');
  PERFORM pg_temp.q(SUB, format('SELECT public.admin_first_approve_withdrawal(%L, 2000000)::text', W3));
  PERFORM pg_temp.chk_like('a sub-admin cannot reject', pg_temp.q(SUB2, format('SELECT public.admin_reject_organizer_payout(%L, ''x'')::text', W3)), 'ERR:%Super Admin access required%');
  PERFORM pg_temp.chk('full admin rejects', (pg_temp.q(ADM2, format('SELECT public.admin_reject_organizer_payout(%L, ''E2E review'')::text', W3)) NOT LIKE 'ERR:%')::text, 'true');
  PERFORM pg_temp.chk('rejected; open first approval closed; money back; user told with reason',
    pg_temp.mystage(ORG, W3) || '/' || (SELECT string_agg(status, ',') FROM public.admin_action_requests WHERE target_id = W3) || '/' || pg_temp.wallet(ORG)
    || '/' || (SELECT count(*)::text FROM public.notifications WHERE user_id = ORG AND title = 'Withdrawal not approved' AND body LIKE '%E2E review%'),
    'rejected/rejected/7000000/0/1');
  PERFORM pg_temp.chk_like('a rejected withdrawal cannot be approved', pg_temp.q(ADM, format('SELECT public.admin_first_approve_withdrawal(%L, 2000000)::text', W3)), 'ERR:%not pending%');

  -- ---------------- 10. own withdrawal; cancel first approval; bank changed between approvals ----------------
  PERFORM pg_temp.q(OADM, 'SELECT public.set_my_withdrawal_pin(''8053'', ''8053'')::text');
  W5 := pg_temp.wd_id(OADM, 1500000, BANKO, '8053', 'oa-1');
  PERFORM pg_temp.chk_like('an admin cannot first-approve their own withdrawal', pg_temp.q(OADM, format('SELECT public.admin_first_approve_withdrawal(%L, 1500000)::text', W5)), 'ERR:%cannot approve their own withdrawal%');
  PERFORM pg_temp.q(SUB, format('SELECT public.admin_first_approve_withdrawal(%L, 1500000)::text', W5));
  PERFORM pg_temp.chk_like('...nor second-approve it', pg_temp.q(OADM, format('SELECT public.admin_approve_withdrawal(%L)::text', W5)), 'ERR:%cannot approve their own withdrawal%');
  PERFORM pg_temp.chk_like('another admin cannot withdraw someone else''s first approval', pg_temp.q(SUB2, format('SELECT public.admin_cancel_withdrawal_first_approval(%L, ''x'')::text', W5)), 'ERR:%Only the admin who gave the first approval%');
  PERFORM pg_temp.chk('the first approver can withdraw it -> back to pending first approval',
    (pg_temp.q(SUB, format('SELECT public.admin_cancel_withdrawal_first_approval(%L, ''e2e'')::text', W5)) NOT LIKE 'ERR:%')::text || '/' || pg_temp.stage(ADM, W5), 'true/pending_first_approval');
  PERFORM pg_temp.q(ADM, format('SELECT public.admin_first_approve_withdrawal(%L, 1500000)::text', W5));
  UPDATE public.organizer_bank_accounts SET recipient_code = 'RCP_e2e_oadm_new' WHERE id = BANKO;
  PERFORM pg_temp.chk_like('a recipient changed after the first approval refuses the second', pg_temp.q(SUB, format('SELECT public.admin_approve_withdrawal(%L)::text', W5)), 'ERR:%changed after the first approval%');

  -- ---------------- 11. nothing real touched ----------------
  real_after := (SELECT md5(string_agg(t::text, '|' ORDER BY id)) FROM public.organizer_withdrawal_requests t WHERE organizer_id NOT IN (ORG, ADM, SUB, SUB2, PLAIN, ADM2, OADM))
    || (SELECT md5(string_agg(t::text, '|' ORDER BY id)) FROM public.admin_action_requests t WHERE target_id IS DISTINCT FROM W1 AND target_id IS DISTINCT FROM W2 AND target_id IS DISTINCT FROM W3 AND target_id IS DISTINCT FROM W5)
    || (SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM public.organizer_wallets t WHERE organizer_id NOT IN (ORG, ADM, SUB, SUB2, PLAIN, ADM2, OADM));
  PERFORM pg_temp.chk('every real withdrawal, approval and wallet row unchanged during the test', real_after, real_before);
  PERFORM pg_temp.chk('test organizer ledger reconciles (no gaps)',
    pg_temp.q(ADM, format('SELECT count(*)::text FROM public.admin_earnings_reconciliation() WHERE organizer_id IN (%L, %L) AND (ledger_gap_kobo <> 0 OR pending_gap_kobo <> 0 OR ''negative_balance'' = ANY(issues))', ORG, OADM)), '0');

  SELECT count(*) FILTER (WHERE ok), count(*) FILTER (WHERE NOT ok OR ok IS NULL),
         string_agg(CASE WHEN ok THEN 'PASS ' ELSE 'FAIL ' END || name || CASE WHEN ok THEN '' ELSE ' [got: ' || COALESCE(left(got, 200), 'NULL') || ' | expected: ' || exp || ']' END, E'\n' ORDER BY n)
    INTO npass, nfail, report FROM e2e_res;
  RAISE EXCEPTION E'E2E_RESULT (rolled back) pass=% fail=%\n%', npass, nfail, report;
END
$e2e$;
