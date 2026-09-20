// Shared user/event admin mutations for the Batch 2 Admin Console screens
// (AdminUsersList, AdminUserDetail, AdminEventsList, AdminEventDetail).
//
// Every RPC name, parameter and the maker-checker gate below is copied
// verbatim from the existing, already-shipped AdminDashboardScreen.tsx
// (handleRoleChange / handleSuspend / handleSoftDelete / handleReinstate /
// handleToggleVerify / handleHideEvent / handleReinstateEvent /
// handleRestoreEvent / handleToggleFeatured, and its submitOrExecute
// gate) — per the Batch 2 task brief's instruction to reuse the exact same
// backend calls rather than invent new mutation logic. AdminDashboardScreen
// itself is left untouched; this module only avoids duplicating divergent
// copies of the same logic across the new files.
import { supabase } from '../../../lib/supabase';

export interface ActionMeta {
  target_type: string;
  target_id?: string | null;
  target_label?: string | null;
  payload?: any;
  previous?: any;
  changes?: any;
}

// Super Admins (Root + full Admin) execute immediately. Sub-Admins never
// execute directly — the action is queued via request_admin_action for a
// Super Admin to approve. The backend independently enforces this (the
// underlying RPCs are Super-Admin-gated); this mirrors it for the UI.
export async function submitOrExecute(
  isSuperAdmin: boolean,
  actionType: string,
  meta: ActionMeta,
  execute: () => Promise<void>,
): Promise<{ ok: boolean; message: string }> {
  if (isSuperAdmin) {
    try {
      await execute();
      return { ok: true, message: 'Done.' };
    } catch (e: any) {
      return { ok: false, message: e?.message || 'Action failed.' };
    }
  }
  try {
    const { error } = await supabase.rpc('request_admin_action' as any, {
      p_action_type: actionType,
      p_target_type: meta.target_type,
      p_target_id: meta.target_id ?? null,
      p_target_label: meta.target_label ?? null,
      p_payload: meta.payload ?? {},
      p_previous_values: meta.previous ?? null,
      p_requested_changes: meta.changes ?? null,
      p_device: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    });
    if (error) throw error;
    return { ok: true, message: 'Request sent — waiting for Admin approval.' };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'Could not submit request.' };
  }
}

// ── User actions ─────────────────────────────────────────────────────────
export async function roleChange(isSuperAdmin: boolean, userId: string, currentRole: string | null | undefined, newRole: string, label: string) {
  return submitOrExecute(isSuperAdmin, 'set_user_role',
    { target_type: 'user', target_id: userId, target_label: label, payload: { new_role: newRole }, previous: { role: currentRole }, changes: { role: newRole } },
    async () => {
      const { error } = await supabase.rpc('admin_set_user_role', { p_user_id: userId, p_new_role: newRole });
      if (error) throw error;
    });
}

export async function suspendOrUnban(isSuperAdmin: boolean, userId: string, label: string, currentStatus: string, banDays: number | null) {
  if (currentStatus === 'suspended') {
    return submitOrExecute(isSuperAdmin, 'unsuspend_user',
      { target_type: 'user', target_id: userId, target_label: label, previous: { status: 'suspended' }, changes: { status: 'active' } },
      async () => {
        const { error } = await supabase.rpc('admin_unsuspend_user', { p_user_id: userId });
        if (error) throw error;
      });
  }
  const bannedUntil = banDays ? new Date(Date.now() + banDays * 86400000).toISOString() : null;
  return submitOrExecute(isSuperAdmin, 'suspend_user',
    { target_type: 'user', target_id: userId, target_label: label, payload: { banned_until: bannedUntil, ban_days: banDays ?? 'permanent' }, previous: { status: currentStatus }, changes: { status: 'suspended', banned_until: bannedUntil } },
    async () => {
      const { error } = await supabase.rpc('admin_suspend_user', { p_user_id: userId, p_banned_until: bannedUntil, p_reason: null });
      if (error) throw error;
    });
}

export async function softDeleteUser(isSuperAdmin: boolean, userId: string, label: string, currentStatus: string, reason: string | null) {
  return submitOrExecute(isSuperAdmin, 'soft_delete_user',
    { target_type: 'user', target_id: userId, target_label: label, payload: { reason }, previous: { status: currentStatus }, changes: { status: 'deleted', reason } },
    async () => {
      const { error } = await supabase.rpc('admin_soft_delete_user', { p_user_id: userId, p_reason: reason });
      if (error) throw error;
    });
}

export async function reinstateUser(isSuperAdmin: boolean, userId: string, label: string, currentStatus: string) {
  return submitOrExecute(isSuperAdmin, 'reinstate_user',
    { target_type: 'user', target_id: userId, target_label: label, previous: { status: currentStatus }, changes: { status: 'active' } },
    async () => {
      const { error } = await supabase.rpc('admin_reinstate_user', { p_user_id: userId });
      if (error) throw error;
    });
}

export async function toggleVerifyUser(isSuperAdmin: boolean, userId: string, label: string, currentlyVerified: boolean) {
  const newVerified = !currentlyVerified;
  return submitOrExecute(isSuperAdmin, 'toggle_user_verified',
    { target_type: 'user', target_id: userId, target_label: label, payload: { verified: newVerified }, previous: { is_verified: currentlyVerified }, changes: { is_verified: newVerified } },
    async () => {
      const { error } = await supabase.rpc('admin_toggle_user_verified', { p_user_id: userId, p_verified: newVerified, p_reason: null });
      if (error) throw error;
    });
}

// ── Event actions ────────────────────────────────────────────────────────
export async function hideEvent(isSuperAdmin: boolean, eventId: string, label: string) {
  return submitOrExecute(isSuperAdmin, 'hide_event',
    { target_type: 'event', target_id: eventId, target_label: label, previous: { hidden_by_admin: false }, changes: { hidden_by_admin: true } },
    async () => {
      const { error } = await supabase.rpc('admin_hide_event', { p_event_id: eventId });
      if (error) throw error;
    });
}

export async function reinstateEvent(isSuperAdmin: boolean, eventId: string, label: string) {
  return submitOrExecute(isSuperAdmin, 'reinstate_event',
    { target_type: 'event', target_id: eventId, target_label: label, previous: { hidden_by_admin: true }, changes: { hidden_by_admin: false } },
    async () => {
      const { error } = await supabase.rpc('admin_reinstate_event', { p_event_id: eventId });
      if (error) throw error;
    });
}

export async function restoreDeletedEvent(isSuperAdmin: boolean, eventId: string, label: string) {
  return submitOrExecute(isSuperAdmin, 'restore_event',
    { target_type: 'event', target_id: eventId, target_label: label, previous: { deleted: true }, changes: { deleted: false } },
    async () => {
      const { error } = await supabase.rpc('admin_restore_deleted_event', { p_event_id: eventId });
      if (error) throw error;
    });
}

// The only two legitimate paths into Featured are a paid promotion or this
// admin action — matches AdminDashboardScreen's handleToggleFeatured exactly
// (14-day duration, admin_set_event_featured RPC).
export async function toggleEventFeatured(isSuperAdmin: boolean, eventId: string, label: string, currentlyFeatured: boolean) {
  const nextFeatured = !currentlyFeatured;
  return submitOrExecute(isSuperAdmin, 'toggle_event_featured',
    { target_type: 'event', target_id: eventId, target_label: label, previous: { is_featured: currentlyFeatured }, changes: { is_featured: nextFeatured } },
    async () => {
      const { error } = await supabase.rpc('admin_set_event_featured', {
        p_event_id: eventId,
        p_featured: nextFeatured,
        p_duration_days: nextFeatured ? 14 : null,
      });
      if (error) throw error;
    });
}
