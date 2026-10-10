import { describe, it, expect, vi, afterEach } from 'vitest';

const rpc = vi.fn();
vi.mock('./supabase', () => ({
  supabase: { rpc: (...args: any[]) => rpc(...args) },
  getAuthToken: vi.fn(async () => 'test-token'),
}));
vi.mock('./apiBase', () => ({ apiUrl: (p: string) => `https://example.test${p}` }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  rpc.mockReset();
  fetchMock.mockReset();
});

describe('aiSubscription client helpers', () => {
  it('fetchAiPlansPublic returns the real RPC rows, and propagates an RPC error', async () => {
    const { fetchAiPlansPublic } = await import('./aiSubscription');
    rpc.mockResolvedValueOnce({ data: [{ plan_id: 'ai', label: 'VENTS AI' }], error: null });
    expect(await fetchAiPlansPublic()).toEqual([{ plan_id: 'ai', label: 'VENTS AI' }]);

    rpc.mockResolvedValueOnce({ data: null, error: new Error('boom') });
    await expect(fetchAiPlansPublic()).rejects.toThrow('boom');
  });

  it('initiateAiSubscriptionPayment passes the plan id through and returns the server intent verbatim', async () => {
    const { initiateAiSubscriptionPayment } = await import('./aiSubscription');
    rpc.mockResolvedValueOnce({ data: { reference: 'aisub_1', amount_kobo: 750000, currency: 'NGN', plan_id: 'ai', label: 'VENTS AI' }, error: null });
    const intent = await initiateAiSubscriptionPayment('ai');
    expect(rpc).toHaveBeenCalledWith('initiate_ai_subscription_payment', { p_plan_id: 'ai' });
    expect(intent.reference).toBe('aisub_1');
    expect(intent.amount_kobo).toBe(750000);
  });

  it('verifyAiSubscriptionPayment posts to the shared Paystack verify endpoint with an auth header and real reference', async () => {
    const { verifyAiSubscriptionPayment } = await import('./aiSubscription');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success', planId: 'ai' }) });
    const result = await verifyAiSubscriptionPayment('aisub_1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/webhook/paystack?action=verify',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        body: JSON.stringify({ reference: 'aisub_1' }),
      })
    );
    expect(result).toEqual({ status: 'success', planId: 'ai' });
  });

  it('verifyAiSubscriptionPayment never reports success on a network/HTTP failure', async () => {
    const { verifyAiSubscriptionPayment } = await import('./aiSubscription');
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'server exploded' }) });
    const result = await verifyAiSubscriptionPayment('aisub_1');
    expect(result.status).toBe('error');
  });

  it('verifyAiSubscriptionPayment passes through abandoned/failed exactly as the server reports them', async () => {
    const { verifyAiSubscriptionPayment } = await import('./aiSubscription');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'abandoned' }) });
    expect((await verifyAiSubscriptionPayment('r')).status).toBe('abandoned');
  });
});
