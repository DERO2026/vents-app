import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 2 cost-hardening finding: ConversationScreen.tsx's sendImageMessage
// uploads directly to Supabase Storage and never went through
// src/lib/mediaPipeline.ts's uploadImage() -- the one place Phase 1 added
// check_media_upload_rate_limit and a 15MB-style size convention. This
// chat path had none of that: no file-size cap, no upload-count rate
// limit, no long-lived Cache-Control. Static-analysis test (ConversationScreen
// is a large, un-unit-tested component with no existing render harness in
// this repo -- this proves the fix is wired in the right order without
// needing one) matching the convention already used for
// paystackVerifyRateLimit.security.test.ts / emergencyKillSwitches.security.test.ts.

let source: string;

beforeAll(() => {
  source = readFileSync(join(__dirname, '..', 'app', 'components', 'ConversationScreen.tsx'), 'utf8');
});

function fnBody(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  const end = source.indexOf('}, [', start);
  const closeIdx = source.indexOf('\n  }, [', start);
  return source.slice(start, closeIdx === -1 ? end : closeIdx);
}

describe('ConversationScreen sendImageMessage: upload hardening', () => {
  it('rejects a file over 15MB before any compression or network call', () => {
    const fn = fnBody('sendImageMessage');
    expect(fn).toMatch(/file\.size\s*>\s*15\s*\*\s*1024\s*\*\s*1024/);
    const sizeCheckIdx = fn.search(/file\.size\s*>\s*15\s*\*\s*1024\s*\*\s*1024/);
    const compressIdx = fn.indexOf('compressImage(file)');
    expect(sizeCheckIdx).toBeGreaterThan(-1);
    expect(compressIdx).toBeGreaterThan(sizeCheckIdx);
  });

  it('calls check_media_upload_rate_limit before compressing/uploading', () => {
    const fn = fnBody('sendImageMessage');
    const rpcIdx = fn.indexOf("supabase.rpc('check_media_upload_rate_limit')");
    const compressIdx = fn.indexOf('compressImage(file)');
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(compressIdx).toBeGreaterThan(rpcIdx);
  });

  it('sets a long-lived Cache-Control on the uploaded object (unique key, upsert:false, safe to cache)', () => {
    const fn = fnBody('sendImageMessage');
    expect(fn).toMatch(/cacheControl:\s*'31536000'/);
  });
});
