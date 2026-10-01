import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Notifications/Push end-to-end reconciliation audit.
//
// CRITICAL (0135): get_pending_push_notifications_for_user(p_user_id uuid,
// p_limit integer) had NO internal authorization check at all -- unlike
// every other privileged function in this codebase -- and was GRANTed
// EXECUTE to anon and authenticated. Its only legitimate caller
// (api/_lib/pushDelivery.ts) uses the direct project_admin Postgres
// connection, never the client RPC surface. Live-verified: before this fix,
// `SET ROLE authenticated; SELECT * FROM
// get_pending_push_notifications_for_user(<any uuid>, 5);` returned another
// user's notification content and device push token; after the fix the
// identical call fails with "permission denied for function
// get_pending_push_notifications_for_user".
//
// Grant hygiene (0136): register_push_token and remove_push_tokens_for_user
// carried anon grants despite both already having a correct internal
// auth.uid() ownership check -- not an active exploit, but inconsistent
// with the established defense-in-depth convention (same class as the
// complete_service_booking / generate_ticket_token fixes earlier in this
// reconciliation).

let m0135: string;
let m0136: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0135 = readFileSync(join(dir, '0135_lock_down_get_pending_push_notifications_for_user.sql'), 'utf8');
  m0136 = readFileSync(join(dir, '0136_revoke_anon_push_token_rpcs.sql'), 'utf8');
});

describe('get_pending_push_notifications_for_user is no longer client-callable', () => {
  it('revokes EXECUTE from PUBLIC, anon, and authenticated', () => {
    expect(m0135).toMatch(/REVOKE ALL ON FUNCTION public\.get_pending_push_notifications_for_user\(uuid, integer\) FROM PUBLIC, anon, authenticated;/);
  });

  it('grants EXECUTE only to project_admin -- the one legitimate server-side caller', () => {
    expect(m0135).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_pending_push_notifications_for_user\(uuid, integer\) TO project_admin;/);
  });

  it('does not touch the function body or signature -- this is a grant-only fix', () => {
    expect(m0135).not.toMatch(/CREATE OR REPLACE FUNCTION/);
  });
});

describe('push-token RPCs no longer carry a stray anon grant', () => {
  it('revokes EXECUTE from anon on register_push_token', () => {
    expect(m0136).toMatch(/REVOKE EXECUTE ON FUNCTION public\.register_push_token\(uuid, text, text\) FROM anon;/);
  });

  it('revokes EXECUTE from anon on remove_push_tokens_for_user', () => {
    expect(m0136).toMatch(/REVOKE EXECUTE ON FUNCTION public\.remove_push_tokens_for_user\(uuid\) FROM anon;/);
  });

  it('does not touch the authenticated grant for either function', () => {
    expect(m0136).not.toMatch(/REVOKE[^;]*authenticated/);
    expect(m0136).not.toMatch(/GRANT[^;]*authenticated/);
  });
});
