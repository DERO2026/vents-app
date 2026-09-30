// System Controller — ported verbatim (root-only) from the legacy
// AdminDashboardScreen.tsx 'system' tab as part of its full retirement.
// Every toggle already had a confirmation dialog; nothing here is weakened.
// Global Broadcast stays root-only, matching the legacy console exactly —
// there is no separate, less-restrictive "Communication" screen, since that
// would widen access beyond what production has ever granted.
import React, { useState, useEffect } from 'react';
import {
  Zap, Wrench, ToggleLeft, ToggleRight, Mic, Image as ImageIcon, Activity,
  Ticket, ScanLine, UserPlus, Banknote, MapPin, Megaphone, Trash2, Swords,
} from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { ConfirmModal } from './adminShared';
import { writeAuditLog } from './adminAuditLog';
import { appVersionLabel } from '../../../lib/appVersion';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

interface KillSwitchDef { key: 'disable_purchases' | 'disable_bookings' | 'disable_deposits' | 'disable_scanning' | 'disable_signups' | 'disable_payouts' | 'disable_location_sharing'; label: string; desc: (v: boolean) => string; icon: React.ReactNode; financial?: boolean; }

// Financial switches (financial: true) are enforced server-side at the
// pre-payment entry point for that operation (create_pending_purchase/
// purchase_ticket, create_service_booking, request_organizer_payout,
// initiate_wallet_deposit — see 0124_emergency_kill_switches.sql) and fail
// CLOSED (blocked) if app_config can't be read at all, never fail open.
const KILL_SWITCHES: KillSwitchDef[] = [
  { key: 'disable_purchases', label: 'Ticket Purchases', icon: <Ticket size={17} />, financial: true, desc: (v) => v ? 'Paused — "Buy Ticket" is blocked for every user' : 'Enabled — purchases are open' },
  { key: 'disable_bookings', label: 'Service Bookings', icon: <Ticket size={17} />, financial: true, desc: (v) => v ? 'Paused — new service bookings are blocked for every user' : 'Enabled — service bookings are open' },
  { key: 'disable_deposits', label: 'Wallet Deposits', icon: <Banknote size={17} />, financial: true, desc: (v) => v ? 'Paused — new VENTS Wallet top-ups are blocked' : 'Enabled — wallet deposits are open' },
  { key: 'disable_payouts', label: 'Organizer/Provider Payouts', icon: <Banknote size={17} />, financial: true, desc: (v) => v ? 'Paused — new withdrawal requests and approve/cancel/reject payout actions are blocked' : 'Enabled — payout actions are open' },
  { key: 'disable_scanning', label: 'QR Scanning', icon: <ScanLine size={17} />, desc: (v) => v ? 'Paused — check-in scanners are blocked for every organizer' : 'Enabled — check-in scanning is open' },
  { key: 'disable_signups', label: 'New Sign-ups', icon: <UserPlus size={17} />, desc: (v) => v ? 'Paused — new account creation is blocked' : 'Enabled — sign-ups are open' },
  { key: 'disable_location_sharing', label: 'Location Sharing', icon: <MapPin size={17} />, desc: (v) => v ? 'Paused — sharing your location in chat is blocked' : 'Enabled — location sharing is open' },
];

export function AdminSystemScreen({ currentUser }: { currentUser: { id: string; role?: string } }) {
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [voiceNotesEnabled, setVoiceNotesEnabled] = useState(true);
  const [imageSharingEnabled, setImageSharingEnabled] = useState(true);
  const [killSwitches, setKillSwitches] = useState<Record<string, boolean>>({});
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [isPinging, setIsPinging] = useState(false);
  const [healthResult, setHealthResult] = useState<{ ok: boolean; latencyMs: number; detail: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; confirmLabel: string; danger: boolean; optionalReason?: boolean; onConfirm: (reason?: string) => void } | null>(null);

  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  useEffect(() => {
    supabase.from('app_config').select('maintenance_mode, voice_notes_enabled, image_sharing_enabled, disable_purchases, disable_bookings, disable_deposits, disable_scanning, disable_signups, disable_payouts, disable_location_sharing').maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        setMaintenanceMode(!!data.maintenance_mode);
        setVoiceNotesEnabled(data.voice_notes_enabled !== false);
        setImageSharingEnabled(data.image_sharing_enabled !== false);
        setKillSwitches({
          disable_purchases: !!data.disable_purchases, disable_bookings: !!data.disable_bookings,
          disable_deposits: !!data.disable_deposits, disable_scanning: !!data.disable_scanning,
          disable_signups: !!data.disable_signups, disable_payouts: !!data.disable_payouts,
          disable_location_sharing: !!data.disable_location_sharing,
        });
      });
  }, []);

  // Every app_config write goes through admin_update_app_config (0083;
  // extended in 0124 for the new switches + an optional reason) -- the one
  // Root-gated, whitelisted, server-side-audited path. There is no direct
  // table write here: `authenticated` has no UPDATE grant on app_config at
  // all, so a raw .update() call fails outright (this replaced exactly
  // that bug -- the previous version of this screen called
  // supabase.from('app_config').update(...) directly, which could never
  // have worked and would have failed every single toggle in production).
  const toggleAppConfig = (column: string, next: boolean, title: string, message: string, danger: boolean, onSuccess: () => void, optionalReason = false) => {
    setConfirmModal({
      title, message, confirmLabel: next ? 'Enable' : 'Disable', danger, optionalReason,
      onConfirm: async (reason) => {
        setConfirmModal(null);
        try {
          const { error } = await supabase.rpc('admin_update_app_config', { p_field: column, p_value: String(next), p_reason: reason || null });
          if (error) throw error;
          onSuccess();
          flash(true, `${title} ${next ? 'enabled' : 'disabled'}.`);
        } catch (err: any) { flash(false, err?.message || `Failed to update ${title}.`); }
      },
    });
  };

  const handleToggleKillSwitch = (def: KillSwitchDef) => {
    const currentlyDisabled = !!killSwitches[def.key];
    const next = !currentlyDisabled;
    toggleAppConfig(def.key, next,
      next ? `Disable ${def.label}` : `Enable ${def.label}`,
      next
        ? `This will immediately block ${def.label} for every user, on every app version — old installed clients cannot bypass this. Continue?`
        : `This will restore ${def.label} for every user.`,
      next, () => setKillSwitches((prev) => ({ ...prev, [def.key]: next })),
      /* optionalReason */ next && !!def.financial);
  };

  const handleOrphanCleanup = () => {
    setConfirmModal({
      title: 'Orphaned Record Cleanup', message: 'This will soft-delete tickets and saves for non-existent events. This is irreversible.',
      confirmLabel: 'Clean Up', danger: true,
      onConfirm: async () => {
        setConfirmModal(null); setIsCleaning(true);
        try {
          const { data, error } = await supabase.rpc('cleanup_orphaned_records' as any);
          if (error) throw error;
          const result = data as any;
          flash(true, `Cleaned up ${result?.tickets_cancelled ?? 0} orphaned ticket(s) and ${result?.saves_removed ?? 0} orphaned save(s).`);
        } catch (err: any) { flash(false, err?.message || 'Cleanup failed.'); } finally { setIsCleaning(false); }
      },
    });
  };

  const handleBulkSuspend = () => {
    setConfirmModal({
      title: 'Bulk Suspend Unverified', message: 'Suspend all unverified accounts with status "active"? They can be unsuspended individually.',
      confirmLabel: 'Suspend All', danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const { data: targets, error: fetchErr } = await supabase.from('users').select('id').eq('is_verified', false).eq('status', 'active').neq('id', ROOT_UID);
          if (fetchErr) throw fetchErr;
          let failed = 0;
          for (const t of targets || []) {
            const { error } = await supabase.rpc('admin_suspend_user', { p_user_id: t.id, p_banned_until: null, p_reason: 'Bulk suspend: unverified account' });
            if (error) failed++;
          }
          await writeAuditLog(currentUser, 'ROOT_bulk_suspend_unverified', null, { count: (targets || []).length, failed });
          flash(failed === 0, failed === 0 ? `${(targets || []).length} unverified account(s) suspended.` : `${failed} of ${(targets || []).length} failed — see individual admin_logs entries.`);
        } catch (err: any) { flash(false, err?.message || 'Bulk suspend failed.'); }
      },
    });
  };

  const handleBroadcast = () => {
    if (!broadcastMsg.trim()) return;
    setConfirmModal({
      title: 'Send Broadcast', message: `Send to all users: "${broadcastMsg.slice(0, 60)}${broadcastMsg.length > 60 ? '…' : ''}"?`,
      confirmLabel: 'Send', danger: false,
      onConfirm: async () => {
        setConfirmModal(null); setIsSending(true);
        try {
          const { data: recipientCount, error: broadcastErr } = await supabase.rpc('admin_broadcast', { p_title: 'Announcement from VENTS', p_body: broadcastMsg, p_type: 'promo' });
          if (broadcastErr) throw broadcastErr;
          await writeAuditLog(currentUser, 'ROOT_broadcast', null, { message: broadcastMsg, recipients: recipientCount ?? 0 });
          setBroadcastMsg('');
          flash(true, `Broadcast sent to ${recipientCount ?? 0} users.`);
        } catch (err: any) { flash(false, err?.message || 'Failed to broadcast.'); } finally { setIsSending(false); }
      },
    });
  };

  const handleHealthPing = async () => {
    setIsPinging(true); setHealthResult(null);
    const started = performance.now();
    try {
      const { data, error } = await supabase.rpc('admin_health_ping' as any);
      if (error) throw error;
      const latencyMs = Math.round(performance.now() - started);
      const result = data as any;
      setHealthResult({ ok: true, latencyMs, detail: `DB reachable · ${result?.users_reachable ?? 0} users · ${result?.events_reachable ?? 0} events` });
    } catch (err: any) {
      setHealthResult({ ok: false, latencyMs: Math.round(performance.now() - started), detail: err?.message || 'Health ping failed.' });
    } finally { setIsPinging(false); }
  };

  const toggleRow = (icon: React.ReactNode, label: string, active: boolean, desc: string, onClick: () => void, activeColor: string = adminTheme.green) => (
    <div key={label} style={{ background: adminTheme.panel, borderRadius: 16, border: `1px solid ${adminTheme.border}`, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: active ? `${activeColor}20` : adminTheme.panelAlt, display: 'flex', alignItems: 'center', justifyContent: 'center', color: active ? activeColor : adminTheme.textMuted }}>{icon}</div>
          <div>
            <p style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 600, margin: 0 }}>{label}</p>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0' }}>{desc}</p>
          </div>
        </div>
        <div onClick={onClick} style={{ cursor: 'pointer' }}>
          {active ? <ToggleRight size={32} color={activeColor} /> : <ToggleLeft size={32} color={adminTheme.textFainter} />}
        </div>
      </div>
    </div>
  );

  return (
    <div data-testid="admin-system" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ background: adminTheme.accentSoftBg, border: `1px solid ${adminTheme.accentSoftBorder}`, borderRadius: 16, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: adminTheme.accentSoftBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Zap size={20} color={adminTheme.accentFrom} /></div>
        <div>
          <h3 style={{ color: adminTheme.textStrong, fontSize: 15, fontWeight: 800, margin: 0 }}>System Controller</h3>
          <p style={{ color: adminTheme.textFaint, fontSize: 12, margin: '2px 0 0' }}>Root-level platform controls. All actions are logged.</p>
        </div>
      </div>

      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text }}>{msg}</div>}

      {toggleRow(<Wrench size={17} />, 'Maintenance Mode', maintenanceMode, maintenanceMode ? '⚠️ ACTIVE — users see maintenance notice' : 'Platform running normally',
        () => toggleAppConfig('maintenance_mode', !maintenanceMode,
          !maintenanceMode ? 'Enable Maintenance Mode' : 'Disable Maintenance Mode',
          !maintenanceMode ? 'This will display a maintenance notice to all users. Continue?' : 'This will restore normal access to all users.',
          !maintenanceMode, () => setMaintenanceMode(!maintenanceMode)), adminTheme.amber)}

      {toggleRow(<Mic size={17} />, 'Voice Notes', voiceNotesEnabled, voiceNotesEnabled ? 'Enabled — users can record voice notes' : 'Disabled for MVP launch stability',
        () => toggleAppConfig('voice_notes_enabled', !voiceNotesEnabled,
          !voiceNotesEnabled ? 'Enable Voice Notes' : 'Disable Voice Notes',
          !voiceNotesEnabled ? 'This will let all users record and send voice notes in chat again. Continue?' : 'This will hide the voice-note button and block recording for all users.',
          voiceNotesEnabled, () => setVoiceNotesEnabled(!voiceNotesEnabled)))}

      {toggleRow(<ImageIcon size={17} />, 'Image Sharing', imageSharingEnabled, imageSharingEnabled ? 'Enabled — users can send images in chat' : 'Disabled',
        () => toggleAppConfig('image_sharing_enabled', !imageSharingEnabled,
          !imageSharingEnabled ? 'Enable Image Sharing' : 'Disable Image Sharing',
          !imageSharingEnabled ? 'This will let all users send images in chat again. Continue?' : 'This will hide the image button and block sending images for all users.',
          imageSharingEnabled, () => setImageSharingEnabled(!imageSharingEnabled)))}

      <div>
        <p style={{ color: adminTheme.textStrong, fontSize: 13, fontWeight: 700, margin: '4px 0 8px' }}>Emergency Controls</p>
        <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '0 0 10px' }}>Enforced server-side — an old app version or a direct API/RPC call cannot bypass these. Disabling a financial operation only blocks NEW attempts; a payout or purchase already in progress is never corrupted.</p>
      </div>

      {KILL_SWITCHES.map((def) => {
        const disabled = !!killSwitches[def.key];
        return toggleRow(def.icon, def.label, !disabled, def.desc(disabled), () => handleToggleKillSwitch(def), adminTheme.green);
      })}

      <div style={{ background: adminTheme.panel, borderRadius: 16, border: `1px solid ${adminTheme.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: adminTheme.accentSoftBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Megaphone size={17} color={adminTheme.accentFrom} /></div>
          <div>
            <p style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 600, margin: 0 }}>Global Broadcast</p>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0' }}>Send a notification to all users</p>
          </div>
        </div>
        <textarea value={broadcastMsg} onChange={(e) => setBroadcastMsg(e.target.value)} placeholder="Type your announcement…" rows={3} style={{ background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 12, color: adminTheme.text, fontSize: 13, resize: 'none', outline: 'none' }} />
        <button onClick={handleBroadcast} disabled={isSending || !broadcastMsg.trim()} style={{ background: broadcastMsg.trim() ? adminTheme.accentSoftBg : adminTheme.panelAlt, border: `1px solid ${broadcastMsg.trim() ? adminTheme.accentSoftBorder : adminTheme.border}`, borderRadius: 12, padding: 12, color: broadcastMsg.trim() ? adminTheme.accentFrom : adminTheme.textFainter, fontSize: 14, fontWeight: 700, cursor: broadcastMsg.trim() ? 'pointer' : 'default' }}>
          {isSending ? 'Sending…' : '📡 Send Broadcast'}
        </button>
      </div>

      <div style={{ background: adminTheme.panel, borderRadius: 16, border: `1px solid ${adminTheme.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(248,113,113,.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Trash2 size={17} color={adminTheme.red} /></div>
          <div>
            <p style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 600, margin: 0 }}>Orphaned Record Cleanup</p>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0' }}>Remove dangling tickets, saves and refs</p>
          </div>
        </div>
        <button onClick={handleOrphanCleanup} disabled={isCleaning} style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.2)', borderRadius: 12, padding: 12, color: adminTheme.red, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
          {isCleaning ? 'Cleaning…' : '🧹 Run Cleanup'}
        </button>
      </div>

      <div style={{ background: adminTheme.panel, borderRadius: 16, border: `1px solid ${adminTheme.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(248,113,113,.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Swords size={17} color={adminTheme.red} /></div>
          <div>
            <p style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 600, margin: 0 }}>Bulk Actions</p>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0' }}>Platform-wide user operations</p>
          </div>
        </div>
        <button onClick={handleBulkSuspend} style={{ background: 'rgba(248,113,113,.08)', border: '1px solid rgba(248,113,113,.2)', borderRadius: 12, padding: 12, color: adminTheme.red, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
          🚫 Suspend All Unverified Accounts
        </button>
      </div>

      <div style={{ background: adminTheme.panel, borderRadius: 16, border: `1px solid ${adminTheme.border}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(52,211,153,.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Activity size={17} color={adminTheme.green} /></div>
          <div>
            <p style={{ color: adminTheme.textStrong, fontSize: 14, fontWeight: 600, margin: 0 }}>Server Health Ping</p>
            <p style={{ color: adminTheme.textFaint, fontSize: 11, margin: '2px 0 0' }}>Round-trip through auth, DB and RLS</p>
          </div>
        </div>
        <button onClick={handleHealthPing} disabled={isPinging} style={{ background: 'rgba(52,211,153,.08)', border: '1px solid rgba(52,211,153,.2)', borderRadius: 12, padding: 12, color: adminTheme.green, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
          {isPinging ? 'Pinging…' : 'Run Health Ping'}
        </button>
        {healthResult && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 10, background: healthResult.ok ? 'rgba(52,211,153,.08)' : 'rgba(248,113,113,.08)', border: `1px solid ${healthResult.ok ? 'rgba(52,211,153,.25)' : 'rgba(248,113,113,.25)'}` }}>
            <span style={{ color: healthResult.ok ? adminTheme.green : adminTheme.red, fontSize: 12, fontWeight: 700 }}>{healthResult.ok ? `Healthy — ${healthResult.latencyMs}ms` : `Unhealthy — ${healthResult.latencyMs}ms`}</span>
            <span style={{ color: adminTheme.textMuted, fontSize: 11 }}>{healthResult.detail}</span>
          </div>
        )}
      </div>

      <p style={{ color: adminTheme.textFainter, fontSize: 10, textAlign: 'center', marginTop: 4 }}>{appVersionLabel()} · All root actions are immutably logged.</p>

      {confirmModal && (
        <ConfirmModal title={confirmModal.title} message={confirmModal.message} confirmLabel={confirmModal.confirmLabel} danger={confirmModal.danger} optionalReason={confirmModal.optionalReason} reasonPlaceholder="Optional: reason for this change (visible in the audit log)" onConfirm={confirmModal.onConfirm} onCancel={() => setConfirmModal(null)} />
      )}
    </div>
  );
}
