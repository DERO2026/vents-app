#!/usr/bin/env python3
"""Generates supabase/migrations/0203_earnings_policies.sql from 0203_template.sql.

Usage: python3 scripts/local-pg-test/generators/gen0203.py

Every function patch is (old, new) text pairs applied in the database to the
function's current pg_get_functiondef. Before emitting, each anchor is
checked to occur exactly once in the md5-verified live copy (or our own
0201/0202 text), so the migration cannot ship a dead anchor.
"""
import re, sys, os, hashlib

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
LIVE = os.path.join(REPO, 'scripts/local-pg-test/live-money-functions.sql')
M201 = os.path.join(REPO, 'supabase/migrations/0201_vents_earn_representative_rewards.sql')
M202 = os.path.join(REPO, 'supabase/migrations/0202_payout_engine_safety.sql')
OUT = os.path.join(REPO, 'supabase/migrations/0203_earnings_policies.sql')


def fn_text(path, name):
    s = open(path).read()
    m = list(re.finditer(r'CREATE OR REPLACE FUNCTION public\.%s\(' % name, s))[-1]
    am = re.compile(r'AS (\$[a-z_]*\$)').search(s, m.start())
    end = s.index(am.group(1), am.end()) + len(am.group(1))
    return s[m.start():end], s[am.end():s.index(am.group(1), am.end())]


# Pinned md5(prosrc) of the LIVE production bodies (read-only query, 2026-10-30).
LIVE_MD5 = {
    'create_pending_purchase': ('public.create_pending_purchase(uuid,text,jsonb,text,text)', 'e10d13bed6fe2e53743c1fb5bca6cd57'),
    'confirm_ticket_payment': ('public.confirm_ticket_payment(text,bigint)', '56d671416e12041eefe0856cec303b75'),
    'confirm_ticket_payment_via_wallet': ('public.confirm_ticket_payment_via_wallet(text)', '99e7184e21cd3acee3739ebd7d260464'),
    'refund_ticket': ('public.refund_ticket(uuid,text)', '6ad935dc8a027533a1481208045fe861'),
    'finalize_ticket_refund': ('public.finalize_ticket_refund(text)', '0006acfb1f30da94029367dbc21a6b98'),
    'cancel_service_booking': ('public.cancel_service_booking(uuid,text)', '80d930ef3b259cc982a91ec4895b732c'),
    'finalize_service_booking_refund': ('public.finalize_service_booking_refund(text)', 'e2c6c2979960fa5477da0de0f49fefb7'),
    'get_event_analytics': ('public.get_event_analytics(uuid)', '1657aa6186eb1286981f5fe258d84654'),
    'credit_organizer_wallet': ('public.credit_organizer_wallet(uuid,bigint,text,uuid,jsonb)', '9b889f4696ceb56f990cdf582c40c679'),
    'credit_provider_wallet_for_booking': ('public.credit_provider_wallet_for_booking(uuid,bigint,uuid,text)', '2f0724e6b3de78ddd97b27af3a1188c7'),
    'request_organizer_payout': ('public.request_organizer_payout(bigint,uuid,text)', 'dd12a3e3b54b5aa620404e8b928527f4'),
}

patches = []  # (name, sig, md5 or None, source_body, [(old,new),...], comment)


def money_block(body, owed_expr):
    """The live 'debit the available balance, log the shortfall' block."""
    start = body.index('SELECT balance_kobo INTO v_wallet_bal')
    start = body.rindex('\n', 0, start) + 1
    head = 'IF v_actual_debit < %s THEN' % owed_expr
    h = body.index(head, start)
    indent = body[body.rindex('\n', 0, h) + 1:h]
    end = body.index('\n' + indent + 'END IF;\n', h) + len('\n' + indent + 'END IF;\n')
    return body[start:end], indent


def helper_call(indent, args):
    i2 = indent + '  '
    return (indent + 'v_actual_debit := public.earnings_debit_for_refund(\n' +
            ',\n'.join(i2 + a for a in args) + ');\n')


live = {n: fn_text(LIVE, n)[1] for n in LIVE_MD5}
for n, body in live.items():
    got = hashlib.md5(body.encode()).hexdigest()
    if got != LIVE_MD5[n][1]:
        sys.exit(f'{n}: local copy md5 {got} != pinned live md5 {LIVE_MD5[n][1]}')

# --- create_pending_purchase -------------------------------------------------
patches.append(('create_pending_purchase', [
    ("v_amount_kobo := round(v_unit_price * v_count * (1.05 - v_discount_pct / 100) * 100)::bigint;",
     "v_amount_kobo := round(v_unit_price * v_count * (public.ticket_fee_buyer_multiplier('v2_4_5') - v_discount_pct / 100) * 100)::bigint;"),
    ("     AND status = 'pending'\n     AND created_at > now() - interval '30 minutes'",
     "     AND status = 'pending'\n     AND fee_model = 'v2_4_5'\n     AND created_at > now() - interval '30 minutes'"),
    ("(event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at)",
     "(event_id, user_id, ticket_type, attendees, attendees_hash, promo_code, amount_kobo, payment_ref, status, payer_id, expires_at, fee_model)"),
    ("     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END);",
     "     CASE WHEN v_payer_id IS NOT NULL THEN now() + interval '48 hours' ELSE NULL END, 'v2_4_5');"),
]))

# --- confirm_ticket_payment (+ via wallet) -----------------------------------
for name, ref_key in (('confirm_ticket_payment', 'paystack_reference'), ('confirm_ticket_payment_via_wallet', 'wallet_reference')):
    patches.append((name, [
        ("  v_prior_paid_count integer;\nBEGIN",
         "  v_prior_paid_count integer;\n  v_fee_model        text;\n  v_face_kobo        bigint;\n  v_commission_kobo  bigint;\nBEGIN"),
        ("         max(t.ticket_type), e.organizer_id, e.id, max(e.title),",
         "         max(t.ticket_type), max(t.fee_model), e.organizer_id, e.id, max(e.title),"),
        ("         v_ticket_type, v_organizer_id, v_event_id, v_event_title,",
         "         v_ticket_type, v_fee_model, v_organizer_id, v_event_id, v_event_title,"),
        ("v_expected_kobo := round(v_total_amount * (1.05 - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;",
         "v_expected_kobo := round(v_total_amount * (public.ticket_fee_buyer_multiplier(v_fee_model) - COALESCE(v_discount_pct, 0) / 100) * 100)::bigint;"),
        ("    v_credit_kobo := floor(v_total_amount * 100)::bigint;",
         "    -- Organizer settlement = face value minus the VENTS organizer commission.\n"
         "    v_face_kobo := floor(v_total_amount * 100)::bigint;\n"
         "    v_commission_kobo := public.ticket_fee_commission_kobo(v_face_kobo, v_fee_model);\n"
         "    v_credit_kobo := v_face_kobo - v_commission_kobo;"),
        ("      'gross_kobo', v_credit_kobo,\n      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_credit_kobo),",
         "      'gross_kobo', v_face_kobo,\n      'buyer_fee_kobo', GREATEST(0, v_expected_kobo - v_face_kobo),\n"
         "      'organizer_commission_kobo', v_commission_kobo,\n      'net_kobo', v_credit_kobo,\n      'fee_model', v_fee_model,"),
    ]))

# --- refund_ticket -----------------------------------------------------------
b = live['refund_ticket']
blk, ind = money_block(b, 'v_owed_kobo')
patches.append(('refund_ticket', [
    ("  SELECT t.id, t.payment_ref, t.payment_status, t.status, t.amount, t.discount_percentage,\n",
     "  SELECT t.id, t.payment_ref, t.payment_status, t.status, t.amount, t.discount_percentage, t.fee_model,\n"),
    ("  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;",
     "  v_refund_kobo := round(v_ticket.amount * (public.ticket_fee_buyer_multiplier(v_ticket.fee_model) - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;"),
    ("      v_owed_kobo := floor(v_ticket.amount * 100)::bigint;",
     "      v_owed_kobo := floor(v_ticket.amount * 100)::bigint\n"
     "                   - public.ticket_fee_commission_kobo(floor(v_ticket.amount * 100)::bigint, v_ticket.fee_model);"),
    (blk, helper_call(ind, [
        'v_ticket.organizer_id, v_owed_kobo',
        "'ticket_sale', COALESCE(v_ticket.payment_ref, v_ticket.id::text)",
        "'ticket_refund', v_ticket.id::text",
        "'Refund (Wallet): ' || v_ticket.ticket_type, v_ticket.id",
        "jsonb_build_object('ticket_id', v_ticket.id)",
        "auth.uid(), public.actor_role(), 'refund_wallet_shortfall'"])),
]))

# --- finalize_ticket_refund --------------------------------------------------
b = live['finalize_ticket_refund']
blk, ind = money_block(b, 'v_owed_kobo')
patches.append(('finalize_ticket_refund', [
    ("  SELECT t.id, t.user_id, t.amount, t.discount_percentage, t.ticket_type, t.payment_status,\n",
     "  SELECT t.id, t.user_id, t.amount, t.discount_percentage, t.fee_model, t.payment_ref, t.ticket_type, t.payment_status,\n"),
    ("  v_refund_kobo := round(v_ticket.amount * (1.05 - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;",
     "  v_refund_kobo := round(v_ticket.amount * (public.ticket_fee_buyer_multiplier(v_ticket.fee_model) - COALESCE(v_ticket.discount_percentage, 0) / 100) * 100)::bigint;"),
    ("    v_owed_kobo := floor(v_ticket.amount * 100)::bigint;",
     "    v_owed_kobo := floor(v_ticket.amount * 100)::bigint\n"
     "                 - public.ticket_fee_commission_kobo(floor(v_ticket.amount * 100)::bigint, v_ticket.fee_model);"),
    (blk, helper_call(ind, [
        'v_ticket.organizer_id, v_owed_kobo',
        "'ticket_sale', COALESCE(v_ticket.payment_ref, v_ticket.id::text)",
        "'ticket_refund', v_ticket.id::text",
        "'Refund: ' || v_ticket.ticket_type, v_ticket.id",
        "jsonb_build_object('ticket_id', v_ticket.id)",
        "v_ticket.refund_initiated_by, 'webhook', 'refund_wallet_shortfall'"])),
]))

# --- cancel_service_booking (wallet path) ------------------------------------
b = live['cancel_service_booking']
blk, ind = money_block(b, 'v_booking.subtotal_kobo')
patches.append(('cancel_service_booking', [
    # A completed booking can be refunded only once two admins have upheld
    # the customer's dispute (execute_booking_dispute_resolution).
    ("  IF v_booking.status = 'completed' THEN\n    RAISE EXCEPTION 'A completed booking cannot be cancelled or refunded';\n  END IF;",
     "  IF v_booking.status = 'completed' AND NOT EXISTS (\n"
     "       SELECT 1 FROM public.service_booking_disputes d\n"
     "        WHERE d.booking_id = v_booking.id AND d.status = 'resolved_for_customer') THEN\n"
     "    RAISE EXCEPTION 'A completed booking cannot be cancelled or refunded';\n  END IF;"),
    (blk, helper_call(ind, [
        'v_provider_user_id, v_booking.subtotal_kobo',
        "'service_booking', v_booking.id::text",
        "'service_booking_refund', v_booking.id::text",
        "'Refund (Wallet): service booking', NULL",
        "jsonb_build_object('service_booking_id', v_booking.id, 'booking_id', v_booking.id)",
        "auth.uid(), public.actor_role(), 'refund_service_booking_wallet_shortfall'"])),
]))

# --- finalize_service_booking_refund -----------------------------------------
b = live['finalize_service_booking_refund']
blk, ind = money_block(b, 'v_booking.subtotal_kobo')
patches.append(('finalize_service_booking_refund', [
    (blk, helper_call(ind, [
        'v_booking.provider_user_id, v_booking.subtotal_kobo',
        "'service_booking', v_booking.id::text",
        "'service_booking_refund', v_booking.id::text",
        "'Refund (Paystack): service booking', NULL",
        "jsonb_build_object('service_booking_id', v_booking.id, 'booking_id', v_booking.id)",
        "v_booking.refund_initiated_by, 'webhook', 'refund_service_booking_shortfall'"])),
]))

# --- get_event_analytics -----------------------------------------------------
patches.append(('get_event_analytics', [
    ("      COALESCE(sum(amount * 100), 0)::bigint AS gross_kobo,\n",
     "      COALESCE(sum(amount * 100), 0)::bigint AS gross_kobo,\n"
     "      COALESCE(sum(public.ticket_fee_commission_kobo(floor(amount * 100)::bigint, fee_model)), 0)::bigint AS commission_kobo,\n"),
    ("round(amount * (1.05 - COALESCE(discount_percentage, 0) / 100) * 100)",
     "round(amount * (public.ticket_fee_buyer_multiplier(fee_model) - COALESCE(discount_percentage, 0) / 100) * 100)"),
    ("      'organizerEarnedKobo', o.gross_kobo,",
     "      'organizerEarnedKobo', o.gross_kobo - o.commission_kobo,\n      'ventsCommissionKobo', o.commission_kobo,"),
]))

# --- credit functions: earnings go on hold -----------------------------------
patches.append(('credit_organizer_wallet', [
    ("  SELECT t.id, e.organizer_id, t.payment_status\n",
     "  SELECT t.id, e.organizer_id, t.payment_status, t.payment_ref, e.id AS event_id\n"),
    ("  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo)\n"
     "  VALUES (p_organizer_id, p_amount_kobo, p_amount_kobo)\n"
     "  ON CONFLICT (organizer_id) DO UPDATE\n"
     "    SET balance_kobo      = organizer_wallets.balance_kobo + p_amount_kobo,",
     "  -- Settlement hold: the sale is earned now but withdrawable only 48\n"
     "  -- hours after the event ends (see earnings_hold_state).\n"
     "  INSERT INTO public.organizer_wallets (organizer_id, on_hold_kobo, total_earned_kobo)\n"
     "  VALUES (p_organizer_id, p_amount_kobo, p_amount_kobo)\n"
     "  ON CONFLICT (organizer_id) DO UPDATE\n"
     "    SET on_hold_kobo      = organizer_wallets.on_hold_kobo + p_amount_kobo,"),
    ("  VALUES (p_organizer_id, 'credit', p_amount_kobo, p_description, p_ticket_sale_id, p_metadata);\nEND;",
     "  VALUES (p_organizer_id, 'credit', p_amount_kobo, p_description, p_ticket_sale_id, p_metadata);\n\n"
     "  PERFORM public.earnings_place_hold(p_organizer_id, 'ticket_sale',\n"
     "                                     COALESCE(v_ticket.payment_ref, p_ticket_sale_id::text), p_amount_kobo,\n"
     "                                     v_ticket.event_id);\nEND;"),
]))
patches.append(('credit_provider_wallet_for_booking', [
    ("  INSERT INTO public.organizer_wallets (organizer_id, balance_kobo, total_earned_kobo, total_withdrawn_kobo, pending_kobo)\n"
     "  VALUES (p_provider_user_id, p_amount_kobo, p_amount_kobo, 0, 0)\n"
     "  ON CONFLICT (organizer_id) DO UPDATE\n"
     "    SET balance_kobo = public.organizer_wallets.balance_kobo + p_amount_kobo,",
     "  -- Settlement hold until 48 hours after completion (see earnings_hold_state).\n"
     "  INSERT INTO public.organizer_wallets (organizer_id, on_hold_kobo, total_earned_kobo, total_withdrawn_kobo, pending_kobo)\n"
     "  VALUES (p_provider_user_id, p_amount_kobo, p_amount_kobo, 0, 0)\n"
     "  ON CONFLICT (organizer_id) DO UPDATE\n"
     "    SET on_hold_kobo = public.organizer_wallets.on_hold_kobo + p_amount_kobo,"),
    ("  VALUES (p_provider_user_id, 'credit', p_amount_kobo, p_description, jsonb_build_object('service_booking_id', p_booking_id));\nEND;",
     "  VALUES (p_provider_user_id, 'credit', p_amount_kobo, p_description, jsonb_build_object('service_booking_id', p_booking_id));\n\n"
     "  PERFORM public.earnings_place_hold(p_provider_user_id, 'service_booking', p_booking_id::text, p_amount_kobo, p_booking_id);\nEND;"),
]))

# --- request_organizer_payout: release matured earnings first ----------------
patches.append(('request_organizer_payout', [
    ("  SELECT balance_kobo INTO v_balance\n  FROM public.organizer_wallets\n  WHERE organizer_id = v_organizer_id\n  FOR UPDATE;\n",
     "  -- Matured holds become available (and outstanding recoveries are\n"
     "  -- deducted) before the balance is read.\n"
     "  PERFORM public.settle_earnings(v_organizer_id);\n\n"
     "  SELECT balance_kobo INTO v_balance\n  FROM public.organizer_wallets\n  WHERE organizer_id = v_organizer_id\n  FOR UPDATE;\n"),
]))

# --- our own 0201 / 0202 functions (pinned to the text in this repo) ---------
own = []
b201_elig = fn_text(M201, 'earn_event_eligibility')[1]
b201_trig = fn_text(M201, 'earn_ticket_refund_adjust_profit')[1]
b202_complete = fn_text(M202, 'complete_organizer_payout')[1]
own.append(('earn_event_eligibility', 'public.earn_event_eligibility(uuid)', b201_elig, [
    ("SELECT COALESCE(sum(GREATEST(0, COALESCE((ot.metadata->>'buyer_fee_kobo')::bigint, 0))), 0)",
     "SELECT COALESCE(sum(GREATEST(0, COALESCE((ot.metadata->>'buyer_fee_kobo')::bigint, 0))\n"
     "                    + GREATEST(0, COALESCE((ot.metadata->>'organizer_commission_kobo')::bigint, 0))), 0)"),
    ("SELECT COALESCE(sum(public.earn_ticket_nominal_fee_kobo(t.amount)), 0)",
     "SELECT COALESCE(sum(public.earn_ticket_nominal_fee_kobo(t.amount, t.fee_model)), 0)"),
]))
own.append(('earn_ticket_refund_adjust_profit', 'public.earn_ticket_refund_adjust_profit()', b201_trig, [
    ("v_fee := public.earn_ticket_nominal_fee_kobo(NEW.amount);",
     "v_fee := public.earn_ticket_nominal_fee_kobo(NEW.amount, NEW.fee_model);"),
]))
own.append(('complete_organizer_payout', 'public.complete_organizer_payout(text)', b202_complete, [
    ("    IF v_debit < v_amount_kobo THEN\n",
     "    IF v_debit < v_amount_kobo THEN\n"
     "      -- Rule: never absorb it silently; recover it from future earnings.\n"
     "      INSERT INTO public.earnings_recoveries (owner_id, source_kind, source_key, amount_kobo, reason, metadata)\n"
     "      VALUES (v_organizer_id, 'payout_after_cancel', v_id::text, v_amount_kobo - v_debit,\n"
     "              'Withdrawal paid after it was cancelled',\n"
     "              jsonb_build_object('request_id', v_id, 'amount_kobo', v_amount_kobo, 'recovered_now_kobo', v_debit))\n"
     "      ON CONFLICT (source_kind, source_key) DO NOTHING;\n"),
]))


def q(s, tag='x0203'):
    assert '$%s$' % tag not in s
    return '$%s$%s$%s$' % (tag, s, tag)


def emit_patch(sig, md5, body, edits):
    for o, n in edits:
        c = body.count(o)
        if c != 1:
            sys.exit(f'{sig}: anchor found {c} times:\n{o}')
        body = body.replace(o, n)
    arr = ',\n  '.join(q(o) + ', ' + q(n) for o, n in edits)
    return "SELECT pg_temp.vents_0203_patch('%s', %s, ARRAY[\n  %s\n]);\n" % (
        sig, "'%s'" % md5 if md5 else 'NULL', arr)


parts = []
for name, edits in patches:
    sig, md5 = LIVE_MD5[name]
    parts.append('-- %s\n' % name + emit_patch(sig, md5, live[name], edits))
own_parts = []
for name, sig, body, edits in own:
    md5 = hashlib.md5(body.encode()).hexdigest()
    own_parts.append('-- %s (0201/0202 text in this repo)\n' % name + emit_patch(sig, md5, body, edits))

tpl = open(os.path.join(os.path.dirname(__file__), '0203_template.sql')).read()
out = tpl.replace('--@@LIVE_PATCHES@@\n', '\n'.join(parts)).replace('--@@OWN_PATCHES@@\n', '\n'.join(own_parts))
open(OUT, 'w').write(out)
print('wrote', OUT, len(out))
