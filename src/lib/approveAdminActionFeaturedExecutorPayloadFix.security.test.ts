import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression coverage for the confirmed production defect this migration
// fixes: approve_admin_action()'s live 'toggle_event_featured' branch
// (0183_approve_admin_action_capability_executors.sql) uses
// COALESCE((r.payload->>'featured')::boolean, false) -- and
// toggleEventFeatured() (src/app/components/admin/adminUserEventActions.ts)
// never sent a `payload` key, only `previous`/`changes`. request_admin_action()
// therefore always stored payload = {}, so every Sub-Admin "Feature" request
// approved in production today silently resolves to featured=false,
// regardless of the admin's actual intent. Same bug class 0185 already fixed
// for toggle_event_trending; this is the same fix for the one remaining branch.
//
// Static-text assertions against the migration file itself (same convention
// as approveAdminActionTrendingExecutor.security.test.ts), since 0186 has
// not been applied to any database -- this proves the file's own content,
// not live Postgres behavior.

let m0186: string;

beforeAll(() => {
  m0186 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0186_approve_admin_action_featured_executor_payload_fix.sql'),
    'utf8'
  );
});

describe('0186: approve_admin_action\'s toggle_event_featured branch gains strict payload.featured validation', () => {
  it('validates payload.featured strictly, rejecting missing or non-boolean values before admin_set_event_featured runs', () => {
    expect(m0186).toMatch(/WHEN 'toggle_event_featured'\s+THEN\s*\n\s*IF r\.payload->>'featured' IS NULL OR r\.payload->>'featured' NOT IN \('true', 'false'\) THEN\s*\n\s*RAISE EXCEPTION 'toggle_event_featured requires a boolean payload\.featured \(got: %\)', r\.payload->>'featured';\s*\n\s*END IF;/);
  });

  it('dispatches to admin_set_event_featured with the validated boolean, and keeps duration_days\' COALESCE default (not a correctness-inversion field)', () => {
    expect(m0186).toMatch(/PERFORM public\.admin_set_event_featured\(\s*r\.target_id,\s*\(r\.payload->>'featured'\)::boolean,\s*COALESCE\(\(r\.payload->>'duration_days'\)::integer, 14\)\);/);
  });

  it('preserves the toggle_event_trending branch exactly as 0185 left it, unaffected by this change', () => {
    expect(m0186).toMatch(/WHEN 'toggle_event_trending' THEN\s*\n\s*IF r\.payload->>'trending' IS NULL OR r\.payload->>'trending' NOT IN \('true', 'false'\) THEN\s*\n\s*RAISE EXCEPTION 'toggle_event_trending requires a boolean payload\.trending \(got: %\)', r\.payload->>'trending';\s*\n\s*END IF;\s*\n\s*PERFORM public\.admin_set_event_trending\(r\.target_id, \(r\.payload->>'trending'\)::boolean\);/);
  });

  it('preserves every other pre-existing branch untouched (spot-check a representative sample)', () => {
    expect(m0186).toMatch(/WHEN 'set_organizer_capability' THEN/);
    expect(m0186).toMatch(/WHEN 'set_service_provider_capability' THEN/);
    expect(m0186).toMatch(/WHEN 'credit_vents_cents'\s*THEN PERFORM public\.admin_credit_vents_cents\(r\.target_id, \(r\.payload->>'amount'\)::numeric, r\.payload->>'reason'\);/);
    expect(m0186).toMatch(/ELSE RAISE EXCEPTION 'No executor mapped for action_type: %', r\.action_type;/);
  });

  it('preserves the Super-Admin-only gate, self-approval block, and row lock ahead of the CASE', () => {
    expect(m0186).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(m0186).toMatch(/SELECT \* INTO r FROM public\.admin_action_requests WHERE id = p_request_id FOR UPDATE;/);
    expect(m0186).toMatch(/IF r\.requested_by = auth\.uid\(\) THEN\s*\n\s*RAISE EXCEPTION 'Cannot approve your own request';/);
  });

  it('preserves the post-CASE status update, admin_logs insert, and notification exactly as live', () => {
    expect(m0186).toMatch(/SET status = 'approved', reviewed_by = auth\.uid\(\), reviewed_at = now\(\), seen_at = COALESCE\(seen_at, now\(\)\)/);
    expect(m0186).toMatch(/INSERT INTO public\.admin_logs/);
    expect(m0186).toMatch(/INSERT INTO public\.notifications/);
  });

  it('is SECURITY DEFINER with an empty search_path, matching the live function', () => {
    expect(m0186).toMatch(/SECURITY DEFINER\s*\n\s*SET search_path TO ''/);
  });
});
