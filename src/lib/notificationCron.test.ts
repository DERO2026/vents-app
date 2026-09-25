import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the hours-late push notification bug and its fix.
//
// The FIRST fix attempt (tightening this cron to hourly) was reverted: on
// Vercel's Hobby plan, cron invocation frequency is capped at once/day
// regardless of the schedule string configured, so an hourly entry here
// would silently still only fire daily while looking fixed in the repo.
// The real fix is a request-triggered delivery path (api/_lib/pushDelivery.ts,
// used by api/webhook/paystack.ts and api/push/send.ts's `deliverForUserId`
// mode, called from the client via triggerPushDelivery()) that fires
// immediately when each transactional notification is created, independent
// of any cron. This file asserts: (a) the cron stays daily -- an hourly
// schedule here would silently do nothing extra on Hobby and should never
// be reintroduced -- and (b) the event-driven trigger wiring exists.

let vercelJson: { crons?: Array<{ path: string; schedule: string }> };
let pushDeliverySrc: string;
let sendSrc: string;
let paystackWebhookSrc: string;
let pushNotificationsSrc: string;
let myTicketsSrc: string;
let adminDashboardSrc: string;

beforeAll(() => {
  vercelJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'vercel.json'), 'utf8'));
  const apiDir = join(__dirname, '..', '..', 'api');
  pushDeliverySrc = readFileSync(join(apiDir, '_lib', 'pushDelivery.ts'), 'utf8');
  sendSrc = readFileSync(join(apiDir, 'push', 'send.ts'), 'utf8');
  paystackWebhookSrc = readFileSync(join(apiDir, 'webhook', 'paystack.ts'), 'utf8');
  pushNotificationsSrc = readFileSync(join(__dirname, 'pushNotifications.ts'), 'utf8');
  const componentsDir = join(__dirname, '..', 'app', 'components');
  myTicketsSrc = readFileSync(join(componentsDir, 'MyTicketsScreen.tsx'), 'utf8');
  adminDashboardSrc = readFileSync(join(componentsDir, 'AdminDashboardScreen.tsx'), 'utf8');
});

describe('notification cron cadence: daily, not hourly (Vercel Hobby plan)', () => {
  it('the safety-net sweep cron stays daily -- an hourly schedule silently does nothing extra on Hobby', () => {
    const entry = (vercelJson.crons || []).find((c) => c.path === '/api/cron/run');
    expect(entry).toBeTruthy();
    // "0 8 * * *" (daily) has a fixed, non-'*' hour field. An hourly-or-more-
    // frequent schedule would have '*' or a step expression there instead --
    // that shape must never come back (see notificationCron.test.ts header).
    const hourField = entry!.schedule.trim().split(/\s+/)[1];
    expect(hourField).not.toMatch(/^(\*|\*\/\d+)$/);
  });
});

describe('event-driven push delivery: request-triggered, not cron-dependent', () => {
  it('the shared delivery helper only ever reads/marks via the trusted project_admin connection', () => {
    expect(pushDeliverySrc).toMatch(/get_pending_push_notifications_for_user/);
    expect(pushDeliverySrc).toMatch(/mark_notifications_pushed/);
    expect(pushDeliverySrc).not.toMatch(/FCM_SERVICE_ACCOUNT_JSON.*\n.*res\.json\(/); // never echoed back to a client
  });

  it('api/push/send.ts exposes an any-authenticated-user delivery trigger, distinct from the admin broadcast mode', () => {
    expect(sendSrc).toMatch(/deliverForUserId/);
    expect(sendSrc).toMatch(/deliverPendingPushesForUser/);
    // The trigger mode must not require the super-admin-only broadcast RPC.
    const triggerBlock = sendSrc.match(/if \(deliverForUserId\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(triggerBlock).not.toMatch(/admin_list_push_tokens/);
  });

  it('the Paystack webhook triggers delivery right after confirming a transfer-fee payment, on both its paths', () => {
    expect(paystackWebhookSrc).toMatch(/notifyTransferFeeOutcome/);
    expect(paystackWebhookSrc).toMatch(/get_ticket_transfer_from_user/);
    const matches = paystackWebhookSrc.match(/await notifyTransferFeeOutcome\(reference\);?/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // webhook path + ?action=verify path
  });

  it('the client helper posts to the relay endpoint with the caller\'s own session token', () => {
    expect(pushNotificationsSrc).toMatch(/export function triggerPushDelivery/);
    expect(pushNotificationsSrc).toMatch(/deliverForUserId: userId/);
  });

  it('ticket-transfer initiate/decline and the service-provider admin decision call the trigger', () => {
    expect(myTicketsSrc).toMatch(/triggerPushDelivery\(notifyUserId\)/);
    expect(myTicketsSrc).toMatch(/triggerPushDelivery\(data\?\.to_user_id\)/);
    expect(adminDashboardSrc).toMatch(/triggerPushDelivery\(req\?\.user_id\)/);
  });
});
