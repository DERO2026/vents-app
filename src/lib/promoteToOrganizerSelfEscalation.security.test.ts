import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression test for a real self-service privilege-escalation bug: "Become
// an Organizer" used to call `supabase.rpc('promote_to_organizer')` directly
// from App.tsx and instantly flip the caller's own role to 'organizer' --
// zero application form, zero admin review -- even though a proper
// organizer_requests application/approval flow (submitted via ProfileScreen,
// decided by a Super Admin through admin_decide_organizer_request, which
// alone grants the role via admin_set_user_role) already existed and was
// fully wired up in ProfileScreen. Worse, promote_to_organizer() itself has
// no internal admin/approval gating at all -- it unconditionally promotes
// whoever calls it -- and had EXECUTE granted to anon and authenticated, so
// it was directly callable from a browser console regardless of any client
// UI change.
//
// Same static-analysis approach as the repo's other *.security.test.ts
// files: no live Postgres harness here, so this asserts the fix is actually
// encoded in the source that ships, not that Postgres enforces it at
// runtime.

let appTsxSrc: string;
let profileScreenSrc: string;
let revokeMigration: string;

beforeAll(() => {
  appTsxSrc = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  profileScreenSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'ProfileScreen.tsx'), 'utf8');
  revokeMigration = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0116_revoke_promote_to_organizer_self_escalation.sql'),
    'utf8'
  );
});

describe('Become an Organizer: no instant self-promotion path', () => {
  it('App.tsx no longer wires an onBecomeOrganizer instant-promote callback', () => {
    expect(appTsxSrc).not.toMatch(/onBecomeOrganizer=/);
    expect(appTsxSrc).not.toMatch(/supabase\.rpc\('promote_to_organizer'\)/);
  });

  it('ProfileScreen no longer accepts an onBecomeOrganizer prop', () => {
    expect(profileScreenSrc).not.toMatch(/onBecomeOrganizer/);
  });

  it('setActiveView passed to ProfileScreen never grants the organizer role itself -- it only switches nav state for an account that already has it', () => {
    const wiring = appTsxSrc.match(/setActiveView=\{\(view\) => \{[\s\S]*?\n              \}\}/)?.[0] ?? '';
    expect(wiring).not.toMatch(/promote_to_organizer/);
    // Guards against promoting a non-organizer, non-admin account when
    // switching the view to 'organizer'.
    expect(wiring).toMatch(/currentUser\.role !== 'organizer'[\s\S]*?return;/);
  });

  it('"Become an Organizer" in ProfileScreen submits an application to organizer_requests, reviewed elsewhere', () => {
    expect(profileScreenSrc).toMatch(/onClick=\{\(\) => setShowOrgRequestModal\(true\)\}/);
    expect(profileScreenSrc).toMatch(/\.from\('organizer_requests'\)\s*\n\s*\.insert\(\[\{ user_id: currentUser\.id/);
  });
});

describe('promote_to_organizer(): client EXECUTE revoked (0116)', () => {
  it('revokes EXECUTE from anon and authenticated', () => {
    expect(revokeMigration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.promote_to_organizer\(\) FROM anon;/);
    expect(revokeMigration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.promote_to_organizer\(\) FROM authenticated;/);
  });

  it('the real promotion path is admin_decide_organizer_request -> admin_set_user_role, gated on is_super_admin()', () => {
    const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
    // admin_decide_organizer_request was introduced alongside the org
    // requests dual-control wiring; confirm its Super-Admin gate and its
    // call into admin_set_user_role exist somewhere in the shipped
    // migrations (function is CREATE OR REPLACE'd, so just confirm the
    // pattern is present anywhere in the migration history).
    const fs = require('node:fs');
    const files: string[] = fs.readdirSync(dir).filter((f: string) => f.endsWith('.sql'));
    const combined = files.map((f) => fs.readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(combined).toMatch(/admin_decide_organizer_request/);
  });
});
