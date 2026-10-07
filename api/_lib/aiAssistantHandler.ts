import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession, enforceRateLimit, isAiDisabled } from './verifyAuth.js';
import { applyCors } from './cors.js';
import { createConfirmationToken, verifyConfirmationToken } from './aiConfirmation.js';
import { isAiEntitlementEnforced, checkAndReserveAiUsage, AiEntitlementError } from './aiEntitlement.js';
import { newAiRequestId, recordAiUsageEvent } from './aiTelemetry.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ALL_TOOLS,
  READ_ONLY_TOOL_NAMES,
  PROPOSAL_TOOL_NAMES,
  PLAN_TOOL_NAMES,
  WEB_SEARCH_TOOL,
  WEB_SEARCH_TOOL_NAME,
  buildUserSupabaseClient,
  executeReadOnlyTool,
  executePlanTool,
  buildProposal,
  executeStartTicketTransfer,
  executeRequestTicketRefund,
  executeStartServiceBooking,
  executeCreateReport,
} from './aiTools.js';

// Flattens an Anthropic message `content` field (either a plain string, or
// an array of content blocks) down to its text, for persisting into
// plan_messages -- that table stores plain text, not Anthropic's block
// format, and a plan conversation's history is meant to be human-readable
// later, not re-parsed as API request/response shapes.
function flattenContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

// Persists one plan-scoped conversation turn (the user's latest message and
// the assistant's final reply) into plan_messages -- the persisted half of
// the "one pinned SI thread per plan" design, for ONLY the plan(s) an
// actual tool call touched this turn (never a client-supplied plan_id with
// no real activity behind it, and never general Chat outside a plan, which
// stays in-memory exactly as before this batch).
//
// Best-effort: a failure here is logged and swallowed, never surfaced to
// the user or allowed to turn a successful AI turn into an error response --
// conversation history is a convenience on top of the plan, not the source
// of truth for it (plan state only ever comes from the plan tables/RPCs via
// get_plan, never reconstructed from these rows).
//
// De-duplicates against a retry of the exact same turn: if the most
// recently stored row for this plan already has this exact role+content,
// it is not inserted again (the common "client retried the same HTTP
// request" case, e.g. after a client-side timeout on an already-completed
// call).
async function persistPlanTurn(client: SupabaseClient, planId: string, userText: string, assistantText: string) {
  try {
    const rows: { plan_id: string; role: 'user' | 'assistant'; content: string }[] = [];
    if (userText.trim()) rows.push({ plan_id: planId, role: 'user', content: userText });
    if (assistantText.trim()) rows.push({ plan_id: planId, role: 'assistant', content: assistantText });
    if (rows.length === 0) return;

    const { data: lastRows } = await client
      .from('plan_messages')
      .select('role, content')
      .eq('plan_id', planId)
      .order('created_at', { ascending: false })
      .limit(1);
    const last = Array.isArray(lastRows) ? lastRows[0] : null;

    const toInsert = rows.filter((r, i) => {
      // Only the first row in this turn can collide with what's already
      // the last stored row -- the second row (the assistant's reply)
      // never matches a pre-existing row at the moment it's being added.
      if (i === 0 && last && last.role === r.role && last.content === r.content) return false;
      return true;
    });
    if (toInsert.length === 0) return;

    // RLS (plan_messages_insert_own, 0156) requires the plan to exist and
    // be owned by the authenticated caller -- this is the real
    // authorization boundary, not the fact that planId came from a
    // successful tool call this same request. A plan_id that somehow isn't
    // the caller's own is rejected here regardless of how it got this far.
    await client.from('plan_messages').insert(toInsert);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('plan_messages persistence failed (non-fatal):', (err as any)?.message || err);
  }
}

// VENTS AI -- server-orchestrated conversational assistant. Modeled directly
// on api/extract-events.ts's structure (raw fetch to the Anthropic Messages
// API, server-only ANTHROPIC_API_KEY, verifyInsforgeSession gating, an
// AbortController timeout). The key difference from extract-events.ts: this
// handler calls EXISTING secure backend functionality as tools rather than
// asking the model to produce data from nothing -- it never uses a
// service-role Supabase client, and every tool executor runs as the calling
// user via their own forwarded access token, so it can never see or do more
// than that user could already see/do through the app's own screens.
//
// Required flow for anything consequential: explain -> confirm -> execute ->
// report the REAL result. A Phase 2 (mutating) tool_use block never runs
// inside the model's tool loop -- it immediately ends the turn with a
// confirmation_required response carrying a signed token. Only a follow-up
// request carrying that verified token (`confirmedAction`) executes the
// real thing, and that path runs BEFORE any new model call -- confirming an
// action reports what actually happened, it never re-asks the model.
//
// This used to be its own Vercel serverless function (api/ai-assistant.ts).
// It was moved here and is now invoked as an internal branch of
// api/extract-events.ts (routed via an explicit `{ mode: 'ai_assistant' }`
// request-body discriminator) purely to stay within Vercel Hobby's
// 12-serverless-function-per-deployment cap -- see api/extract-events.ts for
// the routing. Nothing about this handler's own logic, auth, rate limiting,
// tool execution, or confirmation flow changed in that move.

const MAX_TOOL_ROUNDTRIPS = 5;
const TIMEOUT_MS = 25000;

// Emergency cost-hardening pass (following the production billing audit).
// None of these change intended behavior for a normal conversation -- they
// exist to put a hard, server-side ceiling under the two things the audit
// found genuinely unbounded: a single message's length, and how much prior
// conversation gets re-sent (and re-billed) on every new turn.
const MAX_MESSAGE_CHARS = 4000; // one message's own text -- generous for real chat, well short of "paste a document"
const MAX_HISTORY_MESSAGES = 20; // most recent N messages kept, oldest dropped first
const MAX_HISTORY_CHARS = 20000; // total text budget across the kept messages, trimmed further if still over
const AI_GLOBAL_RATE_KEY = 'ai_assistant_global';
const AI_GLOBAL_RATE_MAX = 500; // shared ceiling across ALL users combined, per hour -- a backstop under the per-user cap, not a replacement for it. Temporary safety ceiling (lowered from 2000 in the Phase 3A cost-optimization pass) until real production usage data exists -- raise it once demand actually justifies more headroom; see that commit for the exposure math behind this specific number.
const AI_GLOBAL_RATE_WINDOW_SECONDS = 3600;

// Phase 3A cost-optimization fix: WEB_SEARCH_TOOL's own `max_uses: 3`
// (aiTools.ts) resets every time it's sent in a NEW request to Anthropic --
// and this handler sends a new request every tool-calling round (up to
// MAX_TOOL_ROUNDTRIPS=5), so the true ceiling was 3 x 5 = 15 searches in one
// HTTP request, not 3. This constant is the REAL per-HTTP-request ceiling,
// enforced by a request-local counter (searchesUsedThisRequest, declared
// inside handleAiAssistant below) that persists across rounds within one
// call to this function but is never stored anywhere -- a fresh call to
// handleAiAssistant always starts this counter at 0, so it can never leak
// between different users or different requests from the same user.
const WEB_SEARCH_MAX_PER_REQUEST = 3;

function messageTextLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum: number, b: any) => sum + (typeof b?.text === 'string' ? b.text.length : 0), 0);
  }
  return 0;
}

// Server-side history cap -- the client (VentsAiScreen.tsx) resends the
// entire thread on every turn with no trimming of its own; this is the one
// and only place that matters, since an old/malicious client can send
// whatever it wants regardless of what the current app build would do.
// Keeps the most recent messages (simple count cap first, since the client
// array here is always plain {role, content:string} turns -- no tool_use/
// tool_result blocks, those only ever get appended server-side further
// below in THIS request's own loop, never persisted from a prior one), then
// trims further from the oldest end if the kept window is still over the
// character budget. Always keeps at least the single most recent message.
function capConversationHistory(messages: any[]): any[] {
  let kept = messages.slice(-MAX_HISTORY_MESSAGES);
  let total = kept.reduce((sum, m) => sum + messageTextLength(m?.content), 0);
  while (kept.length > 1 && total > MAX_HISTORY_CHARS) {
    total -= messageTextLength(kept[0]?.content);
    kept = kept.slice(1);
  }
  return kept;
}

const SYSTEM_PROMPT = `You are VENTS AI, the assistant built into the VENTS app (events, service bookings, tickets, wallet and VENTS Cents, for a primarily Nigerian audience).

Ground rules:
1. NEVER fabricate live VENTS data -- events, prices, availability, payment status, ticket status, booking status, wallet balance, or VENTS Cents balance. For anything VENTS-specific (does an event/provider exist on VENTS, ticket/booking/payment/wallet/VC status), always call the matching VENTS tool and base your answer only on its result -- never web_search, never your own knowledge. If a tool call fails or returns nothing, say so plainly rather than guessing.
1a. VENTS Cents (VC) rules -- there is currently NO tool for general VC rules, rates, amounts, prices, or eligibility (how much VC something earns or costs, the cash-out rate, cash-out minimums/maximums/daily limits/cooldown/maturation period, badge/feature/boost prices). NEVER state one of these numbers from memory. If asked about any of them, say plainly that you can't look up the current VC rules right now and point the user to the VENTS Cents/Referrals screen in the app instead. You MUST still call the existing get_vents_cents_balance tool for any question about the user's OWN live VC balance. If asked whether VC can be used to buy or pay for tickets, you MUST answer that "Using VENTS Cents toward ticket purchases is not currently available" -- do not imply otherwise even if a display estimate elsewhere looks like it could be spent that way. You MUST NOT invent a user's referral status, transaction history, cash-out request status, or eligibility for a specific reward -- no tool here provides live transaction or cash-out-request history, so if asked something that needs it, say plainly that you can't look that up rather than guessing.
2. Clearly distinguish three kinds of things in your answers, and use the right source for each:
   (a) Live VENTS data -- from a VENTS tool call just now (search_events, get_event, search_services_or_providers, etc.). Present this as VENTS listings.
   (b) Live external/current information -- concerts, events, or services that are NOT on VENTS, or current city/country information. Use the web_search tool for these. NEVER answer a question about a current external event, a current artist appearance/schedule, or a current external service/business listing from your own static/training knowledge -- that knowledge can be stale. Call web_search instead.
   (c) General/stable knowledge -- who an artist is, what a genre or cultural term means, historical facts, casual conversation. Answer this directly from your own knowledge; do NOT call web_search for it.
   You decide which of these three a question needs. When more than one applies, use each source for its own part of the answer.
3. Handle Nigerian phrasing, culture, artists, and event terminology naturally, using your own general knowledge -- there is no hardcoded slang list here, so use judgment the way you would for any other region's phrasing.
4. For any consequential action (transferring or refunding a ticket, booking a service, filing a report), you may only ever PROPOSE it via the matching tool. Never claim an action has been completed unless you are reporting the actual result of a real, already-executed tool call. The system will ask the user to confirm before anything actually happens.
5. Whenever your answer includes anything from web_search, clearly label it as coming from outside VENTS (e.g. "I found this elsewhere, not listed on VENTS" / "this isn't on VENTS"). NEVER imply that an externally-found event, artist appearance, or service/business is bookable through VENTS, or present it as if it were a VENTS listing, unless a VENTS tool call has actually confirmed that exact thing exists on VENTS.

Keep answers conversational and concise. When you have structured results (events, providers, tickets, bookings, payment status, wallet/VC balances), summarize them in your text -- the app will also render them as structured cards from the tool results, so you don't need to reformat them as lists or tables yourself.

6. SI Planner (create_plan_draft, get_plan, propose_plan_update, apply_plan_update, recommend_providers, assign_provider, reschedule_plan, confirm_brief, offer_plan_intent, ask_plan_question, preview_plan_brief, disambiguate_plans) -- event-planning tools, distinct from the ticket/booking/report tools above:
   a. Always call get_plan before answering a question about an existing plan's state (budget, categories, tasks, timeline) -- never recall or guess a figure from earlier in the conversation, since the user or you may have changed it since.
   b. Changing a plan's budget has two very different paths, and mixing them up is a real mistake: a DIRECT, unambiguous user instruction ("move 300k from decoration to catering") calls apply_plan_update right away. YOUR OWN unprompted suggestion ("I'd recommend allocating more to photography") must go through propose_plan_update first -- that writes nothing -- and apply_plan_update only runs afterward if the user actually agrees to apply it. Never call apply_plan_update for your own suggestion before the user has agreed.
   c. Every amount you report or accept is in naira, not kobo -- the tools handle the conversion. Keep Estimated, Committed, and Paid clearly distinct in what you say (get_plan returns all three separately) -- they are never the same thing, and an SI estimate must never be presented as if it were a provider's actual price or a quote.
   d. recommend_providers returns only real VENTS provider data. NEVER state or imply a provider is "available" on any date -- there is no availability data in VENTS. Tell the user to confirm availability with the provider directly. Never invent a provider's price; if recommend_providers doesn't return a price for a provider, say so plainly.
   e. assign_provider records which provider the user chose for a category -- it is NEVER a booking and NEVER charges anything. Do not say a provider has been "booked" or "reserved" -- say "assigned," and if the user wants to actually book and pay, that is the existing service-booking flow (start_service_booking), a completely separate step.
   f. reschedule_plan only changes the plan's own date. It never cancels, refunds, or changes a real booking or payment -- if the plan has an assigned provider, say the new date still needs to be confirmed with that provider directly.
   g. A planner change (apply_plan_update) is reversible by the user afterward through the app's own Undo -- never imply this can undo a real Paystack payment, booking, or any financial transaction. Those are permanent through this tool layer.
   i. If the user says a booked provider cancelled ("my photographer cancelled"), call get_plan and check that category's recently_cancelled field -- a real VENTS booking cancellation (via cancel_service_booking) already flips the plan's own assignment to cancelled automatically, so get_plan already reflects it; never take the user's word alone as proof of what refund happened. State the refund_status EXACTLY as get_plan returns it (e.g. "refund_pending" means processing, "refunded" means done, null means there's no real booking behind that assignment to refund) -- never say "fully refunded" unless refund_status says so. The category is already reopened (unassigned) in the budget/team views; you can recommend_providers for it same as any open category. If the user describes cancelling an OWN VENDOR or a merely-committed (not booked-and-paid) assignment, there is no real booking to check -- that is a plan edit, so propose removing that assignment via propose_plan_update/apply_plan_update instead of claiming a refund happened.
   h. Starting a NEW plan from scratch is a guided sequence, not a single tool call -- and no plans row exists until the very end of it:
      1. The moment you detect the user wants a whole event planned (not just one service booked), call offer_plan_intent with whatever fields you've already extracted from what they said, plus your honest estimate of how many more questions you'll need. Do NOT call create_plan_draft yet.
      2. If they accept, gather the handful of details you still need ONE AT A TIME via ask_plan_question (never create_plan_draft during this -- there is still no plan row). Vary single_choice and multi_select questions naturally; every question still allows a free-text answer or a skip, and your lead_in should react to their last answer so it reads as conversation. Ask only one question per call.
      3. Once you have enough (title + event_type is always enough -- never force completeness just to fill in every field), call preview_plan_brief with everything gathered so the user reviews it before anything is created.
      4. Only after the user confirms from that preview (e.g. "Build my plan", "yes", "looks good") do you call create_plan_draft, immediately followed by confirm_brief. If their message spells out specific final details (e.g. "Build my plan with these final details: title ..., date ..., city ..., guests ..., total budget ..."), those are the brief's actual values after any edits made on the review card -- use them exactly for create_plan_draft's arguments rather than values from earlier in the conversation, which may be stale.
      If the user dismisses the offer ("just chat") or answers in a way that makes clear they want to skip the guided flow, drop it and continue as plain conversation -- the offer can always be re-summoned later if they say something like "plan this" again.
   j. Outside a plan's own pinned thread (i.e. this message has no [plan_id: ...] context), if the user names a service/category (e.g. "I still need a caterer", "find me a DJ") and they have more than one active or draft plan, you cannot know which plan they mean -- NEVER guess. Call disambiguate_plans with your best-guess category_hint and let its real candidates (plans that genuinely still need that category -- it already excludes any plan where the slot is filled) drive the options you show; don't list a plan yourself from memory. If it returns zero or one candidate, don't show a disambiguation card -- just continue normally (zero candidates means every plan already has that category filled; say so). If the user picks "Something else," continue as a normal, plan-independent provider search.`;

export async function handleAiAssistant(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const session = await verifyInsforgeSession(authHeader);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const accessToken = String(authHeader).replace(/^Bearer\s+/i, '');

  // Same enforceRateLimit RPC other endpoints gate paid/privileged calls
  // with (see api/_lib/verifyAuth.ts) -- keyed per user so one user's usage
  // can't exhaust another's allowance.
  const rateOk = await enforceRateLimit(String(authHeader), `ai_assistant:${session.userId}`, 20, 3600);
  if (!rateOk) return res.status(429).json({ error: 'Too many requests. Please try again in a bit.' });

  const { messages, confirmedAction } = req.body || {};

  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = req.headers.host;
  const origin = `${proto}://${host}`;

  try {
    // Confirmation path: verify the token, then execute exactly that one
    // mutating tool's real executor and report the real result. No model
    // call happens on this path at all.
    if (confirmedAction && typeof confirmedAction === 'object') {
      const { action, params, token } = confirmedAction;
      if (typeof action !== 'string' || !(PROPOSAL_TOOL_NAMES as Set<string>).has(action) || typeof token !== 'string') {
        return res.status(400).json({ error: 'Invalid confirmedAction' });
      }
      const verified = verifyConfirmationToken(token, action, params, session.userId);
      if (!verified.ok) {
        return res.status(403).json({ error: `Confirmation rejected: ${(verified as { ok: false; reason: string }).reason}` });
      }

      const client = buildUserSupabaseClient(accessToken);
      let result: unknown;
      try {
        switch (action) {
          case 'start_ticket_transfer':
            result = await executeStartTicketTransfer(client, params);
            break;
          case 'request_ticket_refund':
            result = await executeRequestTicketRefund(accessToken, origin, params);
            break;
          case 'start_service_booking':
            result = await executeStartServiceBooking(client, params);
            break;
          case 'create_report':
            result = await executeCreateReport(client, session.userId, params);
            break;
          default:
            return res.status(400).json({ error: 'Unknown action' });
        }
      } catch (execError: any) {
        return res.status(200).json({
          type: 'message',
          text: `That didn't go through: ${execError?.message || 'unknown error'}.`,
          cards: [],
        });
      }

      return res.status(200).json({
        type: 'message',
        text: `Done -- ${action.replace(/_/g, ' ')} completed.`,
        cards: [{ type: action, data: result, source: 'vents' as const }],
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Hard per-message length cap -- the only one of these three checks that
    // rejects outright rather than silently truncating, since a message
    // this long is almost certainly not normal chat input and truncating it
    // silently would answer a different question than the one actually
    // asked.
    for (const m of messages) {
      if (messageTextLength(m?.content) > MAX_MESSAGE_CHARS) {
        return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_CHARS} characters).` });
      }
    }

    // Emergency Anthropic kill switch. See isAiDisabled's own comment
    // (api/_lib/verifyAuth.ts) for why this fails closed. Placed after the
    // confirmedAction branch above (confirming an already-proposed action
    // executes a real VENTS tool, never a new Anthropic call, so it stays
    // available even with AI disabled) but before any model call below.
    if (await isAiDisabled(String(authHeader))) {
      return res.status(503).json({ error: 'AI_UNAVAILABLE', message: 'AI features are temporarily unavailable. Please try again later.' });
    }

    // Phase 4 -- AI subscription entitlement + usage enforcement (chat
    // surface only; see aiEntitlement.ts and
    // supabase/migrations/0165_ai_subscription_foundation.sql). Gated
    // behind app_config.ai_entitlement_enforced, which defaults to false --
    // until a Root admin turns it on (once real store purchases exist),
    // this block is a no-op and behavior is unchanged from before Phase 4.
    // When enabled: verifies the entitlement is active and within its
    // period, then atomically reserves one usage unit against it, BEFORE
    // any Anthropic call -- a rejection here means no Anthropic request is
    // ever made and no usage is consumed for it (the reservation call
    // itself either fully succeeds, consuming exactly one unit, or throws
    // without having consumed one -- any RAISE EXCEPTION inside
    // check_and_reserve_ai_usage rolls back every write that single call
    // made, including its own usage increment, as ordinary Postgres
    // transaction semantics (see 0166_fix_ai_usage_expiry_transaction_semantics.sql).
    if (await isAiEntitlementEnforced(String(authHeader))) {
      try {
        await checkAndReserveAiUsage(session.userId, 'chat');
      } catch (entErr) {
        if (entErr instanceof AiEntitlementError) {
          if (entErr.code === 'usage_ceiling_exceeded') {
            return res.status(429).json({
              error: 'AI_USAGE_LIMIT_REACHED',
              message: 'You have used up your VENTS AI allowance for this billing period.',
            });
          }
          return res.status(402).json({
            error: 'AI_SUBSCRIPTION_REQUIRED',
            message: 'A VENTS AI subscription is required to use this feature.',
            reason: entErr.code,
          });
        }
        // Unexpected infra failure talking to the entitlement RPC -- fail
        // closed on the ENTITLEMENT CHECK ITSELF (distinct from the
        // enforcement flag above, which fails open). Once enforcement is
        // turned on, an entitlement that cannot be verified must not be
        // treated as entitled -- that would silently defeat the whole
        // point of turning the flag on.
        console.error('check_and_reserve_ai_usage failed unexpectedly:', (entErr as any)?.message || entErr);
        return res.status(503).json({ error: 'AI_UNAVAILABLE', message: 'AI features are temporarily unavailable. Please try again later.' });
      }
    }

    // Global ceiling across ALL users combined -- a backstop under the
    // existing 20/hour/user cap above, not a replacement for it. Fails
    // open on an infra hiccup (same as the per-user cap), never closed --
    // only the kill switch above is fail-closed.
    const globalOk = await enforceRateLimit(String(authHeader), AI_GLOBAL_RATE_KEY, AI_GLOBAL_RATE_MAX, AI_GLOBAL_RATE_WINDOW_SECONDS);
    if (!globalOk) return res.status(429).json({ error: 'VENTS AI is experiencing high demand right now. Please try again shortly.' });

    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }

    const client = buildUserSupabaseClient(accessToken);
    const conversation: any[] = capConversationHistory(messages).map((m: any) => ({ role: m.role, content: m.content }));
    const cards: any[] = [];
    // Populated only from a plan tool that actually SUCCEEDED this request
    // (see the toolResults map below) -- never from a bare tool_use input,
    // so a model-supplied plan_id that turned out not to belong to this
    // user (the tool call errored) never reaches persistPlanTurn at all.
    const touchedPlanIds = new Set<string>();
    const lastUserMessage = [...messages].reverse().find((m: any) => m.role === 'user');
    const lastUserText = lastUserMessage ? flattenContentToText(lastUserMessage.content) : '';

    // Request-local only -- declared inside this function call, never
    // written to any store, never read by any other request. See
    // WEB_SEARCH_MAX_PER_REQUEST's own comment above for why this exists.
    let searchesUsedThisRequest = 0;

    // Phase 5A telemetry -- groups this request's rounds together (via
    // roundId + an incrementing roundIndex) without identifying who made
    // the request. See aiTelemetry.ts: never derived from, and never
    // stored alongside, session.userId or anything else user-identifying.
    const aiTelemetryRoundId = newAiRequestId();

    for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round++) {
      // Shrink (never grow) the search budget actually offered to Anthropic
      // this round, down to whatever's left of the per-request cap -- once
      // it hits zero, web_search is dropped from `tools` entirely so the
      // model has no way to call it, but every VENTS tool stays available
      // and the conversation/tool loop continues normally without it.
      const remainingSearches = Math.max(0, WEB_SEARCH_MAX_PER_REQUEST - searchesUsedThisRequest);
      const toolsForRound: any[] = remainingSearches > 0
        ? [...ALL_TOOLS, { ...WEB_SEARCH_TOOL, max_uses: remainingSearches }]
        : [...ALL_TOOLS];
      // Prompt caching: the system prompt and the tools schema are
      // byte-identical on every round of every request, for every user --
      // confirmed by reading this file, there is no per-user or per-request
      // interpolation in SYSTEM_PROMPT or in any VENTS tool definition.
      // Caching only this static prefix (never `conversation`, which is the
      // whole point -- that's the part that actually changes every round)
      // cuts the ~8,000+ tokens of system+tools overhead this handler
      // previously resent and billed at full price on every single round
      // down to cache-read pricing after the first hit. Because the cached
      // content contains no user-specific data, a cache hit can occur
      // across different users' requests too, not just within one
      // conversation's own rounds -- that's safe specifically because
      // nothing user-specific is in the cached bytes. cache_control goes on
      // the LAST block of each cacheable section (tools, then system) --
      // when the search budget hits zero and web_search is dropped from
      // `tools`, that array's bytes change and its cache entry for this
      // round misses (a minor, rare-tail inefficiency, not a correctness
      // issue); the system-prompt cache entry is unaffected either way.
      if (toolsForRound.length > 0) {
        toolsForRound[toolsForRound.length - 1] = {
          ...toolsForRound[toolsForRound.length - 1],
          cache_control: { type: 'ephemeral' },
        };
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          signal: ctrl.signal,
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 2000,
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            tools: toolsForRound,
            messages: conversation,
          }),
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const errText = await response.text();
        await recordAiUsageEvent({
          surface: 'chat',
          model: 'claude-sonnet-5',
          roundId: aiTelemetryRoundId,
          roundIndex: round,
          status: 'error',
          inputTokens: null,
          outputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          webSearchRequests: null,
        });
        return res.status(500).json({ error: `Anthropic error: ${errText.substring(0, 200)}` });
      }

      const data: any = await response.json();
      const roundWebSearches = data?.usage?.server_tool_use?.web_search_requests ?? null;
      searchesUsedThisRequest += roundWebSearches || 0;
      await recordAiUsageEvent({
        surface: 'chat',
        model: 'claude-sonnet-5',
        roundId: aiTelemetryRoundId,
        roundIndex: round,
        status: 'success',
        inputTokens: data?.usage?.input_tokens ?? null,
        outputTokens: data?.usage?.output_tokens ?? null,
        cacheCreationInputTokens: data?.usage?.cache_creation_input_tokens ?? null,
        cacheReadInputTokens: data?.usage?.cache_read_input_tokens ?? null,
        webSearchRequests: roundWebSearches,
      });
      const blocks: any[] = data.content || [];
      // web_search runs server-side on Anthropic's infrastructure -- its
      // tool_use/web_search_tool_result blocks arrive already resolved as
      // part of this same response, not as a pending call for us to
      // dispatch. Only tool_use blocks for OUR tools (VENTS DB read/proposal
      // tools) need manual execution here, so explicitly exclude
      // WEB_SEARCH_TOOL_NAME before deciding whether there's anything left
      // to do this round.
      const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use' && b.name !== WEB_SEARCH_TOOL_NAME);

      // web_search_tool_result blocks carry the server-executed search
      // results in-band -- surface them as their own cards, tagged
      // source: 'external' so the (future) UI can render them distinctly
      // from live VENTS data and never as bookable VENTS listings.
      const webSearchResultBlocks = blocks.filter((b) => b.type === 'web_search_tool_result');
      for (const b of webSearchResultBlocks) {
        // On error, `.content` is a single error object (e.g.
        // {error_code: 'max_uses_exceeded'}), not a list -- the API returns
        // HTTP 200 either way, so this must be branched on before treating
        // the content as a results array.
        const isError = !Array.isArray(b.content);
        if (isError) {
          cards.push({
            type: 'web_search_error',
            data: b.content,
            source: 'external' as const,
          });
          continue;
        }
        cards.push({ type: 'web_search', data: b.content, source: 'external' as const });
      }

      if (toolUseBlocks.length === 0) {
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        // Only persist when exactly one plan was touched this turn --
        // zero means this wasn't a plan conversation at all (nothing to
        // persist); more than one is an ambiguous turn (e.g. the model
        // called get_plan on two different plans), and guessing which one
        // the reply is "about" risks attaching a reply to the wrong
        // plan's thread, so it's skipped rather than guessed.
        if (touchedPlanIds.size === 1) {
          await persistPlanTurn(client, [...touchedPlanIds][0], lastUserText, text);
        }
        return res.status(200).json({ type: 'message', text, cards });
      }

      // A Phase 2 (mutating) tool ends the turn immediately with a
      // proposal -- it is never executed inside this loop, and the model is
      // never given a chance to keep going past a proposed mutation in the
      // same turn.
      const proposalBlock = toolUseBlocks.find((b) => PROPOSAL_TOOL_NAMES.has(b.name));
      if (proposalBlock) {
        const { proposal } = buildProposal(proposalBlock.name, proposalBlock.input);
        const token = createConfirmationToken(proposalBlock.name, proposalBlock.input, session.userId);
        const precedingText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        return res.status(200).json({
          type: 'confirmation_required',
          action: proposalBlock.name,
          params: proposalBlock.input,
          proposal,
          token,
          text: precedingText,
        });
      }

      // Otherwise every tool_use block this round is either a Phase 1 read
      // tool or an SI Planner tool -- both auto-execute here and feed
      // results back as tool_result blocks (see the PLAN_TOOLS comment in
      // aiTools.ts for why planner tools don't go through the Phase 2
      // confirmation flow: they're reversible planning data, never money).
      conversation.push({ role: 'assistant', content: blocks });

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const isReadOnly = READ_ONLY_TOOL_NAMES.has(block.name);
          const isPlanTool = PLAN_TOOL_NAMES.has(block.name);
          if (!isReadOnly && !isPlanTool) {
            return { type: 'tool_result', tool_use_id: block.id, content: 'Unknown tool', is_error: true };
          }
          try {
            const result: any = isReadOnly
              ? await executeReadOnlyTool(block.name, client, block.input)
              : await executePlanTool(block.name, client, session.userId, block.input);
            cards.push({ type: block.name, data: result, source: 'vents' as const });
            if (isPlanTool) {
              // The plan_id this call succeeded against -- either echoed
              // back in the result (every plan-tool executor includes it)
              // or, failing that, the plan_id the model supplied as input.
              // Only reached on success, so a plan_id for a plan this user
              // doesn't own (the executor would have thrown) never lands
              // here.
              const planId = result?.plan_id ?? block.input?.plan_id;
              if (typeof planId === 'string' && planId) touchedPlanIds.add(planId);
            }
            return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
          } catch (toolError: any) {
            return {
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: ${toolError?.message || 'tool failed'}`,
              is_error: true,
            };
          }
        })
      );

      conversation.push({ role: 'user', content: toolResults });
    }

    return res.status(200).json({
      type: 'message',
      text: "I looked into that but couldn't finish in time -- try narrowing your question.",
      cards,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      return res.status(504).json({ error: 'VENTS AI took too long to respond. Please try again.' });
    }
    return res.status(500).json({ error: error?.message || 'Unknown error' });
  }
}
