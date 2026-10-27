import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for 0194_direct_messages_column_grant_hardening.sql.
//
// This suite is static: it reads the literal migration SQL and asserts on
// its text, following the same convention as
// platformFeeAllocation.security.test.ts / walletRefundFeeLedger.security.test.ts.
// It does NOT execute SQL against a live database -- that real-execution
// coverage (proving the vulnerability exists pre-fix, and that the fix
// both blocks unauthorized columns and preserves the legitimate read_at /
// deleted_by_sender paths under the actual non-superuser `authenticated`
// role) lives in scripts/local-pg-test/run-direct-messages-grant-verification.sh,
// which is the authoritative proof for this migration, not this file.

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(
    join(dir, '0194_direct_messages_column_grant_hardening.sql'),
    'utf8'
  );
});

describe('0194_direct_messages_column_grant_hardening.sql', () => {
  it('revokes the prior table-wide UPDATE grant from authenticated and anon', () => {
    expect(migration).toMatch(
      /REVOKE\s+UPDATE\s+ON\s+public\.direct_messages\s+FROM\s+authenticated\s*,\s*anon\s*;/i
    );
  });

  it('grants back UPDATE on only read_at and deleted_by_sender to authenticated', () => {
    const match = migration.match(
      /GRANT\s+UPDATE\s*\(([^)]+)\)\s+ON\s+public\.direct_messages\s+TO\s+authenticated\s*;/i
    );
    expect(match).not.toBeNull();
    const columns = match![1]
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .sort();
    expect(columns).toEqual(['deleted_by_sender', 'read_at'].sort());
  });

  it('does not grant anon any UPDATE columns back', () => {
    // anon must not appear as a grantee on any GRANT UPDATE statement.
    const grantUpdateLines = migration
      .split('\n')
      .filter((line) => /GRANT\s+UPDATE/i.test(line));
    for (const line of grantUpdateLines) {
      expect(line.toLowerCase()).not.toMatch(/\banon\b/);
    }
  });

  it('does not grant UPDATE on protected columns (body, sender_id, recipient_id, etc.) to authenticated', () => {
    const match = migration.match(
      /GRANT\s+UPDATE\s*\(([^)]+)\)\s+ON\s+public\.direct_messages\s+TO\s+authenticated\s*;/i
    );
    const columns = match![1].toLowerCase();
    for (const protectedColumn of [
      'body',
      'sender_id',
      'recipient_id',
      'image_url',
      'media_type',
      'reply_to_id',
      'event_id',
      'duration_seconds',
      'created_at',
      'id',
    ]) {
      expect(columns).not.toMatch(new RegExp(`\\b${protectedColumn}\\b`));
    }
  });

  it('does not touch migration 0192 or 0193', () => {
    // Scope discipline: this migration must not reference or redefine any
    // object introduced by the fee-accounting or VENTS Earn migrations.
    expect(migration).not.toMatch(/platform_fee_kobo|allocate_ticket_platform_fees/i);
    expect(migration).not.toMatch(/recruiter_partnerships|register_as_recruiter/i);
  });

  it('does not alter the existing dm_update RLS policy (row-scope restriction is unchanged)', () => {
    expect(migration).not.toMatch(/CREATE\s+POLICY\s+dm_update/i);
    expect(migration).not.toMatch(/ALTER\s+POLICY\s+dm_update/i);
    expect(migration).not.toMatch(/DROP\s+POLICY\s+dm_update/i);
  });

  it('does not introduce any commission/payout logic', () => {
    expect(migration).not.toMatch(/commission|payout/i);
  });
});
