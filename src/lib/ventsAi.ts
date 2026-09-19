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

export async function sendVentsAiMessage(
  messages: VentsAiMessage[],
  confirmedAction?: VentsAiConfirmedAction
): Promise<VentsAiResponse> {
  const token = await getAuthToken();

  const res = await fetch(apiUrl('/api/extract-events'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mode: 'ai_assistant', messages, confirmedAction }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error || `VENTS AI request failed (${res.status})`);
  }
  return body as VentsAiResponse;
}
