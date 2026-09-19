import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyInsforgeSession, enforceRateLimit } from './_lib/verifyAuth.js';
import { applyCors } from './_lib/cors.js';
import { createConfirmationToken, verifyConfirmationToken } from './_lib/aiConfirmation.js';
import {
  ALL_TOOLS,
  READ_ONLY_TOOL_NAMES,
  PROPOSAL_TOOL_NAMES,
  buildUserSupabaseClient,
  executeReadOnlyTool,
  buildProposal,
  executeStartTicketTransfer,
  executeRequestTicketRefund,
  executeStartServiceBooking,
  executeCreateReport,
} from './_lib/aiTools.js';

// VENTS AI -- server-orchestrated conversational assistant. Modeled directly
// on api/extract-events.ts's structure (raw fetch to the Anthropic Messages
// API, server-only ANTHROPIC_API_KEY, verifyInsforgeSession gating, an
// AbortController timeout). The key difference from extract-events.ts: this
// endpoint calls EXISTING secure backend functionality as tools rather than
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

const MAX_TOOL_ROUNDTRIPS = 5;
const TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = `You are VENTS AI, the assistant built into the VENTS app (events, service bookings, tickets, wallet and VENTS Cents, for a primarily Nigerian audience).

Ground rules:
1. NEVER fabricate live VENTS data -- events, prices, availability, payment status, ticket status, booking status, wallet balance, or VENTS Cents balance. For anything VENTS-specific, always call the matching tool and base your answer only on its result. If a tool call fails or returns nothing, say so plainly rather than guessing.
2. Clearly distinguish three kinds of things in your answers: (a) live VENTS data you got from a tool just now, (b) general/cultural knowledge you already have (e.g. who an artist is, what a term means, general event-planning advice), and (c) anything you are not confident about -- say so rather than presenting a guess as fact.
3. Handle Nigerian phrasing, culture, artists, and event terminology naturally, using your own general knowledge -- there is no hardcoded slang list here, so use judgment the way you would for any other region's phrasing.
4. For any consequential action (transferring or refunding a ticket, booking a service, filing a report), you may only ever PROPOSE it via the matching tool. Never claim an action has been completed unless you are reporting the actual result of a real, already-executed tool call. The system will ask the user to confirm before anything actually happens.

Keep answers conversational and concise. When you have structured results (events, providers, tickets, bookings, payment status, wallet/VC balances), summarize them in your text -- the app will also render them as structured cards from the tool results, so you don't need to reformat them as lists or tables yourself.`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
      if (typeof action !== 'string' || !PROPOSAL_TOOL_NAMES.has(action) || typeof token !== 'string') {
        return res.status(400).json({ error: 'Invalid confirmedAction' });
      }
      const verified = verifyConfirmationToken(token, action, params, session.userId);
      if (!verified.ok) {
        return res.status(403).json({ error: `Confirmation rejected: ${verified.reason}` });
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
        cards: [{ type: action, data: result }],
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }

    const client = buildUserSupabaseClient(accessToken);
    const conversation: any[] = messages.map((m: any) => ({ role: m.role, content: m.content }));
    const cards: any[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round++) {
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
            system: SYSTEM_PROMPT,
            tools: ALL_TOOLS,
            messages: conversation,
          }),
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const errText = await response.text();
        return res.status(500).json({ error: `Anthropic error: ${errText.substring(0, 200)}` });
      }

      const data: any = await response.json();
      const blocks: any[] = data.content || [];
      const toolUseBlocks = blocks.filter((b) => b.type === 'tool_use');

      if (toolUseBlocks.length === 0) {
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
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

      // Otherwise every tool_use block this round is a Phase 1 read tool --
      // execute all of them and feed results back as tool_result blocks.
      conversation.push({ role: 'assistant', content: blocks });

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          if (!READ_ONLY_TOOL_NAMES.has(block.name)) {
            return { type: 'tool_result', tool_use_id: block.id, content: 'Unknown tool', is_error: true };
          }
          try {
            const result = await executeReadOnlyTool(block.name, client, block.input);
            cards.push({ type: block.name, data: result });
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
