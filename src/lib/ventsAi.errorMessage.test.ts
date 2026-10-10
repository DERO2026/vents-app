import { describe, it, expect, vi, afterEach } from 'vitest';

// Regression test for a real bug found alongside AI_BETA_RESTRICTED: this
// client was throwing `body.error` (the raw machine code, e.g.
// "AI_BETA_RESTRICTED") as the user-visible error message, discarding the
// server's actual human-readable `body.message` entirely. A user hitting
// the access gate saw the literal string "AI_BETA_RESTRICTED" in the chat
// error banner instead of "VENTS AI requires an active subscription...".

vi.mock('./supabase', () => ({ getAuthToken: vi.fn(async () => 'token') }));
vi.mock('./apiBase', () => ({ apiUrl: (p: string) => `https://example.test${p}` }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => { fetchMock.mockReset(); });

describe('sendVentsAiMessage: error surfacing', () => {
  it('throws the server\'s human-readable message, not the raw error code, and attaches the code separately', async () => {
    const { sendVentsAiMessage } = await import('./ventsAi');
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: 'AI_BETA_RESTRICTED', message: 'VENTS AI requires an active subscription. Subscribe to VENTS AI or VENTS AI+ to start chatting.' }),
    });

    await expect(sendVentsAiMessage([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      message: 'VENTS AI requires an active subscription. Subscribe to VENTS AI or VENTS AI+ to start chatting.',
      code: 'AI_BETA_RESTRICTED',
    });
  });

  it('falls back to the error code when no message is provided, and to a generic message when neither is', async () => {
    const { sendVentsAiMessage } = await import('./ventsAi');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'SOME_CODE' }) });
    await expect(sendVentsAiMessage([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ message: 'SOME_CODE' });

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => null });
    await expect(sendVentsAiMessage([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ message: 'VENTS AI request failed (500)' });
  });

  it('a successful response is returned as-is, untouched', async () => {
    const { sendVentsAiMessage } = await import('./ventsAi');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ type: 'message', text: 'hi there' }) });
    const result = await sendVentsAiMessage([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ type: 'message', text: 'hi there' });
  });
});
