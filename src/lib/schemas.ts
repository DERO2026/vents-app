import { z } from 'zod';

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

const NIGERIAN_PHONE_REGEX = /^\+234[789][01]\d{8}$/;

export const signupSchema = z.object({
  name: safeText(1, 100),
  username: z.string().trim().regex(/^[a-zA-Z0-9_]{3,30}$/, 'Username must be 3-30 characters, letters, numbers, and underscores only'),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().regex(NIGERIAN_PHONE_REGEX, 'Phone number must be in +234XXXXXXXXXX format, e.g., +2348012345678'),
  password: z.string().min(8).max(128),
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
    quantity: z.number().min(1),
  })).min(1),
});

export const reviewSchema = z.object({
  body: safeText(10, 1000),
  rating: z.number().min(1).max(5),
});

/** Returns the first validation error message, or null if the payload is clean. */
export function firstValidationError(result: { success: boolean; error?: { issues: { message: string }[] } }): string | null {
  if (result.success) return null;
  return result.error?.issues?.[0]?.message || 'Invalid input.';
}
