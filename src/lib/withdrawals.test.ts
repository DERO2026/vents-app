import { describe, it, expect, vi } from 'vitest';
vi.mock('./supabase', () => ({ supabase: {} }));
import { pinProblem, parseWithdrawalResult, stageInfo, WITHDRAWAL_STAGES, normalizePinStatus } from './withdrawals';

describe('withdrawal PIN rules (mirror the server; the server is the authority)', () => {
  it('needs exactly 4 digits', () => {
    expect(pinProblem('739')).toMatch(/exactly 4 digits/);
    expect(pinProblem('73a1')).toMatch(/exactly 4 digits/);
    expect(pinProblem('73911')).toMatch(/exactly 4 digits/);
    expect(pinProblem('7391')).toBeNull();
  });
  it('must be confirmed', () => {
    expect(pinProblem('7391', '7392')).toMatch(/do not match/);
    expect(pinProblem('7391', '7391')).toBeNull();
  });
  it('refuses the same easy PINs as withdrawal_pin_is_weak', () => {
    for (const weak of ['0000', '1111', '1234', '0123', '6789', '4321', '9876', '1212', '2020']) {
      expect(pinProblem(weak)).toMatch(/too easy/);
    }
    for (const ok of ['7391', '5820', '4826', '8053', '1357']) expect(pinProblem(ok)).toBeNull();
  });
});

describe('request_withdrawal results', () => {
  it('success', () => {
    expect(parseWithdrawalResult({ ok: true, request_id: 'r1' })).toEqual({ ok: true, requestId: 'r1', replayed: false });
  });
  it('wrong PIN keeps the server message and attempts left', () => {
    const r = parseWithdrawalResult({ ok: false, code: 'wrong_pin', attempts_left: 3, message: 'Wrong PIN. 3 attempts left' });
    expect(r).toMatchObject({ ok: false, code: 'wrong_pin', attemptsLeft: 3, message: 'Wrong PIN. 3 attempts left' });
  });
  it('an unexpected shape is never treated as success', () => {
    expect(parseWithdrawalResult(null).ok).toBe(false);
    expect(parseWithdrawalResult({ ok: 'true' }).ok).toBe(false);
    expect(parseWithdrawalResult({ ok: true }).ok).toBe(false); // no request id
  });
});

describe('stages', () => {
  it('every server stage has user and admin wording', () => {
    for (const s of ['pending_first_approval', 'pending_second_approval', 'approved', 'processing', 'paid', 'rejected', 'failed', 'cancelled', 'reversed']) {
      expect(WITHDRAWAL_STAGES[s as keyof typeof WITHDRAWAL_STAGES]).toBeTruthy();
    }
    expect(stageInfo('pending_second_approval').user).toBe('Waiting for second approval');
    expect(stageInfo('processing').detail).toMatch(/only when Paystack confirms/);
  });
  it('never calls a withdrawal paid before Paystack confirmed it', () => {
    for (const s of ['pending_first_approval', 'pending_second_approval', 'approved', 'processing']) {
      expect(stageInfo(s).user.toLowerCase()).not.toContain('paid');
    }
  });
  it('an unknown stage shows as-is instead of crashing', () => {
    expect(stageInfo('mystery').user).toBe('mystery');
  });
});

describe('PIN status', () => {
  it('never carries anything but the documented fields', () => {
    const s = normalizePinStatus({ has_pin: true, locked: false, attempts_left: 5, pin_hash: 'x', pin: '7391' });
    expect(s).toEqual({ has_pin: true, locked: false, locked_until: null, must_reset: false, attempts_left: 5, withdrawals_paused_until: null });
  });
});
