import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guard for migration 0221 (event attendance visibility). The real
// behaviour -- the leak reproduced before 0221, then every role against every
// count RPC, RLS on the setting, purchases/QR/check-in/refunds, undo and drift
// -- is exercised in scripts/local-pg-test/run-attendance-visibility-verification.sh.
// This pins what a later edit could silently drop.
const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const m = read('supabase/migrations/0221_event_attendance_visibility.sql');
const undo = read('supabase/rollback/undo_0221.sql');
const PRIV = 'e.show_attendance_count OR e.organizer_id = auth.uid() OR public.is_admin()';

describe('0221: the setting', () => {
  it('is NOT NULL DEFAULT true, so every existing and new event keeps its count public', () => {
    expect(m).toContain('ALTER TABLE public.events ADD COLUMN IF NOT EXISTS show_attendance_count boolean NOT NULL DEFAULT true;');
  });
  it('adds no policy and no grant on events (the existing organizer/admin UPDATE policy governs it)', () => {
    expect(m).not.toMatch(/CREATE POLICY|ALTER POLICY|GRANT [A-Z, ]+ ON (TABLE )?public\.events/);
  });
});

describe('0221: hidden counts are withheld server-side', () => {
  it('get_event_ticket_stats returns no row for a hidden event except to its organizer and admins', () => {
    expect(m).toContain(`    AND (${PRIV})\n  GROUP BY t.event_id, e.organizer_id;`);
  });
  it('pending / cancelled / refunded counts are organizer/admin-only for every event', () => {
    for (const col of ['pending_count', 'cancelled_count', 'refunded_count']) {
      expect(m).toMatch(new RegExp(`CASE WHEN e\\.organizer_id = auth\\.uid\\(\\) OR public\\.is_admin\\(\\)\\n\\s+THEN count\\(\\*\\) FILTER \\([^)]*\\)::integer END AS ${col}`));
    }
  });
  it('get_event_ticket_type_availability gives a NULL sold_count to the public for a hidden event, with sold_out', () => {
    expect(m).toContain('RETURNS TABLE(ticket_type text, sold_count integer, sold_out boolean)');
    expect(m).toContain(`(${PRIV}) IS TRUE AS can_see`);
    expect(m).toContain('CASE WHEN ev.can_see THEN COALESCE(s.n, 0) END');
  });
  it('get_event_trending_scores scores a hidden event on saves only and withholds raw sales figures', () => {
    expect(m).toContain("(CASE WHEN e.show_attendance_count\n       THEN COALESCE(recent.recent_sold, 0) * 5.0 + COALESCE(total.total_sold, 0) * 2.0\n       ELSE 0 END");
    expect(m).toContain('CASE WHEN e.organizer_id = auth.uid() OR public.is_admin() THEN COALESCE(total.total_sold, 0) END');
  });
  it('every rewritten function stays SECURITY DEFINER with an empty search_path', () => {
    const headers = m.match(/ LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO ''\nAS \$function\$/g) ?? [];
    expect(headers.length).toBe(3);
  });
});

describe('0221: safe to apply and to roll back', () => {
  it('refuses unless each function is the repository version (md5) or already patched', () => {
    for (const md5 of ['b2548724d5d18d2c99770cf97c27f4a4', '864e737ffd0e8019d70c74bf82c9ba20', 'bc02a20185367e9f15074dda1ce2bdf7']) {
      expect(m).toContain(md5);
      expect(undo).toContain(md5);
    }
    expect(m).toContain("is not the expected version (md5 of its body differs from the repository''s); refusing");
  });
  it('re-creating the availability function restores its owner and EXECUTE grants', () => {
    expect(m).toContain("EXECUTE format('ALTER FUNCTION public.get_event_ticket_type_availability(uuid) OWNER TO %I', v.owner);");
    expect(m).toContain("EXECUTE format('GRANT EXECUTE ON FUNCTION public.get_event_ticket_type_availability(uuid) TO %s', g);");
  });
  it('changes no ticket and no unrelated function', () => {
    expect(m).not.toMatch(/^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+public\./m);
    const replaced = [...m.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_]+)\(/g)].map((x) => x[1]);
    expect(new Set(replaced)).toEqual(new Set(['get_event_ticket_stats', 'get_event_ticket_type_availability', 'get_event_trending_scores']));
  });
  it('the undo is confirmation-gated and refuses to re-expose hidden counts without a second, explicit flag', () => {
    expect(undo).toContain("IS DISTINCT FROM 'undo-0221' THEN");
    expect(undo).toContain("current_setting('vents.rollback_reexpose_hidden_counts', true) IS DISTINCT FROM 'yes'");
    expect(undo).toContain('was not restored to its exact pre-0221 body; refusing');
  });
});
