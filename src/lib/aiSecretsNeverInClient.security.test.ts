import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

// VENTS AI security audit: the three real secrets the AI/payment/admin
// backend code reads (ANTHROPIC_API_KEY for the model,
// PROJECT_ADMIN_DATABASE_URL for the privileged Postgres connection,
// and the Paystack server-side signing/verification secret (already
// guarded separately in withdrawalPayoutFinancialSafety.security.test.ts)
// must never be referenced from src/ (the client bundle), only from
// api/ (server-only serverless functions, never shipped to the browser).
// A literal reference in src/ would mean Vite could bundle it into the
// client JS depending on how it's used -- this test catches that class
// of mistake directly, not just by trusting code review.

describe('AI/payment/admin secrets never reach the client bundle', () => {
  it('ANTHROPIC_API_KEY is referenced only from server-side api/ files or test mocks, never from real client src/ code', () => {
    const srcDir = join(__dirname, '..');
    const { execSync } = require('node:child_process');
    // Test files legitimately stub this env var name to mock server
    // behavior (e.g. vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')) -- that
    // is a fake value in a test process, never a real secret shipped in
    // the client bundle. What this guards against is the name appearing
    // in actual application source that Vite would bundle.
    const hits = execSync(`grep -rl "ANTHROPIC_API_KEY" "${srcDir}" --include="*.ts" --include="*.tsx" | grep -v '\\.test\\.ts$' || true`, { encoding: 'utf8' }).trim();
    expect(hits).toBe('');
  });

  it('PROJECT_ADMIN_DATABASE_URL is referenced only from server-side api/ files or test mocks, never from real client src/ code', () => {
    const srcDir = join(__dirname, '..');
    const { execSync } = require('node:child_process');
    const hits = execSync(`grep -rl "PROJECT_ADMIN_DATABASE_URL" "${srcDir}" --include="*.ts" --include="*.tsx" | grep -v '\\.test\\.ts$' || true`, { encoding: 'utf8' }).trim();
    expect(hits).toBe('');
  });

  it('ANTHROPIC_API_KEY is genuinely read in api/ (proves the grep above is meaningful, not just absent everywhere)', () => {
    const apiDir = join(__dirname, '..', '..', 'api');
    const { execSync } = require('node:child_process');
    const hits = execSync(`grep -rl "ANTHROPIC_API_KEY" "${apiDir}" || true`, { encoding: 'utf8' }).trim();
    expect(hits.length).toBeGreaterThan(0);
  });
});
