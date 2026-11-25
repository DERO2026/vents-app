import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guards for 0222_announcements_drafts_publish.sql. Behaviour is
// proven by executing the real migration in
// scripts/local-pg-test/run-announcements-verification.sh; these tests keep
// the security-relevant shape from regressing in later edits.

let m: string;
let app: string;
const fn = (name: string) => m.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`))?.[0] ?? '';

beforeAll(() => {
  const root = join(__dirname, '..', '..');
  m = readFileSync(join(root, 'supabase', 'migrations', '0222_announcements_drafts_publish.sql'), 'utf8');
  app = readFileSync(join(root, 'src', 'app', 'App.tsx'), 'utf8');
});

describe('0222: authorization', () => {
  for (const name of ['admin_save_announcement_draft', 'admin_delete_announcement_draft', 'admin_publish_announcement']) {
    it(`${name} checks is_admin_or_root() before anything else`, () => {
      const body = fn(name);
      expect(body).toMatch(/SECURITY DEFINER/);
      expect(body).toMatch(/SET search_path TO ''/);
      const begin = body.indexOf('BEGIN');
      const auth = body.indexOf('IF NOT public.is_admin_or_root() THEN');
      expect(auth).toBeGreaterThan(begin);
      for (const later of ['INSERT INTO', 'UPDATE public.announcements', 'DELETE FROM', 'SELECT status', 'SELECT * INTO']) {
        const i = body.indexOf(later);
        if (i >= 0) expect(i).toBeGreaterThan(auth);
      }
      expect(body).not.toMatch(/public\.is_admin\(\)/); // Sub-Admins stay excluded, as in 0191
      expect(body).not.toMatch(/EXECUTE\s+(format|')/i); // no dynamic SQL
    });
  }

  it('anon gets no EXECUTE; authenticated + project_admin only', () => {
    for (const sig of ['admin_save_announcement_draft(uuid, text, text, text)', 'admin_delete_announcement_draft(uuid)', 'admin_publish_announcement(uuid)']) {
      expect(m).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(m).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated, project_admin;`);
    }
    expect(m).not.toMatch(/GRANT EXECUTE[^;]*\banon\b/);
  });
});

describe('0222: the announcements table is admin-read-only for clients', () => {
  it('RLS on, SELECT gated on is_admin_or_root(), no client write grant', () => {
    expect(m).toContain('ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;');
    expect(m).toMatch(/CREATE POLICY select_announcements_admin ON public\.announcements\s+FOR SELECT TO authenticated\s+USING \(public\.is_admin_or_root\(\)\);/);
    expect(m).toContain('REVOKE ALL ON public.announcements FROM PUBLIC, anon, authenticated;');
    expect(m).toContain('GRANT SELECT ON public.announcements TO authenticated;');
    expect(m).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON public\.announcements TO[^;]*authenticated/);
    expect(m).not.toMatch(/CREATE POLICY[^;]*ON public\.announcements[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/);
  });
});

describe('0222: publish', () => {
  it('locks the row and refuses anything that is not a draft (no double send)', () => {
    const body = fn('admin_publish_announcement');
    expect(body).toMatch(/FROM public\.announcements WHERE id = p_id FOR UPDATE;/);
    expect(body).toMatch(/IF v_ann\.status <> 'draft' THEN\s+RAISE EXCEPTION 'Announcement is already published';/);
  });

  it('delivers through notifications with push_data linking back to the announcement', () => {
    const body = fn('admin_publish_announcement');
    expect(body).toContain("v_push := jsonb_build_object('type', 'announcement', 'announcementId', v_ann.id::text);");
    expect(body.match(/INSERT INTO public\.notifications \(id, user_id, type, title, body, read, icon, created_at, push_data\)/g)).toHaveLength(3);
  });

  it('targets the same populations as 0191, with mutes honoured for role audiences only', () => {
    const body = fn('admin_publish_announcement');
    expect(body).toMatch(/'broadcast'[\s\S]*FROM public\.users u\s+WHERE u\.role <> 'admin';/);
    expect(body.match(/NOT EXISTS \(\s*SELECT 1 FROM public\.announcement_mutes mu\s+WHERE mu\.user_id = m\.user_id AND mu\.group_id = m\.group_id/g)).toHaveLength(2);
  });

  it('is rate limited and audit logged', () => {
    const body = fn('admin_publish_announcement');
    expect(body).toContain("PERFORM public.check_rate_limit('admin_publish_announcement:' || v_admin_id::text, 10, 300);");
    expect(body).toMatch(/'announcement_published'/);
  });

  it('published announcements cannot be edited or deleted', () => {
    expect(fn('admin_save_announcement_draft')).toContain("RAISE EXCEPTION 'Published announcements cannot be edited';");
    expect(fn('admin_delete_announcement_draft')).toContain("RAISE EXCEPTION 'Published announcements cannot be deleted';");
  });

  it('leaves admin_send_announcement (0191) in place for installed app builds', () => {
    expect(m).not.toMatch(/(DROP|CREATE OR REPLACE) FUNCTION public\.admin_send_announcement/);
  });
});

describe('App push routing for announcements', () => {
  it("routes data.type === 'announcement' to the notification centre before the generic id branches", () => {
    const handler = app.slice(app.indexOf('pushActionRef.current = (data'));
    const ann = handler.indexOf("if (data.type === 'announcement')");
    expect(ann).toBeGreaterThan(0);
    for (const later of ['if (data.transferId)', 'if (data.ticketId)']) expect(handler.indexOf(later)).toBeGreaterThan(ann);
    expect(handler.slice(ann, ann + 600)).toContain("setScreen('notifications')");
  });
});
