// VENTS Phase 5A -- lightweight, privacy-conscious AI cost telemetry.
//
// Purpose: the Phase 5 economics audit found zero production evidence for
// its own cost-per-request estimates -- this records just enough per
// completed Anthropic call to later compute real cache-hit rates and
// cost distributions, without ever persisting anything that identifies a
// user or reveals what they said.
//
// Hard privacy rule, enforced by this module's own type signature, not
// just by convention: RecordAiUsageEventInput below has no field for
// prompt text, message content, tool arguments/results, images, email,
// username, auth user id, or IP address -- there is nothing to
// accidentally pass through, because the shape does not accept it.
//
// Reachable only via the trusted project_admin Postgres connection (same
// pattern as every other server-only RPC in this codebase) -- see
// supabase/migrations/0167_ai_usage_telemetry.sql for the function this
// calls and its grants. Writes are fire-and-forget from the caller's
// perspective: a telemetry failure is logged and swallowed, NEVER allowed
// to turn a successful (or already-failed) Anthropic call into a
// different outcome for the user -- same philosophy as persistPlanTurn in
// aiAssistantHandler.ts.
import { randomUUID } from 'node:crypto';
import { callProjectAdminRpc } from './projectAdminDb.js';
import { estimateCostUsd } from './aiPricing.js';

export type AiSurface = 'chat' | 'extraction' | 'vision';

export type RecordAiUsageEventInput = {
  surface: AiSurface;
  model: string;
  // Groups the rounds of ONE HTTP request together without identifying
  // who made it -- generated fresh per request via newAiRequestId() below,
  // never derived from (and never stored alongside) a user id, session
  // token, or IP.
  roundId: string;
  roundIndex: number;
  status: 'success' | 'error';
  // Each left as null (never invented) when Anthropic's response didn't
  // report it -- e.g. an error response has no usage object at all, and a
  // response with no server_tool_use never ran a web search.
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  webSearchRequests: number | null;
};

// Fresh, random, per-HTTP-request identifier -- call once per incoming
// chat/extraction/vision request, before any Anthropic call, and reuse
// it across that request's rounds (roundIndex 0, 1, 2...) via
// recordAiUsageEvent. Never persisted anywhere else, never logged
// alongside a user id.
export function newAiRequestId(): string {
  return randomUUID();
}

export async function recordAiUsageEvent(input: RecordAiUsageEventInput): Promise<void> {
  try {
    const estimatedCostUsd = estimateCostUsd({
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheCreationInputTokens: input.cacheCreationInputTokens,
      cacheReadInputTokens: input.cacheReadInputTokens,
      webSearchRequests: input.webSearchRequests,
    });

    await callProjectAdminRpc('record_ai_usage_event', [
      input.surface,
      input.model,
      input.roundId,
      input.roundIndex,
      input.status,
      input.inputTokens,
      input.outputTokens,
      input.cacheCreationInputTokens,
      input.cacheReadInputTokens,
      input.webSearchRequests,
      estimatedCostUsd,
    ]);
  } catch (err: any) {
    // Best-effort, non-fatal -- a telemetry outage must never affect a
    // real AI response. Logged so a silent, total telemetry failure is at
    // least visible in Vercel logs, same as persistPlanTurn's own catch.
    // eslint-disable-next-line no-console
    console.error('record_ai_usage_event failed (non-fatal):', err?.message || err);
  }
}
