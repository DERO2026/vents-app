import { getAuthToken } from './supabase';
import { apiUrl } from './apiBase';

// Thin client for VENTS AI's server-orchestrated assistant. This used to
// post to its own /api/ai-assistant serverless function; that function was
// folded into api/extract-events.ts (its handler logic now lives in
// api/_lib/aiAssistantHandler.ts) to stay within Vercel Hobby's
// 12-serverless-function-per-deployment cap. This client now posts to
// /api/extract-events with the explicit `mode: 'ai_assistant'` discriminator
// that endpoint routes on -- everything else about this helper (its
// signature, what it sends, what it returns) is unchanged.

export type VentsAiMessage = { role: 'user' | 'assistant'; content: string };

export type VentsAiConfirmedAction = {
  action: string;
  params: Record<string, unknown>;
  token: string;
};

export type VentsAiResponse =
  | { type: 'message'; text: string; cards?: Array<{ type: string; data: unknown; source?: 'vents' | 'external' | 'general' }> }
  | {
      type: 'confirmation_required';
      action: string;
      params: Record<string, unknown>;
      proposal: Record<string, unknown>;
      token: string;
      text?: string;
    };

// Optional real coordinates, read from the browser's own geolocation API
// (navigator.geolocation, via the same useGeolocation hook
// ServicesHomeScreen's "Near You" already uses) -- never fabricated, never
// derived from a typed location string. Omitted entirely when permission
// was denied/unavailable, so the server-side recommend_providers tool
// falls back to its existing text-location match (see aiTools.ts).
export type VentsAiLocation = { lat: number; lng: number };

export async function sendVentsAiMessage(
  messages: VentsAiMessage[],
  confirmedAction?: VentsAiConfirmedAction,
  location?: VentsAiLocation
): Promise<VentsAiResponse> {
  const token = await getAuthToken();

  const res = await fetch(apiUrl('/api/extract-events'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mode: 'ai_assistant', messages, confirmedAction, location }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Prefer the server's human-readable `message` (e.g. "VENTS AI
    // requires an active subscription...") over the raw `error` code
    // (e.g. "AI_BETA_RESTRICTED") -- the code alone was being shown to
    // users verbatim as the error text, which is exactly the kind of
    // unfriendly/cryptic message this screen's own errorText banner is
    // supposed to avoid.
    const err: any = new Error(body?.message || body?.error || `VENTS AI request failed (${res.status})`);
    err.code = body?.error;
    throw err;
  }
  return body as VentsAiResponse;
}
