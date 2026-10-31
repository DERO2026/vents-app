import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// Migration 0192 is retired (docs/migration-apply-plan-0192-0203.md §4):
// applied before 0203 it blocks 0203; applied after (with a naive
// IF NOT EXISTS edit) it silently replaces 0203's money functions. These
// checks keep it out of the applied set and keep its hazard from returning.

const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
const topLevel = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const retired = join(dir, '_superseded', '0192_platform_fee_accounting_foundation.sql');

describe('0192 retirement', () => {
  it('no top-level migration is 0192, so nothing applies it by filename order', () => {
    expect(topLevel.filter((f) => f.startsWith('0192'))).toEqual([]);
  });

  it('the retired file is kept unchanged for history', () => {
    expect(existsSync(retired)).toBe(true);
    expect(createHash('sha256').update(readFileSync(retired)).digest('hex'))
      .toBe('b157d102581f67b14e90196f61159d12cb45c0632c638be82bb4854d22b0ff84');
  });

  it('the superseded folder explains why its files must never be applied', () => {
    const readme = readFileSync(join(dir, '_superseded', 'README.md'), 'utf8');
    expect(readme).toMatch(/must \*\*not\*\* be applied/);
    expect(readme).toMatch(/0192_platform_fee_accounting_foundation\.sql/);
  });

  it('no migration after 0203 fully replaces a function 0203 patches (the 0192 hazard)', () => {
    const patched = ['confirm_ticket_payment', 'confirm_ticket_payment_via_wallet', 'credit_organizer_wallet',
      'credit_provider_wallet_for_booking', 'create_pending_purchase', 'refund_ticket', 'finalize_ticket_refund',
      'cancel_service_booking', 'finalize_service_booking_refund', 'request_organizer_payout', 'complete_organizer_payout'];
    const offenders: string[] = [];
    for (const f of topLevel.filter((name) => name > '0203')) {
      const sql = readFileSync(join(dir, f), 'utf8');
      for (const fn of patched) {
        if (new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i').test(sql)) offenders.push(`${f}: ${fn}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the apply chain 0201, 0202, 0203 is all still at the top level', () => {
    for (const n of ['0201', '0202', '0203']) expect(topLevel.some((f) => f.startsWith(n))).toBe(true);
  });
});
