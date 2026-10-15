// Single source of truth for event-promotion plan identity and prices --
// shared between the purchase UI (PromoteEventScreen.tsx) and the
// server-side verify-and-activate endpoint (api/promotions/activate.ts),
// which imports this same file directly (see that file's own import
// comment for why a cross-boundary import is safe here: Vercel's function
// bundler resolves relative imports by real filesystem path, independent
// of tsconfig's "include": ["src"] scope, which only governs `tsc
// --noEmit`/Vite's own type-checking, not what a serverless function can
// import at build time).
//
// Before this file existed, the same three numbers were hand-copied into
// both files -- and had already drifted: PromoteEventScreen.tsx's
// 'trending'/'featured' prices did not match api/promotions/activate.ts's
// 'trending'/'featured' prices (the two plans' price tables were swapped
// between the two files). That mismatch meant every real Trending/
// Featured purchase was being rejected server-side as "Payment amount
// does not match the selected plan" (api/promotions/activate.ts's own
// amount-vs-plan anti-fraud check, working exactly as designed, just
// against the wrong expected number). A single shared file makes that
// specific class of bug structurally impossible going forward -- there is
// now exactly one place these numbers live.
//
// The server remains the sole source of TRUST, unchanged: it still
// independently computes its own expected amount from this table and
// verifies that against Paystack's own reported transaction amount before
// activating anything (api/promotions/activate.ts) -- nothing about the
// client being untrusted for the actual charge/activation decision has
// changed. This file only removes the duplication of the *numbers*
// themselves, the same way a client bundle legitimately knows its own
// prices without that making the client authoritative for what it's
// actually charged.
//
// Spotlight/'boosted' is intentionally still priced here and left
// unchanged -- removing it from the product lineup is a separate,
// coordinated change (client UI + this table + the DB check constraint
// in activate_event_promotion), not done in this pass.

export type EventPromotionPlan = 'spotlight' | 'trending' | 'featured';
export type EventPromotionDuration = 3 | 7 | 14 | 30;

export const EVENT_PROMOTION_DURATIONS: readonly EventPromotionDuration[] = [3, 7, 14, 30];

// Prices in whole Naira (not kobo) -- the same unit PromoteEventScreen.tsx
// has always displayed and sent as `amountNaira` to openPaystackPopup().
// api/promotions/activate.ts multiplies by 100 itself to compare against
// Paystack's kobo-denominated transaction amount, exactly as it already
// did with its own local copy of these numbers.
export const EVENT_PROMOTION_PRICES_NAIRA: Record<EventPromotionPlan, Record<EventPromotionDuration, number>> = {
  // Unchanged -- Spotlight is not part of this pricing update.
  spotlight: { 3: 5000, 7: 10000, 14: 18000, 30: 30000 },
  // Updated prices (this pass): matches the agreed Trending/Featured price
  // list exactly.
  trending: { 3: 75000, 7: 150000, 14: 275000, 30: 500000 },
  featured: { 3: 150000, 7: 250000, 14: 450000, 30: 800000 },
};

// Maps the client-facing plan id to the value `activate_event_promotion`'s
// own `p_plan_type` check constraint actually accepts in the database
// ('boosted' | 'featured' | 'trending' -- note 'spotlight' itself is never
// a valid DB value, only its UI-facing id).
export const EVENT_PROMOTION_PLAN_DB_TYPE: Record<EventPromotionPlan, string> = {
  spotlight: 'boosted',
  trending: 'trending',
  featured: 'featured',
};

export function isEventPromotionPlan(value: unknown): value is EventPromotionPlan {
  return value === 'spotlight' || value === 'trending' || value === 'featured';
}

export function isEventPromotionDuration(value: unknown): value is EventPromotionDuration {
  return value === 3 || value === 7 || value === 14 || value === 30;
}
