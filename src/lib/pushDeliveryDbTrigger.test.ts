import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the genuinely server-side push delivery trigger
// (migration 0047_push_delivery_db_webhook.sql) -- the fix for the gap the
// previous stage left open: ticket-transfer initiate/decline and the
// service-provider admin decision only fired delivery via a CLIENT-side
// POST (triggerPushDelivery), which does nothing when VENTS is fully
// closed. This is a static-analysis suite (same approach as every other
// *.security.test.ts / *Cron.test.ts in this repo -- no live Postgres/pg_net
// harness available), asserting the trigger, the claim-based idempotency
// fix, and the webhook-secret auth path are all actually present in the
// shipped SQL/TS, not just described in a comment.

let m0047: string;
let sendSrc: string;
let pushDeliverySrc: string;
let cronRunSrc: string;

beforeAll(() => {
  const migrationsDir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0047 = readFileSync(join(migrationsDir, '0047_push_delivery_db_webhook.sql'), 'utf8');
  const apiDir = join(__dirname, '..', '..', 'api');
  sendSrc = readFileSync(join(apiDir, 'push', 'send.ts'), 'utf8');
  pushDeliverySrc = readFileSync(join(apiDir, '_lib', 'pushDelivery.ts'), 'utf8');
  cronRunSrc = readFileSync(join(apiDir, 'cron', 'run.ts'), 'utf8');
});

describe('DB-side trigger: fires on every notifications INSERT, independent of any client', () => {
  it('pg_net is enabled and the AFTER INSERT trigger is wired to notify_push_on_notification_insert', () => {
    expect(m0047).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_net/);
    expect(m0047).toMatch(/CREATE TRIGGER trg_notify_push_on_notification_insert\s*\n\s*AFTER INSERT ON public\.notifications/);
    expect(m0047).toMatch(/FOR EACH ROW EXECUTE FUNCTION public\.notify_push_on_notification_insert\(\);/);
  });

  it('the trigger dispatches via pg_net asynchronously and never blocks or fails the INSERT it fired on', () => {
    const fnBody = m0047.match(/CREATE OR REPLACE FUNCTION public\.notify_push_on_notification_insert\(\)[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fnBody).toMatch(/PERFORM extensions\.net\.http_post/);
    expect(fnBody).toMatch(/EXCEPTION WHEN OTHERS THEN/);
    expect(fnBody).toMatch(/RETURN NEW;/);
  });

  it('the webhook config table has zero anon/authenticated grants -- the secret is never client-readable', () => {
    expect(m0047).toMatch(/CREATE TABLE IF NOT EXISTS public\.push_delivery_webhook_config/);
    expect(m0047).toMatch(/REVOKE ALL ON public\.push_delivery_webhook_config FROM PUBLIC, anon, authenticated;/);
    expect(m0047).not.toMatch(/GRANT[^;]*push_delivery_webhook_config[^;]*TO[^;]*\banon\b/);
    expect(m0047).not.toMatch(/GRANT[^;]*push_delivery_webhook_config[^;]*TO[^;]*\bauthenticated\b/);
  });
});

describe('api/push/send.ts: webhook-secret mode requires no Supabase session, unlike modes 1-2', () => {
  it('checks the shared secret before any session/auth-header lookup', () => {
    const webhookModeIdx = sendSrc.indexOf('PUSH_WEBHOOK_SECRET');
    const sessionCheckIdx = sendSrc.indexOf('verifyInsforgeSession(authHeader)');
    expect(webhookModeIdx).toBeGreaterThan(-1);
    expect(sessionCheckIdx).toBeGreaterThan(-1);
    expect(webhookModeIdx).toBeLessThan(sessionCheckIdx);
  });

  it('compares the secret with a timing-safe check, not ===', () => {
    const webhookBlock = sendSrc.match(/const webhookSecret[\s\S]*?return res\.status\(401\)\.json\(\{ error: 'Invalid webhook secret' \}\);\s*\n\s*\}/)?.[0] ?? '';
    expect(webhookBlock).toMatch(/crypto\.timingSafeEqual/);
    expect(webhookBlock).not.toMatch(/providedSecret === webhookSecret/);
  });

  it('an invalid or missing secret never falls through to a body-controlled userId being delivered', () => {
    const webhookBlock = sendSrc.match(/const webhookSecret[\s\S]*?return res\.status\(401\)\.json\(\{ error: 'Invalid webhook secret' \}\);\s*\n\s*\}/)?.[0] ?? '';
    expect(webhookBlock).toMatch(/return res\.status\(401\)\.json\(\{ error: 'Invalid webhook secret' \}\);/);
  });
});

describe('idempotency: claim-before-send prevents duplicate FCM sends across trigger/client/cron', () => {
  it('get_pending_push_notifications_for_user claims atomically (UPDATE ... FOR UPDATE SKIP LOCKED) before returning rows', () => {
    const fnBody = m0047.match(/CREATE OR REPLACE FUNCTION public\.get_pending_push_notifications_for_user[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fnBody).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(fnBody).toMatch(/SET push_claim_expires_at = now\(\) \+ interval '2 minutes'/);
    expect(fnBody).toMatch(/push_sent = false/);
  });

  it('get_pending_push_notifications (the daily cron reader) gets the identical claim fix, same external signature', () => {
    const fnBody = m0047.match(/CREATE OR REPLACE FUNCTION public\.get_pending_push_notifications\(p_limit[\s\S]*?\$function\$\s*;/)?.[0] ?? '';
    expect(fnBody).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(fnBody).toMatch(/RETURNS TABLE\(notification_id uuid, user_id uuid, title text, body text, push_data jsonb, token text, platform text\)/);
  });

  it('a claim expires (2 minutes) rather than permanently blocking retry on a failed send', () => {
    expect(m0047).toMatch(/push_claim_expires_at IS NULL OR push_claim_expires_at < now\(\)/);
  });

  it('cron/run.ts calls the same function name unchanged -- no separate code path to fall out of sync', () => {
    expect(cronRunSrc).toMatch(/get_pending_push_notifications/);
  });

  it('final success is still marked via mark_notifications_pushed, only after FCM actually accepts the message', () => {
    expect(pushDeliverySrc).toMatch(/mark_notifications_pushed/);
    const sendLoop = pushDeliverySrc.match(/await Promise\.all\(rows\.map[\s\S]*?\}\)\);/)?.[0] ?? '';
    expect(sendLoop).toMatch(/if \(resp\.ok\) \{ sent\+\+; toMark\.add\(row\.notification_id\); return; \}/);
  });
});
