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
// Phase 6 (Spotlight removal): VENTS now sells only Trending and Featured.
// 'spotlight'/'boosted' has been removed from this module entirely --
// isEventPromotionPlan('spotlight') now returns false, which is what makes
// api/promotions/activate.ts reject a new Spotlight purchase/activation
// request with 400 "Invalid plan" (that endpoint's validation reads
// directly off this function; no separate change was needed there beyond
// removing its own now-redundant local copy of the plan type).
//
// This does NOT touch the `event_promotions` table's existing rows, or its
// `plan_type` CHECK constraint (which still allows the historical value
// 'boosted' at the database level, deliberately left alone -- tightening
// it is a separate, higher-risk change that would need to validate every
// existing row in production first; not required to stop NEW Spotlight
// purchases, since this module and the activation RPC are the only paths
// that can ever insert a new row). See
// supabase/migrations/0180_reject_boosted_event_promotion_activation.sql
// for the matching server-side RPC change, and HomeScreen.tsx's promoPlan
// badge, which still correctly renders "SPOTLIGHT" for any historical
// event_promotions row with plan_type='boosted' -- that display logic is
// about PAST records, not a purchase option, and is intentionally
// untouched.

export type EventPromotionPlan = 'trending' | 'featured';
export type EventPromotionDuration = 3 | 7 | 14 | 30;

export const EVENT_PROMOTION_DURATIONS: readonly EventPromotionDuration[] = [3, 7, 14, 30];

// Prices in whole Naira (not kobo) -- the same unit PromoteEventScreen.tsx
// has always displayed and sent as `amountNaira` to openPaystackPopup().
// api/promotions/activate.ts multiplies by 100 itself to compare against
// Paystack's kobo-denominated transaction amount, exactly as it already
// did with its own local copy of these numbers.
export const EVENT_PROMOTION_PRICES_NAIRA: Record<EventPromotionPlan, Record<EventPromotionDuration, number>> = {
  trending: { 3: 75000, 7: 150000, 14: 275000, 30: 500000 },
  featured: { 3: 150000, 7: 250000, 14: 450000, 30: 800000 },
};

// Maps the client-facing plan id to the value `activate_event_promotion`'s
// own `p_plan_type` check constraint accepts in the database.
export const EVENT_PROMOTION_PLAN_DB_TYPE: Record<EventPromotionPlan, string> = {
  trending: 'trending',
  featured: 'featured',
};

export function isEventPromotionPlan(value: unknown): value is EventPromotionPlan {
  return value === 'trending' || value === 'featured';
}

export function isEventPromotionDuration(value: unknown): value is EventPromotionDuration {
  return value === 3 || value === 7 || value === 14 || value === 30;
}
