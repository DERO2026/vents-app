// Shared audit-log/notification helpers, ported verbatim from the legacy
// AdminDashboardScreen.tsx as part of its full retirement.
import { supabase, getAuthToken } from '../../../lib/supabase';
import { apiUrl } from '../../../lib/apiBase';
import { Sentry } from '../../../lib/sentry';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

// Takes the acting user's row so every audit entry can explicitly flag their
// authorization level (Admin / Sub-Admin / Root) alongside the raw admin_id.
export async function writeAuditLog(actor: { id: string; role?: string }, action: string, targetUserId: string | null, details: Record<string, any>) {
  const actorRole = actor.id === ROOT_UID ? 'root' : actor.role || 'unknown';
  await supabase
    .from('admin_logs')
    .insert([{ admin_id: actor.id, action, target_user_id: targetUserId, details, actor_role: actorRole }]);
}

// Fires the confirmation/rejection email after an admin action succeeds.
export async function notifyByEmail(requestType: 'organizer' | 'cac' | 'payout', requestId: string, decision: 'approved' | 'rejected', reason?: string) {
  try {
    const token = await getAuthToken();
    await fetch(apiUrl('/api/v1/notify/status-email'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ request_type: requestType, request_id: requestId, decision, reason }),
    });
  } catch (err) {
    console.error('Notification email failed:', err);
    Sentry.captureException(err);
  }
}
