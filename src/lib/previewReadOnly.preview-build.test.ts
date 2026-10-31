import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Runs only under vitest.preview.config.ts: the real modules compiled as a
// read-only Vercel Preview build.

const paystackCtor = vi.fn();
vi.mock('@paystack/inline-js', () => ({ default: vi.fn().mockImplementation(() => { paystackCtor(); return { newTransaction: vi.fn(), resumeTransaction: vi.fn() }; }) }));

const fetchSpy = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
let supabase: any;
let openPaystackPopup: typeof import('./paystack').openPaystackPopup;
let PREVIEW_READ_ONLY_MESSAGE: string;

beforeAll(async () => {
  // supabase-js captures fetch when the client is created.
  vi.stubGlobal('fetch', fetchSpy);
  ({ supabase } = await import('./supabase'));
  ({ openPaystackPopup } = await import('./paystack'));
  ({ PREVIEW_READ_ONLY_MESSAGE } = await import('./previewReadOnly'));
});
beforeEach(() => { fetchSpy.mockClear(); paystackCtor.mockClear(); });

describe('read-only Preview build', () => {
  it('compiles the flags in', () => {
    expect(__VENTS_PREVIEW_READ_ONLY__).toBe(true);
    expect(__VENTS_VERCEL_PREVIEW__).toBe(true);
  });

  it('the app\'s own Supabase client blocks money-moving and write calls with no request', async () => {
    for (const fn of ['request_organizer_payout', 'confirm_ticket_payment_via_wallet', 'initiate_wallet_deposit', 'convert_vc_to_wallet', 'approve_admin_action', 'get_my_vc_balance']) {
      const r = await supabase.rpc(fn, {});
      expect(r.error?.code, fn).toBe('PREVIEW_READ_ONLY');
    }
    expect((await supabase.from('tickets').insert([{}]).select()).error?.code).toBe('PREVIEW_READ_ONLY');
    expect((await supabase.storage.from('avatars').upload('a.png', new Blob(['x']))).error?.code).toBe('PREVIEW_READ_ONLY');
    expect((await supabase.auth.signUp({ email: 'a@b.c', password: 'x' })).error?.code).toBe('PREVIEW_READ_ONLY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads still reach the database', async () => {
    await supabase.from('events').select('id').limit(1);
    await supabase.rpc('search_events_fuzzy', { p_query: 'x' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('Paystack checkout refuses without creating a Paystack instance or making a request', () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    openPaystackPopup({ email: 'a@b.c', amountKobo: 500000, ref: 'r', onSuccess, onClose: vi.fn(), onError } as any);
    expect(onError).toHaveBeenCalledWith(PREVIEW_READ_ONLY_MESSAGE);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(paystackCtor).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
