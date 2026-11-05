// Explains a failed check_media_upload_rate_limit call accurately.
//
// The RPC (live definition read 2026-10-31) is
//   check_rate_limit('media_upload:' || auth.uid(), 30, 3600)
// i.e. 30 uploads per user per FIXED clock hour: the bucket is
// floor(epoch / 3600), so it resets on the hour (UTC-aligned), not 60
// minutes after the first upload. It raises 'rate_limited' (SQLSTATE
// P0429) once the 31st call lands in the same hour; that call's own
// increment is rolled back with the exception, so refused attempts do
// not use up more allowance. A call that passes the check DOES count,
// even if the upload after it fails.
//
// Root cause of the misleading "Too many uploads" error: every upload
// site mapped ANY error from this RPC to that message -- including the
// read-only Preview build's block (the RPC is not on its allowlist, so
// every Preview upload said "Too many uploads"), an expired session
// ("Not authenticated") and network failures. Production's rate_limits
// table showed at most 2 media uploads per user-hour, nowhere near 30.
//
// Uploads still fail CLOSED on every error; only the message changes.

export const MEDIA_UPLOADS_PER_HOUR = 30;

export type UploadBlockKind = 'rate_limited' | 'preview' | 'signed_out' | 'unavailable';

export class UploadAllowanceError extends Error {
  kind: UploadBlockKind;
  /** When a rate-limited user can upload again; null for other kinds. */
  retryAt: Date | null;
  constructor(kind: UploadBlockKind, message: string, retryAt: Date | null = null) {
    super(message);
    this.name = 'UploadAllowanceError';
    this.kind = kind;
    this.retryAt = retryAt;
  }
}

/** Start of the next fixed one-hour rate-limit window. */
export function nextUploadWindow(now: Date = new Date()): Date {
  const hour = 3600 * 1000;
  return new Date(Math.floor(now.getTime() / hour) * hour + hour);
}

function formatTime(d: Date): string {
  try {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

export function uploadAllowanceError(err: unknown, now: Date = new Date()): UploadAllowanceError {
  if (err instanceof UploadAllowanceError) return err;
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = String(e.code ?? '');
  const message = String(e.message ?? '');
  if (code === 'P0429' || /rate_limited/i.test(message)) {
    const retryAt = nextUploadWindow(now);
    return new UploadAllowanceError(
      'rate_limited',
      `You've reached the limit of ${MEDIA_UPLOADS_PER_HOUR} uploads per hour. You can upload again from ${formatTime(retryAt)}.`,
      retryAt,
    );
  }
  if (code === 'PREVIEW_READ_ONLY') {
    return new UploadAllowanceError('preview', 'Uploads are disabled in this Preview build because it shares production data. They work in the production app.');
  }
  if (/not authenticated|jwt|session/i.test(message)) {
    return new UploadAllowanceError('signed_out', 'Your session has expired. Sign in again, then retry the upload.');
  }
  return new UploadAllowanceError('unavailable', "Couldn't start the upload. Check your connection and try again.");
}
