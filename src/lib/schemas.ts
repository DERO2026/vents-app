import { z } from 'zod';

// Generic E.164-shaped check — '+' followed by 7 to 15 digits (ITU E.164's
// max total length, country code included). This is intentionally
// country-agnostic: VENTS launches Nigeria-first for currency/SMS/CAC
// verification (see src/lib/regionConfig.ts), but phone-number entry itself
// must accept any real country's number, not just Nigeria's. Precise
// per-country format/length checks happen earlier in the UI (PhoneInput +
// src/lib/countries.ts's isPlausibleNationalNumber) using the country the
// user actually picked; this is just the last-line defense-in-depth guard
// against an obviously malformed payload reaching the DB.
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * Boundary-layer validation. These run before any DB call — a rejection here
 * means the payload never reaches InsForge. This is defense-in-depth on top
 * of (not a replacement for) parameterized queries and RLS: the goal is to
 * refuse obviously malicious payloads early and give a clean error instead
 * of letting them reach the database layer at all.
 */

// High-signal XSS/SQLi fragments. Narrow patterns only — broad ones like a
// bare "--" or "'" false-positive on real names/dates/descriptions.
const INJECTION_PATTERN =
  /<script\b|<iframe\b|javascript:|on\w+\s*=\s*["']|(\bunion\s+select\b)|(\bdrop\s+table\b)|(\bor\s+1\s*=\s*1\b)|('\s*;?\s*--)/i;

function noInjection(value: string) {
  return !INJECTION_PATTERN.test(value);
}

const safeText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine(noInjection, { message: 'Invalid characters detected' });

export const signupSchema = z.object({
  name: safeText(1, 100),
  username: z.string().trim().regex(/^[a-zA-Z0-9_]{3,30}$/, 'Username must be 3-30 characters, letters, numbers, and underscores only'),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().regex(E164_PATTERN, 'Please enter a valid phone number.'),
  password: z.string().min(10).max(128)
    .regex(/[a-z]/, 'Password must include a lowercase letter')
    .regex(/[A-Z]/, 'Password must include an uppercase letter')
    .regex(/\d/, 'Password must include a number'),
  state: safeText(1, 100),
});

export const loginSchema = z.object({
  identifier: safeText(1, 254), // email or username
  password: z.string().min(1).max(128),
});

export const eventCreateSchema = z.object({
  title: safeText(1, 200),
  description: safeText(0, 5000),
  venue: safeText(1, 200),
  city: safeText(1, 100),
  address: safeText(0, 200).optional(),
  ticketTypes: z.array(z.object({
    name: safeText(1, 100),
    description: safeText(0, 500),
    price: z.number().min(0),
    // No artificial event-size cap — this ceiling exists only to keep a
    // single ticket type's inventory within a sane integer range (stadiums,
    // multi-day festivals, etc. all fit well under it), not to limit event size.
    quantity: z.number().min(1).max(1_000_000),
  })).min(1),
});

/** Returns the first validation error message, or null if the payload is clean. */
export function firstValidationError(result: { success: boolean; error?: { issues: { message: string }[] } }): string | null {
  if (result.success) return null;
  return result.error?.issues?.[0]?.message || 'Invalid input.';
}
