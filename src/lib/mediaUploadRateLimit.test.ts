import { describe, it, expect, vi, beforeEach } from 'vitest';

// Emergency cost-hardening pass (production billing audit): no upload path
// had any per-user/per-time-window cap on upload COUNT. uploadImage/
// uploadVideo (src/lib/mediaPipeline.ts) now call
// check_media_upload_rate_limit (0163_emergency_cost_hardening.sql) before
// doing any compression/upload work.

const { mockRpc, mockStorageUpload, mockFrom } = vi.hoisted(() => {
  const mockStorageUpload = vi.fn(async () => ({ data: { path: 'img-123.jpg' }, error: null }));
  const mockFrom = vi.fn(() => ({
    upload: mockStorageUpload,
    getPublicUrl: () => ({ data: { publicUrl: 'https://example.com/img-123.jpg' } }),
    insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'asset-1' } }) }) }),
  }));
  return { mockRpc: vi.fn(), mockStorageUpload, mockFrom };
});

vi.mock('./supabase', () => ({
  supabase: {
    rpc: mockRpc,
    storage: { from: mockFrom },
    from: mockFrom,
  },
}));

// Compression itself is unrelated to what's under test here (the rate-limit
// gate) and does real canvas work that doesn't resolve in jsdom -- stub it
// out so these tests stay fast and focused.
vi.mock('./compressImage', () => ({
  compressImage: vi.fn(async (blob: Blob) => ({ blob, extension: 'jpg', mimeType: 'image/jpeg' })),
}));

import { uploadImage } from './mediaPipeline';

beforeEach(() => {
  mockRpc.mockReset();
  mockStorageUpload.mockClear();
});

describe('uploadImage: server-side upload-count rate limit', () => {
  it('checks the rate limit before doing any compression/upload work', async () => {
    mockRpc.mockResolvedValue({ error: null });
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    await uploadImage(blob, { bucket: 'avatars' });
    expect(mockRpc).toHaveBeenCalledWith('check_media_upload_rate_limit');
  });

  it('rejects the upload with a clear message when the limit is hit, before any Storage call', async () => {
    mockRpc.mockResolvedValue({ error: { code: 'P0429', message: 'rate_limited' } });
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    await expect(uploadImage(blob, { bucket: 'avatars' })).rejects.toThrow(/too many uploads/i);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('fails CLOSED on an unrelated RPC error too -- an infra hiccup must not let uploads through unmetered', async () => {
    mockRpc.mockResolvedValue({ error: { code: '42883', message: 'function check_media_upload_rate_limit() does not exist' } });
    const blob = new Blob(['x'], { type: 'image/jpeg' });
    await expect(uploadImage(blob, { bucket: 'avatars' })).rejects.toThrow(/too many uploads/i);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });
});
