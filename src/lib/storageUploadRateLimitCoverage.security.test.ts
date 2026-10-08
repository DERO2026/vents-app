import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Storage audit finding: 6 upload call sites went straight to Storage
// (direct supabase.storage.upload or a raw XHR to the Storage REST
// endpoint) with zero VENTS-side count limit -- check_media_upload_rate_
// limit (30/hr/user, 0163_emergency_cost_hardening.sql) already existed
// and was already wired into mediaPipeline.ts/ConversationScreen.tsx, just
// not these six. Static-analysis tests (large, un-unit-tested components,
// same convention as chatImageUploadHardening.security.test.ts) proving
// each site now checks the limit before its upload/XHR fires.

const componentsDir = join(__dirname, '..', 'app', 'components');

function readSource(file: string): string {
  return readFileSync(join(componentsDir, file), 'utf8');
}

// Extracts a `const <name> = async (...) => { ... }` function body by
// brace-matching from the first `{` after the arrow, so it works
// regardless of how deeply nested the function's own braces are.
function fnBody(source: string, name: string): string {
  const declIdx = source.indexOf(`const ${name} = `);
  if (declIdx === -1) throw new Error(`function ${name} not found`);
  const braceStart = source.indexOf('{', source.indexOf('=>', declIdx));
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

const RATE_LIMIT_CALL = "supabase.rpc('check_media_upload_rate_limit')";

describe('ServiceProviderSetupScreen.handleCropComplete: service-provider photo upload', () => {
  let source: string;
  beforeAll(() => { source = readSource('ServiceProviderSetupScreen.tsx'); });

  it('checks the upload rate limit before any Storage upload', () => {
    const fn = fnBody(source, 'handleCropComplete');
    const rpcIdx = fn.indexOf(RATE_LIMIT_CALL);
    const uploadIdx = fn.indexOf('.storage.from(');
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(rpcIdx);
  });

  it('surfaces a clear message and aborts on a rate-limit error', () => {
    const fn = fnBody(source, 'handleCropComplete');
    const rpcIdx = fn.indexOf(RATE_LIMIT_CALL);
    const nearby = fn.slice(rpcIdx, rpcIdx + 200);
    expect(nearby).toMatch(/limitError/);
    expect(nearby).toMatch(/throw new Error/);
  });
});

describe('SettingsScreen: avatar / cover / verification-doc uploads', () => {
  let source: string;
  beforeAll(() => { source = readSource('SettingsScreen.tsx'); });

  it('handleCropComplete (avatar upload) checks the rate limit before any Storage upload', () => {
    const fn = fnBody(source, 'handleCropComplete');
    const rpcIdx = fn.indexOf(RATE_LIMIT_CALL);
    const uploadIdx = fn.indexOf('.storage.from(');
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(rpcIdx);
  });

  it('handleCoverCropComplete (cover upload) checks the rate limit before any Storage upload', () => {
    const fn = fnBody(source, 'handleCoverCropComplete');
    const rpcIdx = fn.indexOf(RATE_LIMIT_CALL);
    const uploadIdx = fn.indexOf('.storage.from(');
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(rpcIdx);
  });

  it('handleSubmit (organizer verification-doc XHR) checks the rate limit before the upload XHR fires', () => {
    const fn = fnBody(source, 'handleSubmit');
    const rpcIdx = fn.indexOf(RATE_LIMIT_CALL);
    const xhrIdx = fn.indexOf('uploadVerificationCertificate(');
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(xhrIdx).toBeGreaterThan(rpcIdx);
  });

  it('handleSubmit resets submitting state and aborts on a rate-limit error', () => {
    const fn = fnBody(source, 'handleSubmit');
    const rpcIdx = fn.indexOf(RATE_LIMIT_CALL);
    const nearby = fn.slice(rpcIdx, rpcIdx + 300);
    expect(nearby).toMatch(/setSubmitting\(false\)/);
    expect(nearby).toMatch(/return;/);
  });
});

describe('AuthScreen.uploadAvatarIfPending: signup avatar upload', () => {
  let source: string;
  beforeAll(() => { source = readSource('AuthScreen.tsx'); });

  it('checks the rate limit before any Storage upload', () => {
    const fn = fnBody(source, 'uploadAvatarIfPending');
    const rpcIdx = fn.indexOf(RATE_LIMIT_CALL);
    const uploadIdx = fn.indexOf('.storage.from(');
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(uploadIdx).toBeGreaterThan(rpcIdx);
  });

  it('is only ever called once a real authenticated session exists at both call sites', () => {
    // Call site 1: inside the signup branch, gated by `data?.session && data?.user`.
    expect(source).toMatch(/data\?\.session\s*&&\s*data\?\.user[\s\S]{0,200}uploadAvatarIfPending\(\)/);
    // Call site 2: after verifyOtp() has already succeeded and data.user.email is used,
    // which only happens once Supabase has confirmed the user and session are real.
    const secondCallIdx = source.lastIndexOf('uploadAvatarIfPending()');
    const before = source.slice(Math.max(0, secondCallIdx - 400), secondCallIdx);
    expect(before).toMatch(/clearPendingVerification\(\)/);
  });
});

describe('ServiceProviderVerificationScreen.handleSubmit: verification-doc XHR upload', () => {
  let source: string;
  beforeAll(() => { source = readSource('ServiceProviderVerificationScreen.tsx'); });

  it('checks the rate limit before the upload XHR fires', () => {
    const fn = fnBody(source, 'handleSubmit');
    const rpcIdx = fn.indexOf(RATE_LIMIT_CALL);
    const xhrIdx = fn.indexOf('uploadVerificationDoc(');
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(xhrIdx).toBeGreaterThan(rpcIdx);
  });

  it('surfaces a clear message and aborts on a rate-limit error, relying on the outer finally to reset submitting state', () => {
    const fn = fnBody(source, 'handleSubmit');
    const rpcIdx = fn.indexOf(RATE_LIMIT_CALL);
    const nearby = fn.slice(rpcIdx, rpcIdx + 200);
    expect(nearby).toMatch(/limitError/);
    expect(nearby).toMatch(/return;/);
    expect(fn).toMatch(/finally\s*\{\s*setSubmitting\(false\);\s*\}/);
  });
});
