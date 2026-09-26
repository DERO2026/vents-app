import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createConfirmationToken, verifyConfirmationToken } from '../../api/_lib/aiConfirmation';

// Unit tests for VENTS AI's confirmation-token helper (api/_lib/aiConfirmation.ts),
// which gates every Phase 2 mutating tool (start_ticket_transfer,
// request_ticket_refund, start_service_booking, create_report): the model can
// only ever propose one of these, never execute it directly, and the real
// executor only runs once the client re-sends the exact token it was given
// back with a matching action/params/userId.

const ACTION = 'request_ticket_refund';
const PARAMS = { ticket_id: 'tkt_1', reason: 'Event cancelled' };
const USER_ID = 'user_abc';

beforeEach(() => {
  process.env.AI_CONFIRMATION_SECRET = 'test-secret-do-not-use-in-prod';
});

describe('createConfirmationToken / verifyConfirmationToken', () => {
  it('accepts a freshly minted token for the exact same action/params/userId', () => {
    const token = createConfirmationToken(ACTION, PARAMS, USER_ID);
    const result = verifyConfirmationToken(token, ACTION, PARAMS, USER_ID);
    expect(result.ok).toBe(true);
  });

  it('accepts params regardless of key order (stable comparison)', () => {
    const token = createConfirmationToken(ACTION, PARAMS, USER_ID);
    const reordered = { reason: PARAMS.reason, ticket_id: PARAMS.ticket_id };
    const result = verifyConfirmationToken(token, ACTION, reordered, USER_ID);
    expect(result.ok).toBe(true);
  });

  it('rejects a token whose params were tampered with after minting', () => {
    const token = createConfirmationToken(ACTION, PARAMS, USER_ID);
    const tamperedParams = { ...PARAMS, ticket_id: 'tkt_2' };
    const result = verifyConfirmationToken(token, ACTION, tamperedParams, USER_ID);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('params mismatch');
  });

  it('rejects a token being confirmed for a different action than it was minted for', () => {
    const token = createConfirmationToken(ACTION, PARAMS, USER_ID);
    const result = verifyConfirmationToken(token, 'start_service_booking', PARAMS, USER_ID);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('action mismatch');
  });

  it('rejects a token minted for a different user (cannot replay someone else\'s confirmation)', () => {
    const token = createConfirmationToken(ACTION, PARAMS, USER_ID);
    const result = verifyConfirmationToken(token, ACTION, PARAMS, 'someone-else');
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('user mismatch');
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    try {
      const token = createConfirmationToken(ACTION, PARAMS, USER_ID);
      vi.advanceTimersByTime(6 * 60 * 1000); // past the 5-minute TTL
      const result = verifyConfirmationToken(token, ACTION, PARAMS, USER_ID);
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.reason).toBe('token expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a token whose signature was tampered with directly', () => {
    const token = createConfirmationToken(ACTION, PARAMS, USER_ID);
    const [body] = token.split('.');
    const forged = `${body}.forged-signature-that-will-never-match`;
    const result = verifyConfirmationToken(forged, ACTION, PARAMS, USER_ID);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('invalid signature');
  });

  it('rejects a malformed token', () => {
    const result = verifyConfirmationToken('not-a-real-token', ACTION, PARAMS, USER_ID);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('malformed token');
  });

  it('rejects a token signed with a different secret (e.g. after a secret rotation)', () => {
    const token = createConfirmationToken(ACTION, PARAMS, USER_ID);
    process.env.AI_CONFIRMATION_SECRET = 'a-different-secret';
    const result = verifyConfirmationToken(token, ACTION, PARAMS, USER_ID);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('invalid signature');
  });
});
