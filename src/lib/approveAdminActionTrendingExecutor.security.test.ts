import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression coverage for the confirmed production defect fixed by
// supabase/migrations/0185_approve_admin_action_trending_executor.sql:
// approve_admin_action() had no CASE branch for 'toggle_event_trending', the
// action type adminUserEventActions.ts's toggleEventTrending() submits via
// request_admin_action() whenever the caller isn't a Super Admin -- same bug
// class 0183 already fixed for set_organizer_capability/
// set_service_provider_capability.
//
// REVISED after a follow-up audit found the first draft's
// COALESCE((r.payload->>'trending')::boolean, false) fallback could silently
// turn an intended "enable" into a no-op/disable on approval, since a
// missing payload key is indistinguishable from an explicit false under
// COALESCE. Fixed on both ends: toggleEventTrending() now sends
// `payload: { trending: nextTrending }`, and this branch now validates that
// payload strictly (matching set_organizer_capability's reject-on-missing
// pattern) instead of defaulting it.
//
// Static-text assertions against the migration file itself (same convention
// as adminManualTrendingControl.security.test.ts), since 0185 has not been
// applied to any database -- this proves the file's own content, not live
// Postgres behavior.

let m0185: string;

beforeAll(() => {
  m0185 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0185_approve_admin_action_trending_executor.sql'),
    'utf8'
  );
});

describe('0185: approve_admin_action gains a toggle_event_trending executor', () => {
  it('adds a CASE branch for toggle_event_trending that dispatches to admin_set_event_trending with the validated payload value', () => {
    expect(m0185).toMatch(/WHEN 'toggle_event_trending' THEN\s*\n\s*IF r\.payload->>'trending' IS NULL OR r\.payload->>'trending' NOT IN \('true', 'false'\) THEN\s*\n\s*RAISE EXCEPTION 'toggle_event_trending requires a boolean payload\.trending \(got: %\)', r\.payload->>'trending';\s*\n\s*END IF;\s*\n\s*PERFORM public\.admin_set_event_trending\(r\.target_id, \(r\.payload->>'trending'\)::boolean\);/);
  });

  it('validates strictly like set_organizer_capability/set_service_provider_capability, NOT toggle_event_featured\'s COALESCE-to-false pattern', () => {
    const trendingBranch = m0185.match(/WHEN 'toggle_event_trending' THEN[\s\S]*?PERFORM public\.admin_set_event_trending\([^;]*\);/)?.[0] ?? '';
    expect(trendingBranch).toMatch(/RAISE EXCEPTION 'toggle_event_trending requires a boolean payload\.trending/);
    expect(trendingBranch).not.toMatch(/COALESCE/);
    // toggle_event_featured keeps its own, separate, pre-existing pattern --
    // this migration does not touch that branch at all.
    expect(m0185).toMatch(/WHEN 'toggle_event_featured'\s*THEN PERFORM public\.admin_set_event_featured\(\s*r\.target_id,\s*COALESCE\(\(r\.payload->>'featured'\)::boolean, false\),\s*COALESCE\(\(r\.payload->>'duration_days'\)::integer, 14\)\);/);
  });

  it('a missing or malformed payload.trending raises before admin_set_event_trending is ever reached', () => {
    const trendingBranch = m0185.match(/WHEN 'toggle_event_trending' THEN[\s\S]*?PERFORM public\.admin_set_event_trending\([^;]*\);/)?.[0] ?? '';
    const ifIdx = trendingBranch.indexOf('RAISE EXCEPTION');
    const performIdx = trendingBranch.indexOf('PERFORM public.admin_set_event_trending');
    expect(ifIdx).toBeGreaterThan(-1);
    expect(performIdx).toBeGreaterThan(ifIdx); // validation precedes dispatch
  });

  it('preserves every pre-existing branch untouched (spot-check a representative sample across the CASE)', () => {
    expect(m0185).toMatch(/WHEN 'set_organizer_capability' THEN/);
    expect(m0185).toMatch(/WHEN 'set_service_provider_capability' THEN/);
    expect(m0185).toMatch(/WHEN 'credit_vents_cents'\s*THEN PERFORM public\.admin_credit_vents_cents\(r\.target_id, \(r\.payload->>'amount'\)::numeric, r\.payload->>'reason'\);/);
    expect(m0185).toMatch(/WHEN 'debit_vents_cents'\s*THEN PERFORM public\.admin_debit_vents_cents\(r\.target_id, \(r\.payload->>'amount'\)::integer, r\.payload->>'reason'\);/);
    expect(m0185).toMatch(/ELSE RAISE EXCEPTION 'No executor mapped for action_type: %', r\.action_type;/);
  });

  it('preserves the Super-Admin-only gate, self-approval block, and row lock ahead of the CASE', () => {
    expect(m0185).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(m0185).toMatch(/SELECT \* INTO r FROM public\.admin_action_requests WHERE id = p_request_id FOR UPDATE;/);
    expect(m0185).toMatch(/IF r\.requested_by = auth\.uid\(\) THEN\s*\n\s*RAISE EXCEPTION 'Cannot approve your own request';/);
  });

  it('preserves the post-CASE status update, admin_logs insert, and notification exactly as live', () => {
    expect(m0185).toMatch(/SET status = 'approved', reviewed_by = auth\.uid\(\), reviewed_at = now\(\), seen_at = COALESCE\(seen_at, now\(\)\)/);
    expect(m0185).toMatch(/INSERT INTO public\.admin_logs/);
    expect(m0185).toMatch(/INSERT INTO public\.notifications/);
  });

  it('is SECURITY DEFINER with an empty search_path, matching the live function', () => {
    expect(m0185).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path TO ''/);
  });

  it('does not touch VC/financial signatures -- credit/debit_vents_cents keep their current 3-arg/2-arg live form, not migration 0170\'s unapplied 5-arg/4-arg draft', () => {
    expect(m0185).not.toMatch(/admin_credit_vents_cents\(r\.target_id, \(r\.payload->>'amount'\)::numeric, r\.payload->>'reason', false, r\.id\)/);
    expect(m0185).not.toMatch(/admin_debit_vents_cents\(r\.target_id, \(r\.payload->>'amount'\)::integer, r\.payload->>'reason', r\.id\)/);
  });
});
