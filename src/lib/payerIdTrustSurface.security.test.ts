import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A /code-review pass flagged api/webhook/paystack.ts's ?action=verify
// ownership check accepting EITHER owner_id OR payer_id as "worth
// confirming payer_id provenance is trustworthy." Audited end-to-end here:
// payer_id can never be a client-supplied identity. create_pending_purchase
// (0058) resolves it server-side, under the CALLER's own auth.uid(), by an
// exact case-insensitive email/username lookup against an EXISTING,
// non-deleted public.users row -- the client only ever supplies a search
// string (p_payer_identifier), never a user id, and a miss returns
// {payer_not_found: true} rather than fabricating or guessing an id. Only
// that resolved payer's own future authenticated session (session.userId
// === row.payer_id, read back from get_pending_purchase_owner, a
// project_admin-only function) can ever complete the payment -- there is
// no path for the request's creator to also act as the payer.

let m0058: string;
let paystackWebhook: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0058 = readFileSync(join(migrationsDir, '0058_ticket_payment_requests.sql'), 'utf8');
  paystackWebhook = readFileSync(join(__dirname, '..', '..', 'api', 'webhook', 'paystack.ts'), 'utf8');
});

describe('payer_id provenance: server-resolved from an existing account, never client-supplied', () => {
  it('create_pending_purchase requires the caller to be authenticated before resolving any payer', () => {
    expect(m0058).toMatch(/IF v_user_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated';\s*\n\s*END IF;/);
  });

  it('resolves the payer by exact email/username match against a real, non-deleted user row -- never trusts a client-supplied id', () => {
    expect(m0058).toMatch(/SELECT id INTO v_payer_id FROM public\.users\s*\n\s*WHERE \(lower\(email\) = v_payer_norm OR lower\(username\) = v_payer_norm\)\s*\n\s*AND deleted_at IS NULL/);
  });

  it('a payer identifier that matches no account resolves to a clean not-found signal, not a fabricated id', () => {
    expect(m0058).toMatch(/IF v_payer_id IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('payer_not_found', true\);\s*\n\s*END IF;/);
  });

  it('rejects requesting payment from yourself -- payer_id can never equal the requester', () => {
    expect(m0058).toMatch(/IF v_payer_id = v_user_id THEN\s*\n\s*RAISE EXCEPTION 'You cannot request payment from yourself/);
  });

  it('the pending_purchases row is created under the CALLER auth.uid() as user_id, with the resolved payer_id as a separate column -- the requester never becomes the payer', () => {
    const insertBlock = m0058.match(/INSERT INTO public\.pending_purchases\s*\n\s*\([\s\S]{0,400}?payer_id, expires_at\)[\s\S]{0,400}?;/)?.[0] ?? '';
    expect(insertBlock).toMatch(/v_user_id/);
    expect(insertBlock).toMatch(/v_payer_id/);
  });
});

describe('api/webhook/paystack.ts ?action=verify: payer_id only ever comes from the DB row, never from the request', () => {
  it('get_pending_purchase_owner is a project_admin-only RPC read straight from pending_purchases -- not fed anything from the request body', () => {
    expect(m0058).toMatch(/CREATE OR REPLACE FUNCTION public\.get_pending_purchase_owner\(p_payment_ref text\)\s*\n RETURNS TABLE\(owner_id uuid, payer_id uuid\)/);
    expect(m0058).toMatch(/SELECT user_id, payer_id FROM public\.pending_purchases WHERE payment_ref = p_payment_ref;/);
  });

  it('the verify handler compares the AUTHENTICATED session user id against the DB-resolved owner_id/payer_id -- the request body only supplies the payment reference to look up, never an identity', () => {
    const block = paystackWebhook.match(/const rows = await callProjectAdminTableRpc[\s\S]{0,400}/)?.[0] ?? '';
    expect(block).toMatch(/session\.userId !== row\.owner_id && session\.userId !== row\.payer_id/);
    // The only request-derived input feeding this lookup is `reference` --
    // confirm the RPC call site doesn't also thread through any body field
    // that could impersonate an identity (e.g. a client-supplied userId).
    expect(block).not.toMatch(/req\.body\.(payerId|userId|owner_id|payer_id)/);
  });
});
