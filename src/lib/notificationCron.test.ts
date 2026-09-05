import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression test for the hours-late push notification bug: the only thing
// that ever turns an unsent `notifications` row into an actual FCM push is
// the /api/cron/run sweep (see that file's header comment for the full
// root-cause writeup) -- if vercel.json's cron schedule ever regresses back
// to a daily cadence, this catches it.

let vercelJson: { crons?: Array<{ path: string; schedule: string }> };

beforeAll(() => {
  const raw = readFileSync(join(__dirname, '..', '..', 'vercel.json'), 'utf8');
  vercelJson = JSON.parse(raw);
});

describe('notification push delivery cadence (vercel.json crons)', () => {
  it('the notification sweep cron runs at least hourly, not once a day', () => {
    const entry = (vercelJson.crons || []).find((c) => c.path === '/api/cron/run');
    expect(entry).toBeTruthy();
    // A schedule like "0 8 * * *" (daily) has a non-'*' hour field -- an
    // hourly-or-more-frequent schedule ("0 * * * *", "*/30 * * * *", etc.)
    // always has '*' (or a step expression) in the hour field.
    const hourField = entry!.schedule.trim().split(/\s+/)[1];
    expect(hourField).toMatch(/^(\*|\*\/\d+)$/);
  });
});
