import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Storage audit finding: all 6 storage.buckets rows had file_size_limit =
// null -- no provider-side cap on object size at all, only client-side
// checks a caller bypassing the app's JS can skip. This migration adds a
// real cap to each bucket, sized to the largest legitimate client-side
// check plus a small margin, without reducing any legitimate upload.

let migrationSql: string;

beforeAll(() => {
  migrationSql = readFileSync(
    join(__dirname, '..', '..', 'supabase', 'migrations', '0169_storage_bucket_file_size_limits.sql'),
    'utf8'
  );
});

function limitFor(bucket: string): number | null {
  const re = new RegExp(
    `update\\s+storage\\.buckets\\s+set\\s+file_size_limit\\s*=\\s*(\\d+)\\s+where\\s+id\\s*(?:=\\s*'${bucket}'|in\\s*\\([^)]*'${bucket}'[^)]*\\))\\s*;`,
    'i'
  );
  const m = migrationSql.match(re);
  return m ? Number(m[1]) : null;
}

describe('migration 0169: storage bucket file_size_limit values', () => {
  it('sets avatars to 20MB (client check: 8MB + margin)', () => {
    expect(limitFor('avatars')).toBe(20 * 1024 * 1024);
  });

  it('sets direct_messages to 20MB (client check: 15MB + margin)', () => {
    expect(limitFor('direct_messages')).toBe(20 * 1024 * 1024);
  });

  it('sets events to 20MB (client check: 15MB + margin)', () => {
    expect(limitFor('events')).toBe(20 * 1024 * 1024);
  });

  it('sets service-providers to 20MB (client check: 15MB + margin)', () => {
    expect(limitFor('service-providers')).toBe(20 * 1024 * 1024);
  });

  it('sets highlights to 20MB (no legitimate caller found; consistent margin applied anyway)', () => {
    expect(limitFor('highlights')).toBe(20 * 1024 * 1024);
  });

  it('sets verification-docs to 15MB (client check: 10MB + margin)', () => {
    expect(limitFor('verification-docs')).toBe(15 * 1024 * 1024);
  });

  it('never reduces a legitimate client-side limit -- every new limit is >= its client check', () => {
    const clientChecks: Record<string, number> = {
      avatars: 8 * 1024 * 1024,
      direct_messages: 15 * 1024 * 1024,
      events: 15 * 1024 * 1024,
      'service-providers': 15 * 1024 * 1024,
      'verification-docs': 10 * 1024 * 1024,
    };
    for (const [bucket, clientMax] of Object.entries(clientChecks)) {
      expect(limitFor(bucket)).toBeGreaterThanOrEqual(clientMax);
    }
  });

  it('does not touch bucket names, public/private status, or allowed_mime_types', () => {
    const sqlStatements = migrationSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(sqlStatements).not.toMatch(/\bpublic\s*=/i);
    expect(sqlStatements).not.toMatch(/allowed_mime_types/i);
    expect(sqlStatements).not.toMatch(/rename|insert into storage\.buckets|delete from storage\.buckets/i);
  });
});
