import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft, Search, Shield, UserCheck, AlertCircle,
  UserX, Trash2, RefreshCw, ClipboardList, Users,
  Zap, Settings, Bell, Wrench, ToggleLeft, ToggleRight,
  Copy, CheckCircle, BadgeCheck, Megaphone, Swords, Flag, Wallet,
  Mic, Image as ImageIcon, Activity,
} from 'lucide-react';
import { insforge, getAuthToken } from '../../lib/insforge';
import { sendSMS } from '../../lib/sendchamp';
import { extractEventsFromText, publishEvents, type ImportedEvent } from '../../lib/eventImporter';

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
  deleted_at?: string | null;
}

interface AuditLog {
  id: string;
  action: string;
  details: Record<string, any>;
  created_at: string;
  admin_id: string;
  target_user_id: string | null;
  actor_role?: string | null;
}

type Tab = 'users' | 'events' | 'logs' | 'reports' | 'vc' | 'stats' | 'verify' | 'payouts' | 'system' | 'org-requests' | 'import-events' | 'deleted';

interface EventRow {
  id: string;
  title: string | null;
  organizer_id: string | null;
  hidden_by_admin: boolean;
  hidden_at: string | null;
  created_at: string;
  status: string | null;
  image_url: string | null;
  event_date: string | null;
  'users!events_organizer_id_fkey'?: { username: string | null; full_name: string | null; is_verified: boolean } | null;
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
        background: '#090514', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '20px',
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
// Takes the acting user's row so every audit entry can explicitly flag their
// authorization level (Admin / Sub-Admin / Root) alongside the raw admin_id.
async function writeAuditLog(actor: { id: string; role?: string }, action: string, targetUserId: string | null, details: Record<string, any>) {
  const actorRole = actor.id === ROOT_UID ? 'root' : actor.role || 'unknown';
  await insforge.database
    .from('admin_logs')
    .insert([{ admin_id: actor.id, action, target_user_id: targetUserId, details, actor_role: actorRole }]);
}

// Fires the confirmation/rejection email after an admin action succeeds.
// Module-scope (not tied to a specific component) since both PayoutsTab and
// the main AdminDashboardScreen component call it.
async function notifyByEmail(requestType: 'organizer' | 'cac' | 'payout', requestId: string, decision: 'approved' | 'rejected', reason?: string) {
  try {
    const token = await getAuthToken();
    await fetch('/api/notify/status-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ request_type: requestType, request_id: requestId, decision, reason }),
    });
  } catch (err) {
    console.error('Notification email failed:', err);
  }
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
function PayoutsTab({ flash }: { flash: (ok: boolean, msg: string) => void }) {
  const [requests, setRequests] = useState<any[]>([]);
  const [wallets, setWallets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'all'>('pending');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'requests' | 'wallets'>('requests');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // InsForge's SDK doesn't always keep hc.userToken reliably populated —
      // without this, admin_list_pending_payouts (is_admin()-gated) can fail
      // silently under RLS and render as an empty state with no error shown.
      try { await getAuthToken(); } catch { /* fall through — surfaced below if the queries also fail */ }

      const [reqRes, walRes] = await Promise.all([
        // admin_list_pending_payouts is SECURITY DEFINER + is_admin()-gated —
        // it joins organizer + bank metadata server-side in one call, so the
        // panel always shows Name/Email/Phone/Amount/Bank/recipient_code.
        statusFilter === 'pending'
          ? insforge.database.rpc('admin_list_pending_payouts' as any)
          : insforge.database
              .from('organizer_withdrawal_requests')
              .select('id, organizer_id, amount_kobo, status, created_at, updated_at, admin_note, organizer_bank_accounts(bank_name, account_number, account_name, recipient_code), users!organizer_withdrawal_requests_organizer_id_public_users_fkey(username, full_name, email, phone_number)')
              .order('created_at', { ascending: false })
              .limit(50),
        insforge.database
          .from('organizer_wallets')
          .select('organizer_id, balance_kobo, pending_kobo, total_earned_kobo, total_withdrawn_kobo')
          .order('balance_kobo', { ascending: false })
          .limit(100),
      ]);
      const { data: reqs, error: reqError } = reqRes;
      const { data: walsRaw, error: walError } = walRes;
      if (reqError || walError) {
        console.error('PayoutsTab load error:', reqError || walError);
        setLoadError((reqError || walError)?.message || 'Failed to load payouts.');
      }
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
      // Normalize both response shapes (RPC returns flat columns; the 'all'
      // fallback query returns nested embeds) into one shape for rendering.
      const normalized = (reqs || []).map((r: any) => {
        if ('request_id' in r) return r; // already flat, from admin_list_pending_payouts
        const org = r['users!organizer_withdrawal_requests_organizer_id_public_users_fkey'];
        const bank = r.organizer_bank_accounts;
        return {
          request_id: r.id,
          organizer_id: r.organizer_id,
          organizer_name: org?.full_name || org?.username,
          organizer_email: org?.email,
          organizer_phone: org?.phone_number,
          amount_kobo: r.amount_kobo,
          bank_name: bank?.bank_name,
          account_number: bank?.account_number,
          account_name: bank?.account_name,
          recipient_code: bank?.recipient_code,
          status: r.status,
          created_at: r.created_at,
        };
      });
      setRequests(normalized);
      setWallets(wals);
    } catch (err: any) {
      console.error('PayoutsTab load threw:', err);
      setLoadError(err?.message || 'Failed to load payouts.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      const token = await getAuthToken();
      const res = await fetch('/api/wallet/admin-approve-payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ request_id: id }),
      });
      const json = await res.json().catch(() => ({}));
      // Paystack rejections (insufficient transfer balance, invalid
      // recipient_code, etc.) come back as a non-200 with the exact
      // provider message in json.error — surface it verbatim rather than
      // a generic string, and always fall through to `finally` so the
      // button is immediately re-clickable.
      if (!res.ok) throw new Error(json.error || 'Approve failed');
      await load();
      // Paystack only confirmed it accepted the transfer for processing
      // here — transfer.success (the actual "money moved" signal) arrives
      // later via webhook, which is what flips the row to COMPLETED and
      // fires the organizer's confirmation email. Marking it complete or
      // emailing at this point would be inaccurate for OTP-finalized
      // transfers.
      flash(true, 'Transfer initiated — Paystack is processing. Status will update to Completed once confirmed.');
    } catch (e: any) {
      flash(false, e.message || 'Approve failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: string) => {
    const reason = window.prompt('Reason for rejecting this payout? (shown to the organizer)');
    if (!reason || !reason.trim()) return;
    setActionLoading(id);
    try {
      const token = await getAuthToken();
      const res = await fetch('/api/wallet/admin-reject-payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ request_id: id, reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Reject failed');
      await load();
      notifyByEmail('payout', id, 'rejected', reason.trim());
      flash(true, 'Payout rejected and funds returned to available balance.');
    } catch (e: any) {
      flash(false, e.message || 'Reject failed');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReconcile = async () => {
    setReconciling(true);
    try {
      const token = await getAuthToken();
      const res = await fetch('/api/wallet/reconcile-payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Reconcile failed');
      const resolved = (json.results || []).filter((r: any) => r.outcome === 'completed' || r.outcome === 'failed').length;
      flash(true, `Checked ${json.checked ?? 0} processing payout(s) against Paystack — ${resolved} resolved.`);
      await load();
    } catch (e: any) {
      flash(false, e.message || 'Reconcile failed');
    } finally {
      setReconciling(false);
    }
  };

  const handleCancelConfirmed = async (id: string) => {
    setCancelConfirmId(null);
    const reason = window.prompt('Reason for cancelling this payout? (required for the audit trail, shown to the organizer)');
    if (!reason || !reason.trim()) return;
    setActionLoading(id);
    try {
      const token = await getAuthToken();
      const res = await fetch('/api/wallet/admin-cancel-payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ request_id: id, reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Cancel failed');
      await load();
      flash(true, 'Payout cancelled and funds returned to available balance.');
    } catch (e: any) {
      flash(false, e.message || 'Cancel failed');
    } finally {
      setActionLoading(null);
    }
  };

  const fmt = (kobo: number) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

  const statusColor: Record<string, string> = {
    pending: '#F59E0B', processing: '#60A5FA', completed: '#10B981', failed: '#EF4444', rejected: '#EF4444', cancelled: '#EF4444',
  };

  // Funds requested but not yet released are still held (in pending_kobo)
  // through both 'pending' and 'processing' — Paystack only confirms
  // "money actually moved" via webhook/reconciliation, which is what flips
  // a row to 'completed'. Excluding 'processing' here made this banner
  // under-report the instant an admin approved a payout, even though the
  // funds hadn't gone anywhere yet.
  const totalPending = requests.filter(r => r.status === 'pending' || r.status === 'processing').reduce((s: number, r: any) => s + r.amount_kobo, 0);

  // Map organizer_id -> their pending request, so wallet cards (which have
  // no request_id of their own) can still expose Approve/Reject controls.
  const pendingByOrganizer: Record<string, any> = {};
  requests.filter(r => r.status === 'pending').forEach(r => { pendingByOrganizer[r.organizer_id] = r; });

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 40px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/* Total pending banner */}
      {totalPending > 0 && (
        <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '4px' }}>
          <p style={{ margin: 0, fontSize: '12px', color: '#F59E0B' }}>Total pending payout</p>
          <p style={{ margin: '2px 0 0', fontSize: '20px', fontWeight: 800, color: '#F59E0B' }}>{fmt(totalPending)}</p>
        </div>
      )}

      {/* Section tabs — always visible, never conditionally hidden */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
        {(['requests', 'wallets'] as const).map(s => (
          <button key={s} onClick={() => setActiveSection(s)}
            style={{ padding: '6px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '12px', background: activeSection === s ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)', color: activeSection === s ? '#A855F7' : '#8B8FA8' }}>
            {s === 'requests' ? 'Requests' : 'All Wallets'}
          </button>
        ))}
        <div style={{ width: '1px', background: 'rgba(255,255,255,0.08)', margin: '2px 2px' }} />
        {(['pending', 'all'] as const).map(f => (
          <button key={f} onClick={() => { setStatusFilter(f); setActiveSection('requests'); }}
            style={{ padding: '6px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '12px', background: activeSection === 'requests' && statusFilter === f ? 'rgba(96,165,250,0.15)' : 'rgba(255,255,255,0.03)', color: activeSection === 'requests' && statusFilter === f ? '#60A5FA' : '#6B7280' }}>
            {f === 'pending' ? 'Pending' : 'All'}
          </button>
        ))}
        <button
          onClick={handleReconcile}
          disabled={reconciling}
          title="Poll Paystack directly for any payout stuck in Processing and resolve it — a fallback for when the transfer.success webhook doesn't fire"
          style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: '8px', border: '1px solid rgba(96,165,250,0.3)', cursor: reconciling ? 'wait' : 'pointer', fontWeight: 600, fontSize: '12px', background: 'rgba(96,165,250,0.1)', color: '#60A5FA', opacity: reconciling ? 0.6 : 1 }}>
          {reconciling ? 'Reconciling…' : '⟳ Reconcile Processing'}
        </button>
      </div>

      {loadError && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 14px' }}>
          <p style={{ margin: 0, fontSize: '12px', color: '#EF4444' }}>{loadError}</p>
        </div>
      )}

      {loading ? (
        <p style={{ color: '#8B8FA8', fontSize: '13px' }}>Loading…</p>
      ) : activeSection === 'wallets' ? (
        wallets.length === 0 ? (
          <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', padding: '24px 0' }}>No organizer wallets yet</p>
        ) : (
          wallets.map((w: any) => {
            const u = w.users;
            const pendingReq = (w.pending_kobo ?? 0) > 0 ? pendingByOrganizer[w.organizer_id] : null;
            return (
              <div key={w.organizer_id} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '14px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#F0F0FF' }}>{u?.username || u?.full_name || w.organizer_id.slice(0, 8)}</p>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12px', color: '#A78BFA' }}>Balance: <strong>{fmt(w.balance_kobo)}</strong></span>
                  {(w.pending_kobo ?? 0) > 0 && (
                    <span style={{ fontSize: '12px', color: '#F59E0B' }}>Pending: {fmt(w.pending_kobo)}</span>
                  )}
                  <span style={{ fontSize: '12px', color: '#8B8FA8' }}>Earned: {fmt(w.total_earned_kobo)}</span>
                  <span style={{ fontSize: '12px', color: '#8B8FA8' }}>Withdrawn: {fmt(w.total_withdrawn_kobo ?? 0)}</span>
                </div>
                {pendingReq && (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '2px' }}>
                    <button
                      onClick={() => handleApprove(pendingReq.request_id)}
                      disabled={actionLoading === pendingReq.request_id}
                      style={{ flex: 1, background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '10px', padding: '8px', color: '#10B981', fontWeight: 700, fontSize: '13px', cursor: 'pointer', opacity: actionLoading === pendingReq.request_id ? 0.6 : 1 }}>
                      {actionLoading === pendingReq.request_id ? 'Processing…' : 'Approve & Pay'}
                    </button>
                    <button
                      onClick={() => handleReject(pendingReq.request_id)}
                      disabled={actionLoading === pendingReq.request_id}
                      style={{ flex: 1, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '8px', color: '#EF4444', fontWeight: 700, fontSize: '13px', cursor: 'pointer', opacity: actionLoading === pendingReq.request_id ? 0.6 : 1 }}>
                      Reject & Refund
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )
      ) : requests.length === 0 ? (
        <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', padding: '24px 0' }}>No {statusFilter === 'pending' ? 'pending ' : ''}withdrawal requests</p>
      ) : (
        requests.map((r: any) => {
          return (
            <div key={r.request_id} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: '14px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#F0F0FF' }}>{r.organizer_name || r.organizer_id?.slice(0, 8)}</p>
                  <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#8B8FA8' }}>{r.organizer_email}{r.organizer_phone ? ` · ${r.organizer_phone}` : ''}</p>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, color: statusColor[r.status] || '#8B8FA8', background: `${statusColor[r.status]}22`, borderRadius: '6px', padding: '3px 8px' }}>{r.status.toUpperCase()}</span>
              </div>
              <p style={{ margin: 0, fontSize: '20px', fontWeight: 800, color: '#A855F7' }}>{fmt(r.amount_kobo)}</p>
              {r.bank_name && (
                <p style={{ margin: 0, fontSize: '12px', color: '#8B8FA8' }}>{r.bank_name} · {r.account_number} · {r.account_name}</p>
              )}
              {r.recipient_code && (
                <p style={{ margin: 0, fontSize: '10px', color: '#6B7280', fontFamily: 'monospace' }}>{r.recipient_code}</p>
              )}
              <p style={{ margin: 0, fontSize: '11px', color: '#6B7280' }}>{new Date(r.created_at).toLocaleString('en-NG')}</p>
              {r.status === 'pending' && (
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button
                    onClick={() => handleApprove(r.request_id)}
                    disabled={actionLoading === r.request_id}
                    style={{ flex: 1, background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '10px', padding: '8px', color: '#10B981', fontWeight: 700, fontSize: '13px', cursor: 'pointer', opacity: actionLoading === r.request_id ? 0.6 : 1 }}>
                    {actionLoading === r.request_id ? 'Processing…' : 'Approve & Pay'}
                  </button>
                  <button
                    onClick={() => handleReject(r.request_id)}
                    disabled={actionLoading === r.request_id}
                    style={{ flex: 1, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '8px', color: '#EF4444', fontWeight: 700, fontSize: '13px', cursor: 'pointer', opacity: actionLoading === r.request_id ? 0.6 : 1 }}>
                    Reject & Refund
                  </button>
                </div>
              )}
              {r.status === 'processing' && (
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button
                    onClick={() => setCancelConfirmId(r.request_id)}
                    disabled={actionLoading === r.request_id}
                    title="Use this if this request is stuck in Processing and doesn't actually exist on Paystack — e.g. the 'Reconcile Processing' check couldn't find it"
                    style={{ flex: 1, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '8px', color: '#EF4444', fontWeight: 700, fontSize: '13px', cursor: 'pointer', opacity: actionLoading === r.request_id ? 0.6 : 1 }}>
                    {actionLoading === r.request_id ? 'Cancelling…' : 'Cancel & Refund'}
                  </button>
                </div>
              )}
              {cancelConfirmId === r.request_id && (
                <ConfirmModal
                  title="Cancel this payout?"
                  message="Are you sure you want to cancel this payout? This will refund the amount to the user."
                  confirmLabel="Yes, cancel"
                  danger
                  onConfirm={() => handleCancelConfirmed(r.request_id)}
                  onCancel={() => setCancelConfirmId(null)}
                />
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
  const isSubAdmin = currentUser?.role === 'sub-admin';
  const isAdminOrSubAdmin = currentUser?.role === 'admin' || isSubAdmin || isRoot;
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
  const [reportedUsers, setReportedUsers] = useState<Record<string, any>>({});
  const [reportedEvents, setReportedEvents] = useState<Record<string, any>>({});
  const [deletedUsers, setDeletedUsers] = useState<UserRow[]>([]);
  const [deletedUsersLoading, setDeletedUsersLoading] = useState(false);
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
  const [vcDebit, setVcDebit] = useState({ amount: '', reason: '' });
  const [vcDebitBusy, setVcDebitBusy] = useState(false);
  const [vcDebitMsg, setVcDebitMsg] = useState<string | null>(null);

  // Stats tab state
  const [stats, setStats] = useState<any | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Organizer Verification tab state
  const [pendingOrgs, setPendingOrgs] = useState<any[]>([]);
  const [pendingOrgsLoading, setPendingOrgsLoading] = useState(false);
  const [verifySection, setVerifySection] = useState<'cac' | 'unverified'>('cac');
  const [cacRequests, setCacRequests] = useState<any[]>([]);
  const [cacRequestsLoading, setCacRequestsLoading] = useState(false);
  const [expandedCacId, setExpandedCacId] = useState<string | null>(null);
  const [cacActionLoading, setCacActionLoading] = useState<string | null>(null);

  // Organizer Requests tab state
  const [orgRequests, setOrgRequests] = useState<any[]>([]);
  const [orgRequestsLoading, setOrgRequestsLoading] = useState(false);

  // Import Events tab state
  const [importText, setImportText] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [importResults, setImportResults] = useState<ImportedEvent[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedImports, setSelectedImports] = useState<Set<number>>(new Set());
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== 'vc') return;
    setVcLoading(true);
    insforge.database
      .from('vc_transactions')
      .select('id, user_id, amount, type, status, reference_id, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(
        ({ data }) => { setVcTxns(data || []); setVcLoading(false); },
        (err) => { console.error('VC transactions fetch error:', err); setVcLoading(false); }
      );
  }, [tab]);

  const loadStats = useCallback(() => {
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
  }, []);

  useEffect(() => { if (tab === 'stats') loadStats(); }, [tab, loadStats]);

  // Live stats: the backend publishes 'admin_stats_changed' on the
  // 'admin:stats' channel whenever a transaction, payout, or signup
  // happens (see migrations/20260710181449_realtime-admin-stats.sql).
  // Subscribed for the lifetime of the dashboard, not just while the Stats
  // tab is open, so numbers are already fresh the moment an admin looks —
  // debounced since several rows (e.g. a batch of ticket sales) can land
  // in quick succession.
  const tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);

  useEffect(() => {
    let subscribed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    insforge.realtime.connect().then(() => {
      insforge.realtime.subscribe('admin:stats').then(() => { subscribed = true; });
    }).catch(() => {});
    const onStatsChanged = () => {
      if (tabRef.current !== 'stats') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadStats, 300);
    };
    insforge.realtime.on('admin_stats_changed', onStatsChanged);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      insforge.realtime.off?.('admin_stats_changed', onStatsChanged);
      if (subscribed) insforge.realtime.unsubscribe('admin:stats');
    };
  }, [loadStats]);

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
      .then(
        ({ data }) => { setPendingOrgs(data || []); setPendingOrgsLoading(false); },
        (err) => { console.error('Pending orgs fetch error:', err); setPendingOrgsLoading(false); }
      );
  }, [tab]);

  const loadCacRequests = useCallback(async () => {
    setCacRequestsLoading(true);
    try {
      const { data, error } = await insforge.database.rpc('admin_list_organizer_verifications' as any);
      if (error) throw error;
      setCacRequests(data || []);
    } catch (err) {
      console.error('CAC requests fetch error:', err);
      setCacRequests([]);
    } finally {
      setCacRequestsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'verify') return;
    loadCacRequests();
  }, [tab, loadCacRequests]);

  const handleApproveCac = async (requestId: string) => {
    setCacActionLoading(requestId);
    try {
      const { error } = await insforge.database.rpc('admin_approve_organizer_verification' as any, { p_request_id: requestId });
      if (error) throw new Error(error.message);
      flash(true, 'Brand verified ✓');
      setExpandedCacId(null);
      await loadCacRequests();
      notifyByEmail('cac', requestId, 'approved');
    } catch (e: any) {
      flash(false, e.message || 'Approval failed');
    } finally {
      setCacActionLoading(null);
    }
  };

  const handleRejectCac = async (requestId: string) => {
    const reason = window.prompt('Reason for rejecting this brand verification? (shown to the organizer)');
    if (!reason || !reason.trim()) return;
    setCacActionLoading(requestId);
    try {
      const { error } = await insforge.database.rpc('admin_reject_organizer_verification' as any, { p_request_id: requestId, p_reason: reason.trim() });
      if (error) throw new Error(error.message);
      flash(false, 'Verification rejected');
      setExpandedCacId(null);
      await loadCacRequests();
      notifyByEmail('cac', requestId, 'rejected', reason.trim());
    } catch (e: any) {
      flash(false, e.message || 'Rejection failed');
    } finally {
      setCacActionLoading(null);
    }
  };

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
      await writeAuditLog(currentUser,'admin_vc_transfer', uid, {
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

  const handleVcAdminDebit = async () => {
    const uid = vcTransfer.userId.trim();
    if (!uid || !vcDebit.amount || Number(vcDebit.amount) <= 0) {
      setVcDebitMsg('Search and select a user first, then enter a positive amount.'); return;
    }
    if (!vcDebit.reason.trim()) {
      setVcDebitMsg('A reason is required for admin debits.'); return;
    }
    setVcDebitBusy(true); setVcDebitMsg(null);
    try {
      const { error } = await insforge.database.rpc('admin_debit_vents_cents' as any, {
        p_user_id: uid,
        p_amount: Number(vcDebit.amount),
        p_reason: vcDebit.reason.trim(),
      });
      if (error) throw error;
      // admin_debit_vents_cents already writes its own admin_logs row
      // server-side (with an authoritative actor_role) — no client-side
      // writeAuditLog call needed here.
      setVcDebitMsg(`✓ ${vcDebit.amount} VC debited from ${vcSelectedUser?.username || uid.slice(0, 8)}…`);
      setVcDebit({ amount: '', reason: '' });
      setVcTransfer({ userId: '', amount: '', reason: '' });
      setVcSelectedUser(null);
      setVcSearch('');
      setVcSearchResults([]);
    } catch (e: any) {
      setVcDebitMsg(e.message || 'Debit failed.');
    } finally {
      setVcDebitBusy(false);
    }
  };

  // System Controller state
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  // MVP launch kill switches for chat voice notes / image sharing
  // (see migrations/20260710185537_media-feature-toggles.sql)
  const [voiceNotesEnabled, setVoiceNotesEnabled] = useState(false);
  const [imageSharingEnabled, setImageSharingEnabled] = useState(true);
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [isPinging, setIsPinging] = useState(false);
  const [healthResult, setHealthResult] = useState<{ ok: boolean; latencyMs: number; detail: string } | null>(null);

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
        .select('id, email, full_name, role, username, phone_number, state, status, is_verified, created_at, banned_until, deleted_at')
        .neq('status', 'deleted')
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

  // ── Load soft-deleted users (Deleted Users tab) ──────────────────────────────
  const loadDeletedUsers = useCallback(async () => {
    setDeletedUsersLoading(true);
    try {
      const { data, error } = await insforge.database
        .from('users')
        .select('id, email, full_name, role, username, phone_number, state, status, is_verified, created_at, banned_until, deleted_at')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false });
      if (error) throw error;
      setDeletedUsers(data || []);
    } catch (err: any) {
      flash(false, err?.message || 'Failed to load deleted users.');
    } finally {
      setDeletedUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdminOrSubAdmin || tab !== 'deleted') return;
    loadDeletedUsers();
  }, [tab, isAdminOrSubAdmin, loadDeletedUsers]);

  // ── Load audit logs ──────────────────────────────────────────────────────────
  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const { data, error } = await insforge.database
        .from('admin_logs')
        .select('id, action, details, created_at, admin_id, target_user_id, actor_role')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      setLogs(data || []);
    } catch { /* silently fail */ }
    finally { setLogsLoading(false); }
  }, []);

  // ── Load app_config for maintenance mode + media feature toggles ────────────
  const loadConfig = useCallback(async () => {
    try {
      const { data } = await insforge.database.from('app_config').select('maintenance_mode, voice_notes_enabled, image_sharing_enabled').single();
      if (data) {
        setMaintenanceMode(data.maintenance_mode);
        setVoiceNotesEnabled(data.voice_notes_enabled);
        setImageSharingEnabled(data.image_sharing_enabled);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!isAdminOrSubAdmin) return;
    loadUsers();
    if (isRoot) loadConfig();
  }, [loadUsers, currentUser, isRoot, loadConfig]);

  useEffect(() => {
    if ((!isAdminOrSubAdmin) || tab !== 'logs') return;
    loadLogs();
  }, [tab, loadLogs, currentUser, isRoot]);

  useEffect(() => {
    if (tab !== 'org-requests') return;
    if (!isAdminOrSubAdmin) return;
    setOrgRequestsLoading(true);
    (async () => {
      try {
        const { data: reqs, error } = await insforge.database
          .from('organizer_requests')
          .select('id, user_id, reason, status, admin_note, created_at')
          .order('created_at', { ascending: false })
          .limit(100);
        if (error) throw error;
        const rows = reqs || [];
        const userIds = [...new Set(rows.map((r: any) => r.user_id).filter(Boolean))];
        let usersMap: Record<string, any> = {};
        if (userIds.length > 0) {
          const { data: users } = await insforge.database
            .from('users')
            .select('id, username, full_name, email, phone_number, state')
            .in('id', userIds);
          (users || []).forEach((u: any) => { usersMap[u.id] = u; });
        }
        setOrgRequests(rows.map((r: any) => ({ ...r, users: usersMap[r.user_id] || null })));
      } catch (error: any) {
        console.error('Org requests fetch error:', error);
        flash(false, 'Failed to load requests: ' + (error?.message || JSON.stringify(error)));
      } finally {
        setOrgRequestsLoading(false);
      }
    })();
  }, [tab, currentUser?.id, isRoot]);


  const reviewOrgRequest = async (id: string, status: 'approved' | 'rejected', adminNote?: string) => {
    const { error } = await insforge.database
      .from('organizer_requests')
      .update({ status, admin_note: adminNote || null, reviewed_by: currentUser?.id, reviewed_at: new Date().toISOString() })
      .eq('id', id);
    if (!error) {
      setOrgRequests((prev) => prev.map((r) => r.id === id ? { ...r, status, admin_note: adminNote || null } : r));
      const req = orgRequests.find((r) => r.id === id);
      // If approved, update user role to organizer
      if (status === 'approved') {
        if (req?.user_id) {
          await insforge.database.rpc('admin_set_user_role', { p_user_id: req.user_id, p_new_role: 'organizer' });
        }
        if (req?.users?.phone_number) {
          sendSMS({
            to: req.users.phone_number,
            message: `Congratulations! Your request to become an organizer on Vents has been approved. You can now create and manage events. - Vents`,
          }).catch(() => {});
        }
      } else if (status === 'rejected') {
        if (req?.users?.phone_number) {
          sendSMS({
            to: req.users.phone_number,
            message: `Your organizer request on Vents was not approved at this time. Contact support@getvents.com for more information. - Vents`,
          }).catch(() => {});
        }
      }
      notifyByEmail('organizer', id, status, adminNote);
    }
  };

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const { data, error } = await insforge.database
        .from('events')
        .select('id, title, organizer_id, hidden_by_admin, hidden_at, created_at, status, image_url, event_date, users!events_organizer_id_fkey(username, full_name, is_verified)')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      setEvents(data || []);
    } catch (err: any) {
      flash(false, err?.message || 'Failed to load events.');
    } finally { setEventsLoading(false); }
  }, []);

  useEffect(() => {
    if ((!isAdminOrSubAdmin) || tab !== 'events') return;
    loadEvents();
  }, [tab, loadEvents, currentUser, isRoot]);

  useEffect(() => {
    if ((!isAdminOrSubAdmin) || tab !== 'reports') return;
    setReportsLoading(true);
    (async () => {
      try {
        const { data, error } = await insforge.database
          .from('reports')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(100);
        if (error) throw error;
        const reportsData = data || [];
        setReports(reportsData);

        // Fetch full relational data for reported users/events so the
        // Reports view shows more than raw UUIDs.
        const userIds = [...new Set(reportsData.filter(r => r.target_type === 'user').map(r => r.target_id))];
        const eventIds = [...new Set(reportsData.filter(r => r.target_type === 'event').map(r => r.target_id))];

        if (userIds.length > 0) {
          const { data: usersData } = await insforge.database
            .from('users')
            .select('id, username, full_name, email, avatar_url, is_verified, role, status')
            .in('id', userIds);
          setReportedUsers(Object.fromEntries((usersData || []).map((u: any) => [u.id, u])));
        }
        if (eventIds.length > 0) {
          const { data: eventsData } = await insforge.database
            .from('events')
            .select('id, title, image_url, hidden_by_admin')
            .in('id', eventIds);
          setReportedEvents(Object.fromEntries((eventsData || []).map((e: any) => [e.id, e])));
        }
      } catch (err) {
        console.error('Reports fetch error:', err);
      } finally {
        setReportsLoading(false);
      }
    })();
  }, [tab, isAdminOrSubAdmin]);

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
    const target = users.find(u => u.id === userId);
    if (isSubAdmin && target && ['admin', 'sub-admin'].includes(target.role)) {
      flash(false, 'Sub-Admins cannot alter Admin/Sub-Admin accounts.'); return;
    }
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
        await writeAuditLog(currentUser,'unsuspend_user', u.id, { target_email: u.email });
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
      await writeAuditLog(currentUser,'suspend_user', u.id, { target_email: u.email, ban_days: banDays ?? 'permanent', banned_until: bannedUntil });
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
          const deletedAt = new Date().toISOString();
          const { error } = await insforge.database.from('users').update({ status: 'deleted', deleted_at: deletedAt }).eq('id', u.id);
          if (error) throw error;
          await writeAuditLog(currentUser,'delete_user', u.id, { target_email: u.email });
          // Deleted users no longer show in the main Users list — they move
          // to the dedicated Deleted Users tab (queried on deleted_at).
          setUsers(prev => prev.filter(x => x.id !== u.id));
          flash(true, 'User deleted. Use Reinstate (Deleted Users tab) to restore.');
        } catch (err: any) {
          flash(false, err?.message || 'Failed to delete user.');
        } finally { setBusyId(null); }
      },
    });
  };

  const handleReinstate = async (u: UserRow) => {
    setBusyId(u.id);
    try {
      const { error } = await insforge.database.from('users').update({ status: 'active', banned_until: null, deleted_at: null }).eq('id', u.id);
      if (error) throw error;
      await writeAuditLog(currentUser,'reinstate_user', u.id, { target_email: u.email, previous_status: u.status });
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, status: 'active', banned_until: null, deleted_at: null } : x));
      setDeletedUsers(prev => prev.filter(x => x.id !== u.id));
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
      await writeAuditLog(currentUser,'toggle_verification', u.id, { is_verified: newVerified, target_email: u.email });
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
          await writeAuditLog(currentUser,next ? 'ROOT_maintenance_on' : 'ROOT_maintenance_off', null, {});
          setMaintenanceMode(next);
          flash(true, `Maintenance mode ${next ? 'enabled' : 'disabled'}.`);
        } catch (err: any) { flash(false, err?.message || 'Failed to update maintenance mode.'); }
      },
    });
  };

  const handleToggleVoiceNotes = () => {
    const next = !voiceNotesEnabled;
    setConfirmModal({
      title: next ? 'Enable Voice Notes' : 'Disable Voice Notes',
      message: next
        ? 'This will let all users record and send voice notes in chat again. Continue?'
        : 'This will hide the voice-note button and block recording for all users.',
      confirmLabel: next ? 'Enable' : 'Disable',
      danger: !next,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await insforge.database.from('app_config').update({ voice_notes_enabled: next, updated_by: currentUser.id }).eq('id', true);
          await writeAuditLog(currentUser,next ? 'ROOT_voice_notes_on' : 'ROOT_voice_notes_off', null, {});
          setVoiceNotesEnabled(next);
          flash(true, `Voice notes ${next ? 'enabled' : 'disabled'}.`);
        } catch (err: any) { flash(false, err?.message || 'Failed to update voice notes toggle.'); }
      },
    });
  };

  const handleToggleImageSharing = () => {
    const next = !imageSharingEnabled;
    setConfirmModal({
      title: next ? 'Enable Image Sharing' : 'Disable Image Sharing',
      message: next
        ? 'This will let all users send images in chat again. Continue?'
        : 'This will hide the image button and block sending images for all users.',
      confirmLabel: next ? 'Enable' : 'Disable',
      danger: !next,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await insforge.database.from('app_config').update({ image_sharing_enabled: next, updated_by: currentUser.id }).eq('id', true);
          await writeAuditLog(currentUser,next ? 'ROOT_image_sharing_on' : 'ROOT_image_sharing_off', null, {});
          setImageSharingEnabled(next);
          flash(true, `Image sharing ${next ? 'enabled' : 'disabled'}.`);
        } catch (err: any) { flash(false, err?.message || 'Failed to update image sharing toggle.'); }
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
          await writeAuditLog(currentUser,'ROOT_broadcast', null, { message: broadcastMsg, recipients: allUsers?.length ?? 0 });
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
          const { data, error } = await insforge.database.rpc('cleanup_orphaned_records' as any);
          if (error) throw error;
          const result = data as any;
          flash(true, `Cleaned up ${result?.tickets_cancelled ?? 0} orphaned ticket(s) and ${result?.saves_removed ?? 0} orphaned save(s).`);
        } catch (err: any) {
          flash(false, err?.message || 'Cleanup failed.');
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
          await writeAuditLog(currentUser,'ROOT_bulk_suspend_unverified', null, {});
          flash(true, 'Unverified accounts suspended.');
          loadUsers();
        } catch (err: any) { flash(false, err?.message || 'Bulk suspend failed.'); }
      },
    });
  };

  const handleHealthPing = async () => {
    setIsPinging(true);
    setHealthResult(null);
    const started = performance.now();
    try {
      const { data, error } = await insforge.database.rpc('admin_health_ping' as any);
      if (error) throw error;
      const latencyMs = Math.round(performance.now() - started);
      const result = data as any;
      setHealthResult({
        ok: true,
        latencyMs,
        detail: `DB reachable · ${result?.users_reachable ?? 0} users · ${result?.events_reachable ?? 0} events`,
      });
    } catch (err: any) {
      setHealthResult({ ok: false, latencyMs: Math.round(performance.now() - started), detail: err?.message || 'Health ping failed.' });
    } finally {
      setIsPinging(false);
    }
  };

  // ── Access guard ─────────────────────────────────────────────────────────────
  if (!isAdminOrSubAdmin) {
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
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
    'sub-admin': { text: '#F59E0B', bg: 'rgba(245,158,11,0.1)' },
    organizer: { text: '#A78BFA', bg: 'rgba(167,139,250,0.1)' },
    attendee: { text: '#60A5FA', bg: 'rgba(96,165,250,0.1)' },
  }[role] ?? { text: '#10B981', bg: 'rgba(16,185,129,0.1)' });

  const statusColour = (status: string) =>
    status === 'active' ? '#10B981' : status === 'suspended' ? '#F59E0B' : '#EF4444';

  const tabs = [
    { key: 'users' as Tab, label: 'Users', icon: <Users size={14} /> },
    { key: 'deleted' as Tab, label: 'Deleted Users', icon: <Trash2 size={14} /> },
    { key: 'events' as Tab, label: 'Events', icon: <Shield size={14} /> },
    { key: 'logs' as Tab, label: 'Audit Log', icon: <ClipboardList size={14} /> },
    { key: 'reports' as Tab, label: 'Reports', icon: <Flag size={14} /> },
    { key: 'vc' as Tab, label: 'VC', icon: <Swords size={14} /> },
    { key: 'stats' as Tab, label: 'Stats', icon: <Zap size={14} /> },
    { key: 'verify' as Tab, label: 'Verify', icon: <BadgeCheck size={14} /> },
    { key: 'payouts' as Tab, label: 'Payouts', icon: <Wallet size={14} /> },
    { key: 'org-requests' as Tab, label: 'Org Reqs', icon: <Megaphone size={14} /> },
    { key: 'import-events' as Tab, label: 'Import', icon: <Zap size={14} /> },
    ...(isRoot ? [{ key: 'system' as Tab, label: 'System', icon: <Settings size={14} /> }] : []),
  ];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'Inter, sans-serif' }}>

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
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 20px 14px', borderBottom: '1px solid rgba(168,85,247,0.1)', background: '#020005', flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div style={{ flex: 1 }}>
          <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
            Admin Console
            {isRoot && <span style={{ marginLeft: '8px', fontSize: '11px', color: '#A855F7', background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)', padding: '2px 8px', borderRadius: '6px', fontWeight: 700 }}>ROOT</span>}
            {isSubAdmin && <span style={{ marginLeft: '8px', fontSize: '11px', color: '#F59E0B', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)', padding: '2px 8px', borderRadius: '6px', fontWeight: 700 }}>SUB-ADMIN</span>}
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
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)', padding: '10px 14px', gap: '10px' }}>
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
            <button onClick={loadUsers} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '14px', padding: '0 14px', color: '#8B8FA8', cursor: 'pointer' }}>
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
                    <div key={u.id} style={{ background: '#090514', borderRadius: '16px', border: `1px solid ${isRootUser ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)'}`, padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px', opacity: isBusy ? 0.6 : 1, transition: 'opacity 0.2s' }}>

                      {/* Row: Name + badges */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <h4 style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, margin: 0 }}>
                              {u.full_name || 'No Name'}
                            </h4>
                            {u.is_verified && (
                              <span title="Verified" style={{ display: 'inline-flex' }}><BadgeCheck size={14} color="#3B82F6" /></span>
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
                          Joined {new Date(u.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
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
                        {isRootUser ? (
                          <span style={{ fontSize: '11px', color: '#A855F7', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Shield size={12} /> Root — role locked
                          </span>
                        ) : (
                          <select
                            value={['attendee', 'organizer'].includes(u.role) ? u.role : ''}
                            onChange={e => handleRoleChange(u.id, e.target.value)}
                            disabled={isBusy}
                            style={{ background: '#060A12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#F0F0FF', fontSize: '11px', padding: '4px 8px', outline: 'none', cursor: 'pointer' }}
                          >
                            {!['attendee', 'organizer'].includes(u.role) && (
                              <option value="" disabled>{u.role}</option>
                            )}
                            <option value="attendee">Attendee</option>
                            <option value="organizer">Organizer</option>
                          </select>
                        )}

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

                          {/* Ban / Unban */}
                          {u.status === 'suspended' ? (
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

                          {/* Delete — unmounted entirely for the Root account,
                              not merely disabled, per immutable-root policy */}
                          {!isRootUser && (
                            <button
                              onClick={() => handleSoftDelete(u)}
                              disabled={isBusy || u.id === currentUser?.id}
                              title="Delete account"
                              style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', padding: '5px 8px', color: '#EF4444', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
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

      {/* ════════════════ DELETED USERS TAB ═══════════════════════════════ */}
      {tab === 'deleted' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 40px' }}>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: 0, marginBottom: '12px' }}>
            Soft-deleted accounts (deleted_at set). Reinstating restores login and visibility immediately.
          </p>
          {deletedUsersLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading deleted users…</div>
          ) : deletedUsers.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>No deleted users.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {deletedUsers.map(u => {
                const isBusy = busyId === u.id;
                return (
                  <div key={u.id} style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(239,68,68,0.15)', padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px', opacity: isBusy ? 0.6 : 1 }}>
                    <div>
                      <h4 style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, margin: 0 }}>{u.full_name || 'No Name'}</h4>
                      <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '2px 0 0' }}>@{u.username || 'no_username'} · {u.email}</p>
                    </div>
                    <p style={{ color: '#EF4444', fontSize: '11px', margin: 0 }}>
                      Deleted {u.deleted_at ? new Date(u.deleted_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown time'}
                    </p>
                    <button
                      onClick={() => handleReinstate(u)}
                      disabled={isBusy}
                      style={{ alignSelf: 'flex-start', background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', padding: '6px 12px', color: '#10B981', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600 }}
                    >
                      <UserCheck size={13} /> Reinstate
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ════════════════ EVENTS TAB ══════════════════════════════════════ */}
      {tab === 'events' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 40px' }}>
          {/* Event search bar */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.07)', padding: '10px 14px', gap: '10px' }}>
              <Search size={15} color="#8B8FA8" />
              <input
                type="text"
                placeholder="Search events by title…"
                value={eventSearch}
                onChange={e => setEventSearch(e.target.value)}
                style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: '#F0F0FF', fontSize: '13px' }}
              />
            </div>
            <button onClick={loadEvents} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '14px', padding: '0 14px', color: '#8B8FA8', cursor: 'pointer' }}>
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
              {(eventSearch ? events.filter(ev => ev.title?.toLowerCase().includes(eventSearch.toLowerCase())) : events).map(ev => {
                const organizer = ev['users!events_organizer_id_fkey'];
                return (
                <div key={ev.id} style={{ background: '#090514', borderRadius: '14px', border: `1px solid ${ev.hidden_by_admin ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.04)'}`, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ width: '48px', height: '48px', borderRadius: '10px', overflow: 'hidden', flexShrink: 0, background: 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {ev.image_url
                      ? <img src={ev.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <Shield size={18} color="#555C7A" />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ color: ev.hidden_by_admin ? '#EF4444' : '#F0F0FF', fontSize: '13px', fontWeight: 600, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ev.title || '(Untitled)'}
                    </span>
                    <span style={{ color: '#8B8FA8', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                      <span style={{ color: ev.hidden_by_admin ? '#EF4444' : '#10B981', fontWeight: 600 }}>
                        {ev.hidden_by_admin ? 'Hidden' : 'Visible'}
                      </span>
                      · {organizer?.username ? `@${organizer.username}` : 'Unknown organizer'}
                      {organizer?.is_verified && <BadgeCheck size={12} color="#3B82F6" />}
                    </span>
                    <span style={{ color: '#555C7A', fontSize: '10px', display: 'block', marginTop: '2px' }}>
                      Created {new Date(ev.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}
                      {ev.event_date && ` · Event date ${new Date(ev.event_date).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}`}
                      {ev.hidden_by_admin && ev.hidden_at && ` · Hidden ${new Date(ev.hidden_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}`}
                    </span>
                  </div>
                  <button
                    onClick={() => ev.hidden_by_admin ? handleReinstateEvent(ev.id) : setConfirmModal({ title: 'Hide Event?', message: `Hide "${ev.title || 'this event'}" from all public feeds? You can reinstate it later.`, confirmLabel: 'Hide', danger: true, onConfirm: () => { setConfirmModal(null); handleHideEvent(ev.id); } })}
                    style={{ background: ev.hidden_by_admin ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${ev.hidden_by_admin ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`, borderRadius: '10px', padding: '6px 12px', color: ev.hidden_by_admin ? '#10B981' : '#EF4444', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
                  >
                    {ev.hidden_by_admin ? 'Reinstate' : 'Hide'}
                  </button>
                </div>
                );
              })}
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
                  <div key={log.id} style={{ background: '#090514', borderRadius: '14px', border: `1px solid ${isRootAction ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.04)'}`, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: actionColor, background: `${actionColor}18`, padding: '2px 8px', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {isRootAction && <Zap size={10} />}
                        {log.action.replace(/_/g, ' ')}
                      </span>
                      <span style={{ color: '#8B8FA8', fontSize: '10px' }}>
                        {new Date(log.created_at).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' })}
                      </span>
                    </div>
                    {log.actor_role && (
                      <span style={{
                        alignSelf: 'flex-start', fontSize: '9px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                        color: log.actor_role === 'root' ? '#A855F7' : log.actor_role === 'sub-admin' ? '#F59E0B' : '#EF4444',
                        background: log.actor_role === 'root' ? 'rgba(168,85,247,0.12)' : log.actor_role === 'sub-admin' ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)',
                        padding: '2px 6px', borderRadius: '4px',
                      }}>
                        Executed by: {log.actor_role === 'root' ? 'Root' : log.actor_role === 'sub-admin' ? 'Sub-Admin' : log.actor_role === 'admin' ? 'Admin' : log.actor_role}
                      </span>
                    )}
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
                const reportedUser = r.target_type === 'user' ? reportedUsers[r.target_id] : null;
                const reportedEvent = r.target_type === 'event' ? reportedEvents[r.target_id] : null;
                return (
                  <div key={r.id} style={{ background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)', padding: '12px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                      <div>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: statusColor, background: `${statusColor}20`, padding: '2px 8px', borderRadius: '6px' }}>{r.status}</span>
                        <span style={{ fontSize: '11px', color: '#A78BFA', marginLeft: '8px', background: 'rgba(167,139,250,0.12)', padding: '2px 8px', borderRadius: '6px' }}>{r.target_type}</span>
                      </div>
                      <span style={{ color: '#555C7A', fontSize: '10px' }}>{new Date(r.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    </div>

                    {/* Reported entity — full relational data instead of a raw UUID */}
                    {reportedUser ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', padding: '8px 10px', margin: '0 0 8px' }}>
                        <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(167,139,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden' }}>
                          {reportedUser.avatar_url
                            ? <img src={reportedUser.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            : <span style={{ color: '#A78BFA', fontSize: '12px', fontWeight: 700 }}>{(reportedUser.full_name || reportedUser.username || '?')[0].toUpperCase()}</span>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 600 }}>{reportedUser.full_name || reportedUser.username || 'Unknown'}</span>
                            {reportedUser.is_verified && <BadgeCheck size={12} color="#3B82F6" />}
                            <span style={{ fontSize: '9px', color: statusColour(reportedUser.status), fontWeight: 600 }}>● {reportedUser.status}</span>
                          </div>
                          <span style={{ color: '#8B8FA8', fontSize: '11px' }}>@{reportedUser.username} · {reportedUser.email}</span>
                        </div>
                      </div>
                    ) : reportedEvent ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', padding: '8px 10px', margin: '0 0 8px' }}>
                        <div style={{ width: '28px', height: '28px', borderRadius: '8px', overflow: 'hidden', flexShrink: 0, background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {reportedEvent.image_url
                            ? <img src={reportedEvent.image_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            : <Shield size={13} color="#555C7A" />}
                        </div>
                        <span style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 600 }}>
                          {reportedEvent.title || '(Untitled event)'}{reportedEvent.hidden_by_admin ? ' · Hidden' : ''}
                        </span>
                      </div>
                    ) : (
                      <p style={{ color: '#555C7A', fontSize: '10px', margin: '0 0 8px', fontFamily: 'monospace' }}>Target: {r.target_id}</p>
                    )}

                    <p style={{ color: '#C4C9E0', fontSize: '13px', fontWeight: 600, margin: '0 0 4px' }}>{r.reason}</p>
                    {r.details && <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '0 0 6px' }}>{r.details}</p>}
                    <p style={{ color: '#555C7A', fontSize: '10px', margin: '0 0 10px' }}>
                      Reporter: {r.reporter_id?.slice(0, 8)}…
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
              <div key={card.label} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '14px 16px', boxSizing: 'border-box' }}>
                <div style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>{card.label}</div>
                <div style={{ color: '#F0F0FF', fontSize: '22px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>{vcLoading ? '…' : card.value}</div>
              </div>
            ))}
          </div>

          {/* VC Transactions log */}
          <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', overflow: 'hidden', boxSizing: 'border-box' }}>
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
          <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', overflow: 'hidden', boxSizing: 'border-box' }}>
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
          <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', boxSizing: 'border-box' }}>
            <div style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>Admin Transfer</div>

            {/* User search */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input
                placeholder="Search by name, @username, email, or UUID"
                value={vcSearch}
                onChange={e => setVcSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleVcUserSearch()}
                style={{ flex: 1, minWidth: '160px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
              />
              <button onClick={handleVcUserSearch} disabled={vcSearching} style={{ background: 'rgba(167,139,250,0.15)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: '10px', padding: '0 12px', color: '#A78BFA', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>
                {vcSearching ? '…' : 'Find'}
              </button>
            </div>

            {/* Search results — capped and internally scrollable, matching
                the VC Transactions/Purchases lists below, so an unbounded
                result set can't push the Amount/Reason inputs and submit
                button down the page. */}
            {vcSearchResults.length > 0 && (
              <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', maxHeight: '240px', overflowY: 'auto' }}>
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
              style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
            />
            <input
              placeholder="Reason (required)"
              value={vcTransfer.reason}
              onChange={e => setVcTransfer(v => ({ ...v, reason: e.target.value }))}
              style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: `1px solid ${vcTransfer.reason.trim() ? 'rgba(255,255,255,0.1)' : 'rgba(239,68,68,0.3)'}`, borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
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

          {/* Admin Debit / Claw-back — reuses the same search/select above */}
          <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '16px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px', boxSizing: 'border-box' }}>
            <div style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>Admin Debit / Claw-back</div>
            <div style={{ color: '#8B8FA8', fontSize: '11px' }}>Uses the user selected above. Fails if their balance is insufficient.</div>
            <input
              placeholder="Amount (VC)"
              type="number"
              min="1"
              value={vcDebit.amount}
              onChange={e => setVcDebit(v => ({ ...v, amount: e.target.value }))}
              style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
            />
            <input
              placeholder="Reason (required)"
              value={vcDebit.reason}
              onChange={e => setVcDebit(v => ({ ...v, reason: e.target.value }))}
              style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: `1px solid ${vcDebit.reason.trim() ? 'rgba(255,255,255,0.1)' : 'rgba(239,68,68,0.3)'}`, borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }}
            />
            {vcDebitMsg && <div style={{ color: vcDebitMsg.startsWith('✓') ? '#10B981' : '#EF4444', fontSize: '12px' }}>{vcDebitMsg}</div>}
            <button
              onClick={handleVcAdminDebit}
              disabled={vcDebitBusy || !vcTransfer.userId || !vcDebit.reason.trim()}
              style={{ background: 'linear-gradient(135deg, #DC2626, #B91C1C)', border: 'none', borderRadius: '12px', padding: '12px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: (vcDebitBusy || !vcTransfer.userId || !vcDebit.reason.trim()) ? 'not-allowed' : 'pointer', opacity: (vcDebitBusy || !vcTransfer.userId || !vcDebit.reason.trim()) ? 0.5 : 1 }}
            >
              {vcDebitBusy ? 'Debiting…' : 'Debit VC from User'}
            </button>
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
              <p style={{ color: '#555C7A', fontSize: '11px', textAlign: 'center', marginTop: '8px' }}>Live — updates automatically as transactions, payouts, and signups happen.</p>
            </>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>No data.</div>
          )}
        </div>
      )}

      {/* ════════════════ ORGANIZER VERIFICATION TAB ══════════════════════ */}
      {tab === 'verify' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 40px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
            {(['cac', 'unverified'] as const).map(s => (
              <button key={s} onClick={() => setVerifySection(s)}
                style={{ padding: '6px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '12px', background: verifySection === s ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)', color: verifySection === s ? '#A855F7' : '#8B8FA8' }}>
                {s === 'cac' ? 'CAC Requests' : 'Unverified Organizers'}
              </button>
            ))}
          </div>

          {verifySection === 'cac' ? (
            cacRequestsLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading…</div>
            ) : cacRequests.length === 0 ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>No pending brand verification requests</div>
            ) : cacRequests.map((r: any) => {
              const expanded = expandedCacId === r.request_id;
              return (
                <div key={r.request_id} style={{ background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div onClick={() => setExpandedCacId(expanded ? null : r.request_id)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', cursor: 'pointer' }}>
                    <div>
                      <div style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>{r.company_name}</div>
                      <div style={{ color: '#8B8FA8', fontSize: '12px' }}>{r.full_name || 'No Name'} · {r.state || 'No state'}</div>
                      <div style={{ color: '#555C7A', fontSize: '11px' }}>{r.email}</div>
                    </div>
                    <span style={{ fontSize: '10px', color: '#F59E0B', background: 'rgba(245,158,11,0.1)', padding: '2px 8px', borderRadius: '6px', fontWeight: 600 }}>PENDING</span>
                  </div>
                  <div style={{ color: '#555C7A', fontSize: '10px' }}>Submitted {new Date(r.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</div>
                  {expanded && (
                    <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <p style={{ margin: 0, fontSize: '12px', color: '#C4C9E0' }}><strong style={{ color: '#8B8FA8' }}>CAC Number:</strong> {r.cac_number}</p>
                      <p style={{ margin: 0, fontSize: '12px', color: '#C4C9E0' }}><strong style={{ color: '#8B8FA8' }}>Business Address:</strong> {r.business_address}</p>
                      <p style={{ margin: 0, fontSize: '12px', color: '#C4C9E0' }}><strong style={{ color: '#8B8FA8' }}>Phone:</strong> {r.phone_number || '—'}</p>
                      <a href={r.document_url} target="_blank" rel="noopener noreferrer" style={{ color: '#A855F7', fontSize: '12px', fontWeight: 600, textDecoration: 'underline' }}>View uploaded CAC document ↗</a>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => handleApproveCac(r.request_id)}
                      disabled={cacActionLoading === r.request_id}
                      style={{ flex: 1, background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '10px', padding: '8px', color: '#10B981', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: cacActionLoading === r.request_id ? 0.6 : 1 }}
                    >
                      {cacActionLoading === r.request_id ? 'Processing…' : 'Approve & Verify Brand'}
                    </button>
                    <button
                      onClick={() => handleRejectCac(r.request_id)}
                      disabled={cacActionLoading === r.request_id}
                      style={{ flex: 1, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '8px', color: '#EF4444', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: cacActionLoading === r.request_id ? 0.6 : 1 }}
                    >
                      Reject Verification
                    </button>
                  </div>
                </div>
              );
            })
          ) : pendingOrgsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading…</div>
          ) : pendingOrgs.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>All organizers verified ✓</div>
          ) : pendingOrgs.map(u => (
            <div key={u.id} style={{ background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
                      await writeAuditLog(currentUser,'verify_organizer', u.id, { username: u.username, email: u.email });
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
                      await writeAuditLog(currentUser,'reject_organizer', u.id, { username: u.username });
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
      {tab === 'payouts' && <PayoutsTab flash={flash} />}

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
                <div key={req.id} style={{ background: '#090514', borderRadius: '14px', padding: '14px', marginBottom: '10px', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{name}</span>
                    <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '8px', background: req.status === 'pending' ? 'rgba(245,158,11,0.15)' : req.status === 'approved' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)', color: req.status === 'pending' ? '#F59E0B' : req.status === 'approved' ? '#10B981' : '#EF4444', textTransform: 'uppercase' as const }}>
                      {req.status}
                    </span>
                  </div>
                  {(user?.email || user?.phone_number || user?.state) && (
                    <p style={{ color: '#6B7280', fontSize: '11px', margin: '0 0 8px' }}>
                      {[user?.email, user?.phone_number, user?.state].filter(Boolean).join(' · ')}
                    </p>
                  )}
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

      {/* ════════════════ IMPORT EVENTS TAB ═══════════════ */}
      {tab === 'import-events' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 40px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Header */}
          <div style={{ background: 'rgba(123,47,247,0.08)', border: '1px solid rgba(123,47,247,0.25)', borderRadius: '16px', padding: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: 'linear-gradient(135deg, #7B2FF7, #F107A3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Zap size={20} color="#fff" />
            </div>
            <div>
              <h3 style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800, margin: 0, fontFamily: 'Space Grotesk, sans-serif' }}>Import Free Events</h3>
              <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '2px 0 0' }}>Copy event details from tix.africa, pulse.ng or any site and paste below. AI will format and categorise them instantly.</p>
            </div>
          </div>

          {/* Paste input */}
          <div>
            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', marginBottom: '8px' }}>PASTE EVENT DETAILS</p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={`Paste event details here — copy from any website:\n\nEvent Name: \nDate: \nTime: \nVenue: \nCity/State: \nDescription: \nPrice: Free\n\nYou can paste multiple events separated by ---`}
              rows={10}
              style={{ width: '100%', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px 14px', color: '#F0F0FF', fontSize: '13px', outline: 'none', fontFamily: 'Inter, sans-serif', boxSizing: 'border-box', resize: 'vertical', lineHeight: 1.6 }}
            />
          </div>

          {/* Extract button */}
          <button
            onClick={async () => {
              if (!importText.trim()) return;
              setImportLoading(true);
              setImportError(null);
              setImportResults([]);
              setSelectedImports(new Set());
              setPublishMsg(null);
              try {
                const results = await extractEventsFromText(importText.trim());
                setImportResults(results);
                if (results.length === 0) setImportError('No events found. Try adding more details like event name, date, and venue.');
                else setSelectedImports(new Set(results.map((_, i) => i)));
              } catch (err: any) {
                setImportError(err?.message || 'Failed to format events. Check your API key and try again.');
              } finally {
                setImportLoading(false);
              }
            }}
            disabled={importLoading || !importText.trim()}
            style={{ width: '100%', background: importLoading || !importText.trim() ? 'rgba(123,47,247,0.3)' : 'linear-gradient(135deg, #7B2FF7, #F107A3)', border: 'none', borderRadius: '12px', padding: '14px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: importLoading || !importText.trim() ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
          >
            {importLoading ? (
              <>
                <div style={{ width: '14px', height: '14px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
                Formatting with AI...
              </>
            ) : (
              <><Zap size={14} /> Format with AI</>
            )}
          </button>

          {importError && (
            <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '10px', padding: '12px', color: '#EF4444', fontSize: '13px' }}>
              {importError}
            </div>
          )}

          {/* Results */}
          {importResults.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>{importResults.length} free event{importResults.length !== 1 ? 's' : ''} found</p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => setSelectedImports(new Set(importResults.map((_, i) => i)))} style={{ background: 'none', border: '1px solid rgba(167,139,250,0.3)', borderRadius: '8px', padding: '4px 10px', color: '#A78BFA', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>All</button>
                  <button onClick={() => setSelectedImports(new Set())} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '4px 10px', color: '#8B8FA8', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>None</button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {importResults.map((event, i) => {
                  const selected = selectedImports.has(i);
                  return (
                    <div
                      key={i}
                      onClick={() => {
                        const next = new Set(selectedImports);
                        if (selected) next.delete(i); else next.add(i);
                        setSelectedImports(next);
                      }}
                      style={{ background: selected ? 'rgba(123,47,247,0.08)' : '#131629', border: selected ? '1.5px solid rgba(123,47,247,0.4)' : '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '14px', cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                        <div style={{ width: '18px', height: '18px', borderRadius: '5px', border: selected ? 'none' : '2px solid rgba(255,255,255,0.2)', background: selected ? '#7B2FF7' : 'transparent', flexShrink: 0, marginTop: '2px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {selected && <span style={{ color: '#fff', fontSize: '11px', fontWeight: 800 }}>✓</span>}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 700, margin: '0 0 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.title}</p>
                          <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '0 0 4px' }}>{event.date} {event.time && `· ${event.time}`} · {event.location}</p>
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            <span style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '5px', padding: '2px 7px', color: '#10B981', fontSize: '10px', fontWeight: 600 }}>FREE</span>
                            {event.category && <span style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '5px', padding: '2px 7px', color: '#A78BFA', fontSize: '10px' }}>{event.category}</span>}
                            {event.state && <span style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '5px', padding: '2px 7px', color: '#8B8FA8', fontSize: '10px' }}>{event.state}</span>}
                          </div>
                          {event.description && <p style={{ color: '#6B7280', fontSize: '11px', margin: '6px 0 0', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{event.description}</p>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Publish button */}
              <button
                onClick={async () => {
                  const toPublish = importResults.filter((_, i) => selectedImports.has(i));
                  if (toPublish.length === 0) return;
                  setPublishLoading(true);
                  setPublishMsg(null);
                  try {
                    const result = await publishEvents(toPublish, 'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc', insforge.database);
                    if (result.success > 0) {
                      setPublishMsg(`✓ Published ${result.success} event${result.success !== 1 ? 's' : ''} successfully${result.failed > 0 ? ` (${result.failed} failed)` : ''}.`);
                      setImportResults([]);
                      setSelectedImports(new Set());
                      setImportText('');
                    } else {
                      setPublishMsg(`✗ All ${result.failed} event${result.failed !== 1 ? 's' : ''} failed to publish.${result.lastError ? ` Error: ${result.lastError}` : ''}`);
                    }
                  } catch (err: any) {
                    setPublishMsg(`✗ ${err?.message || 'Publish failed.'}`);
                  } finally {
                    setPublishLoading(false);
                  }
                }}
                disabled={publishLoading || selectedImports.size === 0}
                style={{ width: '100%', background: publishLoading || selectedImports.size === 0 ? 'rgba(123,47,247,0.3)' : '#7B2FF7', border: 'none', borderRadius: '12px', padding: '14px', color: '#fff', fontSize: '14px', fontWeight: 700, cursor: publishLoading || selectedImports.size === 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', boxShadow: selectedImports.size > 0 ? '0 4px 16px rgba(123,47,247,0.4)' : 'none' }}
              >
                {publishLoading ? (
                  <>
                    <div style={{ width: '14px', height: '14px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />
                    Publishing...
                  </>
                ) : (
                  `Publish ${selectedImports.size} Selected Event${selectedImports.size !== 1 ? 's' : ''}`
                )}
              </button>
            </>
          )}

          {publishMsg && (
            <div style={{ background: publishMsg.startsWith('✓') ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${publishMsg.startsWith('✓') ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.25)'}`, borderRadius: '10px', padding: '12px', color: publishMsg.startsWith('✓') ? '#10B981' : '#EF4444', fontSize: '13px', fontWeight: 600 }}>
              {publishMsg}
            </div>
          )}

          {/* Instructions — only show if API key not configured */}
          {!import.meta.env.VITE_ANTHROPIC_API_KEY && (
            <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '12px', padding: '14px' }}>
              <p style={{ color: '#F59E0B', fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', marginBottom: '8px' }}>⚠ SETUP REQUIRED</p>
              <p style={{ color: '#6B7280', fontSize: '12px', lineHeight: 1.6 }}>
                Add <span style={{ color: '#A78BFA', fontFamily: 'monospace' }}>VITE_ANTHROPIC_API_KEY</span> in Vercel dashboard → Vents project → Settings → Environment Variables. Get your key from <span style={{ color: '#A78BFA' }}>console.anthropic.com → API Keys</span>. Redeploy after adding.
              </p>
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
          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px' }}>
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

          {/* Voice Notes toggle (MVP launch kill switch — off by default, see
              migrations/20260710185537_media-feature-toggles.sql) */}
          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: voiceNotesEnabled ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Mic size={17} color={voiceNotesEnabled ? '#10B981' : '#C4C9E0'} />
                </div>
                <div>
                  <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Voice Notes</p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                    {voiceNotesEnabled ? 'Enabled — users can record voice notes' : 'Disabled for MVP launch stability'}
                  </p>
                </div>
              </div>
              <div onClick={handleToggleVoiceNotes} style={{ cursor: 'pointer' }}>
                {voiceNotesEnabled
                  ? <ToggleRight size={32} color="#10B981" />
                  : <ToggleLeft size={32} color="#555C7A" />}
              </div>
            </div>
          </div>

          {/* Image Sharing toggle */}
          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: imageSharingEnabled ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ImageIcon size={17} color={imageSharingEnabled ? '#10B981' : '#C4C9E0'} />
                </div>
                <div>
                  <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Image Sharing</p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                    {imageSharingEnabled ? 'Enabled — users can send images in chat' : 'Disabled'}
                  </p>
                </div>
              </div>
              <div onClick={handleToggleImageSharing} style={{ cursor: 'pointer' }}>
                {imageSharingEnabled
                  ? <ToggleRight size={32} color="#10B981" />
                  : <ToggleLeft size={32} color="#555C7A" />}
              </div>
            </div>
          </div>

          {/* Global Broadcast */}
          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
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

          {/* Orphaned Record Cleanup */}
          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
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

          {/* Server Health Ping */}
          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(16,185,129,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Activity size={17} color="#10B981" />
              </div>
              <div>
                <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Server Health Ping</p>
                <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>Round-trip through auth, DB and RLS</p>
              </div>
            </div>
            <button
              onClick={handleHealthPing}
              disabled={isPinging}
              style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '12px', padding: '12px', color: '#10B981', fontSize: '14px', fontWeight: 700, cursor: 'pointer' }}
            >
              {isPinging ? 'Pinging…' : 'Run Health Ping'}
            </button>
            {healthResult && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderRadius: '10px',
                background: healthResult.ok ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${healthResult.ok ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
              }}>
                <span style={{ color: healthResult.ok ? '#10B981' : '#EF4444', fontSize: '12px', fontWeight: 700 }}>
                  {healthResult.ok ? `Healthy — ${healthResult.latencyMs}ms` : `Unhealthy — ${healthResult.latencyMs}ms`}
                </span>
                <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{healthResult.detail}</span>
              </div>
            )}
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
