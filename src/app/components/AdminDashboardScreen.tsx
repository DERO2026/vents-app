import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft, Search, Shield, UserCheck, AlertCircle,
  UserX, Trash2, RefreshCw, ClipboardList, Users,
  Zap, Settings, Bell, Wrench, ToggleLeft, ToggleRight,
  Copy, CheckCircle, BadgeCheck, Megaphone, Swords, Flag, Wallet,
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

type Tab = 'users' | 'events' | 'logs' | 'reports' | 'vc' | 'stats' | 'verify' | 'payouts' | 'system' | 'org-requests';

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

// ─── Payouts tab ───────────────────────────────────────────────────────────────
function PayoutsTab() {
  const [requests, setRequests] = useState<any[]>([]);
  const [wallets, setWallets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'all'>('pending');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'requests' | 'wallets'>('requests');

  const load = async () => {
    setLoading(true);
    let q = insforge.database
      .from('organizer_withdrawal_requests')
      .select('id, organizer_id, amount_kobo, status, created_at, updated_at, admin_note, organizer_bank_accounts(bank_name, account_number, account_name), users!organizer_withdrawal_requests_organizer_id_fkey(username, full_name, email)')
      .order('created_at', { ascending: false })
      .limit(50);
    if (statusFilter === 'pending') q = q.eq('status', 'pending');
    const [{ data: reqs }, { data: walsRaw }] = await Promise.all([
      q,
      insforge.database
        .from('organizer_wallets')
        .select('organizer_id, balance_kobo, total_earned_kobo, total_withdrawn_kobo')
        .order('balance_kobo', { ascending: false })
        .limit(100),
    ]);
    // organizer_wallets FK points to auth.users — PostgREST can't embed it.
    // Look up usernames from public.users separately.
    let wals = walsRaw || [];
    if (wals.length > 0) {
      const ids = wals.map((w: any) => w.organizer_id);
      const { data: userRows } = await insforge.database
        .from('users')
        .select('id, username, full_name')
        .in('id', ids);
      const userMap: Record<string, any> = {};
      (userRows || []).forEach((u: any) => { userMap[u.id] = u; });
      wals = wals.map((w: any) => ({ ...w, users: userMap[w.organizer_id] || null }));
    }
    setRequests(reqs || []);
    setWallets(wals);
    setLoading(false);
  };

  useEffect(() => { load(); }, [statusFilter]);

  const handleUpdateStatus = async (id: string, status: 'approved' | 'rejected' | 'paid', note?: string) => {
    setActionLoading(id);
    try {
      await insforge.database
        .from('organizer_withdrawal_requests')
        .update({ status, admin_note: note || null, updated_at: new Date().toISOString() })
        .eq('id', id);
      await load();
    } catch (e: any) {
      alert(e.message || 'Action failed');
    } finally {
      setActionLoading(null);
    }
  };

  const fmt = (kobo: number) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

  const statusColor: Record<string, string> = {
    pending: '#F59E0B', approved: '#60A5FA', paid: '#10B981', rejected: '#EF4444',
  };

  const totalPending = requests.filter(r => r.status === 'pending').reduce((s: number, r: any) => s + r.amount_kobo, 0);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 40px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Total pending banner */}
      {totalPending > 0 && (
        <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '4px' }}>
          <p style={{ margin: 0, fontSize: '12px', color: '#F59E0B' }}>Total pending payout</p>
          <p style={{ margin: '2px 0 0', fontSize: '20px', fontWeight: 800, color: '#F59E0B' }}>{fmt(totalPending)}</p>
        </div>
      )}

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
        {(['requests', 'wallets'] as const).map(s => (
          <button key={s} onClick={() => setActiveSection(s)}
            style={{ padding: '6px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '12px', background: activeSection === s ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)', color: activeSection === s ? '#A855F7' : '#8B8FA8' }}>
            {s === 'requests' ? 'Requests' : 'All Wallets'}
          </button>
        ))}
        {activeSection === 'requests' && (
          <>
            {(['pending', 'all'] as const).map(f => (
              <button key={f} onClick={() => setStatusFilter(f)}
                style={{ padding: '6px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '12px', background: statusFilter === f ? 'rgba(96,165,250,0.15)' : 'rgba(255,255,255,0.03)', color: statusFilter === f ? '#60A5FA' : '#6B7280' }}>
                {f === 'pending' ? 'Pending' : 'All'}
              </button>
            ))}
          </>
        )}
      </div>

      {loading ? (
        <p style={{ color: '#8B8FA8', fontSize: '13px' }}>Loading…</p>
      ) : activeSection === 'wallets' ? (
        wallets.length === 0 ? (
          <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', padding: '24px 0' }}>No organizer wallets yet</p>
        ) : (
          wallets.map((w: any) => {
            const u = w.users;
            return (
              <div key={w.organizer_id} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '14px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#F0F0FF' }}>{u?.username || u?.full_name || w.organizer_id.slice(0, 8)}</p>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', color: '#A78BFA' }}>Balance: <strong>{fmt(w.balance_kobo)}</strong></span>
                  <span style={{ fontSize: '12px', color: '#8B8FA8' }}>Earned: {fmt(w.total_earned_kobo)}</span>
                  <span style={{ fontSize: '12px', color: '#8B8FA8' }}>Withdrawn: {fmt(w.total_withdrawn_kobo ?? 0)}</span>
                </div>
              </div>
            );
          })
        )
      ) : requests.length === 0 ? (
        <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', padding: '24px 0' }}>No {statusFilter === 'pending' ? 'pending ' : ''}withdrawal requests</p>
      ) : (
        requests.map((r: any) => {
          const org = r['users!organizer_withdrawal_requests_organizer_id_fkey'];
          const bank = r.organizer_bank_accounts;
          return (
            <div key={r.id} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '14px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#F0F0FF' }}>{org?.username || org?.full_name || r.organizer_id.slice(0,8)}</p>
                  <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#8B8FA8' }}>{org?.email}</p>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, color: statusColor[r.status] || '#8B8FA8', background: `${statusColor[r.status]}22`, borderRadius: '6px', padding: '3px 8px' }}>{r.status.toUpperCase()}</span>
              </div>
              <p style={{ margin: 0, fontSize: '20px', fontWeight: 800, color: '#A855F7' }}>{fmt(r.amount_kobo)}</p>
              {bank && (
                <p style={{ margin: 0, fontSize: '12px', color: '#8B8FA8' }}>{bank.bank_name} · {bank.account_number} · {bank.account_name}</p>
              )}
              <p style={{ margin: 0, fontSize: '11px', color: '#6B7280' }}>{new Date(r.created_at).toLocaleString('en-NG')}</p>
              {r.status === 'pending' && (
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button
                    onClick={() => handleUpdateStatus(r.id, 'approved')}
                    disabled={actionLoading === r.id}
                    style={{ flex: 1, background: 'rgba(96,165,250,0.15)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: '10px', padding: '8px', color: '#60A5FA', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>
                    Approve
                  </button>
                  <button
                    onClick={() => handleUpdateStatus(r.id, 'paid')}
                    disabled={actionLoading === r.id}
                    style={{ flex: 1, background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '10px', padding: '8px', color: '#10B981', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>
                    Mark Paid
                  </button>
                  <button
                    onClick={() => handleUpdateStatus(r.id, 'rejected')}
                    disabled={actionLoading === r.id}
                    style={{ flex: 1, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '8px', color: '#EF4444', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>
                    Reject
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
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
  const [eventSearch, setEventSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // VC Dashboard state
  const [vcTxns, setVcTxns] = useState<any[]>([]);
  const [vcLoading, setVcLoading] = useState(false);
  const [vcTransfer, setVcTransfer] = useState({ userId: '', amount: '', reason: '' });
  const [vcTransferBusy, setVcTransferBusy] = useState(false);
  const [vcMsg, setVcMsg] = useState<string | null>(null);
  const [vcSearch, setVcSearch] = useState('');
  const [vcSearchResults, setVcSearchResults] = useState<any[]>([]);
  const [vcSearching, setVcSearching] = useState(false);
  const [vcSelectedUser, setVcSelectedUser] = useState<any | null>(null);

  // Prize draw management state
  const [drawMonth, setDrawMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [drawEntries, setDrawEntries] = useState<any[]>([]);
  const [drawWinners, setDrawWinners] = useState<any[]>([]);
  const [drawLoading, setDrawLoading] = useState(false);
  const [pickWinnerUserId, setPickWinnerUserId] = useState('');
  const [pickWinnerPrize, setPickWinnerPrize] = useState('');
  const [pickWinnerBusy, setPickWinnerBusy] = useState(false);
  const [drawMsg, setDrawMsg] = useState<string | null>(null);
  const [deliverBusy, setDeliverBusy] = useState<string | null>(null);

  // Stats tab state
  const [stats, setStats] = useState<any | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Organizer Verification tab state
  const [pendingOrgs, setPendingOrgs] = useState<any[]>([]);
  const [pendingOrgsLoading, setPendingOrgsLoading] = useState(false);

  // Organizer Requests tab state
  const [orgRequests, setOrgRequests] = useState<any[]>([]);
  const [orgRequestsLoading, setOrgRequestsLoading] = useState(false);

  useEffect(() => {
    if (tab !== 'vc') return;
    setVcLoading(true);
    insforge.database
      .from('vc_transactions')
      .select('id, user_id, amount, type, status, reference_id, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => { setVcTxns(data || []); setVcLoading(false); });
  }, [tab]);

  const loadDrawData = async (month: string) => {
    setDrawLoading(true); setDrawMsg(null);
    try {
      const [entriesRes, winnersRes] = await Promise.all([
        insforge.database
          .from('prize_draw_entries')
          .select('id, user_id, draw_month, entry_number, vc_spent, created_at, users(username, full_name)')
          .eq('draw_month', month)
          .order('created_at', { ascending: false })
          .limit(100),
        insforge.database
          .from('prize_draw_winners')
          .select('id, user_id, draw_month, prize_description, drawn_at, delivered, users(username, full_name)')
          .order('drawn_at', { ascending: false })
          .limit(20),
      ]);
      setDrawEntries(entriesRes.data || []);
      setDrawWinners(winnersRes.data || []);
    } catch { /* ignore */ }
    finally { setDrawLoading(false); }
  };

  useEffect(() => { if (tab === 'vc') loadDrawData(drawMonth); }, [tab, drawMonth]);

  const handlePickWinner = async () => {
    if (!pickWinnerUserId.trim() || !pickWinnerPrize.trim()) {
      setDrawMsg('Enter a user ID and prize description.'); return;
    }
    setPickWinnerBusy(true); setDrawMsg(null);
    try {
      const { error } = await insforge.database.rpc('admin_pick_draw_winner' as any, {
        p_month: drawMonth,
        p_user_id: pickWinnerUserId.trim(),
        p_prize_description: pickWinnerPrize.trim(),
      });
      if (error) throw error;
      setDrawMsg(`✓ Winner picked for ${drawMonth}`);
      setPickWinnerUserId(''); setPickWinnerPrize('');
      loadDrawData(drawMonth);
    } catch (e: any) { setDrawMsg('Error: ' + (e?.message || 'unknown')); }
    finally { setPickWinnerBusy(false); }
  };

  const handleMarkDelivered = async (month: string) => {
    setDeliverBusy(month); setDrawMsg(null);
    try {
      const { error } = await insforge.database.rpc('admin_mark_winner_delivered' as any, { p_draw_month: month });
      if (error) throw error;
      setDrawMsg(`✓ Marked ${month} as delivered`);
      loadDrawData(drawMonth);
    } catch (e: any) { setDrawMsg('Error: ' + (e?.message || 'unknown')); }
    finally { setDeliverBusy(null); }
  };

  useEffect(() => {
    if (tab !== 'stats') return;
    setStatsLoading(true);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    Promise.all([
      insforge.database.from('users').select('id', { count: 'exact', head: true }),
      insforge.database.from('events').select('id', { count: 'exact', head: true }),
      insforge.database.from('tickets').select('id', { count: 'exact', head: true }).eq('payment_status', 'paid'),
      insforge.database.from('vc_transactions').select('amount').eq('type', 'credit').eq('status', 'active'),
      insforge.database.from('tickets').select('amount').eq('payment_status', 'paid'),
      insforge.database.from('users').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo),
      insforge.database.from('users').select('id', { count: 'exact', head: true }).gte('created_at', monthAgo),
    ]).then(([uRes, eRes, tRes, vcRes, revRes, weekRes, monthRes]) => {
      const vcTotal = (vcRes.data || []).reduce((s: number, r: any) => s + Number(r.amount), 0);
      const revenue = (revRes.data || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      setStats({ users: uRes.count ?? 0, events: eRes.count ?? 0, tickets: tRes.count ?? 0, vc: vcTotal, revenue, newThisWeek: weekRes.count ?? 0, newThisMonth: monthRes.count ?? 0 });
      setStatsLoading(false);
    }).catch(() => setStatsLoading(false));
  }, [tab]);

  useEffect(() => {
    if (tab !== 'verify') return;
    setPendingOrgsLoading(true);
    insforge.database
      .from('users')
      .select('id, full_name, username, email, state, created_at, is_verified')
      .eq('role', 'organizer')
      .eq('is_verified', false)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => { setPendingOrgs(data || []); setPendingOrgsLoading(false); });
  }, [tab]);

  const handleVcUserSearch = async () => {
    const q = vcSearch.trim();
    if (!q) return;
    setVcSearching(true);
    try {
      const like = `%${q}%`;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let query = insforge.database
        .from('public_profiles')
        .select('id, full_name, username, avatar_url')
        .or(`full_name.ilike.${like},username.ilike.${like}`);
      if (uuidRe.test(q)) {
        query = insforge.database
          .from('public_profiles')
          .select('id, full_name, username, avatar_url')
          .or(`full_name.ilike.${like},username.ilike.${like},id.eq.${q}`);
      }
      const { data } = await query.limit(8);
      setVcSearchResults(data || []);
    } catch { setVcSearchResults([]); }
    finally { setVcSearching(false); }
  };

  const vcTotalCirculation = vcTxns
    .filter(t => t.type === 'credit' && t.status === 'active')
    .reduce((s, t) => s + Number(t.amount), 0);

  const handleVcAdminTransfer = async () => {
    const uid = vcTransfer.userId.trim();
    if (!uid || !vcTransfer.amount || Number(vcTransfer.amount) <= 0) {
      setVcMsg('Search and select a user first, then enter a positive amount.'); return;
    }
    if (!vcTransfer.reason.trim()) {
      setVcMsg('A reason is required for admin transfers.'); return;
    }
    setVcTransferBusy(true); setVcMsg(null);
    try {
      const { error } = await insforge.database.rpc('admin_credit_vents_cents' as any, {
        p_user_id: uid,
        p_amount: Number(vcTransfer.amount),
        p_reason: vcTransfer.reason.trim(),
      });
      if (error) throw error;
      await writeAuditLog(currentUser.id, 'admin_vc_transfer', uid, {
        amount: Number(vcTransfer.amount),
        reason: vcTransfer.reason.trim(),
        recipient: vcSelectedUser?.username || uid.slice(0, 8),
      });
      setVcMsg(`✓ ${vcTransfer.amount} VC credited to ${vcSelectedUser?.username || uid.slice(0, 8)}…`);
      setVcTransfer({ userId: '', amount: '', reason: '' });
      setVcSelectedUser(null);
      setVcSearch('');
      setVcSearchResults([]);
    } catch (e: any) {
      setVcMsg(e.message || 'Transfer failed.');
    } finally {
      setVcTransferBusy(false);
    }
  };

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

  useEffect(() => {
    if (tab !== 'org-requests') return;
    setOrgRequestsLoading(true);
    insforge.database
      .from('organizer_requests')
      .select('id, user_id, reason, status, admin_note, created_at, users!organizer_requests_user_id_fkey(username, full_name, email)')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => { setOrgRequests(data || []); setOrgRequestsLoading(false); });
  }, [tab]);

  const reviewOrgRequest = async (id: string, status: 'approved' | 'rejected', adminNote?: string) => {
    const { error } = await insforge.database
      .from('organizer_requests')
      .update({ status, admin_note: adminNote || null, reviewed_by: currentUser?.id, reviewed_at: new Date().toISOString() })
      .eq('id', id);
    if (!error) {
      setOrgRequests((prev) => prev.map((r) => r.id === id ? { ...r, status, admin_note: adminNote || null } : r));
      // If approved, update user role to organizer
      if (status === 'approved') {
        const req = orgRequests.find((r) => r.id === id);
        if (req?.user_id) {
          await insforge.database.from('users').update({ role: 'organizer' }).eq('id', req.user_id);
        }
      }
    }
  };

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
    { key: 'vc' as Tab, label: 'VC', icon: <Swords size={14} /> },
    { key: 'stats' as Tab, label: 'Stats', icon: <Zap size={14} /> },
    { key: 'verify' as Tab, label: 'Verify', icon: <BadgeCheck size={14} /> },
    { key: 'payouts' as Tab, label: 'Payouts', icon: <Wallet size={14} /> },
    { key: 'org-requests' as Tab, label: 'Org Reqs', icon: <Megaphone size={14} /> },
    ...(isRoot ? [{ key: 'system' as Tab, label: 'System', icon: <Settings size={14} /> }] : []),
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
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.04)', flexShrink: 0, overflowX: 'auto', scrollbarWidth: 'none' }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
              padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer',
              color: tab === t.key ? (t.key === 'system' ? '#A855F7' : '#A78BFA') : '#8B8FA8',
              fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
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
          {/* Event search bar */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: '#0D0D1A', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)', padding: '10px 14px', gap: '10px' }}>
              <Search size={15} color="#8B8FA8" />
              <input
                type="text"
                placeholder="Search events by title…"
                value={eventSearch}
                onChange={e => setEventSearch(e.target.value)}
                style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '13px' }}
              />
            </div>
            <button onClick={loadEvents} style={{ background: '#0D0D1A', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '14px', padding: '0 14px', color: '#8B8FA8', cursor: 'pointer' }}>
              <RefreshCw size={15} />
            </button>
          </div>
          <span style={{ color: '#8B8FA8', fontSize: '12px', display: 'block', marginBottom: '8px' }}>
            {(eventSearch ? events.filter(ev => ev.title?.toLowerCase().includes(eventSearch.toLowerCase())) : events).length} events
          </span>
          {eventsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading events…</div>
          ) : events.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>No events found.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {(eventSearch ? events.filter(ev => ev.title?.toLowerCase().includes(eventSearch.toLowerCase())) : events).map(ev => (
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

      {/* ════════════════ VENTS CENTS DASHBOARD ══════════════════════════ */}
      {tab === 'vc' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Overview cards */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            {[
              { label: 'VC in Circulation', value: vcTotalCirculation.toLocaleString() },
              { label: 'Total Transactions', value: vcTxns.length.toString() },
              { label: 'Credits', value: vcTxns.filter(t => t.type === 'credit').length.toString() },
              { label: 'Debits', value: vcTxns.filter(t => t.type === 'debit').length.toString() },
            ].map(card => (
              <div key={card.label} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '14px 16px' }}>
                <div style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>{card.label}</div>
                <div style={{ color: '#F0F0FF', fontSize: '22px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>{vcLoading ? '…' : card.value}</div>
              </div>
            ))}
          </div>

          {/* VC Transactions log */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '16px', overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }}>VC Transactions (last 100)</div>
            {vcLoading ? (
              <div style={{ padding: '24px', textAlign: 'center', color: '#8B8FA8', fontSize: '13px' }}>Loading…</div>
            ) : vcTxns.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: '#8B8FA8', fontSize: '13px' }}>No transactions yet.</div>
            ) : (
              <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                {vcTxns.map(txn => (
                  <div key={txn.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <div>
                      <div style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 600 }}>{txn.type.toUpperCase()} — {txn.status}</div>
                      <div style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '2px' }}>{txn.user_id?.slice(0, 12)}… · {new Date(txn.created_at).toLocaleDateString()}</div>
                    </div>
                    <div style={{ color: txn.type === 'credit' ? '#10B981' : '#EF4444', fontSize: '14px', fontWeight: 700 }}>
                      {txn.type === 'credit' ? '+' : '-'}{Number(txn.amount).toLocaleString()} VC
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* VC Purchases */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '16px', overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', color: '#F0F0FF', fontSize: '13px', fontWeight: 700 }}>VC Purchases</div>
            <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {vcTxns.filter(t => t.type === 'credit' && t.reference_id?.startsWith('purchase')).length === 0 ? (
                <div style={{ padding: '20px 16px', color: '#8B8FA8', fontSize: '12px' }}>No purchase records with reference prefix "purchase".</div>
              ) : vcTxns.filter(t => t.type === 'credit' && t.reference_id?.startsWith('purchase')).map(txn => (
                <div key={txn.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <div style={{ color: '#F0F0FF', fontSize: '12px' }}>{txn.user_id?.slice(0, 12)}…</div>
                  <div style={{ color: '#10B981', fontSize: '13px', fontWeight: 700 }}>+{Number(txn.amount).toLocaleString()} VC</div>
                </div>
              ))}
            </div>
          </div>

          {/* Admin Transfer */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '16px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>Admin Transfer</div>

            {/* User search */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                placeholder="Search by name, @username, email, or UUID"
                value={vcSearch}
                onChange={e => setVcSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleVcUserSearch()}
                style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
              />
              <button onClick={handleVcUserSearch} disabled={vcSearching} style={{ background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: '10px', padding: '0 12px', color: '#A78BFA', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>
                {vcSearching ? '…' : 'Find'}
              </button>
            </div>

            {/* Search results */}
            {vcSearchResults.length > 0 && (
              <div style={{ background: '#0D0D1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', overflow: 'hidden' }}>
                {vcSearchResults.map(u => (
                  <button
                    key={u.id}
                    onClick={() => { setVcSelectedUser(u); setVcTransfer(v => ({ ...v, userId: u.id })); setVcSearchResults([]); setVcSearch(''); }}
                    style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '10px 12px', background: 'none', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer', textAlign: 'left' }}
                  >
                    <div style={{ width: '30px', height: '30px', borderRadius: '50%', background: 'rgba(167,139,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {u.avatar_url
                        ? <img src={u.avatar_url} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                        : <span style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 700 }}>{(u.full_name || u.username || '?')[0].toUpperCase()}</span>
                      }
                    </div>
                    <div>
                      <div style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>{u.full_name || u.username || 'Unknown'}</div>
                      <div style={{ color: '#8B8FA8', fontSize: '11px' }}>@{u.username}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Selected user preview */}
            {vcSelectedUser && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '10px', padding: '10px 12px' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(167,139,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {vcSelectedUser.avatar_url
                    ? <img src={vcSelectedUser.avatar_url} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                    : <span style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 700 }}>{(vcSelectedUser.full_name || vcSelectedUser.username || '?')[0].toUpperCase()}</span>
                  }
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#10B981', fontSize: '13px', fontWeight: 700 }}>✓ {vcSelectedUser.full_name || vcSelectedUser.username}</div>
                  <div style={{ color: '#8B8FA8', fontSize: '11px', fontFamily: 'monospace' }}>{vcSelectedUser.id}</div>
                </div>
                <button onClick={() => { setVcSelectedUser(null); setVcTransfer(v => ({ ...v, userId: '' })); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8B8FA8', fontSize: '16px', padding: '2px' }}>×</button>
              </div>
            )}

            <input
              placeholder="Amount (VC)"
              type="number"
              min="1"
              value={vcTransfer.amount}
              onChange={e => setVcTransfer(v => ({ ...v, amount: e.target.value }))}
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
            />
            <input
              placeholder="Reason (required)"
              value={vcTransfer.reason}
              onChange={e => setVcTransfer(v => ({ ...v, reason: e.target.value }))}
              style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${vcTransfer.reason.trim() ? 'rgba(255,255,255,0.1)' : 'rgba(239,68,68,0.3)'}`, borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
            />
            {vcMsg && <div style={{ color: vcMsg.startsWith('✓') ? '#10B981' : '#EF4444', fontSize: '12px' }}>{vcMsg}</div>}
            <button
              onClick={handleVcAdminTransfer}
              disabled={vcTransferBusy || !vcTransfer.userId || !vcTransfer.reason.trim()}
              style={{ background: 'linear-gradient(135deg, #7C3AED, #4F46E5)', border: 'none', borderRadius: '12px', padding: '12px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: (vcTransferBusy || !vcTransfer.userId || !vcTransfer.reason.trim()) ? 'not-allowed' : 'pointer', opacity: (vcTransferBusy || !vcTransfer.userId || !vcTransfer.reason.trim()) ? 0.5 : 1 }}
            >
              {vcTransferBusy ? 'Transferring…' : 'Credit VC to User'}
            </button>
          </div>

          {/* ── Prize Draw Management ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', paddingBottom: '4px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              Prize Draw Management
            </div>

            {/* Month selector */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="month"
                value={drawMonth}
                onChange={e => setDrawMonth(e.target.value)}
                style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
              />
              <button onClick={() => loadDrawData(drawMonth)} style={{ background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: '10px', padding: '10px 14px', color: '#A78BFA', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>
                {drawLoading ? '…' : 'Load'}
              </button>
            </div>

            {/* This month's entries */}
            <div style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600 }}>Entries for {drawMonth} ({drawEntries.length})</div>
            {drawEntries.length === 0 && !drawLoading && (
              <div style={{ color: '#555C7A', fontSize: '12px', textAlign: 'center', padding: '12px 0' }}>No entries yet</div>
            )}
            {drawEntries.slice(0, 20).map(e => (
              <div key={e.id} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '10px', padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ color: '#C4C9E0', fontSize: '12px' }}>{(e as any).users?.username || (e as any).users?.full_name || e.user_id?.slice(0, 12)}</div>
                  <div style={{ color: '#555C7A', fontSize: '11px' }}>Entry #{e.entry_number} · {e.vc_spent} VC</div>
                </div>
                <div style={{ color: '#555C7A', fontSize: '11px' }}>{new Date(e.created_at).toLocaleDateString()}</div>
              </div>
            ))}

            {/* Pick winner */}
            <div style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, marginTop: '4px' }}>Pick Winner for {drawMonth}</div>
            <input
              placeholder="Winner User ID"
              value={pickWinnerUserId}
              onChange={e => setPickWinnerUserId(e.target.value)}
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', fontFamily: 'monospace' }}
            />
            <input
              placeholder="Prize description (e.g. ₦50,000 gift card)"
              value={pickWinnerPrize}
              onChange={e => setPickWinnerPrize(e.target.value)}
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
            />
            {drawMsg && <div style={{ color: drawMsg.startsWith('✓') ? '#10B981' : '#EF4444', fontSize: '12px' }}>{drawMsg}</div>}
            <button
              onClick={handlePickWinner}
              disabled={pickWinnerBusy || !pickWinnerUserId.trim() || !pickWinnerPrize.trim()}
              style={{ background: 'linear-gradient(135deg, #F59E0B, #D97706)', border: 'none', borderRadius: '12px', padding: '12px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: (pickWinnerBusy || !pickWinnerUserId.trim() || !pickWinnerPrize.trim()) ? 'not-allowed' : 'pointer', opacity: (pickWinnerBusy || !pickWinnerUserId.trim() || !pickWinnerPrize.trim()) ? 0.5 : 1 }}
            >
              {pickWinnerBusy ? 'Saving…' : 'Pick Winner'}
            </button>

            {/* Past winners */}
            <div style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, marginTop: '4px' }}>Past Winners</div>
            {drawWinners.length === 0 ? (
              <div style={{ color: '#555C7A', fontSize: '12px', textAlign: 'center', padding: '8px 0' }}>No winners yet</div>
            ) : drawWinners.map(w => (
              <div key={w.id} style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${w.delivered ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)'}`, borderRadius: '10px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 600 }}>{w.draw_month}</div>
                    <div style={{ color: '#C4C9E0', fontSize: '11px' }}>{w.prize_description}</div>
                    <div style={{ color: '#555C7A', fontSize: '11px' }}>User: {(w as any).users?.username || (w as any).users?.full_name || w.user_id?.slice(0, 12)}</div>
                  </div>
                  <div style={{ padding: '3px 8px', borderRadius: '6px', background: w.delivered ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)', color: w.delivered ? '#10B981' : '#F59E0B', fontSize: '10px', fontWeight: 700 }}>
                    {w.delivered ? 'DELIVERED' : 'PENDING'}
                  </div>
                </div>
                {!w.delivered && (
                  <button
                    onClick={() => handleMarkDelivered(w.draw_month)}
                    disabled={deliverBusy === w.draw_month}
                    style={{ background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', padding: '8px', color: '#10B981', fontSize: '12px', fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start' }}
                  >
                    {deliverBusy === w.draw_month ? '…' : 'Mark as Delivered'}
                  </button>
                )}
              </div>
            ))}
          </div>

        </div>
      )}

      {/* ════════════════ APP STATS TAB ══════════════════════════════════ */}
      {tab === 'stats' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {statsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading stats…</div>
          ) : stats ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                {[
                  { label: 'Total Users', value: stats.users.toLocaleString(), color: '#3B82F6' },
                  { label: 'Total Events', value: stats.events.toLocaleString(), color: '#A78BFA' },
                  { label: 'Paid Tickets', value: stats.tickets.toLocaleString(), color: '#10B981' },
                  { label: 'Active VC', value: stats.vc.toLocaleString(), color: '#F59E0B' },
                  { label: 'Total Revenue', value: '₦' + (stats.revenue / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 }), color: '#34D399' },
                  { label: 'New This Week', value: stats.newThisWeek.toLocaleString(), color: '#60A5FA' },
                  { label: 'New This Month', value: stats.newThisMonth.toLocaleString(), color: '#818CF8' },
                ].map(card => (
                  <div key={card.label} style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${card.color}25`, borderRadius: '14px', padding: '16px' }}>
                    <div style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>{card.label}</div>
                    <div style={{ color: card.color, fontSize: '22px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>{card.value}</div>
                  </div>
                ))}
              </div>
              <p style={{ color: '#555C7A', fontSize: '11px', textAlign: 'center', marginTop: '8px' }}>Live counts from database. Refresh tab to update.</p>
            </>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>No data.</div>
          )}
        </div>
      )}

      {/* ════════════════ ORGANIZER VERIFICATION TAB ══════════════════════ */}
      {tab === 'verify' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 40px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0 }}>{pendingOrgs.length} unverified organizer{pendingOrgs.length !== 1 ? 's' : ''}</p>
          {pendingOrgsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading…</div>
          ) : pendingOrgs.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>All organizers verified ✓</div>
          ) : pendingOrgs.map(u => (
            <div key={u.id} style={{ background: '#0D0D1A', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>{u.full_name || 'No Name'}</div>
                  <div style={{ color: '#8B8FA8', fontSize: '12px' }}>@{u.username || 'no_username'} · {u.state || 'No state'}</div>
                  <div style={{ color: '#555C7A', fontSize: '11px' }}>{u.email}</div>
                </div>
                <span style={{ fontSize: '10px', color: '#F59E0B', background: 'rgba(245,158,11,0.1)', padding: '2px 8px', borderRadius: '6px', fontWeight: 600 }}>UNVERIFIED</span>
              </div>
              <div style={{ color: '#555C7A', fontSize: '10px' }}>Joined {new Date(u.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={async () => {
                    const { error } = await insforge.database.from('users').update({ is_verified: true }).eq('id', u.id);
                    if (!error) {
                      await writeAuditLog(currentUser.id, 'verify_organizer', u.id, { username: u.username, email: u.email });
                      setPendingOrgs(prev => prev.filter(x => x.id !== u.id));
                      flash(true, `@${u.username} verified ✓`);
                    } else flash(false, error.message);
                  }}
                  style={{ flex: 1, background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '10px', padding: '8px', color: '#3B82F6', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                >
                  <BadgeCheck size={13} style={{ display: 'inline', marginRight: '6px' }} />Verify
                </button>
                <button
                  onClick={async () => {
                    const { error } = await insforge.database.from('users').update({ role: 'attendee' }).eq('id', u.id);
                    if (!error) {
                      await writeAuditLog(currentUser.id, 'reject_organizer', u.id, { username: u.username });
                      setPendingOrgs(prev => prev.filter(x => x.id !== u.id));
                      flash(false, `@${u.username} demoted to attendee.`);
                    } else flash(false, error.message);
                  }}
                  style={{ flex: 1, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '8px', color: '#EF4444', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ════════════════ PAYOUTS TAB ════════════════════════════════════ */}
      {tab === 'payouts' && <PayoutsTab />}

      {tab === 'org-requests' && (
        <div style={{ padding: '16px', overflowY: 'auto', flex: 1 }}>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '12px' }}>Organizer Upgrade Requests</p>
          {orgRequestsLoading ? (
            <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '40px' }}>Loading...</p>
          ) : orgRequests.length === 0 ? (
            <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '40px' }}>No requests yet.</p>
          ) : (
            orgRequests.map((req: any) => {
              const user = req.users;
              const name = user?.full_name || user?.username || user?.email || req.user_id;
              return (
                <div key={req.id} style={{ background: '#131629', borderRadius: '14px', padding: '14px', marginBottom: '10px', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{name}</span>
                    <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '8px', background: req.status === 'pending' ? 'rgba(245,158,11,0.15)' : req.status === 'approved' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)', color: req.status === 'pending' ? '#F59E0B' : req.status === 'approved' ? '#10B981' : '#EF4444', textTransform: 'uppercase' as const }}>
                      {req.status}
                    </span>
                  </div>
                  {req.reason && <p style={{ color: '#8B8FA8', fontSize: '13px', margin: '0 0 10px', lineHeight: 1.4 }}>{req.reason}</p>}
                  <p style={{ color: '#555C7A', fontSize: '11px', margin: '0 0 10px' }}>{new Date(req.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                  {req.status === 'pending' && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button onClick={() => reviewOrgRequest(req.id, 'approved')} style={{ flex: 1, height: '36px', borderRadius: '10px', background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', color: '#10B981', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Approve</button>
                      <button onClick={() => reviewOrgRequest(req.id, 'rejected')} style={{ flex: 1, height: '36px', borderRadius: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#EF4444', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Reject</button>
                    </div>
                  )}
                </div>
              );
            })
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
              {isCreditSending ? 'Crediting…' : 'Credit Vents Cents'}
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
