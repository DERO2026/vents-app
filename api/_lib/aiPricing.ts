// VENTS Phase 5A -- pricing CONFIGURATION only, kept deliberately separate
// from the telemetry ledger (aiTelemetry.ts / ai_usage_events) so a future
// price change never requires touching already-recorded raw usage rows --
// every row keeps its actual token counts forever; only the *estimate*
// computed from them depends on this file, and can be recomputed from the
// raw numbers at any time if these rates change.
//
// Rates below are exactly the ones confirmed LIVE against
// platform.claude.com/docs/en/about-claude/pricing during the Phase 5
// economics audit (not recalled from training/memory) -- update this file,
// not aiTelemetry.ts, when Anthropic's published pricing changes.

export type PricingRates = {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number; // "cache hits and refreshes"
  webSearchPerSearch: number; // flat per-search fee, independent of tokens
};

const MODEL_PRICING: Record<string, PricingRates> = {
  'claude-sonnet-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2, // standard 0.1x multiplier on Sonnet 5
    webSearchPerSearch: 0.01, // $10 / 1,000 searches
  },
  'claude-haiku-4-5-20251001': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1, // standard 0.1x multiplier
    webSearchPerSearch: 0.01,
  },
};

export type UsageForEstimate = {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  webSearchRequests: number | null;
};

// Returns an ESTIMATED USD cost from actual usage numbers, or null when the
// model isn't in the table above or a required token count is missing --
// never silently substitutes 0 or a guess for a value Anthropic didn't
// report. `inputTokens` from the API is the NON-cached portion already
// (Anthropic reports cache_read/cache_creation as separate counters, not
// included in `input_tokens`), so this sums all three input buckets at
// their own rates rather than double-charging or under-charging any of
// them. Cache WRITE cost is intentionally omitted here -- Anthropic's
// response does not reliably distinguish 5-minute vs 1-hour cache writes
// in every SDK/response shape, and this handler never requests the 1-hour
// TTL, so cache_creation_input_tokens is left priced at the base input
// rate (a slight underestimate vs the true 1.25x write multiplier) rather
// than guess a write type -- noted as a known approximation, not hidden.
export function estimateCostUsd(u: UsageForEstimate): number | null {
  const rates = MODEL_PRICING[u.model];
  if (!rates) return null;
  if (u.inputTokens == null || u.outputTokens == null) return null;

  const uncachedInputCost = (u.inputTokens / 1_000_000) * rates.inputPerMTok;
  const cacheCreationCost = u.cacheCreationInputTokens != null
    ? (u.cacheCreationInputTokens / 1_000_000) * rates.inputPerMTok
    : 0;
  const cacheReadCost = u.cacheReadInputTokens != null
    ? (u.cacheReadInputTokens / 1_000_000) * rates.cacheReadPerMTok
    : 0;
  const outputCost = (u.outputTokens / 1_000_000) * rates.outputPerMTok;
  const webSearchCost = u.webSearchRequests != null
    ? u.webSearchRequests * rates.webSearchPerSearch
    : 0;

  return uncachedInputCost + cacheCreationCost + cacheReadCost + outputCost + webSearchCost;
}
