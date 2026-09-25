import { describe, it, expect } from 'vitest';
import { ticketDisplayCode, parseTicketDisplayCode } from './ticketCode';

describe('ticketDisplayCode', () => {
  const uuid = '89ac9a41-f868-49f0-8607-f3f62f30e2c6';

  it('never exposes the raw guid', () => {
    const code = ticketDisplayCode(uuid);
    expect(code).not.toContain(uuid);
    expect(code).not.toContain('-f868-'); // no guid fragment leaks through
  });

  it('produces the VT-XXXXX-… alphanumeric format', () => {
    const code = ticketDisplayCode(uuid);
    expect(code).toMatch(/^VT(-[0-9A-Z]{1,5})+$/);
  });

  it('is deterministic — same id always yields the same code', () => {
    expect(ticketDisplayCode(uuid)).toBe(ticketDisplayCode(uuid));
  });

  it('is collision-free — different ids yield different codes', () => {
    const a = ticketDisplayCode('89ac9a41-f868-49f0-8607-f3f62f30e2c6');
    const b = ticketDisplayCode('89ac9a41-f868-49f0-8607-f3f62f30e2c7'); // one hex digit apart
    expect(a).not.toBe(b);
  });

  it('handles empty / nullish input without throwing', () => {
    expect(ticketDisplayCode(null)).toBe('—');
    expect(ticketDisplayCode(undefined)).toBe('—');
    expect(ticketDisplayCode('')).toBe('—');
  });
});

describe('parseTicketDisplayCode — the scanner manual-entry fallback', () => {
  const uuid = '89ac9a41-f868-49f0-8607-f3f62f30e2c6';

  it('round-trips: decoding an encoded code recovers the exact original uuid', () => {
    const code = ticketDisplayCode(uuid);
    expect(parseTicketDisplayCode(code)).toBe(uuid);
  });

  it('round-trips for an all-zero uuid (leading-zero padding edge case)', () => {
    const zero = '00000000-0000-0000-0000-000000000000';
    expect(parseTicketDisplayCode(ticketDisplayCode(zero))).toBe(zero);
  });

  it('round-trips for the all-Fs uuid (max value edge case)', () => {
    const max = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    expect(parseTicketDisplayCode(ticketDisplayCode(max))).toBe(max);
  });

  it('is forgiving of formatting a staffer might type: lowercase, no dashes, no VT- prefix', () => {
    const code = ticketDisplayCode(uuid); // "VT-XXXXX-XXXXX-..."
    const messy = code.toLowerCase().replace(/^vt-?/, '').replace(/-/g, '');
    expect(parseTicketDisplayCode(messy)).toBe(uuid);
  });

  it('returns null for input containing characters outside base36 (never guesses)', () => {
    expect(parseTicketDisplayCode('VT-!!!!!')).toBeNull();
    expect(parseTicketDisplayCode('hello world!')).toBeNull();
    expect(parseTicketDisplayCode('')).toBeNull();
    expect(parseTicketDisplayCode(null)).toBeNull();
    expect(parseTicketDisplayCode(undefined)).toBeNull();
  });

  it('a well-formed-but-nonexistent code decodes to SOME uuid rather than null -- this is expected: the client has no way to know a code is fake without asking the server, which manual_check_in does (not_found) once this uuid is handed to it', () => {
    const decoded = parseTicketDisplayCode('not a code');
    expect(decoded).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns null for a code that decodes past 128 bits (never fabricates a truncated uuid)', () => {
    expect(parseTicketDisplayCode('VT-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ')).toBeNull();
  });
});
