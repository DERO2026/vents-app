import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guards for 0223_announcement_internal_test_audience.sql and
// undo_0223.sql. Behaviour is proven by executing the real migration in
// scripts/local-pg-test/run-announcements-internal-test-verification.sh;
// these tests keep the security-relevant shape from regressing.

let m: string;
let m222: string;
let undo: string;
const fnIn = (src: string, name: string) => src.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;\\n`))?.[0] ?? '';
const fn = (name: string) => fnIn(m, name);
const sqlOnly = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

beforeAll(() => {
  const root = join(__dirname, '..', '..');
  m = readFileSync(join(root, 'supabase', 'migrations', '0223_announcement_internal_test_audience.sql'), 'utf8');
  m222 = readFileSync(join(root, 'supabase', 'migrations', '0222_announcements_drafts_publish.sql'), 'utf8');
  undo = readFileSync(join(root, 'supabase', 'rollback', 'undo_0223.sql'), 'utf8');
});

describe('0223: recipient management is Root only', () => {
  for (const name of ['admin_add_announcement_test_recipient', 'admin_remove_announcement_test_recipient']) {
    it(`${name} checks is_root() first and fails closed when it is NULL (no auth.uid())`, () => {
      const body = fn(name);
      expect(body).toMatch(/SECURITY DEFINER/);
      expect(body).toMatch(/SET search_path TO ''/);
      const auth = body.indexOf('IF NOT COALESCE(public.is_root(), false) THEN');
      expect(auth).toBeGreaterThan(body.indexOf('BEGIN'));
      for (const later of ['INSERT INTO', 'UPDATE public.', 'pg_advisory_xact_lock', 'SELECT count']) {
        const i = body.indexOf(later);
        if (i >= 0) expect(i).toBeGreaterThan(auth);
      }
      expect(body).not.toMatch(/is_admin_or_root|is_super_admin|is_admin\(\)/); // admins are not enough
      expect(body).not.toMatch(/IF NOT public\.is_root\(\)/); // bare form does not raise on NULL
      expect(body).not.toMatch(/EXECUTE\s+(format|')/i);
    });

    it(`${name} writes an admin_logs audit entry and serializes on the advisory lock`, () => {
      const body = fn(name);
      const action = name.includes('add') ? 'announcement_test_recipient_added' : 'announcement_test_recipient_removed';
      expect(body).toContain(`'${action}'`);
      expect(body).toContain("PERFORM pg_advisory_xact_lock(hashtext('public.announcement_test_recipients'));");
    });
  }

  it('add enforces the 10-recipient cap and only accepts existing, non-deleted, active accounts', () => {
    const body = fn('admin_add_announcement_test_recipient');
    expect(body).toMatch(/IF v_active >= 10 THEN\s+RAISE EXCEPTION 'Internal test audience is limited to 10 recipients';/);
    expect(body).toMatch(/u\.id = p_user_id AND u\.deleted_at IS NULL AND u\.status = 'active'/);
    // The cap check comes before the write.
    expect(body.indexOf('v_active >= 10')).toBeLessThan(body.indexOf('INSERT INTO public.announcement_test_recipients'));
  });

  it('the list read is Super Admin tier (like publishing), fail-closed', () => {
    const body = fn('admin_list_announcement_test_recipients');
    expect(body).toContain('IF NOT COALESCE(public.is_admin_or_root(), false) THEN');
    expect(body).not.toMatch(/INSERT|UPDATE public|DELETE/);
  });

  it('anon gets no EXECUTE; authenticated + project_admin only', () => {
    for (const sig of ['admin_add_announcement_test_recipient(uuid)', 'admin_remove_announcement_test_recipient(uuid)', 'admin_list_announcement_test_recipients()']) {
      expect(m).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(m).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated, project_admin;`);
    }
    expect(m).not.toMatch(/GRANT[^;]*\banon\b/);
  });
});

describe('0223: the allowlist table is closed to clients', () => {
  it('RLS on, no policies, no client grants', () => {
    expect(m).toContain('ALTER TABLE public.announcement_test_recipients ENABLE ROW LEVEL SECURITY;');
    expect(m).toContain('REVOKE ALL ON public.announcement_test_recipients FROM PUBLIC, anon, authenticated;');
    expect(m).not.toMatch(/CREATE POLICY[^;]*announcement_test_recipients/);
    expect(m).not.toMatch(/GRANT[^;]*ON public\.announcement_test_recipients TO[^;]*(authenticated|anon)/);
  });

  it('seeds no recipient: no data statement outside the functions, and no hard-coded Root id', () => {
    let outside = m;
    for (const name of ['admin_add_announcement_test_recipient', 'admin_remove_announcement_test_recipient', 'admin_list_announcement_test_recipients', 'admin_save_announcement_draft', 'admin_publish_announcement']) {
      expect(outside).toContain(fn(name));
      outside = outside.replace(fn(name), '');
    }
    expect(sqlOnly(outside)).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(m).not.toContain(ROOT_UID);
  });
});

describe('0223: publish safeguards and delivery', () => {
  it('refuses an empty list and more than 10, before the rate limit and before any delivery', () => {
    const body = fn('admin_publish_announcement');
    const guard = body.indexOf("IF v_ann.audience = 'internal_test' THEN");
    expect(guard).toBeGreaterThan(body.indexOf("RAISE EXCEPTION 'Announcement is already published';"));
    expect(guard).toBeLessThan(body.indexOf('PERFORM public.check_rate_limit'));
    expect(guard).toBeLessThan(body.indexOf('CASE v_ann.audience'));
    expect(body).toMatch(/IF v_count = 0 THEN\s+RAISE EXCEPTION 'Internal test audience has no recipients';/);
    expect(body).toMatch(/IF v_count > 10 THEN\s+RAISE EXCEPTION 'Internal test audience exceeds the 10-recipient limit';/);
  });

  it('internal_test delivers only to active allowlisted, non-deleted, active accounts -- never via role or group', () => {
    const body = fn('admin_publish_announcement');
    const branch = body.slice(body.indexOf("WHEN 'internal_test' THEN"), body.indexOf('END CASE;'));
    expect(branch).toContain('FROM public.announcement_test_recipients r');
    expect(branch).toMatch(/WHERE r\.active AND u\.deleted_at IS NULL AND u\.status = 'active';/);
    expect(branch).toContain("'announcement', v_ann.title, v_ann.body, false, '📢', now(), v_push");
    expect(branch).not.toMatch(/announcement_group|u\.role|is_organizer|is_service_provider/);
  });

  it('the three production audiences are byte-identical to 0222 (only the internal_test guard and branch are added)', () => {
    const p2 = fnIn(m222, 'admin_publish_announcement');
    const p3 = fn('admin_publish_announcement');
    const guard = p3.match(/ {2}-- Internal test \(0223\)[\s\S]*? {2}END IF;\n\n(?= {2}-- Same limiter)/)![0];
    const branch = p3.match(/\n {4}WHEN 'internal_test' THEN[\s\S]*?(?= {2}END CASE;)/)![0];
    expect(p3.replace(guard, '').replace(branch, '')).toBe(p2);
    expect(fn('admin_save_announcement_draft').replace(", 'internal_test')", ')')).toBe(fnIn(m222, 'admin_save_announcement_draft'));
  });

  it('only adds internal_test to the audience CHECK, and does not touch delete, the 0191 send or notifications', () => {
    expect(m).toContain("CHECK (audience IN ('everyone', 'organizers', 'service_providers', 'internal_test'))");
    expect(m).not.toMatch(/FUNCTION public\.(admin_delete_announcement_draft|admin_send_announcement)/);
    expect(sqlOnly(m)).not.toMatch(/ALTER TABLE public\.notifications|notifications_type_check/);
  });
});

describe('undo_0223.sql', () => {
  it('is gated and refuses to discard internal_test announcements silently', () => {
    expect(undo).toContain("IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0223' THEN");
    expect(undo).toContain("current_setting('vents.rollback_discard_internal_test', true) IS DISTINCT FROM 'yes'");
  });

  it("restores 0222's save/publish bodies verbatim and 0222's audience CHECK", () => {
    expect(fnIn(undo, 'admin_publish_announcement')).toBe(fnIn(m222, 'admin_publish_announcement'));
    expect(fnIn(undo, 'admin_save_announcement_draft')).toBe(fnIn(m222, 'admin_save_announcement_draft'));
    expect(undo).toContain("CHECK (audience IN ('everyone', 'organizers', 'service_providers'));");
  });

  it('drops exactly the objects 0223 creates; its only data statement deletes internal_test announcements', () => {
    expect(undo.match(/^DROP [^;]+;/gm)).toEqual([
      'DROP FUNCTION IF EXISTS public.admin_list_announcement_test_recipients();',
      'DROP FUNCTION IF EXISTS public.admin_remove_announcement_test_recipient(uuid);',
      'DROP FUNCTION IF EXISTS public.admin_add_announcement_test_recipient(uuid);',
      'DROP TABLE IF EXISTS public.announcement_test_recipients;',
    ]);
    let top = undo;
    for (const name of ['admin_publish_announcement', 'admin_save_announcement_draft']) top = top.replace(fnIn(undo, name), '');
    top = sqlOnly(top);
    expect(top.match(/\b(DELETE\s+FROM[^;]*|UPDATE\s+public[^;]*|TRUNCATE[^;]*|INSERT\s+INTO[^;]*)/gi)).toEqual([
      "DELETE FROM public.announcements WHERE audience = 'internal_test'",
    ]);
    expect(top).not.toMatch(/\b(notifications|admin_logs|admin_send_announcement|announcement_groups|announcement_mutes)\b/);
  });
});
