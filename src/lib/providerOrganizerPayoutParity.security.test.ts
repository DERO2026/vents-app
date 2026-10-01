import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Financial/security reconciliation audit: service-provider withdrawal
// safety. Finding: there is no separate "provider payout" system to audit --
// service providers and organizers share the EXACT same organizer_wallets
// table (keyed by a plain uuid organizer_id with no role discriminator),
// the EXACT same request_organizer_payout RPC, the EXACT same
// organizer_bank_accounts/organizer_withdrawal_requests tables, and the
// EXACT same WalletScreen.tsx client code path (isEarner includes
// is_service_provider === true). credit_provider_wallet_for_booking (0123)
// already writes a service booking's earnings into organizer_wallets keyed
// by the provider's own user id. So every protection verified for the
// organizer payout path -- fail-closed payouts_disabled(), row-locked
// balance check, idempotency key, RLS scoped to auth.uid() = organizer_id --
// applies identically and automatically to a service provider, because it
// is literally the same code and the same row, just keyed by a different
// user's id.
//
// Live-verified this session (rolled back, no residue) against a real
// is_service_provider=true account: zero/negative amount rejected
// ("Invalid amount"), above-balance rejected ("Insufficient balance"),
// exact-balance withdrawal succeeds and reserves the full amount into
// pending_kobo, a retry with the same idempotency key returns the identical
// request id with no second debit, a second withdrawal while the first is
// still pending is allowed and financially safe (balance_kobo already
// reflects the first reservation, so it cannot overdraw -- confirmed
// intentional/shared with the organizer path, not a provider-specific gap),
// and disabling payouts blocks a new request with "payouts_disabled".
//
// This test guards against the one real regression risk this finding
// implies: someone adding a role check (e.g. "WHERE organizer_id = v_uid
// AND role = 'organizer'") to request_organizer_payout or its RLS policies
// in a future change, which would silently break every service provider's
// ability to withdraw their earnings.

let m0123: string;
let walletScreenSrc: string;

beforeAll(() => {
  m0123 = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0123_withdrawal_payout_financial_safety.sql'), 'utf8');
  walletScreenSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'WalletScreen.tsx'), 'utf8');
});

describe('Service-provider and organizer payouts share one system, not two', () => {
  it('credit_provider_wallet_for_booking credits organizer_wallets keyed by the provider\'s own user id -- no separate provider_wallets table exists', () => {
    expect(m0123).toMatch(/INSERT INTO public\.organizer_wallets \(organizer_id, balance_kobo, total_earned_kobo, total_withdrawn_kobo, pending_kobo\)\s*\n\s*VALUES \(p_provider_user_id,/);
  });

  it('request_organizer_payout has no role branch -- it operates purely on auth.uid(), so a service provider calling it is indistinguishable from an organizer', () => {
    expect(m0123).toMatch(/v_organizer_id uuid := auth\.uid\(\);/);
    expect(m0123).not.toMatch(/role\s*=\s*'organizer'/);
    expect(m0123).not.toMatch(/is_organizer\(\)/);
  });

  it('WalletScreen treats is_service_provider as an earner alongside isOrganizer/admin, using the same wallet query and the same withdrawal RPC', () => {
    expect(walletScreenSrc).toMatch(/isEarner = !!currentUser\?\.isOrganizer \|\| currentUser\?\.role === 'admin' \|\| currentUser\?\.role === 'sub-admin' \|\| currentUser\?\.is_service_provider === true;/);
    expect(walletScreenSrc).toMatch(/supabase\.from\('organizer_wallets'\)\.select\('balance_kobo, total_earned_kobo, pending_kobo'\)\.eq\('organizer_id', currentUser\.id\)/);
    expect(walletScreenSrc).toMatch(/supabase\.rpc\('request_organizer_payout', \{/);
  });

  it('the withdrawal UI carries the same idempotency-key-ref pattern regardless of caller role', () => {
    expect(walletScreenSrc).toMatch(/withdrawIdempotencyKeyRef/);
  });
});
