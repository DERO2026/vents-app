import { describe, it, expect, vi } from 'vitest';
import {
  captureRepReferral, pendingRepReferral, claimPendingRepReferral, normalizeRepCode, repReferralLink, REP_REFERRAL_STORAGE_KEY,
} from './representativeReferral';

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe('representative referral links (0209)', () => {
  it('builds the canonical link', () => {
    expect(repReferralLink('ABCD2345')).toBe('https://getvents.com/?rep=ABCD2345');
  });
  it('accepts only the server alphabet (no 0/O/1/I), case-insensitively', () => {
    expect(normalizeRepCode(' abcd2345 ')).toBe('ABCD2345');
    expect(normalizeRepCode('ABCD0345')).toBeNull();
    expect(normalizeRepCode('ABC')).toBeNull();
    expect(normalizeRepCode("x'; --")).toBeNull();
  });
  it('captures ?rep= and keeps it for 7 days, separate from the VENTS Cents ?ref=', () => {
    const s = memStore();
    expect(captureRepReferral(new URLSearchParams('ref=ABCDEFGH'), s, 0)).toBe(false);
    expect(captureRepReferral(new URLSearchParams('rep=abcd2345'), s, 0)).toBe(true);
    expect(pendingRepReferral(s, 6 * 86400000)).toBe('ABCD2345');
    expect(pendingRepReferral(s, 8 * 86400000)).toBeNull();
    expect(s.m.has(REP_REFERRAL_STORAGE_KEY)).toBe(false);
  });
  it('claims once through the server and clears on any definitive answer', async () => {
    const s = memStore();
    captureRepReferral(new URLSearchParams('rep=ABCD2345'), s);
    const rpc = vi.fn(async () => ({ data: { status: 'attributed' }, error: null }));
    expect(await claimPendingRepReferral(rpc, s)).toBe('attributed');
    expect(rpc).toHaveBeenCalledWith('claim_representative_referral', { p_code: 'ABCD2345' });
    expect(await claimPendingRepReferral(rpc, s)).toBe('none');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('keeps the code for a retry when the server cannot be reached', async () => {
    const s = memStore();
    captureRepReferral(new URLSearchParams('rep=ABCD2345'), s);
    expect(await claimPendingRepReferral(async () => ({ data: null, error: { message: 'network' } }), s)).toBe('retry_later');
    expect(pendingRepReferral(s)).toBe('ABCD2345');
    expect(await claimPendingRepReferral(async () => ({ data: { status: 'not_a_new_account' }, error: null }), s)).toBe('not_a_new_account');
    expect(pendingRepReferral(s)).toBeNull();
  });
  it('App captures ?rep= and claims once signed in', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const app = readFileSync(join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
    expect(app).toMatch(/if \(captureRepReferral\(params\)\)/);
    expect(app).toMatch(/void claimPendingRepReferral\(\(fn, args\) => supabase\.rpc\(fn as any, args as any\)\);\n  \}, \[currentUser\?\.id\]\);/);
  });
});
