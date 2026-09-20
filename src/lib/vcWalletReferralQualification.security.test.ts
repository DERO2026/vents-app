import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Real, static SQL-text-assertion tests for VENTS Cents Batch F1's
// Objective 3 fix: confirm_ticket_payment_via_wallet() (the wallet-funded
// ticket purchase path) never called qualify_referral(), so a referred
// user who paid for their first ticket with wallet balance instead of a
// card never activated their pending referral VC (or their referrer's
// linked pending VC). Fixed in supabase/migrations/
// 0085_authoritative_vc_config.sql by adding the identical
// `PERFORM public.qualify_referral(v_user_id, v_first_ticket_id);` call
// the card path (confirm_ticket_payment(), migrations/
// 20260808120000_ticket-reward-integrity.sql) already had, in the same
// logical position inside the same non-free-amount branch.
//
// As with this repo's other VC migrations, there is no live DB harness
// here, so each of the 7 required scenarios is verified structurally
// against the actual deployed SQL text, mirroring vcTicketRewardWallet
// .security.test.ts's own convention.

function fn(src: string, name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$(?:function\\$|\\$)\\s*;`);
  return src.match(re)?.[0] ?? '';
}

let migration: string; // 0085 -- this fix
let priorWallet0083: string; // 0083 -- the still-buggy version being replaced
let cardPath: string; // 20260808120000 -- proves the card path's shape/position
let cashoutMaturation: string; // 0084 -- qualify_referral's activated_at logic

beforeAll(() => {
  migration = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0085_authoritative_vc_config.sql'),
    'utf8'
  );
  priorWallet0083 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0083_wallet_ticket_reward_dedup.sql'),
    'utf8'
  );
  cardPath = readFileSync(
    join(__dirname, '..', '..', 'migrations', '20260808120000_ticket-reward-integrity.sql'),
    'utf8'
  );
  cashoutMaturation = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0084_vc_cashout_limits_and_maturation.sql'),
    'utf8'
  );
});

describe('the bug really existed: prior wallet path never qualified a referral', () => {
  it('0083\'s confirm_ticket_payment_via_wallet does not call qualify_referral anywhere', () => {
    const f = fn(priorWallet0083, 'confirm_ticket_payment_via_wallet');
    expect(f).not.toMatch(/qualify_referral/);
  });

  it('the card path (confirm_ticket_payment) already called it, inside the v_total_amount > 0 branch', () => {
    const f = fn(cardPath, 'confirm_ticket_payment');
    expect(f).toMatch(/IF v_total_amount > 0 THEN[\s\S]*PERFORM public\.qualify_referral\(v_user_id, v_first_ticket_id\);[\s\S]*END IF;/);
  });
});

describe('scenario 1: referred user + first qualifying wallet ticket activates the referral', () => {
  it('the fixed wallet function calls qualify_referral(v_user_id, v_first_ticket_id) inside its v_total_amount > 0 branch', () => {
    const f = fn(migration, 'confirm_ticket_payment_via_wallet');
    expect(f).toMatch(/IF v_total_amount > 0 THEN[\s\S]*PERFORM public\.qualify_referral\(v_user_id, v_first_ticket_id\);[\s\S]*END IF;/);
  });

  it('the call uses the exact same arguments and function as the card path -- no second qualification function was created', () => {
    const wallet = fn(migration, 'confirm_ticket_payment_via_wallet');
    const card = fn(migration, 'confirm_ticket_payment');
    const walletCall = wallet.match(/PERFORM public\.qualify_referral\([^)]*\);/)?.[0];
    const cardCall = card.match(/PERFORM public\.qualify_referral\([^)]*\);/)?.[0];
    expect(walletCall).toBeTruthy();
    expect(cardCall).toBeTruthy();
    expect(walletCall).toBe(cardCall);
  });

  it('no second/duplicate qualify_referral function definition was introduced', () => {
    const matches = migration.match(/CREATE OR REPLACE FUNCTION public\.qualify_referral/g) ?? [];
    expect(matches.length).toBe(0); // reuses the existing 0084 definition unmodified
  });
});

describe('scenario 2: the same wallet payment cannot qualify a referral twice', () => {
  it('qualify_referral\'s own idempotency guard (in 0084, unmodified) is what prevents this -- not new dedup logic in the wallet function', () => {
    expect(cashoutMaturation).toMatch(
      /WHERE user_id = p_referred_user_id\s*\n\s*AND type = 'referral'\s*\n\s*AND referral_role = 'referred'\s*\n\s*AND status = 'pending'\s*\n\s*AND qualifying_ticket_id IS NULL/
    );
  });

  it('this migration adds no new dedup mechanism to confirm_ticket_payment_via_wallet for the qualify_referral call itself', () => {
    const f = fn(migration, 'confirm_ticket_payment_via_wallet');
    // The only guard directly around the call is the existing already_paid /
    // v_tx_id short-circuits earlier in the function -- confirmed those are
    // untouched (present verbatim) rather than something new being added
    // around the qualify_referral PERFORM.
    expect(f).toMatch(/IF v_tx_id IS NULL THEN\s*\n\s*RETURN 'already_paid';\s*\n\s*END IF;/);
    expect(f).toMatch(/IF v_paid_count = v_ticket_count THEN\s*\n\s*RETURN 'already_paid';\s*\n\s*END IF;/);
  });
});

describe('scenario 3: a free ($0) wallet ticket does not qualify a referral', () => {
  it('qualify_referral is only reached inside "IF v_total_amount > 0 THEN" -- a $0 order never enters that branch', () => {
    const f = fn(migration, 'confirm_ticket_payment_via_wallet');
    const idx = f.indexOf('PERFORM public.qualify_referral');
    const branchStart = f.lastIndexOf('IF v_total_amount > 0 THEN', idx);
    const branchEnd = f.indexOf('END IF;', idx);
    expect(idx).toBeGreaterThan(-1);
    expect(branchStart).toBeGreaterThan(-1);
    expect(branchStart).toBeLessThan(idx);
    expect(branchEnd).toBeGreaterThan(idx);
  });

  it('qualify_referral() itself also independently rejects a zero/negative-amount ticket, as defense in depth', () => {
    expect(cashoutMaturation).toMatch(/OR v_ticket\.amount IS NULL\s*\n\s*OR v_ticket\.amount <= 0 THEN/);
  });
});

describe('scenario 4: a non-referred user is unaffected', () => {
  it('qualify_referral is a no-op (changed:false) when there is no matching pending referral row', () => {
    expect(cashoutMaturation).toMatch(/IF v_amount IS NULL THEN[\s\S]*RETURN jsonb_build_object\('success', false, 'changed', false, 'message', 'No pending referral to qualify'\);/);
  });

  it('the wallet function does not raise or short-circuit differently based on qualify_referral\'s result (PERFORM discards the return value, same as the card path)', () => {
    const f = fn(migration, 'confirm_ticket_payment_via_wallet');
    expect(f).toMatch(/PERFORM public\.qualify_referral\(v_user_id, v_first_ticket_id\);\s*\n\s*END IF;/);
  });
});

describe('scenario 5: existing card qualification remains unchanged', () => {
  it('confirm_ticket_payment (card path) in this migration still calls qualify_referral in the same position as before', () => {
    const f = fn(migration, 'confirm_ticket_payment');
    expect(f).toMatch(/IF v_total_amount > 0 THEN[\s\S]*PERFORM public\.qualify_referral\(v_user_id, v_first_ticket_id\);[\s\S]*END IF;/);
  });

  it('the card path\'s ticket-reward insert and already_paid guard are untouched aside from the config re-point (see vcConfig.security.test.ts)', () => {
    const f = fn(migration, 'confirm_ticket_payment');
    expect(f).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE type = 'earn' DO NOTHING;/);
  });
});

describe('scenario 6: the referral reward remains correctly deduplicated regardless of qualifying path', () => {
  it('complete_referral\'s referral-row dedup (ON CONFLICT on (user_id, reference_id) WHERE type=\'referral\') is untouched by this migration', () => {
    const f = fn(migration, 'complete_referral');
    expect(f).toMatch(/ON CONFLICT \(user_id, reference_id\) WHERE type = 'referral' DO NOTHING\s*\n\s*RETURNING id INTO v_new_row_id;/);
  });

  it('qualify_referral\'s UPDATE...WHERE status=\'pending\' AND qualifying_ticket_id IS NULL guard applies identically whether invoked from the card or wallet path, since it is the exact same function object', () => {
    const matches = migration.match(/CREATE OR REPLACE FUNCTION public\.qualify_referral/g) ?? [];
    expect(matches.length).toBe(0);
    expect(cashoutMaturation).toMatch(/CREATE OR REPLACE FUNCTION public\.qualify_referral\(p_referred_user_id uuid, p_ticket_id uuid\)/);
  });
});

describe('scenario 7: maturation timestamp (activated_at) behavior is correct for wallet-triggered qualification', () => {
  it('qualify_referral (0084, reused unmodified) stamps activated_at = now() on the same guarded UPDATE, regardless of caller', () => {
    expect(cashoutMaturation).toMatch(
      /UPDATE public\.vc_transactions\s*\n\s*SET status = 'active', qualifying_ticket_id = p_ticket_id, activated_at = now\(\)/
    );
  });

  it('the cash-out maturation check (request_vc_cashout, untouched by this migration) keys off COALESCE(activated_at, earned_at) for both card- and wallet-qualified referral rows alike', () => {
    expect(cashoutMaturation).toMatch(/COALESCE\(activated_at, earned_at\) > now\(\) - make_interval\(hours => v_hold_hours\)/);
  });

  it('this migration does not redefine qualify_referral or request_vc_cashout, so the activated_at/maturation behavior is unmodified for both invocation paths', () => {
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.qualify_referral/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.request_vc_cashout/);
  });
});
