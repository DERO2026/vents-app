/** Strip HTML tags and null bytes from user-supplied text. */
export function sanitize(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')   // strip HTML tags
    .replace(/\0/g, '')         // strip null bytes
    .trim();
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
