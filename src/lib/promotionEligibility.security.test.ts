import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guards for 0225_promotion_eligibility.sql / undo_0225.sql. Behaviour
// is proven by real execution in scripts/local-pg-test/run-coming-soon-
// verification.sh (section "0225"); these keep the shape from regressing.

let m: string; let undo: string; const src: Record<string, string> = {};
const fnIn = (t: string, name: string) => [...t.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$`, 'g'))].pop()?.[1] ?? '';
const ORIG = {
  activate_event_promotion: '0180_reject_boosted_event_promotion_activation',
  admin_set_event_featured: '0090_harden_event_featuring',
  admin_set_event_trending: '0182_admin_manual_trending_control',
} as const;

beforeAll(() => {
  const root = join(__dirname, '..', '..');
  m = readFileSync(join(root, 'supabase', 'migrations', '0225_promotion_eligibility.sql'), 'utf8');
  undo = readFileSync(join(root, 'supabase', 'rollback', 'undo_0225.sql'), 'utf8');
  for (const [n, f] of Object.entries(ORIG)) src[n] = readFileSync(join(root, 'supabase', 'migrations', `${f}.sql`), 'utf8');
});

describe('0225: one eligibility rule', () => {
  it('on sale only: exists, not deleted, not cancelled, not admin-hidden, live/published, not ended', () => {
    const r = fnIn(m, 'event_promotion_block_reason');
    for (const c of ["WHEN e.id IS NULL THEN 'not_found'", "WHEN e.deleted_at IS NOT NULL THEN 'deleted'", "WHEN e.cancelled_at IS NOT NULL THEN 'cancelled'",
      "WHEN e.hidden_by_admin THEN 'hidden_by_admin'", "WHEN e.status NOT IN ('live', 'published') THEN 'not_on_sale'",
      "WHEN now() >= public.event_effective_end_at(e.event_date, e.end_date) THEN 'ended'"]) expect(r).toContain(c);
    expect(m).toContain('GRANT EXECUTE ON FUNCTION public.event_promotion_block_reason(uuid) TO project_admin;');
    expect(m).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.event_promotion_block_reason\(uuid\) TO[^;]*authenticated/);
  });
});

describe('0225: the three granting functions are the repo bodies plus only the check', () => {
  it('activate_event_promotion: replay no-op first, then the eligibility check; nothing else changed', () => {
    const b = fnIn(m, 'activate_event_promotion');
    const replay = b.indexOf('IF EXISTS (SELECT 1 FROM public.event_promotions WHERE payment_ref = p_payment_ref) THEN');
    const check = b.indexOf('v_block := public.event_promotion_block_reason(p_event_id);');
    expect(replay).toBeGreaterThan(b.indexOf("RAISE EXCEPTION 'You do not own this event';"));
    expect(check).toBeGreaterThan(replay);
    expect(check).toBeLessThan(b.indexOf('INSERT INTO public.event_promotions'));
    const stripped = b.replace('  v_block    text;\n', '').replace(/\n  -- 0225: a replayed reference[\s\S]*?  END IF;\n  v_block := [\s\S]*?  END IF;\n/, '');
    expect(stripped).toBe(fnIn(src.activate_event_promotion, 'activate_event_promotion'));
  });
  it('admin_set_event_featured: check only when featuring; un-featuring untouched', () => {
    const b = fnIn(m, 'admin_set_event_featured');
    const stripped = b.replace('  v_block    text;\n', '').replace(/    -- 0225: only an event that is on sale can be featured\.\n[\s\S]*?    END IF;\n/, '');
    expect(stripped).toBe(fnIn(src.admin_set_event_featured, 'admin_set_event_featured'));
    expect(b.indexOf('v_block := public.event_promotion_block_reason')).toBeGreaterThan(b.indexOf('  IF p_featured THEN\n    -- 0225'));
  });
  it('admin_set_event_trending: adds the check after the existing ones; nothing else changed', () => {
    const b = fnIn(m, 'admin_set_event_trending');
    const stripped = b.replace('  v_block text;\n', '').replace(/    -- 0225: also refuses cancelled and ended events[\s\S]*?    END IF;\n/, '');
    expect(stripped).toBe(fnIn(src.admin_set_event_trending, 'admin_set_event_trending'));
  });
  it('refuses to apply over a drifted production definition (md5 pins)', () => {
    expect(m).toContain("SELECT md5(replace(p.prosrc, E'\\r', '')) INTO v_live");
    expect(m).toMatch(/differs from the definition this migration was written against/);
    for (const n of Object.keys(ORIG)) expect(m).toMatch(new RegExp(`"${n}": "[0-9a-f]{32}"`));
  });
  it('does not touch prices, durations, the Paystack route or grants on the paid path', () => {
    expect(m).not.toMatch(/(GRANT|REVOKE)[^;]*activate_event_promotion/);
    expect(fnIn(m, 'activate_event_promotion')).toContain("IF p_duration_days NOT IN (3, 7, 14, 30) THEN");
    const sql = m.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/price|amount|kobo|paystack\.co/i);
  });
});

describe('0225: event_promotions has no client writes', () => {
  it('drops the 0008 write policies and revokes INSERT/UPDATE/DELETE from clients', () => {
    for (const p of ['insert', 'update', 'delete']) expect(m).toContain(`DROP POLICY IF EXISTS ${p}_event_promotions ON public.event_promotions;`);
    expect(m).toContain('REVOKE INSERT, UPDATE, DELETE ON public.event_promotions FROM PUBLIC, anon, authenticated;');
    expect(m).not.toMatch(/DROP POLICY[^;]*select_event_promotions/);
  });
});

describe('undo_0225.sql', () => {
  it('is gated, restores the three bodies verbatim, and warns that it re-opens the write gap', () => {
    expect(undo).toContain("IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0225' THEN");
    for (const n of Object.keys(ORIG)) expect(fnIn(undo, n)).toBe(fnIn(src[n], n));
    expect(undo).toMatch(/WARNING: that last step re-opens the gap 0225 closed/);
    let top = undo;
    for (const n of Object.keys(ORIG)) top = top.replace(fnIn(undo, n), '');
    expect(top.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')).not.toMatch(/\b(DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO\s+public\.event_promotions)/i);
  });
});
