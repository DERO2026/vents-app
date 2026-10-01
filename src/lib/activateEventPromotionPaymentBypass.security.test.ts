import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Final whole-app cross-system reconciliation audit: activate_event_
// promotion let any organizer grant their own event a free, paid Featured/
// Trending/Boosted promotion via a direct RPC call with a fabricated
// payment_ref -- the Paystack verification lived entirely in
// api/promotions/activate.ts, but the RPC it called was also directly
// client-callable (authenticated), with no payment check of its own.
//
// Live-verified against project slrtjxtzhowhwhebjprv (rolled back, no
// residue):
//   - PRE-FIX: a direct call with payment_ref='fabricated-free-ref-123'
//     set is_featured=true and a 30-day featured_until on a real event,
//     no payment involved.
//   - POST-FIX: the identical direct call fails with "permission denied
//     for function activate_event_promotion"; the legitimate
//     project_admin-connection call (now passing an explicit
//     p_organizer_id instead of relying on auth.uid()) still activates
//     the promotion correctly; a mismatched p_organizer_id still fails
//     with "You do not own this event".

let m0137: string;
let activateApiSrc: string;

beforeAll(() => {
  m0137 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0137_fix_activate_event_promotion_payment_bypass.sql'), 'utf8');
  activateApiSrc = readFileSync(join(__dirname, '..', '..', 'api', 'promotions', 'activate.ts'), 'utf8');
});

describe('activate_event_promotion is no longer client-callable', () => {
  it('drops the old auth.uid()-based signature and defines a new one taking an explicit p_organizer_id', () => {
    expect(m0137).toMatch(/DROP FUNCTION IF EXISTS public\.activate_event_promotion\(uuid, text, integer, text\);/);
    expect(m0137).toMatch(/CREATE OR REPLACE FUNCTION public\.activate_event_promotion\(p_event_id uuid, p_plan_type text, p_duration_days integer, p_payment_ref text, p_organizer_id uuid\)/);
  });

  it('no longer reads auth.uid() for ownership -- that was the exploitable part', () => {
    const fn = m0137.match(/CREATE OR REPLACE FUNCTION public\.activate_event_promotion[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).not.toMatch(/auth\.uid\(\)/);
    expect(fn).toMatch(/v_owner_id <> p_organizer_id/);
  });

  it('revokes EXECUTE from PUBLIC/anon/authenticated and grants only to project_admin', () => {
    expect(m0137).toMatch(/REVOKE ALL ON FUNCTION public\.activate_event_promotion\(uuid, text, integer, text, uuid\) FROM PUBLIC, anon, authenticated;/);
    expect(m0137).toMatch(/GRANT EXECUTE ON FUNCTION public\.activate_event_promotion\(uuid, text, integer, text, uuid\) TO project_admin;/);
  });

  it('every validation from the original function is preserved (plan_type, duration, payment_ref, ownership, idempotency)', () => {
    expect(m0137).toMatch(/IF p_plan_type NOT IN \('boosted', 'featured', 'trending'\) THEN/);
    expect(m0137).toMatch(/IF p_duration_days NOT IN \(3, 7, 14, 30\) THEN/);
    expect(m0137).toMatch(/IF p_payment_ref IS NULL OR trim\(p_payment_ref\) = '' THEN/);
    expect(m0137).toMatch(/ON CONFLICT \(payment_ref\) DO NOTHING;/);
  });
});

describe('api/promotions/activate.ts calls the RPC over the project_admin connection, not the forwarded client token', () => {
  it('imports and uses callProjectAdminRpc instead of fetching PostgREST with the client Authorization header', () => {
    expect(activateApiSrc).toMatch(/import \{ callProjectAdminRpc \} from '\.\.\/_lib\/projectAdminDb\.js';/);
    expect(activateApiSrc).toMatch(/await callProjectAdminRpc\('activate_event_promotion', \[/);
    expect(activateApiSrc).not.toMatch(/rest\/v1\/rpc\/activate_event_promotion/);
  });

  it('passes the session-verified user id as the new p_organizer_id argument, never a client-supplied value', () => {
    const block = activateApiSrc.match(/callProjectAdminRpc\('activate_event_promotion', \[[\s\S]*?\]\);/)?.[0] ?? '';
    expect(block).toMatch(/session\.userId/);
  });

  it('still verifies the Paystack transaction and amount before calling the RPC', () => {
    expect(activateApiSrc).toMatch(/api\.paystack\.co\/transaction\/verify/);
    expect(activateApiSrc).toMatch(/Number\(tx\?\.amount\) !== expectedKobo/);
    const verifyIdx = activateApiSrc.indexOf('api.paystack.co/transaction/verify');
    const rpcIdx = activateApiSrc.indexOf("callProjectAdminRpc('activate_event_promotion'");
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(verifyIdx);
  });
});
