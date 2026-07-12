/** Strip HTML tags and null bytes from user-supplied text. */
export function sanitize(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')   // strip HTML tags
    .replace(/\0/g, '')         // strip null bytes
    .trim();
}

export function sanitizeText(input: string): string {
  return input
    .trim()
    .replace(/[<>'"`;]/g, '')
    .substring(0, 500);
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function validateUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,30}$/.test(username.trim());
}

// Mirrors the backend password policy (insforge.toml [auth.password]) so
// users get an immediate, specific error instead of a late server rejection.
export function validatePassword(password: string): boolean {
  return password.length >= 10 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
}

/** Sanitize all string values in an object (shallow). */
export function sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if (typeof result[key] === 'string') {
      (result as Record<string, unknown>)[key] = sanitize(result[key] as string);
    }
  }
  return result;
}
