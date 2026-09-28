import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis test (same approach as every other *.security.test.ts in
// this repo) for 0114_fix_zero_balance_deletion_blocker.sql.
//
// Follow-up to 0113 (which fixed 16 FKs blocking Dashboard hard-delete):
// the Dashboard delete still failed for real accounts. Root cause,
// confirmed live against the actual reported account
// (jetdriveglobal@gmail.com): 0113 deliberately left user_wallets/
// user_wallet_transactions/wallet_deposit_attempts/vc_withdrawal_requests/
// organizer_withdrawal_requests as NO ACTION, reasoning they were "real
// financial ledgers". That block is value-blind: a user_wallets row is
// auto-provisioned (balance_kobo = 0) the first time ANY user opens the
// wallet screen, so its mere existence -- not any real balance -- was
// enough to block deletion. Confirmed live: this exact account had
// balance_kobo = 0.
//
// Fix: each FK becomes CASCADE, but a BEFORE DELETE trigger (fires for a
// direct delete AND one arriving via cascade) blocks it only when there
// is real value at stake: a nonzero wallet balance, or a withdrawal
// request still 'pending'/'processing'. user_wallet_transactions and
// wallet_deposit_attempts get no guard (history/attempt logs, mirroring
// the already-unguarded vc_transactions and pending_purchases CASCADE
// precedents already in this schema).
//
// Behavioral proof was run live, in isolated rolled-back transactions
// with synthetic accounts, against project slrtjxtzhowhwhebjprv:
//   - PRE-FIX: a synthetic account with a zero-balance user_wallets row
//     failed to hard-delete with the exact FK violation.
//   - POST-FIX: the identical zero-balance account now deletes cleanly.
//   - POST-FIX: a synthetic account with a real (500000 kobo) wallet
//     balance is STILL correctly blocked, with a clear message naming the
//     balance -- the fix did not weaken real-money protection.
//   - POST-FIX: a synthetic account with a 'pending' VC withdrawal
//     request is STILL correctly blocked; once resolved to 'completed',
//     the identical delete succeeds.
//   - POST-FIX, the real reported account (id
//     b939bb61-c55d-49df-8395-6f96c262f30f) now deletes cleanly in a
//     rolled-back transaction (no actual change made).

let migration: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  migration = readFileSync(join(dir, '0114_fix_zero_balance_deletion_blocker.sql'), 'utf8');
});

describe('Replaces the value-blind financial-table deletion block with a value-aware guard', () => {
  it('defines a trigger function that blocks only a nonzero wallet balance', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.block_delete_nonzero_wallet_balance\(\)[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF OLD\.balance_kobo <> 0 THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION/);
  });

  it('defines a trigger function that blocks only a pending/processing withdrawal request', () => {
    const fn = migration.match(/CREATE OR REPLACE FUNCTION public\.block_delete_live_withdrawal_request\(\)[\s\S]*?\$function\$;/)?.[0] ?? '';
    expect(fn).toMatch(/IF OLD\.status IN \('pending', 'processing'\) THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION/);
  });

  it('user_wallets is CASCADE with the balance guard attached', () => {
    expect(migration).toMatch(/ALTER TABLE public\.user_wallets ADD CONSTRAINT user_wallets_user_id_fkey\s*\n\s*FOREIGN KEY \(user_id\) REFERENCES public\.users\(id\) ON DELETE CASCADE;/);
    expect(migration).toMatch(/CREATE TRIGGER trg_block_delete_nonzero_wallet_balance\s*\n\s*BEFORE DELETE ON public\.user_wallets/);
  });

  it('vc_withdrawal_requests and organizer_withdrawal_requests are CASCADE with the live-request guard attached', () => {
    expect(migration).toMatch(/ALTER TABLE public\.vc_withdrawal_requests ADD CONSTRAINT vc_withdrawal_requests_user_id_fkey\s*\n\s*FOREIGN KEY \(user_id\) REFERENCES public\.users\(id\) ON DELETE CASCADE;/);
    expect(migration).toMatch(/CREATE TRIGGER trg_block_delete_live_vc_withdrawal\s*\n\s*BEFORE DELETE ON public\.vc_withdrawal_requests/);
    expect(migration).toMatch(/ALTER TABLE public\.organizer_withdrawal_requests ADD CONSTRAINT organizer_withdrawal_requests_organizer_id_public_users_fkey\s*\n\s*FOREIGN KEY \(organizer_id\) REFERENCES public\.users\(id\) ON DELETE CASCADE;/);
    expect(migration).toMatch(/CREATE TRIGGER trg_block_delete_live_organizer_withdrawal\s*\n\s*BEFORE DELETE ON public\.organizer_withdrawal_requests/);
  });

  it('user_wallet_transactions and wallet_deposit_attempts are CASCADE with no guard trigger (history/attempt logs)', () => {
    expect(migration).toMatch(/ALTER TABLE public\.user_wallet_transactions ADD CONSTRAINT user_wallet_transactions_user_id_fkey\s*\n\s*FOREIGN KEY \(user_id\) REFERENCES public\.users\(id\) ON DELETE CASCADE;/);
    expect(migration).toMatch(/ALTER TABLE public\.wallet_deposit_attempts ADD CONSTRAINT wallet_deposit_attempts_user_id_fkey\s*\n\s*FOREIGN KEY \(user_id\) REFERENCES public\.users\(id\) ON DELETE CASCADE;/);
    expect(migration).not.toMatch(/CREATE TRIGGER[^;]*user_wallet_transactions/);
    expect(migration).not.toMatch(/CREATE TRIGGER[^;]*wallet_deposit_attempts/);
  });

  it('does not touch any other table, policy, or grant', () => {
    const sql = migration.replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/\bGRANT\b/);
    expect(sql).not.toMatch(/CREATE POLICY|DROP POLICY/);
  });
});
