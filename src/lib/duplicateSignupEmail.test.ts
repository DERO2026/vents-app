import { describe, it, expect } from 'vitest';
import { isConfirmedDuplicateEmailError, isUnconfirmedDuplicateSignupError } from './duplicateSignupEmail';

describe('isConfirmedDuplicateEmailError', () => {
  it('is true for the exact error AuthScreen throws from check_user_exists (CONFIRMED account)', () => {
    expect(isConfirmedDuplicateEmailError(new Error('Email already exists'))).toBe(true);
  });

  it('is false for Supabase signUp()\'s own duplicate-email wording (UNCONFIRMED account case)', () => {
    expect(isConfirmedDuplicateEmailError(new Error('User already registered'))).toBe(false);
    expect(isConfirmedDuplicateEmailError({ message: 'A user with this email address has already registered' })).toBe(false);
  });

  it('is false for an unrelated error (network failure)', () => {
    expect(isConfirmedDuplicateEmailError(new Error('Failed to fetch'))).toBe(false);
  });

  it('is false for a message that merely contains similar words in a different shape', () => {
    expect(isConfirmedDuplicateEmailError(new Error('Email already exists somewhere else'))).toBe(false);
  });

  it('handles null/undefined/non-object input without throwing', () => {
    expect(isConfirmedDuplicateEmailError(null)).toBe(false);
    expect(isConfirmedDuplicateEmailError(undefined)).toBe(false);
    expect(isConfirmedDuplicateEmailError('Email already exists')).toBe(false);
  });
});

describe('isUnconfirmedDuplicateSignupError', () => {
  it('is true for Supabase Auth\'s "already registered" duplicate-signup error', () => {
    expect(isUnconfirmedDuplicateSignupError(new Error('User already registered'))).toBe(true);
  });

  it('is true for other Supabase-style duplicate-email wordings', () => {
    expect(isUnconfirmedDuplicateSignupError({ message: 'A user with this email address has already registered' })).toBe(true);
    expect(isUnconfirmedDuplicateSignupError({ message: 'Email already in use' })).toBe(true);
  });

  it('is also true for our own check_user_exists message shape (by design: the AuthScreen call site never reaches this check for that case, since it returns/throws earlier)', () => {
    expect(isUnconfirmedDuplicateSignupError(new Error('Email already exists'))).toBe(true);
  });

  it('is false for a genuinely new/unrelated error (network failure)', () => {
    expect(isUnconfirmedDuplicateSignupError(new Error('Failed to fetch'))).toBe(false);
    expect(isUnconfirmedDuplicateSignupError(new Error('Network request failed'))).toBe(false);
  });

  it('is false for unrelated validation errors', () => {
    expect(isUnconfirmedDuplicateSignupError(new Error('Password must be at least 6 characters'))).toBe(false);
  });

  it('handles null/undefined/non-object/no-message input without throwing', () => {
    expect(isUnconfirmedDuplicateSignupError(null)).toBe(false);
    expect(isUnconfirmedDuplicateSignupError(undefined)).toBe(false);
    expect(isUnconfirmedDuplicateSignupError({})).toBe(false);
    expect(isUnconfirmedDuplicateSignupError('User already registered')).toBe(false);
  });
});
