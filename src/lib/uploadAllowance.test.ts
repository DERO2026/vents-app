import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uploadAllowanceError, nextUploadWindow, UploadAllowanceError } from './uploadAllowance';

// Regression: every failed check_media_upload_rate_limit call used to be
// reported as "Too many uploads", whatever actually failed.

describe('uploadAllowanceError', () => {
  const now = new Date('2026-10-31T10:20:00Z');

  it('a real rate limit names the limit and the time uploads resume', () => {
    const e = uploadAllowanceError({ code: 'P0429', message: 'rate_limited' }, now);
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAt?.toISOString()).toBe('2026-10-31T11:00:00.000Z');
    expect(e.message).toMatch(/limit of 30 uploads per hour/);
  });

  it('the window is a fixed clock hour (matches floor(epoch / 3600) in check_rate_limit)', () => {
    expect(nextUploadWindow(new Date('2026-10-31T10:59:59Z')).toISOString()).toBe('2026-10-31T11:00:00.000Z');
    expect(nextUploadWindow(new Date('2026-10-31T11:00:00Z')).toISOString()).toBe('2026-10-31T12:00:00.000Z');
  });

  it('Preview, sign-out and network failures are never reported as a rate limit', () => {
    expect(uploadAllowanceError({ code: 'PREVIEW_READ_ONLY', message: 'x' }).kind).toBe('preview');
    expect(uploadAllowanceError({ code: 'P0001', message: 'Not authenticated' }).kind).toBe('signed_out');
    expect(uploadAllowanceError(new TypeError('Failed to fetch')).kind).toBe('unavailable');
    expect(uploadAllowanceError({ code: '42883', message: 'function does not exist' }).kind).toBe('unavailable');
    for (const err of [{ code: 'PREVIEW_READ_ONLY' }, { message: 'Not authenticated' }, new TypeError('Failed to fetch')]) {
      expect(uploadAllowanceError(err).message).not.toMatch(/too many uploads|limit of 30/i);
    }
  });

  it('passes an already-classified error through unchanged', () => {
    const e = new UploadAllowanceError('preview', 'x');
    expect(uploadAllowanceError(e)).toBe(e);
  });
});

describe('every upload site classifies the error instead of hardcoding "Too many uploads"', () => {
  const root = join(__dirname, '..');
  const files = [
    'lib/mediaPipeline.ts',
    'app/components/ServiceProviderSetupScreen.tsx',
    'app/components/SettingsScreen.tsx',
    'app/components/ServiceProviderVerificationScreen.tsx',
    'app/components/AuthScreen.tsx',
    'app/components/ConversationScreen.tsx',
  ];
  for (const f of files) {
    it(f, () => {
      const src = readFileSync(join(root, f), 'utf8');
      expect(src).toMatch(/check_media_upload_rate_limit/);
      expect(src).toMatch(/uploadAllowanceError\(/);
      expect(src).not.toMatch(/['"]Too many uploads/);
    });
  }
});

describe('mediaPipeline still fails closed', () => {
  const rpc = vi.fn();
  const upload = vi.fn();
  beforeEach(() => { rpc.mockReset(); upload.mockReset(); vi.resetModules(); });

  async function load() {
    vi.doMock('./supabase', () => ({
      supabase: { rpc, storage: { from: () => ({ upload, getPublicUrl: () => ({ data: { publicUrl: 'u' } }) }) }, from: () => ({}) },
      getAuthToken: async () => 't',
    }));
    return import('./mediaPipeline');
  }

  it('a thrown RPC failure blocks the upload with an accurate message', async () => {
    rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    const { uploadImage } = await load();
    await expect(uploadImage(new Blob(['x']), { bucket: 'avatars' })).rejects.toThrow(/Check your connection/);
    expect(upload).not.toHaveBeenCalled();
  });
});
