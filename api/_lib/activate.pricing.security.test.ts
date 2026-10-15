import { describe, it, expect, vi, beforeEach } from 'vitest';

// Lives in api/_lib/ (not api/promotions/) so it isn't counted as its own
// serverless function by Vercel's zero-config detection -- same reason
// promotionVerifyRateLimit.security.test.ts already lives here instead of
// next to api/promotions/activate.ts. A first version of this file placed
// in api/promotions/ pushed this project's function count from 12 to 13,
// exceeding the Hobby plan's 12-function-per-deployment limit and failing
// the real Vercel deploy outright (errorCode
// exceeded_serverless_functions_per_deployment) -- confirmed by reading
// that deployment's actual error, not guessed.
//
// VENTS Phase 5 -- centralized event-promotion pricing. Before this,
// PromoteEventScreen.tsx and api/promotions/activate.ts each hand-copied
// the same plan/duration price table, and the two had already drifted
// apart: the client's 'trending' and 'featured' prices were swapped
// relative to the server's, so every real Trending/Featured payment was
// rejected here as "Payment amount does not match the selected plan" --
// the anti-fraud check working exactly as designed, just against the
// wrong expected number. Both files now import the same
// src/lib/eventPromotionPricing.ts. These tests prove, directly against
// that shared module (never a second hardcoded copy in this test file),
// that the server accepts every real plan/duration combination at its
// correct amount, rejects every one at a wrong amount, and rejects an
// invalid plan or duration before any Paystack call or activation.
//
// VENTS Phase 6 -- Spotlight Boost removed from the purchasable lineup.
// 'spotlight' is no longer in EventPromotionPlan at all, so it's covered
// below as an INVALID plan (same bucket as a typo or a made-up id),
// alongside a new Spotlight-specific rejection test proving a new
// Spotlight purchase/activation attempt is rejected with 400 before any
// Paystack call -- the server-side half of the removal, matching the
// client UI no longer offering it and the new DB migration
// (0180_reject_boosted_event_promotion_activation.sql) rejecting it at
// the activation RPC layer too.

const { mockCallProjectAdminRpc, mockVerifyInsforgeSession } = vi.hoisted(() => ({
  mockCallProjectAdminRpc: vi.fn(),
  mockVerifyInsforgeSession: vi.fn(),
}));

vi.mock('./projectAdminDb.js', () => ({
  callProjectAdminRpc: mockCallProjectAdminRpc,
}));
vi.mock('./verifyAuth.js', () => ({ verifyInsforgeSession: mockVerifyInsforgeSession }));
vi.mock('./cors.js', () => ({ applyCors: vi.fn() }));

import handler from '../promotions/activate';
import {
  EVENT_PROMOTION_PRICES_NAIRA,
  EVENT_PROMOTION_PLAN_DB_TYPE,
  EVENT_PROMOTION_DURATIONS,
  type EventPromotionPlan,
  type EventPromotionDuration,
} from '../../src/lib/eventPromotionPricing';

function makeRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.end = vi.fn(() => res);
  res.setHeader = vi.fn();
  return res;
}

function req(body: any, authorization = 'Bearer tok') {
  return { method: 'POST', headers: { authorization }, body } as any;
}

function makePaystackFetchMock(amountKobo: number, status: string = 'success') {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('api.paystack.co')) {
      return { ok: true, json: async () => ({ status: true, data: { status, amount: amountKobo } }) } as any;
    }
    return { ok: true, json: async () => ({}) } as any;
  });
  return { fn, calls };
}

beforeEach(() => {
  mockCallProjectAdminRpc.mockReset();
  mockVerifyInsforgeSession.mockReset();
  mockVerifyInsforgeSession.mockResolvedValue({ userId: 'user-1', email: 'user@example.com' });
  mockCallProjectAdminRpc.mockResolvedValue(undefined);
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
});

const PLANS: EventPromotionPlan[] = ['trending', 'featured'];

describe('promotions/activate: all plan/duration combinations accept the correct amount', () => {
  for (const plan of PLANS) {
    for (const duration of EVENT_PROMOTION_DURATIONS) {
      const expectedNaira = EVENT_PROMOTION_PRICES_NAIRA[plan][duration];
      const expectedKobo = expectedNaira * 100;

      it(`${plan} / ${duration}d (₦${expectedNaira.toLocaleString()}) -> 200 and activates with the correct DB plan type`, async () => {
        const { fn } = makePaystackFetchMock(expectedKobo);
        vi.stubGlobal('fetch', fn);
        const res = makeRes();
        await handler(
          req({ event_id: 'event-1', reference: `ref-${plan}-${duration}`, plan, duration_days: duration }),
          res
        );
        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockCallProjectAdminRpc).toHaveBeenCalledWith('activate_event_promotion', [
          'event-1',
          EVENT_PROMOTION_PLAN_DB_TYPE[plan],
          duration,
          `ref-${plan}-${duration}`,
          'user-1',
        ]);
        vi.unstubAllGlobals();
      });
    }
  }
});

describe('promotions/activate: rejects an amount that does not match the selected plan/duration', () => {
  it('Trending 3d charged as if it were Trending 7d’s price -> 402, never activates', async () => {
    const wrongKobo = EVENT_PROMOTION_PRICES_NAIRA.trending[7] * 100; // paid the 7-day price
    const { fn } = makePaystackFetchMock(wrongKobo);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ event_id: 'event-1', reference: 'ref-x', plan: 'trending', duration_days: 3 }), res); // but claimed 3-day
    expect(res.status).toHaveBeenCalledWith(402);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalledWith('activate_event_promotion', expect.anything());
    vi.unstubAllGlobals();
  });

  it('Featured priced as Trending (cheap-plan-pay, expensive-plan-activate attempt) -> 402, never activates', async () => {
    const trendingKobo = EVENT_PROMOTION_PRICES_NAIRA.trending[7] * 100;
    const { fn } = makePaystackFetchMock(trendingKobo);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ event_id: 'event-1', reference: 'ref-y', plan: 'featured', duration_days: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalledWith('activate_event_promotion', expect.anything());
    vi.unstubAllGlobals();
  });

  it('a Paystack transaction that did not actually succeed is rejected regardless of amount', async () => {
    const correctKobo = EVENT_PROMOTION_PRICES_NAIRA.featured[30] * 100;
    const { fn } = makePaystackFetchMock(correctKobo, 'abandoned');
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ event_id: 'event-1', reference: 'ref-z', plan: 'featured', duration_days: 30 }), res);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalledWith('activate_event_promotion', expect.anything());
    vi.unstubAllGlobals();
  });
});

describe('promotions/activate: rejects invalid plan/duration before any Paystack call', () => {
  it('an unknown plan id is rejected with 400, no Paystack call, no activation', async () => {
    const { fn, calls } = makePaystackFetchMock(999999999);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ event_id: 'event-1', reference: 'ref-a', plan: 'explore', duration_days: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(calls.length).toBe(0);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('Phase 6: a Spotlight purchase/activation attempt is rejected with 400, even at its own old correct amount, no Paystack call, no activation', async () => {
    const { fn, calls } = makePaystackFetchMock(1000000); // the old Spotlight 7d price in kobo -- irrelevant, request never gets this far
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ event_id: 'event-1', reference: 'ref-spotlight', plan: 'spotlight', duration_days: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(calls.length).toBe(0);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('Phase 6: the raw DB plan_type value "boosted" is also rejected (the client never sends this, but it must not be accepted as an alias)', async () => {
    const { fn, calls } = makePaystackFetchMock(1000000);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ event_id: 'event-1', reference: 'ref-boosted', plan: 'boosted', duration_days: 7 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(calls.length).toBe(0);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a duration outside 3/7/14/30 is rejected with 400, no Paystack call, no activation', async () => {
    const { fn, calls } = makePaystackFetchMock(999999999);
    vi.stubGlobal('fetch', fn);
    const res = makeRes();
    await handler(req({ event_id: 'event-1', reference: 'ref-b', plan: 'trending', duration_days: 10 }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(calls.length).toBe(0);
    expect(mockCallProjectAdminRpc).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
