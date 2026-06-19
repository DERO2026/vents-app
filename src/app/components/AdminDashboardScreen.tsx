import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft, Search, Shield, UserCheck, AlertCircle,
  UserX, Trash2, RefreshCw, ClipboardList, Users,
  Zap, Settings, Bell, Wrench, ToggleLeft, ToggleRight,
  Copy, CheckCircle, BadgeCheck, Megaphone, Swords, Flag,
} from 'lucide-react';
import { insforge } from '../../lib/insforge';

// ─── Constants ─────────────────────────────────────────────────────────────────
const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

// ─── Types ─────────────────────────────────────────────────────────────────────
interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  username: string | null;
  phone_number: string | null;
  state: string | null;
  status: string;
  is_verified: boolean;
  created_at: string;
  banned_until: string | null;
}

interface AuditLog {
  id: string;
  action: string;
  details: Record<string, any>;
  created_at: string;
  admin_id: string;
  target_user_id: string | null;
}

type Tab = 'users' | 'events' | 'logs' | 'reports' | 'system';

interface EventRow {
  id: string;
  title: string | null;
  organizer_id: string | null;
  hidden_by_admin: boolean;
  hidden_at: string | null;
  created_at: string;
  status: string | null;
}

// ─── Confirm Modal ─────────────────────────────────────────────────────────────
function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: '24px',
    }}>
      <div style={{
        background: '#0D0D1A', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '20px',
        padding: '28px 24px', maxWidth: '340px', width: '100%', textAlign: 'center',
      }}>
        <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <AlertCircle size={24} color="#EF4444" />
        </div>
        <h3 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, margin: '0 0 8px', fontFamily: 'Space Grotesk, sans-serif' }}>{title}</h3>
        <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.5, margin: '0 0 24px' }}>{message}</p>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onCancel} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '12px', color: '#C4C9E0', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{ flex: 1, background: danger ? 'rgba(239,68,68,0.15)' : 'rgba(168,85,247,0.15)', border: `1px solid ${danger ? 'rgba(239,68,68,0.4)' : 'rgba(168,85,247,0.4)'}`, borderRadius: '12px', padding: '12px', color: danger ? '#EF4444' : '#A855F7', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
async function writeAuditLog(adminId: string, action: string, targetUserId: string | null, details: Record<string, any>) {
  await insforge.database
    .from('admin_logs')
    .insert([{ admin_id: adminId, action, target_user_id: targetUserId, details }]);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: copied ? '#10B981' : '#555C7A', display: 'flex', alignItems: 'center' }}
      title="Copy UID"
    >
      {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
    </button>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────
export function AdminDashboardScreen({
  onBack,
  currentUser,
}: {
  onBack: () => void;
  currentUser: any;
}) {
  const isRoot = currentUser?.id === ROOT_UID;
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);
  const [reports, setReports] = useState<any[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // System Controller state
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);

  // Vents Cents credit state
  const [creditTargetId, setCreditTargetId] = useState('');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditReason, setCreditReason] = useState('');
  const [isCreditSending, setIsCreditSending] = useState(false);
  const [confirmModal, setConfirmModal] = useState<null | {
    title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void;
  }>(null);

  // ── Load users ───────────────────────────────────────────────────────────────
  const loadUsers = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      let q = insforge.database
        .from('users')
        .select('id, email, full_name, role, username, phone_number, state, status, is_verified, created_at')
        .order('created_at', { ascending: false });

      if (searchQuery.trim()) {
        const like = `%${searchQuery.trim().toLowerCase()}%`;
        q = q.or(`full_name.ilike.${like},username.ilike.${like},email.ilike.${like}`);
      }

      const { data, error } = await q;
      if (error) throw error;
      setUsers(data || []);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  // ── Load audit logs ──────────────────────────────────────────────────────────
  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const { data, error } = await insforge.database
        .from('admin_logs')
        .select('id, action, details, created_at, admin_id, target_user_id')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      setLogs(data || []);
    } catch { /* silently fail */ }
    finally { setLogsLoading(false); }
  }, []);

  // ── Load app_config for maintenance mode ─────────────────────────────────────
  const loadConfig = useCallback(async () => {
    try {
      const { data } = await insforge.database.from('app_config').select('maintenance_mode').single();
      if (data) setMaintenanceMode(data.maintenance_mode);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (currentUser?.role !== 'admin' && !isRoot) return;
    loadUsers();
    if (isRoot) loadConfig();
  }, [loadUsers, currentUser, isRoot, loadConfig]);

  useEffect(() => {
    if ((currentUser?.role !== 'admin' && !isRoot) || tab !== 'logs') return;
    loadLogs();
  }, [tab, loadLogs, currentUser, isRoot]);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const { data, error } = await insforge.database
        .from('events')
        .select('id, title, organizer_id, hidden_by_admin, hidden_at, created_at, status')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      setEvents(data || []);
    } catch (err: any) {
      flash(false, err?.message || 'Failed to load events.');
    } finally { setEventsLoading(false); }
  }, []);

  useEffect(() => {
    if ((currentUser?.role !== 'admin' && !isRoot) || tab !== 'events') return;
    loadEvents();
  }, [tab, loadEvents, currentUser, isRoot]);

  useEffect(() => {
    if ((currentUser?.role !== 'admin' && !isRoot) || tab !== 'reports') return;
    setReportsLoading(true);
    insforge.database
      .from('reports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data, error }) => {
        if (!error) setReports(data || []);
        setReportsLoading(false);
      });
  }, [tab, currentUser, isRoot]);

  const handleUpdateReport = async (id: string, status: string) => {
    const { error } = await insforge.database.from('reports').update({ status }).eq('id', id);
    if (!error) setReports(prev => prev.map(r => r.id === id ? { ...r, status } : r));
  };

  const handleHideEvent = async (eventId: string) => {
    try {
      const { error } = await insforge.database.rpc('admin_hide_event', { p_event_id: eventId });
      if (error) throw error;
      setEvents(prev => prev.map(e => e.id === eventId ? { ...e, hidden_by_admin: true, hidden_at: new Date().toISOString() } : e));
      flash(true, 'Event hidden from public feeds.');
    } catch (err: any) { flash(false, err?.message || 'Failed to hide event.'); }
  };

  const handleReinstateEvent = async (eventId: string) => {
    try {
      const { error } = await insforge.database.rpc('admin_reinstate_event', { p_event_id: eventId });
      if (error) throw error;
      setEvents(prev => prev.map(e => e.id === eventId ? { ...e, hidden_by_admin: false, hidden_at: null } : e));
      flash(true, 'Event reinstated.');
    } catch (err: any) { flash(false, err?.message || 'Failed to reinstate event.'); }
  };

  // ── Flash ────────────────────────────────────────────────────────────────────
  const flash = (ok: boolean, msg: string) => {
    if (ok) setSuccessMessage(msg); else setErrorMessage(msg);
    setTimeout(() => { setSuccessMessage(null); setErrorMessage(null); }, 3500);
  };

  // ── User actions ─────────────────────────────────────────────────────────────
  const handleRoleChange = async (userId: string, newRole: string) => {
    if (userId === ROOT_UID) { flash(false, 'Root admin role cannot be changed.'); return; }
    if (!['attendee', 'organizer'].includes(newRole)) { flash(false, 'Invalid role.'); return; }
    setBusyId(userId);
    try {
      const { error } = await insforge.database.rpc('admin_set_user_role', { p_user_id: userId, p_new_role: newRole });
      if (error) throw error;
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u));
      flash(true, 'Role updated.');
    } catch (err: any) {
      flash(false, err?.message || 'Failed to update role.');
    } finally { setBusyId(null); }
  };

  // banDays: number of days, or null for permanent
  const handleSuspend = async (u: UserRow, banDays: number | null = null) => {
    if (u.status === 'suspended') {
      // Unban
      setBusyId(u.id);
      try {
        const { error } = await insforge.database.from('users').update({ status: 'active', banned_until: null }).eq('id', u.id);
        if (error) throw error;
        await writeAuditLog(currentUser.id, 'unsuspend_user', u.id, { target_email: u.email });
        setUsers(prev => prev.map(x => x.id === u.id ? { ...x, status: 'active', banned_until: null } : x));
        flash(true, 'User reactivated.');
      } catch (err: any) {
        flash(false, err?.message || 'Failed to unban.');
      } finally { setBusyId(null); }
      return;
    }
    // Ban
    const bannedUntil = banDays ? new Date(Date.now() + banDays * 86400000).toISOString() : null;
    setBusyId(u.id);
    try {
      const { error } = await insforge.database.from('users').update({ status: 'suspended', banned_until: bannedUntil }).eq('id', u.id);
      if (error) throw error;
      await writeAuditLog(currentUser.id, 'suspend_user', u.id, { target_email: u.email, ban_days: banDays ?? 'permanent', banned_until: bannedUntil });
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, status: 'suspended', banned_until: bannedUntil } : x));
      flash(true, banDays ? `Banned for ${banDays} day(s).` : 'Permanently banned.');
    } catch (err: any) {
      flash(false, err?.message || 'Failed to ban.');
    } finally { setBusyId(null); }
  };

  const handleSoftDelete = (u: UserRow) => {
    setConfirmModal({
      title: 'Delete Account',
      message: `Soft-delete @${u.username || u.email}? They will be blocked from login. You can reinstate them later.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        setBusyId(u.id);
        try {
          const { error } = await insforge.database.from('users').update({ status: 'deleted' }).eq('id', u.id);
          if (error) throw error;
          await writeAuditLog(currentUser.id, 'delete_user', u.id, { target_email: u.email });
          setUsers(prev => prev.map(x => x.id === u.id ? { ...x, status: 'deleted' } : x));
          flash(true, 'User deleted. Use Reinstate to restore.');
        } catch (err: any) {
          flash(false, err?.message || 'Failed to delete user.');
        } finally { setBusyId(null); }
      },
    });
  };

  const handleReinstate = async (u: UserRow) => {
    setBusyId(u.id);
    try {
      const { error } = await insforge.database.from('users').update({ status: 'active', banned_until: null }).eq('id', u.id);
      if (error) throw error;
      await writeAuditLog(currentUser.id, 'reinstate_user', u.id, { target_email: u.email, previous_status: u.status });
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, status: 'active', banned_until: null } : x));
      flash(true, 'User reinstated.');
    } catch (err: any) {
      flash(false, err?.message || 'Failed to reinstate user.');
    } finally { setBusyId(null); }
  };

  const handleToggleVerify = async (u: UserRow) => {
    const newVerified = !u.is_verified;
    setBusyId(u.id);
    try {
      const { error } = await insforge.database.from('users').update({ is_verified: newVerified }).eq('id', u.id);
      if (error) throw error;
      await writeAuditLog(currentUser.id, 'toggle_verification', u.id, { is_verified: newVerified, target_email: u.email });
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, is_verified: newVerified } : x));
      flash(true, `User ${newVerified ? 'verified ✓' : 'unverified'}.`);
    } catch (err: any) {
      flash(false, err?.message || 'Failed to update verification.');
    } finally { setBusyId(null); }
  };

  // ── System Controller actions (ROOT only) ─────────────────────────────────────
  const handleToggleMaintenance = () => {
    const next = !maintenanceMode;
    setConfirmModal({
      title: next ? 'Enable Maintenance Mode' : 'Disable Maintenance Mode',
      message: next
        ? 'This will display a maintenance notice to all users. Continue?'
        : 'This will restore normal access to all users.',
      confirmLabel: next ? 'Enable' : 'Disable',
      danger: next,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await insforge.database.from('app_config').update({ maintenance_mode: next, updated_by: currentUser.id }).eq('id', true);
          await writeAuditLog(currentUser.id, next ? 'ROOT_maintenance_on' : 'ROOT_maintenance_off', null, {});
          setMaintenanceMode(next);
          flash(true, `Maintenance mode ${next ? 'enabled' : 'disabled'}.`);
        } catch (err: any) { flash(false, err?.message || 'Failed to update maintenance mode.'); }
      },
    });
  };

  const handleBroadcast = () => {
    if (!broadcastMsg.trim()) return;
    setConfirmModal({
      title: 'Send Broadcast',
      message: `Send to all users: "${broadcastMsg.slice(0, 60)}${broadcastMsg.length > 60 ? '…' : ''}"?`,
      confirmLabel: 'Send',
      danger: false,
      onConfirm: async () => {
        setConfirmModal(null);
        setIsSending(true);
        try {
          const { data: recipientCount, error: broadcastErr } = await insforge.database
            .rpc('admin_broadcast', { p_title: 'Announcement from VENTS', p_body: broadcastMsg, p_type: 'promo' });
          if (broadcastErr) throw broadcastErr;
          const allUsers = { length: recipientCount ?? 0 };
          await writeAuditLog(currentUser.id, 'ROOT_broadcast', null, { message: broadcastMsg, recipients: allUsers?.length ?? 0 });
          setBroadcastMsg('');
          flash(true, `Broadcast sent to ${allUsers?.length ?? 0} users.`);
        } catch (err: any) { console.error('Broadcast error:', JSON.stringify(err), err?.message, err?.code, err?.details); flash(false, err?.message || 'Failed to broadcast.'); }
        finally { setIsSending(false); }
      },
    });
  };

  const handleOrphanCleanup = () => {
    setConfirmModal({
      title: 'Orphaned Record Cleanup',
      message: 'This will soft-delete tickets and saves for non-existent events. This is irreversible.',
      confirmLabel: 'Clean Up',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        setIsCleaning(true);
        try {
          // Remove saved_events where event no longer exists
          await insforge.database.rpc('cleanup_orphaned_records' as any);
          await writeAuditLog(currentUser.id, 'ROOT_orphan_cleanup', null, { triggered_at: new Date().toISOString() });
          flash(true, 'Orphaned records cleaned.');
        } catch {
          flash(false, 'Cleanup function not found — run the SQL cleanup migration first.');
        } finally { setIsCleaning(false); }
      },
    });
  };

  const handleBulkSuspend = () => {
    setConfirmModal({
      title: 'Bulk Suspend Unverified',
      message: 'Suspend all unverified accounts with status "active"? They can be unsuspended individually.',
      confirmLabel: 'Suspend All',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const { error } = await insforge.database.from('users')
            .update({ status: 'suspended' })
            .eq('is_verified', false)
            .eq('status', 'active')
            .neq('id', ROOT_UID);
          if (error) throw error;
          await writeAuditLog(currentUser.id, 'ROOT_bulk_suspend_unverified', null, {});
          flash(true, 'Unverified accounts suspended.');
          loadUsers();
        } catch (err: any) { flash(false, err?.message || 'Bulk suspend failed.'); }
      },
    });
  };

  const handleCreditVentsCents = async () => {
    const amount = parseInt(creditAmount, 10);
    if (!creditTargetId.trim()) { flash(false, 'Enter a target user ID.'); return; }
    if (!amount || amount <= 0) { flash(false, 'Amount must be a positive number.'); return; }
    const reason = creditReason.trim() || 'Admin credit';
    setIsCreditSending(true);
    try {
      const { data, error } = await insforge.database.rpc('admin_credit_vents_cents' as any, {
        p_target_user_id: creditTargetId.trim(),
        p_amount: amount,
        p_reason: reason,
      });
      if (error) throw error;
      await writeAuditLog(currentUser.id, 'ROOT_credit_vents_cents', creditTargetId.trim(), { amount, reason });
      setCreditTargetId('');
      setCreditAmount('');
      setCreditReason('');
      flash(true, `Credited ${amount} Vents Cents. New balance: ${(data as any)?.new_target_balance ?? '?'}`);
    } catch (err: any) { flash(false, err?.message || 'Credit failed.'); }
    finally { setIsCreditSending(false); }
  };

  // ── Access guard ─────────────────────────────────────────────────────────────
  if (currentUser?.role !== 'admin' && !isRoot) {
    return (
      <div style={{ background: '#000000', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
        <Shield size={48} color="#EF4444" style={{ marginBottom: '16px' }} />
        <h2 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800 }}>Access Denied</h2>
        <p style={{ color: '#8B8FA8', fontSize: '14px', marginTop: '8px' }}>
          You do not have permission to view the Admin Dashboard.
        </p>
        <button onClick={onBack} style={{ marginTop: '24px', background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.4)', borderRadius: '12px', padding: '12px 24px', color: '#A855F7', fontWeight: 600, cursor: 'pointer', boxShadow: '0 0 20px rgba(168,85,247,0.3)' }}>
          Go Back
        </button>
      </div>
    );
  }

  // ── Colour helpers ────────────────────────────────────────────────────────────
  const roleBg = (role: string) => ({
    admin: { text: '#EF4444', bg: 'rgba(239,68,68,0.1)' },
    organizer: { text: '#A78BFA', bg: 'rgba(167,139,250,0.1)' },
    attendee: { text: '#60A5FA', bg: 'rgba(96,165,250,0.1)' },
  }[role] ?? { text: '#10B981', bg: 'rgba(16,185,129,0.1)' });

  const statusColour = (status: string) =>
    status === 'active' ? '#10B981' : status === 'suspended' ? '#F59E0B' : '#EF4444';

  const tabs = [
    { key: 'users' as Tab, label: 'Users', icon: <Users size={14} /> },
    { key: 'events' as Tab, label: 'Events', icon: <Shield size={14} /> },
    { key: 'logs' as Tab, label: 'Audit Log', icon: <ClipboardList size={14} /> },
    { key: 'reports' as Tab, label: 'Reports', icon: <Flag size={14} /> },
    ...(isRoot ? [{ key: 'system' as Tab, label: 'System', icon: <Zap size={14} /> }] : []),
  ];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: '#000000', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif' }}>

      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          danger={confirmModal.danger}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 20px 14px', borderBottom: '1px solid rgba(168,85,247,0.1)', background: '#000000', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div style={{ flex: 1 }}>
          <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
            Admin Console
            {isRoot && <span style={{ marginLeft: '8px', fontSize: '11px', color: '#A855F7', background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)', padding: '2px 8px', borderRadius: '6px', fontWeight: 700 }}>ROOT</span>}
          </h1>
          <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>Secure user management & audit trail</p>
        </div>
        <Shield size={20} color={isRoot ? '#A855F7' : '#6B7280'} style={{ filter: isRoot ? 'drop-shadow(0 0 8px rgba(168,85,247,0.6))' : 'none' }} />
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.04)', flexShrink: 0 }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              padding: '12px', background: 'none', border: 'none', cursor: 'pointer',
              color: tab === t.key ? (t.key === 'system' ? '#A855F7' : '#A78BFA') : '#8B8FA8',
              fontSize: '13px', fontWeight: 600,
              borderBottom: tab === t.key ? `2px solid ${t.key === 'system' ? '#A855F7' : '#A78BFA'}` : '2px solid transparent',
              transition: 'all 0.2s',
            }}
          >
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* ── Flash messages ────────────────────────────────────────────────── */}
      {(errorMessage || successMessage) && (
        <div style={{ padding: '8px 20px', flexShrink: 0 }}>
          {errorMessage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '10px 12px', color: '#EF4444', fontSize: '12px' }}>
              <AlertCircle size={14} /><span>{errorMessage}</span>
            </div>
          )}
          {successMessage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '10px', padding: '10px 12px', color: '#10B981', fontSize: '12px' }}>
              <UserCheck size={14} /><span>{successMessage}</span>
            </div>
          )}
        </div>
      )}

      {/* ════════════════ USERS TAB ════════════════════════════════════════ */}
      {tab === 'users' && (
        <>
          {/* Search row */}
          <div style={{ padding: '12px 20px 6px', flexShrink: 0, display: 'flex', gap: '8px' }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: '#0D0D1A', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)', padding: '10px 14px', gap: '10px' }}>
              <Search size={15} color="#8B8FA8" />
              <input
                type="text"
                placeholder="Search name, username, or email…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && loadUsers()}
                style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '13px' }}
              />
            </div>
            <button onClick={loadUsers} style={{ background: '#0D0D1A', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '14px', padding: '0 14px', color: '#8B8FA8', cursor: 'pointer' }}>
              <RefreshCw size={15} />
            </button>
          </div>

          {/* User list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 20px 40px' }}>
            {loading ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading users…</div>
            ) : users.length === 0 ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>No users found.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {users.map(u => {
                  const rc = roleBg(u.role);
                  const isBusy = busyId === u.id;
                  const isRootUser = u.id === ROOT_UID;
                  return (
                    <div key={u.id} style={{ background: '#0D0D1A', borderRadius: '16px', border: `1px solid ${isRootUser ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)'}`, padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px', opacity: isBusy ? 0.6 : 1, transition: 'opacity 0.2s' }}>

                      {/* Row: Name + badges */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <h4 style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, margin: 0 }}>
                              {u.full_name || 'No Name'}
                            </h4>
                            {u.is_verified && (
                              <BadgeCheck size={14} color="#3B82F6" title="Verified" />
                            )}
                            {isRootUser && (
                              <span style={{ fontSize: '9px', color: '#A855F7', background: 'rgba(168,85,247,0.12)', border: '1px solid rgba(168,85,247,0.3)', padding: '1px 5px', borderRadius: '4px', fontWeight: 700 }}>ROOT</span>
                            )}
                          </div>
                          <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '2px 0 0' }}>@{u.username || 'no_username'}</p>
                          <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>{u.email}</p>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                          <span style={{ fontSize: '10px', color: rc.text, background: rc.bg, padding: '3px 8px', borderRadius: '6px', fontWeight: 700 }}>
                            {u.role.toUpperCase()}
                          </span>
                          <span style={{ fontSize: '10px', color: statusColour(u.status), fontWeight: 600 }}>
                            ● {u.status}
                          </span>
                        </div>
                      </div>

                      {/* Row: UID + extra meta */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', padding: '6px 10px' }}>
                        <span style={{ color: '#555C7A', fontSize: '10px', fontFamily: 'monospace', flex: 1 }}>
                          {u.id}
                        </span>
                        <CopyButton text={u.id} />
                      </div>

                      {/* Row: dates + verified status */}
                      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                        <span style={{ color: '#8B8FA8', fontSize: '11px' }}>
                          📅 {new Date(u.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
                        </span>
                        <span style={{ color: u.is_verified ? '#3B82F6' : '#6B7280', fontSize: '11px' }}>
                          {u.is_verified ? '✓ Email Verified' : '✗ Unverified'}
                        </span>
                        <span style={{ color: '#8B8FA8', fontSize: '11px' }}>
                          {u.state || 'No state'}
                        </span>
                      </div>

                      {/* Actions row */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: '10px' }}>
                        <select
                          value={u.role}
                          onChange={e => handleRoleChange(u.id, e.target.value)}
                          disabled={isBusy || isRootUser}
                          style={{ background: '#060A12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#F0F0FF', fontSize: '11px', padding: '4px 8px', outline: 'none', cursor: 'pointer' }}
                        >
                          <option value="user">User</option>
                          <option value="attendee">Attendee</option>
                          <option value="organizer">Organizer</option>
                          <option value="admin">Admin</option>
                        </select>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {/* Verify toggle */}
                          <button
                            onClick={() => handleToggleVerify(u)}
                            disabled={isBusy || isRootUser}
                            title={u.is_verified ? 'Remove verification' : 'Verify account'}
                            style={{ background: u.is_verified ? 'rgba(59,130,246,0.12)' : 'rgba(107,114,128,0.12)', border: `1px solid ${u.is_verified ? 'rgba(59,130,246,0.3)' : 'rgba(107,114,128,0.3)'}`, borderRadius: '8px', padding: '5px 8px', color: u.is_verified ? '#3B82F6' : '#6B7280', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                          >
                            <BadgeCheck size={13} />
                          </button>

                          {/* Ban / Unban / Reinstate */}
                          {u.status === 'deleted' ? (
                            <button
                              onClick={() => handleReinstate(u)}
                              disabled={isBusy || isRootUser}
                              title="Reinstate deleted account"
                              style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', padding: '5px 8px', color: '#10B981', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', fontWeight: 600 }}
                            >
                              <UserCheck size={13} /> Reinstate
                            </button>
                          ) : u.status === 'suspended' ? (
                            <button
                              onClick={() => handleSuspend(u)}
                              disabled={isBusy || isRootUser}
                              title={u.banned_until ? `Banned until ${new Date(u.banned_until).toLocaleDateString()}` : 'Permanently banned — click to unban'}
                              style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', padding: '5px 8px', color: '#10B981', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                            >
                              <UserCheck size={13} />
                            </button>
                          ) : (
                            <select
                              disabled={isBusy || isRootUser}
                              defaultValue=""
                              onChange={(e) => {
                                const val = e.target.value;
                                if (!val) return;
                                e.target.value = '';
                                handleSuspend(u, val === 'permanent' ? null : Number(val));
                              }}
                              style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '8px', color: '#F59E0B', fontSize: '11px', padding: '4px 6px', cursor: 'pointer', outline: 'none' }}
                            >
                              <option value="" disabled>🚫 Ban</option>
                              <option value="1">1 day</option>
                              <option value="7">7 days</option>
                              <option value="30">30 days</option>
                              <option value="permanent">Permanent</option>
                            </select>
                          )}

                          {/* Delete */}
                          <button
                            onClick={() => handleSoftDelete(u)}
                            disabled={isBusy || u.id === currentUser?.id || isRootUser}
                            title="Delete account"
                            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', padding: '5px 8px', color: '#EF4444', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* ════════════════ EVENTS TAB ══════════════════════════════════════ */}
      {tab === 'events' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 40px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <span style={{ color: '#8B8FA8', fontSize: '13px' }}>{events.length} events loaded</span>
            <button onClick={loadEvents} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#A78BFA', fontSize: '12px' }}>Refresh</button>
          </div>
          {eventsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading events…</div>
          ) : events.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>No events found.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {events.map(ev => (
                <div key={ev.id} style={{ background: '#0D0D1A', borderRadius: '14px', border: `1px solid ${ev.hidden_by_admin ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.04)'}`, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ color: ev.hidden_by_admin ? '#EF4444' : '#F0F0FF', fontSize: '13px', fontWeight: 600, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ev.title || '(Untitled)'}
                    </span>
                    <span style={{ color: '#555C7A', fontSize: '11px' }}>
                      {ev.hidden_by_admin ? '🚫 Hidden' : '✅ Visible'} · {new Date(ev.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={() => ev.hidden_by_admin ? handleReinstateEvent(ev.id) : setConfirmModal({ title: 'Hide Event?', message: `Hide "${ev.title || 'this event'}" from all public feeds? You can reinstate it later.`, confirmLabel: 'Hide', danger: true, onConfirm: () => { setConfirmModal(null); handleHideEvent(ev.id); } })}
                    style={{ background: ev.hidden_by_admin ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${ev.hidden_by_admin ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`, borderRadius: '10px', padding: '6px 12px', color: ev.hidden_by_admin ? '#10B981' : '#EF4444', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
                  >
                    {ev.hidden_by_admin ? 'Reinstate' : 'Hide'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ════════════════ AUDIT LOG TAB ════════════════════════════════════ */}
      {tab === 'logs' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 40px' }}>
          {logsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading audit log…</div>
          ) : logs.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>No audit entries yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {logs.map(log => {
                const isRootAction = log.action.startsWith('ROOT_');
                const actionColor = isRootAction ? '#A855F7' : log.action.startsWith('delete') ? '#EF4444' : log.action.startsWith('suspend') ? '#F59E0B' : '#A78BFA';
                return (
                  <div key={log.id} style={{ background: '#0D0D1A', borderRadius: '14px', border: `1px solid ${isRootAction ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.04)'}`, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: actionColor, background: `${actionColor}18`, padding: '2px 8px', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {isRootAction && <Zap size={10} />}
                        {log.action.replace(/_/g, ' ')}
                      </span>
                      <span style={{ color: '#8B8FA8', fontSize: '10px' }}>
                        {new Date(log.created_at).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' })}
                      </span>
                    </div>
                    {Object.keys(log.details).length > 0 && (
                      <p style={{ color: '#8B8FA8', fontSize: '11px', margin: 0, wordBreak: 'break-all' }}>
                        {Object.entries(log.details).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                      </p>
                    )}
                    <p style={{ color: '#555C7A', fontSize: '10px', margin: 0 }}>
                      Target: {log.target_user_id || '—'} · Admin: {log.admin_id?.slice(0, 8)}…
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ════════════════ REPORTS TAB ══════════════════════════════════════ */}
      {tab === 'reports' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 40px' }}>
          {reportsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading reports…</div>
          ) : reports.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>No reports yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {reports.map(r => {
                const statusColor = r.status === 'pending' ? '#F59E0B' : r.status === 'actioned' ? '#EF4444' : r.status === 'dismissed' ? '#6B7280' : '#10B981';
                return (
                  <div key={r.id} style={{ background: '#0D0D1A', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)', padding: '12px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                      <div>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: statusColor, background: `${statusColor}20`, padding: '2px 8px', borderRadius: '6px' }}>{r.status}</span>
                        <span style={{ fontSize: '11px', color: '#A78BFA', marginLeft: '8px', background: 'rgba(167,139,250,0.12)', padding: '2px 8px', borderRadius: '6px' }}>{r.target_type}</span>
                      </div>
                      <span style={{ color: '#555C7A', fontSize: '10px' }}>{new Date(r.created_at).toLocaleDateString()}</span>
                    </div>
                    <p style={{ color: '#C4C9E0', fontSize: '13px', fontWeight: 600, margin: '0 0 4px' }}>{r.reason}</p>
                    {r.details && <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '0 0 6px' }}>{r.details}</p>}
                    <p style={{ color: '#555C7A', fontSize: '10px', margin: '0 0 10px' }}>
                      Target: {r.target_id?.slice(0, 8)}… · Reporter: {r.reporter_id?.slice(0, 8)}…
                    </p>
                    {r.status === 'pending' && (
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={() => handleUpdateReport(r.id, 'actioned')} style={{ flex: 1, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '8px', color: '#EF4444', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Action</button>
                        <button onClick={() => handleUpdateReport(r.id, 'dismissed')} style={{ flex: 1, background: 'rgba(107,114,128,0.1)', border: '1px solid rgba(107,114,128,0.3)', borderRadius: '10px', padding: '8px', color: '#9CA3AF', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>Dismiss</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ════════════════ SYSTEM CONTROLLER TAB (ROOT ONLY) ═══════════════ */}
      {tab === 'system' && isRoot && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Header */}
          <div style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.2)', borderRadius: '16px', padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'rgba(168,85,247,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 0 20px rgba(168,85,247,0.3)' }}>
              <Zap size={20} color="#A855F7" />
            </div>
            <div>
              <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, margin: 0, fontFamily: 'Space Grotesk, sans-serif' }}>System Controller</h3>
              <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '2px 0 0' }}>Root-level platform controls. All actions are logged.</p>
            </div>
          </div>

          {/* Maintenance Mode */}
          <div style={{ background: '#0D0D1A', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: maintenanceMode ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Wrench size={17} color={maintenanceMode ? '#F59E0B' : '#C4C9E0'} />
                </div>
                <div>
                  <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Maintenance Mode</p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                    {maintenanceMode ? '⚠️ ACTIVE — users see maintenance notice' : 'Platform running normally'}
                  </p>
                </div>
              </div>
              <div
                onClick={handleToggleMaintenance}
                style={{ cursor: 'pointer' }}
              >
                {maintenanceMode
                  ? <ToggleRight size={32} color="#F59E0B" />
                  : <ToggleLeft size={32} color="#555C7A" />}
              </div>
            </div>
          </div>

          {/* Global Broadcast */}
          <div style={{ background: '#0D0D1A', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(168,85,247,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Megaphone size={17} color="#A855F7" />
              </div>
              <div>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Global Broadcast</p>
                <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>Send a notification to all users</p>
              </div>
            </div>
            <textarea
              value={broadcastMsg}
              onChange={e => setBroadcastMsg(e.target.value)}
              placeholder="Type your announcement…"
              rows={3}
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px', color: '#F0F0FF', fontSize: '13px', resize: 'none', outline: 'none', fontFamily: 'Inter, sans-serif' }}
            />
            <button
              onClick={handleBroadcast}
              disabled={isSending || !broadcastMsg.trim()}
              style={{ background: broadcastMsg.trim() ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.03)', border: `1px solid ${broadcastMsg.trim() ? 'rgba(168,85,247,0.4)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '12px', padding: '12px', color: broadcastMsg.trim() ? '#A855F7' : '#555C7A', fontSize: '14px', fontWeight: 700, cursor: broadcastMsg.trim() ? 'pointer' : 'default', boxShadow: broadcastMsg.trim() ? '0 0 16px rgba(168,85,247,0.2)' : 'none' }}
            >
              {isSending ? 'Sending…' : '📡 Send Broadcast'}
            </button>
          </div>

          {/* Vents Cents Credit */}
          <div style={{ background: '#0D0D1A', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Zap size={17} color="#10B981" />
              </div>
              <div>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Credit Vents Cents</p>
                <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>Manually credit Vents Cents to a user (non-withdrawable)</p>
              </div>
            </div>
            <input
              value={creditTargetId}
              onChange={e => setCreditTargetId(e.target.value)}
              placeholder="Target User ID (UUID)"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', fontFamily: 'monospace' }}
            />
            <input
              value={creditAmount}
              onChange={e => setCreditAmount(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="Amount (e.g. 500)"
              inputMode="numeric"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
            />
            <input
              value={creditReason}
              onChange={e => setCreditReason(e.target.value)}
              placeholder="Reason (optional)"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
            />
            <button
              onClick={handleCreditVentsCents}
              disabled={isCreditSending || !creditTargetId.trim() || !creditAmount}
              style={{
                background: (creditTargetId.trim() && creditAmount) ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${(creditTargetId.trim() && creditAmount) ? 'rgba(16,185,129,0.4)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: '12px', padding: '12px',
                color: (creditTargetId.trim() && creditAmount) ? '#10B981' : '#555C7A',
                fontSize: '14px', fontWeight: 700, cursor: (creditTargetId.trim() && creditAmount) ? 'pointer' : 'default',
              }}
            >
              {isCreditSending ? 'Crediting…' : '💰 Credit Vents Cents'}
            </button>
          </div>

          {/* Orphaned Record Cleanup */}
          <div style={{ background: '#0D0D1A', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Trash2 size={17} color="#EF4444" />
              </div>
              <div>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Orphaned Record Cleanup</p>
                <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>Remove dangling tickets, saves and refs</p>
              </div>
            </div>
            <button
              onClick={handleOrphanCleanup}
              disabled={isCleaning}
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '12px', padding: '12px', color: '#EF4444', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}
            >
              {isCleaning ? 'Cleaning…' : '🧹 Run Cleanup'}
            </button>
          </div>

          {/* Bulk Actions */}
          <div style={{ background: '#0D0D1A', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Swords size={17} color="#EF4444" />
              </div>
              <div>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Bulk Actions</p>
                <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>Platform-wide user operations</p>
              </div>
            </div>
            <button
              onClick={handleBulkSuspend}
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '12px', padding: '12px', color: '#EF4444', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}
            >
              🚫 Suspend All Unverified Accounts
            </button>
          </div>

          {/* Footer */}
          <p style={{ color: '#333', fontSize: '10px', textAlign: 'center', marginTop: '4px' }}>
            VENTS v1.1.0 | © VENTS LTD · All root actions are immutably logged.
          </p>
        </div>
      )}
    </div>
  );
}
