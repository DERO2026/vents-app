import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Finding N1 (owner-authorized 2026-11-26): a price or promo change during an
// open checkout must never change what the buyer pays or receives.
// Migration 0230. Behaviour is proven on a real PostgreSQL by
// scripts/local-pg-test/run-checkout-price-snapshot-verification.sh (and its
// mutation test); these static guards keep the shape from regressing in CI.

const root = join(__dirname, '..', '..');
const migDir = join(root, 'supabase', 'migrations');
let m: string; let undo: string; let undo0229: string;

// (anchor, replacement) pairs of every in-place patch of `sig` in `text`.
function patchPairs(text: string, fn: string, sig: string): [string, string][] {
  const out: [string, string][] = [];
  const esc = sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const call of text.matchAll(new RegExp(`${fn}\\('${esc}',\\s*ARRAY\\[([\\s\\S]*?)\\n\\]\\);`, 'g'))) {
    const vals = [...call[1].matchAll(/(\$a\$)([\s\S]*?)\1/g)].map((x) => x[2]);
    for (let i = 0; i + 1 < vals.length; i += 2) out.push([vals[i], vals[i + 1]]);
  }
  return out;
}

const SIGS = [
  'public.create_pending_purchase(uuid,text,jsonb,text,text)',
  'public.finalize_pending_purchase(text)',
  'public.confirm_ticket_payment(text,bigint)',
  'public.confirm_ticket_payment_via_wallet(text)',
  'public.initiate_ticket_payment_attempt(text)',
];

beforeAll(() => {
  m = readFileSync(join(migDir, '0230_checkout_price_snapshot.sql'), 'utf8');
  undo = readFileSync(join(root, 'supabase', 'rollback', 'undo_0230.sql'), 'utf8');
  undo0229 = readFileSync(join(root, 'supabase', 'rollback', 'undo_0229.sql'), 'utf8');
});

describe('0230: the agreed quote is snapshotted and honoured', () => {
  it('stores unit price, discount, quantity, fee breakdown, currency and tier identity on the order', () => {
    for (const col of ['quote_unit_price', 'quote_discount_pct', 'quote_quantity', 'quote_face_kobo', 'quote_service_fee_kobo',
      'quote_discount_kobo', 'quote_organizer_deduction_kobo', 'quote_currency', 'quote_tier_key', 'quoted_at']) {
      expect(m).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
    expect(m).toMatch(/quote_currency = 'NGN'/);
  });

  it('the snapshot is immutable once written', () => {
    expect(m).toContain('CREATE TRIGGER trg_pending_purchases_quote_immutable');
    expect(m).toContain("cannot be changed after it is created");
  });

  it('finalize issues tickets at the snapshot price and discount, and refuses a different tier', () => {
    const [[, finalize]] = patchPairs(m, 'pg_temp.vents_0230_patch', SIGS[1]);
    expect(finalize).toContain('v_unit_price := v_row.quote_unit_price;');
    expect(finalize).toContain('v_discount_pct := v_row.quote_discount_pct;');
    expect(finalize).toContain('ticket type for this order has changed');
  });

  it('confirm and wallet cross-check the agreed total; wallet debits nothing on a mismatch', () => {
    const confirm = patchPairs(m, 'pg_temp.vents_0230_patch', SIGS[2]).map((p) => p[1]).join('\n');
    expect(confirm).toMatch(/pp\.amount_kobo IS DISTINCT FROM v_expected_kobo[\s\S]*RETURN 'amount_mismatch:'/);
    const wallet = patchPairs(m, 'pg_temp.vents_0230_patch', SIGS[3]).map((p) => p[1]).join('\n');
    expect(wallet).toMatch(/pp\.amount_kobo IS DISTINCT FROM v_expected_kobo[\s\S]*nothing was charged/);
  });

  it('no charge starts against a stale quote (card attempt and wallet), and the order is not mutated', () => {
    const initiate = patchPairs(m, 'pg_temp.vents_0230_patch', SIGS[4]).map((p) => p[1]).join('\n');
    expect(initiate).toContain('public.ticket_order_quote_problem(v_row.payment_ref)');
    const wallet = patchPairs(m, 'pg_temp.vents_0230_patch', SIGS[3]).map((p) => p[1]).join('\n');
    expect(wallet).toContain('public.ticket_order_quote_problem(p_payment_ref)');
    const helper = m.slice(m.indexOf('CREATE FUNCTION public.ticket_order_quote_problem'), m.indexOf('-- ── 3.'));
    expect(helper).not.toMatch(/UPDATE\s+public\./i);
    expect(helper).not.toMatch(/INSERT\s+INTO/i);
  });

  it('an open order is reused only if its quote equals the new quote', () => {
    const [reuse] = patchPairs(m, 'pg_temp.vents_0230_patch', SIGS[0]);
    expect(reuse[1]).toContain('AND quote_unit_price = v_unit_price');
    expect(reuse[1]).toContain('AND quote_discount_pct = v_discount_pct');
    expect(reuse[1]).toContain('AND amount_kobo = v_amount_kobo');
  });
});

describe('0230 does not change the fee model or historical records', () => {
  it('never redefines a 0208 fee helper or references a retired fee model', () => {
    expect(m).not.toMatch(/FUNCTION public\.ticket_fee_/);
    expect(m).not.toMatch(/v2_4_5/);
    expect(m).not.toMatch(/\b(0\.04|0\.05)\b/);
  });
  it('touches no ticket, wallet, ledger or refund row', () => {
    expect(m).not.toMatch(/UPDATE public\.(tickets|user_wallets|organizer_wallets|organizer_transactions|ticket_refunds)\b/);
    expect(m).not.toMatch(/DELETE FROM/i);
  });
});

describe('0230 safety rails', () => {
  it('requires 0229 and refuses drift and a second run', () => {
    expect(m).toContain('0230 requires 0229');
    expect(m).toContain('not the expected version');
    expect(m).toContain('already patched; refusing to run twice');
  });
  it('undo reverses every patch exactly, is gated, and keeps the stored quotes', () => {
    expect(undo).toContain("'undo-0230'");
    for (const sig of SIGS) {
      const fwd = patchPairs(m, 'pg_temp.vents_0230_patch', sig);
      const back = patchPairs(undo, 'pg_temp.vents_undo_0230', sig);
      expect(fwd.length).toBeGreaterThan(0);
      expect(back).toEqual([...fwd].reverse().map(([a, b]) => [b, a]));
    }
    expect(undo).not.toMatch(/DROP COLUMN/i);
  });
  it('undo_0229 refuses while 0230 is applied', () => {
    expect(undo0229).toContain('run undo_0230.sql first');
  });
  it('has a database verification suite and a mutation test', () => {
    expect(existsSync(join(root, 'scripts', 'local-pg-test', 'run-checkout-price-snapshot-verification.sh'))).toBe(true);
    expect(existsSync(join(root, 'scripts', 'local-pg-test', 'run-checkout-price-snapshot-mutation-test.sh'))).toBe(true);
  });
});
