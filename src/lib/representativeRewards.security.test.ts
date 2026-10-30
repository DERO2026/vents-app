import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('credits the VENTS Wallet at most once per claim', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX user_wallet_transactions_earn_reward_ref_idx/);
    expect(fn('claim_representative_reward')).toMatch(/ON CONFLICT \(reference_id\) WHERE \(type = 'earn_reward' AND reference_id IS NOT NULL\) DO NOTHING/);
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
