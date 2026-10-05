import { describe, it, expect } from 'vitest';
import { isSafeHttpsUrl } from './externalLink';

// Client-side mirror of public.is_safe_https_url() (migration 0155) --
// these are the same cases the server-side RPC enforces as the actual
// security boundary; this file only guards the fast inline form check.
describe('isSafeHttpsUrl', () => {
  it('accepts valid https URLs', () => {
    expect(isSafeHttpsUrl('https://discord.gg/abc123')).toBe(true);
    expect(isSafeHttpsUrl('https://zoom.us/j/1234567890')).toBe(true);
    expect(isSafeHttpsUrl('  https://meet.google.com/abc-defg-hij  ')).toBe(true);
  });

  it('rejects dangerous schemes', () => {
    expect(isSafeHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpsUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHttpsUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpsUrl('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects non-https schemes', () => {
    expect(isSafeHttpsUrl('http://insecure.example.com')).toBe(false);
    expect(isSafeHttpsUrl('ftp://example.com/file')).toBe(false);
  });

  it('rejects arbitrary non-URL text instead of silently promoting it to a link', () => {
    expect(isSafeHttpsUrl('just some text')).toBe(false);
    expect(isSafeHttpsUrl('')).toBe(false);
    expect(isSafeHttpsUrl('discord.gg/abc123')).toBe(false);
  });
});
