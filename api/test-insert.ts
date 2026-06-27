import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const INSFORGE_URL = process.env.VITE_INSFORGE_URL || '';
  const INSFORGE_KEY = process.env.VITE_INSFORGE_ANON_KEY || '';

  try {
    const response = await fetch(`${INSFORGE_URL}/rest/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${INSFORGE_KEY}`,
        'apikey': INSFORGE_KEY,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        title: 'Debug Test Event',
        description: 'Test description for debugging import.',
        event_date: '2026-07-10T11:00:00+01:00',
        location: 'ROYAL, Abuja',
        category: 'Education',
        price: 0,
        ticket_goal: 0,
        hidden_by_admin: false,
        is_18_plus: false,
        organizer_id: 'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc',
        status: 'live',
      }),
    });

    const text = await response.text();
    return res.status(200).json({
      status: response.status,
      ok: response.ok,
      body: text
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}
