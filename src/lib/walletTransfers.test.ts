import { describe, it, expect, vi } from 'vitest';
vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }));
import {
  parseNairaToKobo, usernameProblem, normalizeUsernameInput, transferAmountProblem, payLinkFor, usernameFromPayParam,
  newTransferKey, transferRefusalText, formatNaira, type TransferStatus,
} from './walletTransfers';
import { isWalletCredit, walletTxnDirection, walletTxnLabel } from './walletMath';
import { classifyWalletTransaction } from './walletTransactionClassifier';

const status = (over: Partial<TransferStatus> = {}): TransferStatus => ({
  enabled: true, username: 'ada', sent_today_kobo: 0, sent_today_count: 0, remaining_today_kobo: 50000000,
  account_ok: true, account_old_enough: true, email_verified: true, has_pin: true, pin_locked: false, pin_paused_until: null,
  policy: { min_kobo: 10000, max_kobo: 20000000, daily_kobo: 50000000, daily_count: 20, min_account_age_hours: 24, note_max_length: 140 },
  ...over,
});

describe('amount parsing is exact (kobo, no floating point)', () => {
  it.each([
    ['100', 10000], ['100.5', 10050], ['100.05', 10005], ['₦1,250.75', 125075], [' 0.01 ', 1], ['200000', 20000000],
  ])('%s -> %i kobo', (input, kobo) => { expect(parseNairaToKobo(input)).toBe(kobo); });
  it.each(['', 'abc', '1.234', '-5', '1e3', '12.3.4', '١٢'])('%s is not an amount', (input) => { expect(parseNairaToKobo(input)).toBeNull(); });
});

describe('client-side checks mirror the server policy (the server still decides)', () => {
  it('min, max, daily remaining and balance', () => {
    expect(transferAmountProblem(9999, 1e9, status())).toMatch(/minimum is ₦100.00/);
    expect(transferAmountProblem(20000001, 1e9, status())).toMatch(/maximum per transfer is ₦200,000.00/);
    expect(transferAmountProblem(600000, 1e9, status({ remaining_today_kobo: 500000 }))).toMatch(/₦5,000.00 more today/);
    expect(transferAmountProblem(600000, 500000, status())).toMatch(/More than your VENTS Wallet balance/);
    expect(transferAmountProblem(500000, 500000, status())).toBeNull();
    expect(transferAmountProblem(null, 500000, status())).toMatch(/Enter an amount/);
  });
});

describe('usernames and pay links', () => {
  it('normalizes and validates', () => {
    expect(normalizeUsernameInput('  @Ada.B ')).toBe('ada.b');
    expect(usernameProblem('')).toMatch(/Enter/);
    expect(usernameProblem('a')).toMatch(/letters, numbers/);
    expect(usernameProblem("x'; drop")).toMatch(/letters, numbers/);
    expect(usernameProblem('@ada_b')).toBeNull();
  });
  it('the Receive link opens Send Money to exactly that username', () => {
    expect(payLinkFor('ada_b')).toBe('https://getvents.com/?pay=ada_b');
    expect(usernameFromPayParam('@ada_b')).toBe('ada_b');
    expect(usernameFromPayParam('<script>')).toBeNull();
    expect(usernameFromPayParam('../../x')).toBeNull();
    expect(usernameFromPayParam(null)).toBeNull();
  });
});

describe('idempotency keys', () => {
  it('are unique and match the server format', () => {
    const a = newTransferKey(); const b = newTransferKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,100}$/);
  });
});

describe('refusals are explained in plain language', () => {
  it('maps codes', () => {
    expect(transferRefusalText({ ok: false, code: 'insufficient_funds' })).toMatch(/Not enough money/);
    expect(transferRefusalText({ ok: false, code: 'pin_not_set' })).toMatch(/Create your 4-digit VENTS PIN/);
    expect(transferRefusalText({ ok: false, code: 'wrong_pin', message: 'Wrong PIN. 3 attempts left' })).toBe('Wrong PIN. 3 attempts left');
    expect(transferRefusalText({ ok: false, code: 'something_new', message: 'Server says no' })).toBe('Server says no');
  });
  it('formats naira', () => { expect(formatNaira(123456789)).toBe('₦1,234,567.89'); });
});

describe('transaction direction (regression: VC conversions were shown as money out)', () => {
  it('credits and debits', () => {
    for (const t of ['deposit', 'refund', 'vc_conversion', 'transfer_in']) { expect(isWalletCredit(t), t).toBe(true); expect(walletTxnDirection(t)).toBe('in'); }
    for (const t of ['spend', 'transfer_out']) { expect(isWalletCredit(t), t).toBe(false); expect(walletTxnDirection(t)).toBe('out'); }
    expect(walletTxnDirection('something_future')).toBe('unknown');
  });
  it('labels and classification', () => {
    expect(walletTxnLabel('transfer_in', null)).toBe('Money received');
    expect(walletTxnLabel('vc_conversion', null)).toBe('VENTS Cents converted');
    expect(classifyWalletTransaction({ type: 'transfer_out', referenceId: 'VTABC' })).toBe('transfer_out');
    expect(classifyWalletTransaction({ type: 'vc_conversion', referenceId: 'x' })).toBe('vc_conversion');
    expect(classifyWalletTransaction({ type: 'spend', referenceId: 'VNT-1' })).toBe('ticket_purchase');
  });
});
