import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// D2a (owner, 2026-11-26): organizers may rename a ticket tier after sales.
// Migration 0229. Behaviour is proven on a real PostgreSQL by
// scripts/local-pg-test/run-ticket-tier-rename-verification.sh; these static
// guards keep the shape from regressing in CI.

const root = join(__dirname, '..', '..');
const migDir = join(root, 'supabase', 'migrations');
let m: string; let undo: string; let editor: string;
const read = (f: string) => readFileSync(join(migDir, f), 'utf8');
const migFile = (prefix: string) => readdirSync(migDir).find((f) => f.startsWith(prefix));

// Latest CREATE OR REPLACE text of a function in migrations before `before`.
function lastDef(name: string, before: string): string {
  let d = '';
  for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql') && x.slice(0, 4) < before).sort()) {
    const t = readFileSync(join(migDir, f), 'utf8');
    const starts = [...t.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`, 'g'))];
    if (!starts.length) continue;
    const s = starts[starts.length - 1].index!;
    const tag = /AS (\$[A-Za-z_]*\$)/.exec(t.slice(s))!;
    const bodyStart = s + tag.index! + tag[0].length;
    d = t.slice(s, t.indexOf(tag[1], bodyStart) + tag[1].length);
  }
  return d;
}
// (anchor, replacement) pairs of every in-place patch of `sig` in `text`.
function patchPairs(text: string, sig: string): [string, string][] {
  const out: [string, string][] = [];
  const esc = sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const call of text.matchAll(new RegExp(`vents_\\d+_patch\\('${esc}'(?:,\\s*'[0-9a-f]+')?,\\s*ARRAY\\[([\\s\\S]*?)\\n\\]\\);`, 'g'))) {
    const vals = [...call[1].matchAll(/(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1/g)].map((x) => x[2]);
    for (let i = 0; i + 1 < vals.length; i += 2) out.push([vals[i], vals[i + 1]]);
  }
  return out;
}
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

beforeAll(() => {
  m = read('0229_ticket_tier_rename.sql');
  undo = readFileSync(join(root, 'supabase', 'rollback', 'undo_0229.sql'), 'utf8');
  editor = readFileSync(join(root, 'src', 'app', 'components', 'CreateEventScreen.tsx'), 'utf8');
});

describe('0229 anchors survive every earlier in-place patch', () => {
  const chain: Record<string, string[]> = {
    'public.purchase_ticket(uuid,text,jsonb,text,text)': ['0220'],
    'public.create_pending_purchase(uuid,text,jsonb,text,text)': ['0203', '0208'],
    'public.finalize_pending_purchase(text)': [],
    'public.get_event_analytics(uuid)': ['0203', '0208'],
  };
  for (const [sig, earlier] of Object.entries(chain)) {
    it(`${sig}: each 0229 anchor matches exactly once after ${earlier.join(', ') || 'no earlier patch'}`, () => {
      const name = sig.split('.')[1].split('(')[0];
      let body = lastDef(name, '0229');
      expect(body).not.toBe('');
      for (const p of earlier) {
        const f = migFile(p);
        if (!f) continue; // 0220 lives in its own PR until merged
        for (const [a, b] of patchPairs(read(f), sig)) {
          expect(count(body, a), `${p} anchor`).toBe(1);
          body = body.replace(a, b);
        }
      }
      const mine = patchPairs(m, sig);
      expect(mine.length).toBeGreaterThan(0);
      for (const [a] of mine) expect(count(body, a)).toBe(1);
    });
  }
  it('get_event_ticket_type_availability (0221 body): the anchor matches exactly once', () => {
    const t = read('0221_event_attendance_visibility.sql');
    const body = t.slice(t.indexOf('CREATE FUNCTION public.get_event_ticket_type_availability'));
    const [[a]] = patchPairs(m, 'public.get_event_ticket_type_availability(uuid)');
    expect(count(body, a)).toBe(1);
  });
});

describe('undo_0229 is the exact reverse', () => {
  it('every 0229 patch pair appears swapped in the undo, and nothing else is patched', () => {
    const sigs = [...m.matchAll(/vents_0229_patch\('([^']+)'/g)].map((x) => x[1]);
    expect(sigs).toHaveLength(5);
    for (const sig of sigs) {
      const fwd = patchPairs(m, sig);
      const rev = patchPairs(undo.replace(/vents_undo_0229\(/g, 'vents_0229_patch('), sig);
      expect(rev).toEqual(fwd.map(([a, b]) => [b, a]));
    }
    expect(undo).toContain("IS DISTINCT FROM 'undo-0229'");
    expect(undo).toMatch(/DROP TRIGGER IF EXISTS trg_events_ticket_tier_identity ON public\.events;/);
    expect(undo).not.toMatch(/UPDATE public\.(tickets|events|pending_purchases)|DELETE FROM/);
  });
});

describe('historical accuracy', () => {
  it('0229 never writes tickets, pending purchases, payments or ledgers', () => {
    const sql = m.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/UPDATE public\.(tickets|pending_purchases|organizer_wallets|organizer_transactions|earnings_holds)|INSERT INTO public\.tickets|DELETE FROM/);
  });
  it('previous_names is server-maintained: built only from the old row, never from the client', () => {
    expect(m).toContain("v_prev := CASE WHEN jsonb_typeof(v_old->'previous_names') = 'array' THEN v_old->'previous_names' ELSE '[]'::jsonb END;");
    expect(m).not.toMatch(/v_prev := [^;]*v_tier->'previous_names'/);
  });
  it('door scanning and check-in do not depend on tier names', () => {
    for (const fn of ['verify_entry_pass', 'manual_check_in', 'generate_ticket_token']) {
      const body = lastDef(fn, '0229');
      expect(body, fn).not.toBe('');
      expect(body, fn).not.toMatch(/ticket_types|ticket_type\s*=/);
    }
    expect(existsSync(join(migDir, '0229_ticket_tier_rename.sql'))).toBe(true);
  });
});

describe('editor (CreateEventScreen)', () => {
  it('keeps each tier\'s key (legacy tiers: the loaded name), gives new tiers a fresh key, and sends it on save', () => {
    expect(editor).toContain("key: (typeof t.key === 'string' && t.key) || t.name || undefined,");
    expect(editor).toContain("key: newTierKey() }]);");
    expect(count(editor, '...(t.key ? { key: t.key } : {}),')).toBe(2);
  });
  it('the "quantity below sold" check counts sales under every name the tier has had', () => {
    expect(editor).toContain(".in('ticket_type', Array.from(new Set([t.name.trim(), ...(t.previousNames || [])])))");
  });
});
