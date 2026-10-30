import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Static guard for migration 0201 (VENTS Earn representative rewards).
// Real execution against Postgres lives in
// scripts/local-pg-test/run-representative-rewards-verification.sh; this
// file pins the invariants a later edit could silently drop.

const sql = readFileSync(
  join(__dirname, '..', '..', 'supabase', 'migrations', '0201_vents_earn_representative_rewards.sql'),
  'utf8',
);

function fn(name: string): string {
  const m = sql.match(new RegExp(`FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`));
  if (!m) throw new Error(`${name} not found`);
  return m[0];
}

describe('0201: money never moves by default', () => {
  it('ships with payouts disabled and the programme closed until the 10% model is reconciled', () => {
    expect(sql).toMatch(/payouts_enabled\s+boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(/legacy_commission_reconciled\s+boolean NOT NULL DEFAULT false/);
    expect(fn('claim_representative_reward')).toMatch(/IF NOT s\.legacy_commission_reconciled THEN/);
    expect(fn('claim_representative_reward')).toMatch(/IF NOT s\.payouts_enabled THEN\s+RETURN/);
  });

  it('fixes the base reward at ₦50,000 and the rate review at 9', () => {
    expect(sql).toMatch(/base_reward_kobo\s+bigint\s+NOT NULL DEFAULT 5000000 CHECK \(base_reward_kobo = 5000000\)/);
    expect(sql).toMatch(/rate_review_threshold\s+integer NOT NULL DEFAULT 9 CHECK \(rate_review_threshold = 9\)/);
  });

  it('never increases a rate automatically: only the dual-control executor writes monthly rates', () => {
    const writers = [...sql.matchAll(/INSERT INTO public\.representative_monthly_rates/g)];
    expect(writers).toHaveLength(1);
    expect(fn('earn_execute_admin_action')).toMatch(/INSERT INTO public\.representative_monthly_rates/);
  });
});

describe('0201: realized profit, reservations and idempotency', () => {
  it('reserves under a lock on the single pool row and refuses when profit is short', () => {
    const f = fn('claim_representative_reward');
    expect(f).toMatch(/SELECT \* INTO v_pool FROM public\.earn_profit_pool WHERE id FOR UPDATE;\s+IF v_pool\.available_kobo < c\.amount_kobo THEN/);
    expect(f).toMatch(/SELECT \* INTO c FROM public\.representative_reward_claims WHERE id = p_claim_id FOR UPDATE/);
  });

  it('credits the withdrawable earnings wallet at most once per claim, through the existing ledger', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX organizer_transactions_rep_reward_once\s+ON public\.organizer_transactions \(\(metadata->>'representative_reward_claim_id'\)\)\s+WHERE type = 'representative_reward';/);
    const f = fn('claim_representative_reward');
    expect(f).toMatch(/INSERT INTO public\.organizer_transactions[\s\S]*?'representative_reward'[\s\S]*?ON CONFLICT \(\(metadata->>'representative_reward_claim_id'\)\) WHERE type = 'representative_reward' DO NOTHING/);
    // The balance only moves when the ledger row was actually inserted.
    expect(f).toMatch(/IF v_tx IS NOT NULL THEN\s+INSERT INTO public\.organizer_wallets/);
  });

  it('never touches the VENTS Wallet or VENTS Cents', () => {
    expect(sql).not.toMatch(/(INSERT INTO|UPDATE|ALTER TABLE) public\.(user_wallets|user_wallet_transactions|vc_transactions)/);
  });

  it('reverses only from the available earnings balance, never pending or withdrawn money', () => {
    const f = fn('earn_execute_admin_action');
    expect(f).toMatch(/SELECT balance_kobo INTO v_wallet FROM public\.organizer_wallets WHERE organizer_id = c\.representative_id FOR UPDATE;\s+IF COALESCE\(v_wallet, 0\) < c\.amount_kobo THEN/);
    expect(f).toMatch(/'representative_reward_reversal'/);
    expect(f).not.toMatch(/pending_kobo|total_withdrawn_kobo/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX earn_profit_ledger_one_entry_per_claim_step/);
  });

  it('builds the fee candidate from recorded buyer fees, never from gross sales or pending money', () => {
    const f = fn('earn_event_eligibility');
    expect(f).toMatch(/ot\.metadata->>'buyer_fee_kobo'/);
    expect(f).not.toMatch(/amount_kobo\)/); // no sum over the organizer's gross credit
    expect(f).toMatch(/'pending_payments'/);
    expect(f).toMatch(/'pending_refunds'/);
    expect(f).toMatch(/'pending_purchases'/);
    expect(f).toMatch(/'settlement_hold'/);
  });

  it('recognized profit = candidate - stated costs, once per event, by two different people', () => {
    expect(sql).toMatch(/event_id\s+uuid NOT NULL UNIQUE REFERENCES public\.events\(id\)/);
    expect(sql).toMatch(/CHECK \(recognized_kobo = candidate_fee_kobo - cost_deductions_kobo\)/);
    expect(sql).toMatch(/earn_profit_recognitions_two_people CHECK \(requested_by <> approved_by\)/);
  });

  it('audit log and profit ledger are append-only', () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.earn_audit_log/);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON public\.earn_profit_ledger/);
  });
});

describe('0201: no role approves or pays itself', () => {
  it('the executor refuses the representative or organizer as requester or approver', () => {
    const f = fn('earn_execute_admin_action');
    expect(f).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(f).toMatch(/IF r\.requested_by = v_approver THEN/);
    expect(f).toMatch(/v_approver IN \(c\.representative_id, c\.organizer_id\) OR r\.requested_by IN \(c\.representative_id, c\.organizer_id\)/);
    expect(f).toMatch(/v_approver = x\.representative_id OR r\.requested_by = x\.representative_id/);
    expect(f).toMatch(/v_approver = r\.target_id OR r\.requested_by = r\.target_id/);
  });

  it('only the organizer confirms, only the representative claims', () => {
    expect(fn('respond_to_representative_reward_claim')).toMatch(/c\.organizer_id <> v_uid/);
    expect(fn('claim_representative_reward')).toMatch(/c\.representative_id <> v_uid/);
  });

  it('one representative per organizer, one reward per organizer, no self-referral', () => {
    expect(sql).toMatch(/organizer_id\s+uuid NOT NULL UNIQUE REFERENCES public\.users\(id\)/);
    expect(sql).toMatch(/representative_attributions_no_self CHECK \(representative_id <> organizer_id\)/);
    expect(sql).toMatch(/representative_reward_claims_one_per_organizer\s+ON public\.representative_reward_claims \(organizer_id\) WHERE status <> 'rejected'/);
  });

  it('yes/no payload settings must be real JSON booleans, never coerced text', () => {
    const f = fn('earn_execute_admin_action');
    for (const k of ['approve', 'free_event_verified', 'payouts_enabled', 'legacy_commission_reconciled']) {
      expect(f).toContain(`jsonb_typeof(r.payload->'${k}') IS DISTINCT FROM 'boolean'`);
      expect(f).toContain(`RAISE EXCEPTION 'payload.${k} must be true or false'`);
    }
    // approve is required: no "? 'approve'" presence guard that would let a missing value through.
    expect(f).not.toContain(`r.payload ? 'approve'`);
    // The checks run before the CASE that acts on the payload.
    expect(f.indexOf("must be true or false")).toBeLessThan(f.indexOf('CASE r.action_type'));
  });

  it('settlement_hold_days must be a JSON whole number from 0 to 120, never coerced text', () => {
    const f = fn('earn_execute_admin_action');
    expect(f).toMatch(/IF r\.payload \? 'settlement_hold_days' THEN\s+IF jsonb_typeof\(r\.payload->'settlement_hold_days'\) IS DISTINCT FROM 'number' THEN/);
    expect(f).toContain(`scale((r.payload->'settlement_hold_days')::numeric) <> 0`);
    expect(f).toContain(`(r.payload->'settlement_hold_days')::numeric NOT BETWEEN 0 AND 120`);
    // Checked before the CASE that writes earn_settings; the default stays 7.
    expect(f.indexOf('settlement_hold_days must be a whole number')).toBeLessThan(f.indexOf('CASE r.action_type'));
    expect(sql).toMatch(/settlement_hold_days\s+integer NOT NULL DEFAULT 7 CHECK \(settlement_hold_days BETWEEN 0 AND 120\)/);
  });

  it('internal functions are not callable by any client role', () => {
    for (const f of ['earn_execute_admin_action(uuid)', 'earn_pool_move(text,bigint,uuid,uuid,uuid)', 'earn_event_eligibility(uuid)']) {
      expect(sql).toContain(`'public.${f}'`);
    }
    expect(sql).toMatch(/EXECUTE format\('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f\)/);
  });

  it('tables are written only through functions (no client write grants)', () => {
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO authenticated/);
  });

  it('the maker-checker patch refuses to run unless its anchor matches exactly once', () => {
    expect(sql.match(/IF v_count <> 1 THEN/g)).toHaveLength(2);
  });
});

describe('earnings wallet screen shows representative rewards', () => {
  const wallet = readFileSync(join(__dirname, '..', 'app', 'components', 'WalletScreen.tsx'), 'utf8');

  it('labels reward credits and reversals, counting the credit as money in', () => {
    expect(wallet).toMatch(/representative_reward: 'Representative Reward',/);
    expect(wallet).toMatch(/representative_reward_reversal: 'Representative Reward Reversed',/);
    expect(wallet).toMatch(/const CREDIT_TYPES = new Set\(\['credit', 'cancelled_payout_refund', 'representative_reward'\]\);/);
  });

  it('offers withdrawal to anyone with earnings, not only organizers and providers', () => {
    expect(wallet).toMatch(/const hasEarnings = !!wallet && \(wallet\.total_earned_kobo > 0 \|\| wallet\.balance_kobo > 0 \|\| wallet\.pending_kobo > 0\);/);
    expect(wallet).toMatch(/const isEarner = [^\n]*\|\| hasEarnings;/);
  });
});

describe('CodeRabbit review of f860f5d/51d5b55', () => {
  const components = join(__dirname, '..', 'app', 'components');
  const wallet = readFileSync(join(components, 'WalletScreen.tsx'), 'utf8');
  const actions = readFileSync(join(components, 'AdminActionsTab.tsx'), 'utf8');

  it('a failed wallet read is reported, never replaced with a zero balance', () => {
    expect(wallet).toMatch(/if \(wRes\.error\) \{\s*setTxnsError\([^)]*\);\s*\} else \{\s*setWallet\(wRes\.data \|\| \{ balance_kobo: 0/);
  });

  it('linked payout accounts stay visible without an earner role', () => {
    expect(wallet).toMatch(/\{bankAccounts\.length > 0 && \(\s*<div style=\{\{ marginBottom: '24px' \}\}>\s*<p[^>]*>Payout Accounts/);
  });

  it('the approver sees non-boolean flags as INVALID and the earn payload that will execute', () => {
    expect(actions).toMatch(/v === true \? yes : v === false \? no : `INVALID/);
    expect(actions).toMatch(/earn_decide_expense: `\$\{who\} requested to \$\{earnFlag\(r\.payload\?\.approve, 'APPROVE', 'REJECT'\)\}/);
    expect(actions).toMatch(/data-testid="earn-request-payload"/);
  });

  it('the approver sees a settlement hold outside the executor rule as INVALID', () => {
    expect(actions).toMatch(/typeof v === 'number' && Number\.isInteger\(v\) && v >= 0 && v <= 120\s*\? `\$\{v\} days`\s*: `INVALID/);
    expect(actions).toContain('`settlement hold ${earnHoldDays(r.payload.settlement_hold_days)}`');
    expect(actions).not.toMatch(/settlement hold \$\{r\.payload\.settlement_hold_days\}/);
  });
});

describe('retired 10% commission model: only the fixed reward is active', () => {
  const root = join(__dirname, '..', '..');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return sourceFiles(p);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
    });
  }

  it('invitations no longer promise commission sharing or carry a commission split', () => {
    const f = fn('invite_recruiter_partnership');
    expect(f).not.toContain('share part of their commission');
    expect(f).toContain("'A VENTS representative wants to partner with you. VENTS rewards representatives directly; nothing is shared from or deducted from your earnings.'");
    expect(f).toContain("jsonb_build_object('partnershipId', v_row.id, 'recruiterId', v_uid)");
    // The body between AS $function$ and $function$ never mentions commission:
    // the old parameter is accepted (installed apps) but never stored or used.
    const body = f.slice(f.indexOf('AS $function$'));
    expect(body).not.toMatch(/commission/i);
    expect(f).toMatch(/p_commission_split_bps integer DEFAULT NULL/);
  });

  it('keeps the legacy column, its historical values and the reconciliation evidence', () => {
    expect(sql).toMatch(/ALTER TABLE public\.recruiter_partnerships ALTER COLUMN commission_split_bps DROP NOT NULL;/);
    expect(sql).not.toMatch(/DROP COLUMN|UPDATE public\.recruiter_partnerships SET commission_split_bps/);
    expect(sql).toMatch(/'partnerships_by_commission_split_bps'/);
    expect(sql).toMatch(/'commission_accrued_kobo',\s+0,\s+'commission_paid_kobo',\s+0/);
    expect(sql).toMatch(/legacy_commission_reconciled\s+boolean NOT NULL DEFAULT false/);
  });

  it('no app or API code sends, reads or computes a commission split', () => {
    const files = [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'api'))];
    const offenders = files.filter((p) =>
      /commission_split_bps|commissionSplitBps|COMMISSION_BPS|commission_rate|commission_kobo/i.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the representative invite sends only who is invited', () => {
    const screen = readFileSync(join(root, 'src', 'app', 'components', 'RepresentativesScreen.tsx'), 'utf8');
    expect(screen).toMatch(/rpc\('invite_recruiter_partnership', \{\s*p_organizer_id: [^,]+,\s*p_provider_id: [^,]+,\s*\}\)/);
  });
});
