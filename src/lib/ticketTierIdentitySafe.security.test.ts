import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Finding N3 (owner-authorized 2026-11-26): 0229's older-app positional
// fallback could move a tier's sales and in-checkout orders to a different
// tier, and made legacy duplicate-name events uneditable. Migration 0231.
// Behaviour is proven on a real PostgreSQL by
// scripts/local-pg-test/run-ticket-tier-identity-safe-verification.sh (and its
// mutation test); these static guards keep the shape from regressing in CI.

const root = join(__dirname, '..', '..');
let m: string; let undo: string; let m229: string; let editor: string;
let fn: string;

beforeAll(() => {
  m = readFileSync(join(root, 'supabase', 'migrations', '0231_ticket_tier_identity_safe.sql'), 'utf8');
  m229 = readFileSync(join(root, 'supabase', 'migrations', '0229_ticket_tier_rename.sql'), 'utf8');
  undo = readFileSync(join(root, 'supabase', 'rollback', 'undo_0231.sql'), 'utf8');
  editor = readFileSync(join(root, 'src', 'app', 'components', 'CreateEventScreen.tsx'), 'utf8');
  const i = m.indexOf('CREATE OR REPLACE FUNCTION public.events_ticket_tier_identity()');
  fn = m.slice(i, m.indexOf('$function$;', i));
});

describe('0231: tier identity never uses the client\'s positional id', () => {
  it('the replacement trigger never reads the per-save `id`', () => {
    expect(fn).not.toMatch(/->>'id'/);
    expect(fn).toContain('[0231]');
  });
  it('a keyless (older app) tier is matched by its current name only', () => {
    expect(fn).toContain("WHERE o->>'name' = v_tier->>'name' ORDER BY ord OFFSET v_occ - 1 LIMIT 1;");
  });
  it('the sales check is SECURITY DEFINER (not hidden by the caller\'s RLS) and the function is not client-callable', () => {
    expect(fn).toMatch(/LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path TO ''/);
    expect(m).toContain('REVOKE ALL ON FUNCTION public.events_ticket_tier_identity() FROM PUBLIC, anon, authenticated;');
  });
});

describe('0231: refusals that protect sales and orders', () => {
  it('older-app drop of a sold / ordered tier together with an unmatched new tier is refused, with an actionable message', () => {
    expect(fn).toContain('IF v_any_keyless AND v_unmatched_keyless THEN');
    expect(fn).toMatch(/FROM public\.tickets t\s+WHERE t\.event_id = NEW\.id/);
    expect(fn).toMatch(/FROM public\.pending_purchases pp\s+WHERE pp\.event_id = NEW\.id AND pp\.status = 'pending'/);
    expect(fn).toContain('Update the VENTS app and try again');
  });
  it('no tier may take a name that another (or a removed) tier\'s tickets or open orders were bought under', () => {
    expect(fn).toContain("A different ticket type can''t use that name");
  });
  it('no save may create a NEW duplicate name; legacy duplicates are kept with distinct keys', () => {
    expect(fn).toContain("Two ticket types can''t both be called");
    expect(fn).toContain("v_ident := v_base || '#' || v_occ;");
  });
  it('keeps 0229\'s rename-clash rule and server-maintained previous_names', () => {
    expect(fn).toContain('is already used, or was used before, by another ticket type');
    expect(fn).toContain("'previous_names', v_prev");
  });
  it('rewrites no ticket, order, payment or event row', () => {
    expect(m).not.toMatch(/UPDATE public\.|DELETE FROM|INSERT INTO public\./);
  });
});

describe('0231 safety rails', () => {
  it('requires the exact 0229 function and refuses a second run', () => {
    expect(m).toContain('0231 requires 0229');
    expect(m).toContain('is not the expected (0229) version');
    expect(m).toContain('already patched; refusing to run twice');
  });
  it('undo restores 0229\'s function text verbatim and is gated', () => {
    const i = m229.indexOf('CREATE FUNCTION public.events_ticket_tier_identity()');
    const original = m229.slice(i, m229.indexOf('$function$;', i) + '$function$;'.length).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
    expect(undo).toContain(original);
    expect(undo).toContain("'undo-0231'");
  });
  it('has a database verification suite and a mutation test', () => {
    for (const f of ['run-ticket-tier-identity-safe-verification.sh', 'run-ticket-tier-identity-safe-mutation-test.sh']) {
      expect(existsSync(join(root, 'scripts', 'local-pg-test', f))).toBe(true);
    }
  });
});

describe('event editor (current app) always sends a stable tier key', () => {
  it('loaded tiers keep their key (legacy: name) and new tiers get a fresh one', () => {
    expect(editor).toContain("key: (typeof t.key === 'string' && t.key) || t.name || undefined,");
    expect(editor).toMatch(/key: newTierKey\(\)/);
    expect((editor.match(/\.\.\.\(t\.key \? \{ key: t\.key \} : \{\}\)/g) || []).length).toBe(2);
  });
});
