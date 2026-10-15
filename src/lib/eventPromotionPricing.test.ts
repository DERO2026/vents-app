import { describe, it, expect } from 'vitest';
import {
  EVENT_PROMOTION_PRICES_NAIRA,
  EVENT_PROMOTION_PLAN_DB_TYPE,
  EVENT_PROMOTION_DURATIONS,
  isEventPromotionPlan,
  isEventPromotionDuration,
} from './eventPromotionPricing';

// Direct coverage of the shared pricing module itself -- the one place
// PromoteEventScreen.tsx and api/promotions/activate.ts both read these
// numbers from. Locks in the agreed Trending/Featured prices exactly, and
// confirms Spotlight's existing prices are untouched (removing Spotlight
// is a separate, not-yet-done change).

describe('EVENT_PROMOTION_PRICES_NAIRA: agreed Trending prices', () => {
  it('matches the agreed price list exactly', () => {
    expect(EVENT_PROMOTION_PRICES_NAIRA.trending).toEqual({ 3: 75000, 7: 150000, 14: 275000, 30: 500000 });
  });
});

describe('EVENT_PROMOTION_PRICES_NAIRA: agreed Featured prices', () => {
  it('matches the agreed price list exactly', () => {
    expect(EVENT_PROMOTION_PRICES_NAIRA.featured).toEqual({ 3: 150000, 7: 250000, 14: 450000, 30: 800000 });
  });
});

describe('EVENT_PROMOTION_PRICES_NAIRA: Spotlight is untouched by this pricing change', () => {
  it('still has its pre-existing prices', () => {
    expect(EVENT_PROMOTION_PRICES_NAIRA.spotlight).toEqual({ 3: 5000, 7: 10000, 14: 18000, 30: 30000 });
  });
});

describe('EVENT_PROMOTION_PLAN_DB_TYPE', () => {
  it('maps spotlight to the DB check constraint’s real value "boosted", not a literal "spotlight"', () => {
    expect(EVENT_PROMOTION_PLAN_DB_TYPE.spotlight).toBe('boosted');
  });

  it('maps trending/featured to themselves', () => {
    expect(EVENT_PROMOTION_PLAN_DB_TYPE.trending).toBe('trending');
    expect(EVENT_PROMOTION_PLAN_DB_TYPE.featured).toBe('featured');
  });
});

describe('EVENT_PROMOTION_DURATIONS', () => {
  it('is exactly [3, 7, 14, 30]', () => {
    expect(EVENT_PROMOTION_DURATIONS).toEqual([3, 7, 14, 30]);
  });
});

describe('isEventPromotionPlan', () => {
  it('accepts the three real plan ids', () => {
    expect(isEventPromotionPlan('spotlight')).toBe(true);
    expect(isEventPromotionPlan('trending')).toBe(true);
    expect(isEventPromotionPlan('featured')).toBe(true);
  });

  it('rejects anything else, including a not-yet-real "explore" and non-strings', () => {
    expect(isEventPromotionPlan('explore')).toBe(false);
    expect(isEventPromotionPlan('')).toBe(false);
    expect(isEventPromotionPlan(null)).toBe(false);
    expect(isEventPromotionPlan(undefined)).toBe(false);
    expect(isEventPromotionPlan(42)).toBe(false);
  });
});

describe('isEventPromotionDuration', () => {
  it('accepts exactly 3, 7, 14, 30', () => {
    expect(isEventPromotionDuration(3)).toBe(true);
    expect(isEventPromotionDuration(7)).toBe(true);
    expect(isEventPromotionDuration(14)).toBe(true);
    expect(isEventPromotionDuration(30)).toBe(true);
  });

  it('rejects any other number or non-number', () => {
    expect(isEventPromotionDuration(10)).toBe(false);
    expect(isEventPromotionDuration(0)).toBe(false);
    expect(isEventPromotionDuration(-3)).toBe(false);
    expect(isEventPromotionDuration('7')).toBe(false);
    expect(isEventPromotionDuration(null)).toBe(false);
  });
});
