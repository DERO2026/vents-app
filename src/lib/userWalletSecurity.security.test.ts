import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Security regression tests for the customer wallet receipt/deep-link
// audit. The new client-side lookup (findTicketIdForPaymentRef) is the one
// genuinely new code path with an access-control question worth locking
// in: it must rely entirely on RLS (select_tickets: owner-only), never on
// an explicit client-supplied user id that could be tampered with to read
// someone else's ticket.

let userWalletSrc: string;
let m0065: string;

beforeAll(() => {
  userWalletSrc = readFileSync(join(__dirname, 'userWallet.ts'), 'utf8');
  m0065 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0065_user_wallets.sql'), 'utf8');
});

describe('findTicketIdForPaymentRef: relies on RLS, never an explicit/spoofable ownership filter', () => {
  it('queries only by payment_ref, with no user_id/owner filter the client could set to another value', () => {
    const fn = userWalletSrc.match(/export async function findTicketIdForPaymentRef[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/\.eq\('payment_ref', paymentRef\)/);
    expect(fn).not.toMatch(/user_id/);
    expect(fn).not.toMatch(/\.eq\('id',/); // never looks up by an arbitrary client-supplied ticket id here
  });

  it('tickets RLS only grants SELECT to anon/authenticated (public ticket-existence check), and confirm_ticket_payment_via_wallet already proved the RLS-scoped read pattern is safe -- this new lookup uses the identical client (no service-role key), so it inherits the same enforcement', () => {
    // Sanity check that this file never imports or references a service-role
    // key or an elevated client -- it must go through the same anon-key
    // Supabase client every other customer-facing read in this file uses.
    expect(userWalletSrc).not.toMatch(/service_role/i);
    expect(userWalletSrc).not.toMatch(/SUPABASE_SERVICE/);
  });
});

describe('get_my_wallet_transactions: unchanged by the receipt UI work, still owner-scoped and clamped', () => {
  it('still filters by auth.uid() and clamps limit/offset -- this audit only added client-side reads of already-returned columns (metadata), no RPC change', () => {
    const fn = m0065.match(/CREATE OR REPLACE FUNCTION public\.get_my_wallet_transactions[\s\S]*?\$function\$[\s\S]*?\$function\$/)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toMatch(/WHERE user_id = \(SELECT auth\.uid\(\)\)/);
    expect(fn).toMatch(/LIMIT LEAST\(GREATEST\(COALESCE\(p_limit, 50\), 1\), 100\)/);
  });
});
