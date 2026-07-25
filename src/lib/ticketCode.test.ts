import { describe, it, expect } from 'vitest';
import { ticketDisplayCode } from './ticketCode';

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
