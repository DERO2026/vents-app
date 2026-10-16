import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Admin-only manual Trending control -- an admin shouldn't have to ask an
// organizer to buy a promotion just to manually place an eligible event in
// Trending. Static-text assertions against the drafted migration itself
// (same convention as rejectBoostedEventPromotionActivation.security.test.ts),
// since this migration is drafted here but its actual application to
// production is a separate, explicit step.

let m0182: string;

beforeAll(() => {
  m0182 = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0182_admin_manual_trending_control.sql'),
    'utf8'
  );
});

describe('0182: admin_trending column + protection', () => {
  it('adds admin_trending as an independent, default-false boolean column on events', () => {
    expect(m0182).toMatch(/ALTER TABLE public\.events ADD COLUMN IF NOT EXISTS admin_trending boolean NOT NULL DEFAULT false;/);
  });

  it('extends the existing protect_event_promotion_columns trigger to guard admin_trending too, alongside is_featured/featured_until/hidden_by_admin', () => {
    const fn = m0182.match(/CREATE OR REPLACE FUNCTION public\.protect_event_promotion_columns[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/OLD\.is_featured IS DISTINCT FROM NEW\.is_featured/);
    expect(fn).toMatch(/OLD\.featured_until IS DISTINCT FROM NEW\.featured_until/);
    expect(fn).toMatch(/OLD\.hidden_by_admin IS DISTINCT FROM NEW\.hidden_by_admin/);
    expect(fn).toMatch(/OLD\.admin_trending IS DISTINCT FROM NEW\.admin_trending THEN\s*\n\s*RAISE EXCEPTION 'admin_trending can only be changed by an admin';/);
    // The trigger bypass for non-`authenticated` callers (SECURITY DEFINER
    // RPCs) must still be the very first check -- the admin RPC path has to
    // keep working.
    expect(fn).toMatch(/IF current_user <> 'authenticated' THEN RETURN NEW; END IF;/);
  });

  it('re-creates the trigger to fire on admin_trending updates too', () => {
    expect(m0182).toMatch(/CREATE TRIGGER trg_protect_event_promotion_columns\s*\n\s*BEFORE UPDATE OF is_featured, featured_until, hidden_by_admin, admin_trending ON public\.events/);
  });
});

describe('0182: admin_set_event_trending RPC', () => {
  function fnBody(): string {
    return m0182.match(/CREATE OR REPLACE FUNCTION public\.admin_set_event_trending[\s\S]*?\$function\$;/)?.[0] ?? '';
  }

  it('is SECURITY DEFINER with an empty search_path', () => {
    const fn = fnBody();
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path TO ''/);
  });

  it('requires is_super_admin() -- a Sub-Admin cannot execute it directly', () => {
    const fn = fnBody();
    expect(fn).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'Super Admin access required/);
  });

  it('checks eligibility (not hidden, not deleted, status live/published) before allowing p_trending = true', () => {
    const fn = fnBody();
    expect(fn).toMatch(/IF p_trending THEN/);
    expect(fn).toMatch(/v_event\.hidden_by_admin THEN/);
    expect(fn).toMatch(/v_event\.deleted_at IS NOT NULL THEN/);
    expect(fn).toMatch(/v_event\.status NOT IN \('live', 'published'\) THEN/);
  });

  it('has no duration parameter at all -- unlike admin_set_event_featured, there is no expiry to set', () => {
    expect(m0182).toMatch(/CREATE OR REPLACE FUNCTION public\.admin_set_event_trending\(p_event_id uuid, p_trending boolean\)/);
    const fn = fnBody();
    expect(fn).not.toMatch(/duration/i);
    expect(fn).not.toMatch(/featured_until/);
  });

  it('writes only admin_trending -- never touches is_featured, featured_until, or event_promotions', () => {
    const fn = fnBody();
    expect(fn).toMatch(/UPDATE public\.events SET admin_trending = p_trending WHERE id = p_event_id;/);
    expect(fn).not.toMatch(/is_featured/);
    expect(fn).not.toMatch(/event_promotions/);
  });

  it('logs the action to admin_logs with the event id and new trending state', () => {
    const fn = fnBody();
    expect(fn).toMatch(/INSERT INTO public\.admin_logs/);
    expect(fn).toMatch(/CASE WHEN p_trending THEN 'trend_event' ELSE 'untrend_event' END/);
    expect(fn).toMatch(/jsonb_build_object\('event_id', p_event_id, 'trending', p_trending\)/);
  });

  it('grants EXECUTE only to authenticated and project_admin, after revoking PUBLIC default (the real gate is is_super_admin() inside, not the grant)', () => {
    expect(m0182).toMatch(/REVOKE ALL ON FUNCTION public\.admin_set_event_trending\(uuid, boolean\) FROM PUBLIC;/);
    expect(m0182).toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_set_event_trending\(uuid, boolean\) TO authenticated, project_admin;/);
  });
});

describe('0182: does not touch pricing, paid promotion activation, or ticketing', () => {
  it('the new admin_set_event_trending RPC never calls activate_event_promotion, Paystack, or ticket pricing columns', () => {
    // Checked against the new function's own body, not the pre-existing
    // trigger (which legitimately still mentions activate_event_promotion
    // in its unchanged is_featured/featured_until exception text) or this
    // migration's own explanatory comments.
    const fn = m0182.match(/CREATE OR REPLACE FUNCTION public\.admin_set_event_trending[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toMatch(/activate_event_promotion/);
    expect(fn).not.toMatch(/paystack/i);
    expect(fn).not.toMatch(/ticket_types|ticket_goal/);
  });
});
