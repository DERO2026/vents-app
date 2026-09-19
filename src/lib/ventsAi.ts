import { getAuthToken } from './supabase';

// Thin client for VENTS AI's server-orchestrated assistant (api/ai-assistant.ts).
// No business logic lives here -- this only attaches the user's own auth
// token and posts the conversation (and, on a confirm step, the signed
// confirmedAction) to the endpoint.

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

  const res = await fetch('/api/ai-assistant', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages, confirmedAction }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error || `VENTS AI request failed (${res.status})`);
  }
  return body as VentsAiResponse;
}
