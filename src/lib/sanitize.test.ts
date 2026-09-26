import { describe, it, expect } from 'vitest';
import { validatePassword, MIN_PASSWORD_LENGTH } from './sanitize';

// Regression test for the client/server/Supabase-project password-length
// drift: AuthScreen.tsx and schemas.ts used to hardcode 10 while the
// Supabase Auth project's actual "Minimum password length" setting was 6,
// meaning a real 6-9 character password satisfying Supabase would still be
// rejected client-side. MIN_PASSWORD_LENGTH is now the single source of
// truth all three read from.
describe('validatePassword', () => {
  it('matches the Supabase project minimum password length (6)', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(6);
  });

  it('accepts a password at exactly the minimum length', () => {
    expect(validatePassword('Abcde1')).toBe(true); // 6 chars
  });

  it('rejects a password one character below the minimum', () => {
    expect(validatePassword('Abcd1')).toBe(false); // 5 chars
  });

  it('still requires an uppercase letter, a lowercase letter, and a number', () => {
    expect(validatePassword('abcdef')).toBe(false); // no upper, no digit
    expect(validatePassword('ABCDEF')).toBe(false); // no lower, no digit
    expect(validatePassword('Abcdef')).toBe(false); // no digit
    expect(validatePassword('Abcde1')).toBe(true);
  });
});
