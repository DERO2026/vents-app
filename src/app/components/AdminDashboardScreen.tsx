import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowLeft, Search, Shield, UserCheck, AlertCircle,
  UserX, Trash2, RefreshCw, ClipboardList, Users,
  Zap, Settings, Bell, Wrench, ToggleLeft, ToggleRight,
  Copy, CheckCircle, BadgeCheck, Megaphone, Swords, Flag, Wallet,
  Mic, Image as ImageIcon, Activity, ShieldCheck,
  Ticket, ScanLine, UserPlus, Banknote, MapPin,
  Briefcase, Plus, Pencil,
} from 'lucide-react';
import { Sentry } from '../../lib/sentry';
import { supabase, getAuthToken } from '../../lib/supabase';
import { apiUrl } from '../../lib/apiBase';
import { escapePostgrestOrValue } from '../../lib/sanitize';
import { isRoot as permIsRoot, isAdminTier as permIsAdminTier, isSuperAdmin as permIsSuperAdmin } from '../../lib/permissions';
import { triggerPushDelivery } from '../../lib/pushNotifications';
import { AdminActionsTab } from './AdminActionsTab';
import { uploadImage } from '../../lib/mediaPipeline';
import { appVersionLabel } from '../../lib/appVersion';
import { withTimeoutFallback } from '../../lib/withTimeoutFallback';
import { SERVICE_CATEGORIES } from '../../lib/servicesDesignTokens';
import { COUNTRY_CODES } from '../../lib/countries';
import { PickerField, PickerSheet } from './shared/PickerSheet';
import { CURRENCIES } from '../../lib/currencies';
import {
  fetchOwnServicesForProvider as fetchServicesForProviderId,
  createProviderService, updateProviderService, setProviderServiceActive, deleteProviderService,
  ProviderServiceInput,
} from '../../lib/providerServices';
import { ProviderService } from './types';

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
  admin_id: string | null;
  target_user_id: string | null;
  actor_role?: string | null;
}

type Tab = 'admin-actions' | 'users' | 'events' | 'logs' | 'reports' | 'vc' | 'stats' | 'verify' | 'payouts' | 'system' | 'org-requests' | 'sp-requests' | 'services-admin' | 'deleted';

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
  deleted_at: string | null;
  is_featured: boolean;
  featured_until: string | null;
  'users!events_organizer_id_fkey'?: { username: string | null; full_name: string | null; is_verified: boolean } | null;
}

// ─── Confirm Modal ─────────────────────────────────────────────────────────────
function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  danger = true,
  // When set, the confirm button stays disabled until the admin types this
  // exact word (case-insensitive) — the "type CANCEL/REFUND to confirm"
  // guard for the payout split-action work (Block 17).
  typedConfirmationText,
  // Was window.prompt() called separately BEFORE this modal, which is
  // unreliable inside a Capacitor WebView. When set, renders a reason
  // textarea inline and passes its value to onConfirm instead. `requireReason`
  // additionally blocks confirm until non-empty; `optionalReason` shows the
  // field but allows an empty reason through (matches the prior window.prompt
  // behavior where cancelling/leaving it blank still proceeded with null).
  requireReason,
  optionalReason,
  reasonPlaceholder = 'Reason (shown to the affected user)',
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  typedConfirmationText?: string;
  requireReason?: boolean;
  optionalReason?: boolean;
  reasonPlaceholder?: string;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}) {
  const [typedValue, setTypedValue] = useState('');
  const [reasonValue, setReasonValue] = useState('');
  const showReasonField = requireReason || optionalReason;
  const typedMatches = !typedConfirmationText || typedValue.trim().toUpperCase() === typedConfirmationText.toUpperCase();
  const reasonOk = !requireReason || reasonValue.trim().length > 0;

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
        {typedConfirmationText && (
          <div style={{ marginBottom: '20px', textAlign: 'left' }}>
            <p style={{ color: '#8B8FA8', fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', marginBottom: '6px' }}>
              Type <span style={{ color: '#EF4444' }}>{typedConfirmationText}</span> to confirm
            </p>
            <input
              autoFocus
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder={typedConfirmationText}
              style={{ width: '100%', background: '#060A12', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '14px', fontWeight: 700, letterSpacing: '0.05em', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
        )}
        {showReasonField && (
          <div style={{ marginBottom: '20px', textAlign: 'left' }}>
            <textarea
              autoFocus
              value={reasonValue}
              onChange={(e) => setReasonValue(e.target.value)}
              placeholder={reasonPlaceholder}
              rows={3}
              style={{ width: '100%', background: '#060A12', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', boxSizing: 'border-box', resize: 'none' }}
            />
          </div>
        )}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onCancel} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', padding: '12px', color: '#C4C9E0', fontSize: '14px', fontWeight: 600, cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            onClick={() => onConfirm(showReasonField ? reasonValue.trim() : undefined)}
            disabled={!typedMatches || !reasonOk}
            style={{
              flex: 1,
              background: (!typedMatches || !reasonOk) ? 'rgba(255,255,255,0.05)' : danger ? 'rgba(239,68,68,0.15)' : 'rgba(168,85,247,0.15)',
              border: `1px solid ${(!typedMatches || !reasonOk) ? 'rgba(255,255,255,0.1)' : danger ? 'rgba(239,68,68,0.4)' : 'rgba(168,85,247,0.4)'}`,
              borderRadius: '12px', padding: '12px',
              color: (!typedMatches || !reasonOk) ? '#555C7A' : danger ? '#EF4444' : '#A855F7',
              fontSize: '14px', fontWeight: 700,
              cursor: (typedMatches && reasonOk) ? 'pointer' : 'not-allowed',
            }}
          >
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
  await supabase
    .from('admin_logs')
    .insert([{ admin_id: actor.id, action, target_user_id: targetUserId, details, actor_role: actorRole }]);
}

// Fires the confirmation/rejection email after an admin action succeeds.
// Module-scope (not tied to a specific component) since both PayoutsTab and
// the main AdminDashboardScreen component call it.
async function notifyByEmail(requestType: 'organizer' | 'cac' | 'payout', requestId: string, decision: 'approved' | 'rejected', reason?: string) {
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
  // Kill switch (app_config.disable_payouts) — the payout RPCs already
  // reject with 'payouts_disabled' server-side; this is purely so the
  // admin sees why the buttons are greyed out instead of hitting an error.
  const [payoutsDisabled, setPayoutsDisabled] = useState(false);
  useEffect(() => {
    supabase.from('app_config').select('disable_payouts').maybeSingle()
      .then(({ data }) => setPayoutsDisabled(!!data?.disable_payouts), () => {});
  }, []);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'all'>('pending');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'requests' | 'wallets'>('requests');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  // Split from the processing-state action (Block 17): a pending request
  // was never sent to Paystack at all, so rejecting it is a low-risk,
  // purely-internal state change — separate confirmation gate, separate
  // muted styling, from the processing-state "Refund Funds" action below.
  const [rejectConfirmId, setRejectConfirmId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // ROOT-CAUSE FIX (Admin Console "buffering" audit): neither request
      // here had a timeout -- a hung Supabase call (network stall, a slow
      // admin_list_pending_payouts join) left `loading` true indefinitely
      // with no recovery, same failure mode already fixed once in
      // AuthScreen.tsx but never applied to this tab.
      const [reqRes, walRes] = await withTimeoutFallback(
        Promise.all([
        // admin_list_pending_payouts is SECURITY DEFINER + is_admin()-gated —
        // it joins organizer + bank metadata server-side in one call, so the
        // panel always shows Name/Email/Phone/Amount/Bank/recipient_code.
        statusFilter === 'pending'
          ? supabase.rpc('admin_list_pending_payouts' as any)
          : supabase
              .from('organizer_withdrawal_requests')
              .select('id, organizer_id, amount_kobo, status, created_at, updated_at, admin_note, organizer_bank_accounts(bank_name, account_number, account_name, recipient_code), users!organizer_withdrawal_requests_organizer_id_public_users_fkey(username, full_name, email, phone_number)')
              .order('created_at', { ascending: false })
              .limit(50),
        supabase
          .from('organizer_wallets')
          .select('organizer_id, balance_kobo, pending_kobo, total_earned_kobo, total_withdrawn_kobo')
          .order('balance_kobo', { ascending: false })
          .limit(100),
        ]),
        { timeoutMs: 15000, timeoutMessage: 'This is taking longer than expected. Please check your connection and try again.' }
      );
      const { data: reqs, error: reqError } = reqRes;
      const { data: walsRaw, error: walError } = walRes;
      if (reqError || walError) {
        console.error('PayoutsTab load error:', reqError || walError);
        Sentry.captureException(reqError || walError);
        setLoadError((reqError || walError)?.message || 'Failed to load payouts.');
      }
      // organizer_wallets FK points to auth.users — PostgREST can't embed it.
      // Look up usernames from public.users separately.
      let wals = walsRaw || [];
      if (wals.length > 0) {
        const ids = wals.map((w: any) => w.organizer_id);
        const { data: userRows } = await supabase
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
      Sentry.captureException(err);
      setLoadError(err?.message || 'Failed to load payouts.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/admin-payout-action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'approve', request_id: id }),
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

  const handleReject = async (id: string, reason: string) => {
    if (!reason.trim()) return;
    setActionLoading(id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/admin-payout-action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'reject', request_id: id, reason: reason.trim() }),
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
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/reconcile-payouts'), {
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

  const handleCancelConfirmed = async (id: string, reason: string) => {
    setCancelConfirmId(null);
    if (!reason.trim()) return;
    setActionLoading(id);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/admin-payout-action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'cancel', request_id: id, reason: reason.trim() }),
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
      {payoutsDisabled && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '12px', padding: '12px 16px' }}>
          <p style={{ margin: 0, fontSize: '13px', color: '#EF4444', fontWeight: 700 }}>⚠ Payouts are temporarily disabled platform-wide</p>
          <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#8B8FA8' }}>Approve/Cancel/Refund actions are paused until this kill switch is turned off in System Controller.</p>
        </div>
      )}
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
                      disabled={actionLoading === pendingReq.request_id || payoutsDisabled}
                      style={{ flex: 1, background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '10px', padding: '8px', color: '#10B981', fontWeight: 700, fontSize: '13px', cursor: 'pointer', opacity: actionLoading === pendingReq.request_id ? 0.6 : 1 }}>
                      {actionLoading === pendingReq.request_id ? 'Processing…' : 'Approve & Pay'}
                    </button>
                    <button
                      onClick={() => setRejectConfirmId(pendingReq.request_id)}
                      disabled={actionLoading === pendingReq.request_id || payoutsDisabled}
                      title="Rejects the request — funds stay in the platform, nothing is sent to Paystack"
                      style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px', padding: '8px', color: '#C4C9E0', fontWeight: 700, fontSize: '13px', cursor: 'pointer', opacity: actionLoading === pendingReq.request_id ? 0.6 : 1 }}>
                      Cancel Request
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
                    disabled={actionLoading === r.request_id || payoutsDisabled}
                    style={{ flex: 1, background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '10px', padding: '8px', color: '#10B981', fontWeight: 700, fontSize: '13px', cursor: 'pointer', opacity: actionLoading === r.request_id ? 0.6 : 1 }}>
                    {actionLoading === r.request_id ? 'Processing…' : 'Approve & Pay'}
                  </button>
                  <button
                    onClick={() => setRejectConfirmId(r.request_id)}
                    disabled={actionLoading === r.request_id || payoutsDisabled}
                    title="Rejects the request — funds stay in the platform, nothing is sent to Paystack"
                    style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '10px', padding: '8px', color: '#C4C9E0', fontWeight: 700, fontSize: '13px', cursor: 'pointer', opacity: actionLoading === r.request_id ? 0.6 : 1 }}>
                    Cancel Request
                  </button>
                </div>
              )}
              {r.status === 'processing' && (
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button
                    onClick={() => setCancelConfirmId(r.request_id)}
                    disabled={actionLoading === r.request_id || payoutsDisabled}
                    title="Use this if this request is stuck in Processing and doesn't actually exist on Paystack — e.g. the 'Reconcile Processing' check couldn't find it"
                    style={{ flex: 1, background: '#EF4444', border: '1px solid #F87171', borderRadius: '10px', padding: '10px', color: '#fff', fontWeight: 800, fontSize: '13px', cursor: 'pointer', opacity: actionLoading === r.request_id ? 0.6 : 1, boxShadow: '0 0 16px rgba(239,68,68,0.5)' }}>
                    {actionLoading === r.request_id ? 'Refunding…' : '⚠ Refund Funds'}
                  </button>
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Rendered at this level (not per-request-row) so the modal still
          appears when the triggering button lives in the Wallets section,
          which doesn't render the requests.map() above at all. */}
      {rejectConfirmId && (
        <ConfirmModal
          title="Cancel this payout request?"
          message="The request will be rejected and the funds will stay safely in the organizer's platform balance — nothing is sent to Paystack."
          confirmLabel="Cancel request"
          danger={false}
          typedConfirmationText="CANCEL"
          requireReason
          reasonPlaceholder="Reason for rejecting (shown to the organizer)"
          onConfirm={(reason) => { const id = rejectConfirmId; setRejectConfirmId(null); handleReject(id, reason || ''); }}
          onCancel={() => setRejectConfirmId(null)}
        />
      )}
      {cancelConfirmId && (
        <ConfirmModal
          title="Refund this payout?"
          message="This request is already Processing — a transfer may already be in flight with Paystack. Confirming will mark it cancelled and return the funds to the organizer's platform balance."
          confirmLabel="Refund funds"
          danger
          typedConfirmationText="REFUND"
          requireReason
          reasonPlaceholder="Reason for cancelling (required for the audit trail, shown to the organizer)"
          onConfirm={(reason) => { const id = cancelConfirmId; setCancelConfirmId(null); handleCancelConfirmed(id, reason || ''); }}
          onCancel={() => setCancelConfirmId(null)}
        />
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
  // Authorization tiers come from the shared single-source-of-truth helpers
  // (src/lib/permissions.ts), which mirror the backend is_root/is_super_admin/
  // is_admin gates exactly — the UI and RPC gates can no longer drift.
  const isRoot = permIsRoot(currentUser);
  const isSubAdmin = currentUser?.role === 'sub-admin';
  const isAdminOrSubAdmin = permIsAdminTier(currentUser);

  // Detailed permission logging: on mount, ask the backend who it thinks we are
  // and what it resolves us to (authenticated uid, role, and each tier flag),
  // so any future "access denied" is diagnosable against the server's own view
  // rather than guessed from the client.
  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.rpc('whoami_admin' as any, {});
        // eslint-disable-next-line no-console
        console.info('[VENTS admin-auth] resolved permissions', { client: { id: currentUser?.id, role: currentUser?.role }, server: data, error });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[VENTS admin-auth] whoami_admin failed', e);
      }
    })();
  }, [currentUser?.id]);

  // ── Admin Actions approval queue: pending-request badge (Super Admins) ───────
  const isSuperAdmin = permIsSuperAdmin(currentUser);
  const [pendingActionCount, setPendingActionCount] = useState(0);
  const refreshPendingCount = useCallback(async () => {
    if (!isSuperAdmin) { setPendingActionCount(0); return; }
    try {
      const { data } = await supabase.rpc('admin_pending_request_count' as any, {});
      setPendingActionCount(Number(data) || 0);
    } catch { /* ignore */ }
  }, [isSuperAdmin]);
  useEffect(() => {
    refreshPendingCount();
    const id = setInterval(refreshPendingCount, 20000); // near-real-time badge
    return () => clearInterval(id);
  }, [refreshPendingCount]);

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
  const [eventsFilter, setEventsFilter] = useState<'active' | 'deleted'>('active');
  const [busyId, setBusyId] = useState<string | null>(null);
  // Per-row pickers for the Users table's role-change and ban-duration
  // actions -- keyed by user id, since these controls are inside a mapped
  // list (one native <select> per row was the last holdout; every other
  // dropdown in the app already routes through PickerSheet).
  const [rolePickerUserId, setRolePickerUserId] = useState<string | null>(null);
  const [banPickerUserId, setBanPickerUserId] = useState<string | null>(null);
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
  // Overview-card aggregates — computed against the full table, not the
  // capped 100-row vcTxns list below (which is for the recent-activity feed
  // only), so these can't silently undercount once activity exceeds 100 rows.
  const [vcAggregates, setVcAggregates] = useState({ circulation: 0, totalTxns: 0, credits: 0, debits: 0 });

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
  const [cacStatusFilter, setCacStatusFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [cacSearchInput, setCacSearchInput] = useState('');
  const [cacSearch, setCacSearch] = useState('');
  const [cacRejectingId, setCacRejectingId] = useState<string | null>(null);
  const [cacRejectReason, setCacRejectReason] = useState('');
  const [cacPreviewLoadingId, setCacPreviewLoadingId] = useState<string | null>(null);
  const [verifyStats, setVerifyStats] = useState<{ pendingCount: number; approvedToday: number; rejectedToday: number; avgReviewHours: number | null; totalVerified: number } | null>(null);
  const [verifyStatsLoading, setVerifyStatsLoading] = useState(false);

  // Debounce the CAC search box so every keystroke doesn't fire a query.
  useEffect(() => {
    const t = setTimeout(() => setCacSearch(cacSearchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [cacSearchInput]);

  // Organizer Requests tab state
  const [orgRequests, setOrgRequests] = useState<any[]>([]);
  const [orgRequestsLoading, setOrgRequestsLoading] = useState(false);

  // Service Provider Requests tab state -- deliberately its own state block
  // (not shared with orgRequests above), same reasoning as the client-side
  // request flow in ProfileScreen.tsx: keeps this fully independent of the
  // Organizer review flow so neither can ever affect the other.
  const [spRequests, setSpRequests] = useState<any[]>([]);
  const [spRequestsLoading, setSpRequestsLoading] = useState(false);

  // Services (Admin/Sub-Admin management surface, Services Stage 3) --
  // list/search/filter service_providers, drill into one, and manage its
  // provider_services rows. Every read/write here goes through the SAME
  // RLS this whole feature already relies on (service_providers_admin_*,
  // provider_services_admin_*, both is_admin()-gated, 0034/0045/0048) --
  // this tab adds no new server-side surface at all, purely a client UI
  // over existing admin-bypass policies. A non-admin session reaching this
  // tab's code would still get empty results / RLS-denied writes; nothing
  // here is a client-side-only security boundary.
  const [svcProviders, setSvcProviders] = useState<any[] | null>(null);
  const [svcProvidersLoading, setSvcProvidersLoading] = useState(false);
  const [svcProvidersError, setSvcProvidersError] = useState<string | null>(null);
  const [svcSearch, setSvcSearch] = useState('');
  const [svcCountryFilter, setSvcCountryFilter] = useState('');
  const [svcCategoryFilter, setSvcCategoryFilter] = useState('');
  const [svcStatusFilter, setSvcStatusFilter] = useState<'all' | 'draft' | 'approved' | 'rejected'>('all');
  const [svcServiceStatusFilter, setSvcServiceStatusFilter] = useState<'all' | 'has-active' | 'no-active'>('all');
  const [openSvcFilterPicker, setOpenSvcFilterPicker] = useState<'country' | 'category' | 'status' | 'serviceStatus' | null>(null);
  const [svcSelectedProviderId, setSvcSelectedProviderId] = useState<string | null>(null);
  const [svcServices, setSvcServices] = useState<ProviderService[] | null>(null);
  const [svcServicesLoading, setSvcServicesLoading] = useState(false);
  const [svcServicesError, setSvcServicesError] = useState<string | null>(null);
  const [svcServiceForm, setSvcServiceForm] = useState<null | { editing: ProviderService | null; input: ProviderServiceInput }>(null);
  const [svcServiceFormError, setSvcServiceFormError] = useState('');
  const [showSvcServiceCategoryPicker, setShowSvcServiceCategoryPicker] = useState(false);
  const [showSvcServiceCurrencyPicker, setShowSvcServiceCurrencyPicker] = useState(false);
  const [svcServiceSaving, setSvcServiceSaving] = useState(false);
  const [svcServiceBusyId, setSvcServiceBusyId] = useState<string | null>(null);


  useEffect(() => {
    if (tab !== 'vc') return;
    // vc_transactions.type is 'earn'/'spend'/'refund'/'referral' — there is
    // no 'credit'/'debit' value, so these aggregates used to always be 0.
    // Also, vents_wallets has RLS limiting SELECT to the caller's own row,
    // so a plain client-side sum only ever returned the admin's own
    // balance — admin_get_vc_aggregates() (SECURITY DEFINER, admin-gated)
    // sums the real platform-wide balance server-side instead.
    supabase.rpc('admin_get_vc_aggregates').then(({ data }: any) => {
      const row = (data || [])[0] || {};
      setVcAggregates({
        circulation: Number(row.circulation || 0),
        totalTxns: Number(row.total_txns || 0),
        credits: Number(row.credits || 0),
        debits: Number(row.debits || 0),
      });
    }, (err: any) => { console.error('VC aggregates fetch error:', err); Sentry.captureException(err); });
    setVcLoading(true);
    supabase
      .from('vc_transactions')
      .select('id, user_id, amount, type, status, reference_id, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(
        ({ data }) => { setVcTxns(data || []); setVcLoading(false); },
        (err) => { console.error('VC transactions fetch error:', err); Sentry.captureException(err); setVcLoading(false); }
      );
  }, [tab]);

  const loadStats = useCallback(() => {
    setStatsLoading(true);
    Promise.all([
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('events').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('payment_status', 'paid'),
      // vc_transactions.type is 'earn'/'spend'/'refund'/'referral' — there is
      // no 'credit' value, so this used to always compute vcTotal as 0.
      supabase.from('vc_transactions').select('amount').eq('type', 'earn').eq('status', 'active'),
      supabase.from('tickets').select('amount').eq('payment_status', 'paid'),
      // Signup-completion state (auth.users.email_verified), not the
      // organizer trust badge (users.is_verified) — see
      // admin_get_new_user_stats() in
      // migrations/20260713100000_admin-stats-and-payout-cleanup.sql.
      supabase.rpc('admin_get_new_user_stats'),
    ]).then(([uRes, eRes, tRes, vcRes, revRes, newUserRes]) => {
      const vcTotal = (vcRes.data || []).reduce((s: number, r: any) => s + Number(r.amount), 0);
      // tickets.amount is already stored in naira, not kobo — no /100 here.
      const revenue = (revRes.data || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      const newUserRow = (newUserRes.data || [])[0] || {};
      setStats({
        users: uRes.count ?? 0,
        events: eRes.count ?? 0,
        tickets: tRes.count ?? 0,
        vc: vcTotal,
        revenue,
        newThisWeek: newUserRow.new_this_week ?? 0,
        newThisMonth: newUserRow.new_this_month ?? 0,
      });
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
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase.channel('admin:stats', { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'admin_stats_changed' }, () => {
      if (tabRef.current !== 'stats') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadStats, 300);
    });
    channel.subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, [loadStats]);

  useEffect(() => {
    if (tab !== 'verify') return;
    setPendingOrgsLoading(true);
    supabase
      .from('users')
      .select('id, full_name, username, email, state, created_at, is_verified')
      .eq('role', 'organizer')
      .eq('is_verified', false)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(
        ({ data }) => { setPendingOrgs(data || []); setPendingOrgsLoading(false); },
        (err) => { console.error('Pending orgs fetch error:', err); Sentry.captureException(err); setPendingOrgsLoading(false); }
      );
  }, [tab]);

  const loadCacRequests = useCallback(async () => {
    setCacRequestsLoading(true);
    try {
      const { data, error } = await supabase.rpc('admin_list_organizer_verifications' as any, {
        p_status: cacStatusFilter,
        p_search: cacSearch || null,
        p_limit: 50,
        p_offset: 0,
      });
      if (error) throw error;
      setCacRequests(data || []);
    } catch (err) {
      console.error('CAC requests fetch error:', err);
      Sentry.captureException(err);
      setCacRequests([]);
    } finally {
      setCacRequestsLoading(false);
    }
  }, [cacStatusFilter, cacSearch]);

  useEffect(() => {
    if (tab !== 'verify') return;
    loadCacRequests();
  }, [tab, loadCacRequests]);

  // Verification queue analytics (Pending Review / Approved Today / Rejected
  // Today / Average Review Time / Total Verified) — computed server-side via
  // admin_get_verification_stats() (SECURITY DEFINER, admin-gated) rather
  // than aggregated client-side, since the client only ever sees a paginated
  // slice of organizer_verification_requests from admin_list_organizer_verifications.
  const loadVerifyStats = useCallback(async () => {
    setVerifyStatsLoading(true);
    try {
      const { data, error } = await supabase.rpc('admin_get_verification_stats' as any);
      if (error) throw error;
      const row = (data || [])[0] || {};
      setVerifyStats({
        pendingCount: Number(row.pending_count || 0),
        approvedToday: Number(row.approved_today || 0),
        rejectedToday: Number(row.rejected_today || 0),
        avgReviewHours: row.avg_review_hours != null ? Number(row.avg_review_hours) : null,
        totalVerified: Number(row.total_verified || 0),
      });
    } catch (err) {
      console.error('Verification stats fetch error:', err);
      Sentry.captureException(err);
      setVerifyStats(null);
    } finally {
      setVerifyStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab !== 'verify') return;
    loadVerifyStats();
  }, [tab, loadVerifyStats]);

  const handleApproveCac = async (requestId: string) => {
    setCacActionLoading(requestId);
    await submitOrExecute('organizer_verification_approve',
      { target_type: 'verification', target_id: requestId, target_label: 'Organizer verification', payload: { request_id: requestId } },
      async () => {
        const { error } = await supabase.rpc('admin_approve_organizer_verification' as any, { p_request_id: requestId });
        if (error) throw new Error(error.message);
        flash(true, 'Brand verified ✓');
        await loadCacRequests();
        loadVerifyStats();
        notifyByEmail('cac', requestId, 'approved');
      });
    setExpandedCacId(null);
    setCacActionLoading(null);
  };

  const handleRejectCac = async (requestId: string) => {
    const reason = cacRejectReason.trim();
    if (!reason) { flash(false, 'A rejection reason is required'); return; }
    setCacActionLoading(requestId);
    await submitOrExecute('organizer_verification_reject',
      { target_type: 'verification', target_id: requestId, target_label: 'Organizer verification', payload: { request_id: requestId, reason } },
      async () => {
        const { error } = await supabase.rpc('admin_reject_organizer_verification' as any, { p_request_id: requestId, p_reason: reason });
        if (error) throw new Error(error.message);
        flash(false, 'Verification rejected');
        await loadCacRequests();
        loadVerifyStats();
        notifyByEmail('cac', requestId, 'rejected', reason);
      });
    setExpandedCacId(null);
    setCacRejectingId(null);
    setCacRejectReason('');
    setCacActionLoading(null);
  };

  // The verification-docs bucket is private (RLS-gated to the uploader or an
  // admin — see supabase/migrations/0019_verification_docs_storage_policies.sql).
  // document_url stores a bucket-relative key ("verification-docs/<key>"),
  // not a fetchable URL, so a signed URL is generated on demand here — the
  // RLS check happens at signing time (storage_objects_verification_docs_select:
  // owner OR is_admin()), and the resulting URL is usable directly without
  // further auth for a short window.
  const handlePreviewCacDocument = async (requestId: string, documentUrl: string) => {
    setCacPreviewLoadingId(requestId);
    try {
      const key = documentUrl.replace(/^verification-docs\//, '');
      const { data, error } = await supabase.storage.from('verification-docs').createSignedUrl(key, 60);
      if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not load document');
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      flash(false, e.message || 'Could not open document');
    } finally {
      setCacPreviewLoadingId(null);
    }
  };

  const handleVcUserSearch = async () => {
    const q = vcSearch.trim();
    if (!q) return;
    setVcSearching(true);
    try {
      const like = escapePostgrestOrValue(`%${q}%`);
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      // public_profiles has no email column, so the "email" half of the
      // placeholder's promise was silently a no-op — query users directly
      // (same table/pattern the Users tab's loadUsers already uses) so
      // admins can actually find someone by email, not just name/username.
      let query = supabase
        .from('users')
        .select('id, full_name, username, email, avatar_url')
        .or(`full_name.ilike.${like},username.ilike.${like},email.ilike.${like}`);
      if (uuidRe.test(q)) {
        query = supabase
          .from('users')
          .select('id, full_name, username, email, avatar_url')
          .or(`full_name.ilike.${like},username.ilike.${like},email.ilike.${like},id.eq.${q}`);
      }
      const { data } = await query.limit(8);
      setVcSearchResults(data || []);
    } catch { setVcSearchResults([]); }
    finally { setVcSearching(false); }
  };

  const handleVcAdminTransfer = async () => {
    const uid = vcTransfer.userId.trim();
    if (!uid || !vcTransfer.amount || Number(vcTransfer.amount) <= 0) {
      setVcMsg('Search and select a user first, then enter a positive amount.'); return;
    }
    if (!vcTransfer.reason.trim()) {
      setVcMsg('A reason is required for admin transfers.'); return;
    }
    setVcTransferBusy(true); setVcMsg(null);
    const amt = Number(vcTransfer.amount); const rsn = vcTransfer.reason.trim();
    const label = vcSelectedUser?.username || uid.slice(0, 8);
    await submitOrExecute('credit_vents_cents',
      { target_type: 'user', target_id: uid, target_label: label, payload: { amount: amt, reason: rsn }, changes: { credit_vc: amt } },
      async () => {
        const { error } = await supabase.rpc('admin_credit_vents_cents' as any, { p_user_id: uid, p_amount: amt, p_reason: rsn });
        if (error) throw error;
        setVcMsg(`✓ ${amt} VC credited to ${label}…`);
        setVcTransfer({ userId: '', amount: '', reason: '' });
        setVcSelectedUser(null); setVcSearch(''); setVcSearchResults([]);
      });
    if (!isSuperAdmin) { setVcMsg('Request sent — waiting for Admin approval.'); setVcTransfer({ userId: '', amount: '', reason: '' }); }
    setVcTransferBusy(false);
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
    const amt = Number(vcDebit.amount); const rsn = vcDebit.reason.trim();
    const label = vcSelectedUser?.username || uid.slice(0, 8);
    await submitOrExecute('debit_vents_cents',
      { target_type: 'user', target_id: uid, target_label: label, payload: { amount: amt, reason: rsn }, changes: { debit_vc: amt } },
      async () => {
        const { error } = await supabase.rpc('admin_debit_vents_cents' as any, { p_user_id: uid, p_amount: amt, p_reason: rsn });
        if (error) throw error;
        setVcDebitMsg(`✓ ${amt} VC debited from ${label}…`);
        setVcDebit({ amount: '', reason: '' });
        setVcTransfer({ userId: '', amount: '', reason: '' });
        setVcSelectedUser(null); setVcSearch(''); setVcSearchResults([]);
      });
    if (!isSuperAdmin) { setVcDebitMsg('Request sent — waiting for Admin approval.'); setVcDebit({ amount: '', reason: '' }); }
    setVcDebitBusy(false);
  };

  // System Controller state
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  // MVP launch kill switches for chat voice notes / image sharing
  // (see migrations/20260710185537_media-feature-toggles.sql)
  const [voiceNotesEnabled, setVoiceNotesEnabled] = useState(false);
  const [imageSharingEnabled, setImageSharingEnabled] = useState(true);
  // Block 17 kill switches (migrations/20260712193800_kill-switches-and-payout-action-split.sql)
  const [disablePurchases, setDisablePurchases] = useState(false);
  const [disableScanning, setDisableScanning] = useState(false);
  const [disableSignups, setDisableSignups] = useState(false);
  const [disablePayouts, setDisablePayouts] = useState(false);
  // migrations/20260713100000_admin-stats-and-payout-cleanup.sql
  const [disableLocationSharing, setDisableLocationSharing] = useState(false);
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [isPinging, setIsPinging] = useState(false);
  const [healthResult, setHealthResult] = useState<{ ok: boolean; latencyMs: number; detail: string } | null>(null);

  const [confirmModal, setConfirmModal] = useState<null | {
    title: string; message: string; confirmLabel?: string; danger?: boolean;
    requireReason?: boolean; optionalReason?: boolean; reasonPlaceholder?: string;
    onConfirm: (reason?: string) => void;
  }>(null);

  // ── Load users ───────────────────────────────────────────────────────────────
  const loadUsers = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      let q = supabase
        .from('users')
        .select('id, email, full_name, role, username, phone_number, state, status, is_verified, created_at, banned_until, deleted_at')
        .neq('status', 'deleted')
        .order('created_at', { ascending: false });

      if (searchQuery.trim()) {
        const like = escapePostgrestOrValue(`%${searchQuery.trim().toLowerCase()}%`);
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
      const { data, error } = await supabase
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
      const { data, error } = await supabase
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
      const { data } = await supabase.from('app_config').select('maintenance_mode, voice_notes_enabled, image_sharing_enabled, disable_purchases, disable_scanning, disable_signups, disable_payouts, disable_location_sharing').single();
      if (data) {
        setMaintenanceMode(data.maintenance_mode);
        setVoiceNotesEnabled(data.voice_notes_enabled);
        setImageSharingEnabled(data.image_sharing_enabled);
        setDisablePurchases(!!data.disable_purchases);
        setDisableScanning(!!data.disable_scanning);
        setDisableSignups(!!data.disable_signups);
        setDisablePayouts(!!data.disable_payouts);
        setDisableLocationSharing(!!data.disable_location_sharing);
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
        const { data: reqs, error } = await supabase
          .from('organizer_requests')
          .select('id, user_id, reason, status, admin_note, created_at')
          .order('created_at', { ascending: false })
          .limit(100);
        if (error) throw error;
        const rows = reqs || [];
        const userIds = [...new Set(rows.map((r: any) => r.user_id).filter(Boolean))];
        let usersMap: Record<string, any> = {};
        if (userIds.length > 0) {
          const { data: users } = await supabase
            .from('users')
            .select('id, username, full_name, email, phone_number, state')
            .in('id', userIds);
          (users || []).forEach((u: any) => { usersMap[u.id] = u; });
        }
        setOrgRequests(rows.map((r: any) => ({ ...r, users: usersMap[r.user_id] || null })));
      } catch (error: any) {
        console.error('Org requests fetch error:', error);
        Sentry.captureException(error);
        flash(false, 'Failed to load requests: ' + (error?.message || JSON.stringify(error)));
      } finally {
        setOrgRequestsLoading(false);
      }
    })();
  }, [tab, currentUser?.id, isRoot]);


  const reviewOrgRequest = async (id: string, status: 'approved' | 'rejected', adminNote?: string) => {
    const { error } = await supabase
      .from('organizer_requests')
      .update({ status, admin_note: adminNote || null, reviewed_by: currentUser?.id, reviewed_at: new Date().toISOString() })
      .eq('id', id);
    if (!error) {
      setOrgRequests((prev) => prev.map((r) => r.id === id ? { ...r, status, admin_note: adminNote || null } : r));
      const req = orgRequests.find((r) => r.id === id);
      // If approved, update user role to organizer
      if (status === 'approved') {
        if (req?.user_id) {
          await supabase.rpc('admin_set_user_role', { p_user_id: req.user_id, p_new_role: 'organizer' });
        }
      }
      // Decision SMS is now sent server-side by notifyByEmail's endpoint
      // (api/notify/status-email.ts) — it looks up the phone number itself and
      // sends with the same text, no client-held Sendchamp key required.
      notifyByEmail('organizer', id, status, adminNote);
    }
  };

  // Service Provider requests -- own fetch effect and review function,
  // deliberately mirroring the org-requests pair above rather than sharing
  // code with it, so the Organizer flow is never touched by this addition.
  useEffect(() => {
    if (tab !== 'sp-requests') return;
    if (!isAdminOrSubAdmin) return;
    setSpRequestsLoading(true);
    (async () => {
      try {
        const { data: reqs, error } = await supabase
          .from('service_provider_requests')
          .select('id, user_id, reason, status, admin_note, created_at, provider_type, country, owner_name, business_name, cac_number, identity_id_type, identity_id_number, document_url')
          .order('created_at', { ascending: false })
          .limit(100);
        if (error) throw error;
        const rows = reqs || [];
        const userIds = [...new Set(rows.map((r: any) => r.user_id).filter(Boolean))];
        let usersMap: Record<string, any> = {};
        if (userIds.length > 0) {
          const { data: users } = await supabase
            .from('users')
            .select('id, username, full_name, email, phone_number, state')
            .in('id', userIds);
          (users || []).forEach((u: any) => { usersMap[u.id] = u; });
        }
        setSpRequests(rows.map((r: any) => ({ ...r, users: usersMap[r.user_id] || null })));
      } catch (error: any) {
        console.error('Service provider requests fetch error:', error);
        Sentry.captureException(error);
        flash(false, 'Failed to load requests: ' + (error?.message || JSON.stringify(error)));
      } finally {
        setSpRequestsLoading(false);
      }
    })();
  }, [tab, currentUser?.id, isRoot]);

  const reviewSpRequest = async (id: string, status: 'approved' | 'rejected', adminNote?: string) => {
    // Single atomic RPC: updates the request, grants/leaves the capability,
    // AND inserts the applicant's notification together -- see
    // admin_decide_service_provider_request (0044_service_provider_kyc.sql).
    const req = spRequests.find((r) => r.id === id);
    const { error } = await supabase.rpc('admin_decide_service_provider_request', {
      p_request_id: id,
      p_status: status,
      p_admin_note: adminNote || null,
    });
    if (!error) {
      setSpRequests((prev) => prev.map((r) => r.id === id ? { ...r, status, admin_note: adminNote || null } : r));
      triggerPushDelivery(req?.user_id);
    } else {
      flash(false, error.message || 'Failed to review request.');
    }
  };

  // ── Services (Admin/Sub-Admin management surface) ──────────────────────
  // service_providers_admin_select (is_admin(), 0034) lets an admin session
  // read every listing regardless of status -- the same server-side gate
  // that protects provider self-management already covers this tab.
  const loadSvcProviders = useCallback(async () => {
    if (!isAdminOrSubAdmin) return;
    setSvcProvidersLoading(true);
    setSvcProvidersError(null);
    try {
      let q = supabase
        .from('service_providers')
        .select('id, user_id, business_name, category, country, status, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (svcCountryFilter) q = q.eq('country', svcCountryFilter);
      if (svcCategoryFilter) q = q.eq('category', svcCategoryFilter);
      if (svcStatusFilter !== 'all') q = q.eq('status', svcStatusFilter);
      if (svcSearch.trim()) {
        const like = escapePostgrestOrValue(`%${svcSearch.trim()}%`);
        q = q.ilike('business_name', like);
      }
      const { data: rows, error } = await q;
      if (error) throw error;
      const providerRows = rows || [];

      const ownerIds = [...new Set(providerRows.map((r: any) => r.user_id).filter(Boolean))];
      let ownersMap: Record<string, any> = {};
      if (ownerIds.length > 0) {
        const { data: owners } = await supabase.from('users').select('id, username, full_name, email').in('id', ownerIds);
        (owners || []).forEach((u: any) => { ownersMap[u.id] = u; });
      }

      // Service-status filter needs to know, per provider, whether it has
      // at least one active service -- one batch query across every
      // provider on this page rather than N+1 per-row queries.
      const providerIds = providerRows.map((r: any) => r.id);
      let activeServiceProviderIds = new Set<string>();
      if (providerIds.length > 0) {
        const { data: activeRows } = await supabase
          .from('provider_services')
          .select('provider_id')
          .eq('is_active', true)
          .in('provider_id', providerIds);
        activeServiceProviderIds = new Set((activeRows || []).map((r: any) => r.provider_id));
      }

      let merged = providerRows.map((r: any) => ({
        ...r,
        owner: ownersMap[r.user_id] || null,
        hasActiveService: activeServiceProviderIds.has(r.id),
      }));
      if (svcServiceStatusFilter === 'has-active') merged = merged.filter((r: any) => r.hasActiveService);
      if (svcServiceStatusFilter === 'no-active') merged = merged.filter((r: any) => !r.hasActiveService);

      setSvcProviders(merged);
    } catch (err: any) {
      Sentry.captureException(err);
      setSvcProvidersError(err?.message || 'Failed to load service providers.');
      setSvcProviders([]);
    } finally {
      setSvcProvidersLoading(false);
    }
  }, [isAdminOrSubAdmin, svcCountryFilter, svcCategoryFilter, svcStatusFilter, svcServiceStatusFilter, svcSearch]);

  useEffect(() => {
    if (tab !== 'services-admin' || svcSelectedProviderId) return;
    loadSvcProviders();
  }, [tab, svcSelectedProviderId, loadSvcProviders]);

  const loadSvcServices = useCallback(async (providerId: string) => {
    setSvcServicesLoading(true);
    setSvcServicesError(null);
    try {
      // Same helper the provider's own management screen uses -- returns
      // every service regardless of active status; for an admin caller,
      // provider_services_admin_select (is_admin(), 0048) is what actually
      // authorizes seeing a provider that isn't the caller's own.
      const rows = await fetchServicesForProviderId(providerId);
      setSvcServices(rows);
    } catch (err: any) {
      Sentry.captureException(err);
      setSvcServicesError(err?.message || 'Failed to load services for this provider.');
      setSvcServices([]);
    } finally {
      setSvcServicesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!svcSelectedProviderId) { setSvcServices(null); return; }
    loadSvcServices(svcSelectedProviderId);
  }, [svcSelectedProviderId, loadSvcServices]);

  const svcSelectedProvider = svcProviders?.find((p) => p.id === svcSelectedProviderId) || null;

  const openSvcServiceForm = (existing: ProviderService | null) => {
    setSvcServiceFormError('');
    setSvcServiceForm({
      editing: existing,
      input: existing
        ? {
            name: existing.name, description: existing.description || '', price: existing.price,
            currency: existing.currency, durationMinutes: existing.durationMinutes ?? null,
            category: existing.category || svcSelectedProvider?.category || '', isActive: existing.isActive,
          }
        : {
            name: '', description: '', price: 0, currency: CURRENCIES[0]?.code || 'NGN',
            durationMinutes: null, category: svcSelectedProvider?.category || '', isActive: true,
          },
    });
  };

  const handleSvcServiceSubmit = async () => {
    if (!svcServiceForm || !svcSelectedProviderId) return;
    const { editing, input } = svcServiceForm;
    if (!input.name.trim()) { setSvcServiceFormError('Service name is required.'); return; }
    if (!(input.price >= 0)) { setSvcServiceFormError('A valid price is required.'); return; }
    if (!/^[A-Z]{3}$/.test(input.currency)) { setSvcServiceFormError('A valid currency is required.'); return; }
    setSvcServiceSaving(true);
    setSvcServiceFormError('');
    try {
      if (editing) {
        await updateProviderService(editing.id, input);
      } else {
        await createProviderService(svcSelectedProviderId, input);
      }
      setSvcServiceForm(null);
      await loadSvcServices(svcSelectedProviderId);
      flash(true, editing ? 'Service updated.' : 'Service added.');
    } catch (err: any) {
      setSvcServiceFormError(err?.message || 'Failed to save this service.');
    } finally {
      setSvcServiceSaving(false);
    }
  };

  const handleSvcToggleActive = async (svc: ProviderService) => {
    setSvcServiceBusyId(svc.id);
    try {
      await setProviderServiceActive(svc.id, !svc.isActive);
      if (svcSelectedProviderId) await loadSvcServices(svcSelectedProviderId);
    } catch (err: any) {
      flash(false, err?.message || 'Failed to update this service.');
    } finally {
      setSvcServiceBusyId(null);
    }
  };

  const handleSvcDeleteService = (svc: ProviderService) => {
    setConfirmModal({
      title: 'Delete this service?',
      message: `"${svc.name}" will be permanently removed from this provider's listing. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        setConfirmModal(null);
        setSvcServiceBusyId(svc.id);
        try {
          await deleteProviderService(svc.id);
          if (svcSelectedProviderId) await loadSvcServices(svcSelectedProviderId);
          flash(true, 'Service deleted.');
        } catch (err: any) {
          flash(false, err?.message || 'Failed to delete this service.');
        } finally {
          setSvcServiceBusyId(null);
        }
      },
    });
  };

  const loadEvents = useCallback(async (filter: 'active' | 'deleted') => {
    setEventsLoading(true);
    try {
      let q = supabase
        .from('events')
        .select('id, title, organizer_id, hidden_by_admin, hidden_at, created_at, status, image_url, event_date, deleted_at, is_featured, featured_until, users!events_organizer_id_fkey(username, full_name, is_verified)')
        .order('created_at', { ascending: false })
        .limit(50);
      q = filter === 'deleted' ? q.not('deleted_at', 'is', null) : q.is('deleted_at', null);
      const { data, error } = await q;
      if (error) throw error;
      setEvents(data || []);
    } catch (err: any) {
      flash(false, err?.message || 'Failed to load events.');
    } finally { setEventsLoading(false); }
  }, []);

  useEffect(() => {
    if ((!isAdminOrSubAdmin) || tab !== 'events') return;
    loadEvents(eventsFilter);
  }, [tab, loadEvents, currentUser, isRoot, eventsFilter]);

  const handleRestoreEvent = async (eventId: string) => {
    const label = events.find(e => e.id === eventId)?.title || eventId;
    await submitOrExecute('restore_event',
      { target_type: 'event', target_id: eventId, target_label: label, previous: { deleted: true }, changes: { deleted: false } },
      async () => {
        const { error } = await supabase.rpc('admin_restore_deleted_event', { p_event_id: eventId });
        if (error) throw error;
        setEvents(prev => prev.filter(e => e.id !== eventId));
        flash(true, 'Event restored — it is live again.');
      });
  };

  useEffect(() => {
    if ((!isAdminOrSubAdmin) || tab !== 'reports') return;
    setReportsLoading(true);
    (async () => {
      try {
        const { data, error } = await supabase
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
          const { data: usersData } = await supabase
            .from('users')
            .select('id, username, full_name, email, avatar_url, is_verified, role, status')
            .in('id', userIds);
          setReportedUsers(Object.fromEntries((usersData || []).map((u: any) => [u.id, u])));
        }
        if (eventIds.length > 0) {
          const { data: eventsData } = await supabase
            .from('events')
            .select('id, title, image_url, hidden_by_admin')
            .in('id', eventIds);
          setReportedEvents(Object.fromEntries((eventsData || []).map((e: any) => [e.id, e])));
        }
      } catch (err) {
        console.error('Reports fetch error:', err);
        Sentry.captureException(err);
      } finally {
        setReportsLoading(false);
      }
    })();
  }, [tab, isAdminOrSubAdmin]);

  const handleUpdateReport = async (id: string, status: string) => {
    const { error } = await supabase.from('reports').update({ status }).eq('id', id);
    if (!error) setReports(prev => prev.map(r => r.id === id ? { ...r, status } : r));
  };

  const handleHideEvent = async (eventId: string) => {
    const label = events.find(e => e.id === eventId)?.title || eventId;
    await submitOrExecute('hide_event',
      { target_type: 'event', target_id: eventId, target_label: label, previous: { hidden_by_admin: false }, changes: { hidden_by_admin: true } },
      async () => {
        const { error } = await supabase.rpc('admin_hide_event', { p_event_id: eventId });
        if (error) throw error;
        setEvents(prev => prev.map(e => e.id === eventId ? { ...e, hidden_by_admin: true, hidden_at: new Date().toISOString() } : e));
        flash(true, 'Event hidden from public feeds.');
      });
  };

  const handleReinstateEvent = async (eventId: string) => {
    const label = events.find(e => e.id === eventId)?.title || eventId;
    await submitOrExecute('reinstate_event',
      { target_type: 'event', target_id: eventId, target_label: label, previous: { hidden_by_admin: true }, changes: { hidden_by_admin: false } },
      async () => {
        const { error } = await supabase.rpc('admin_reinstate_event', { p_event_id: eventId });
        if (error) throw error;
        setEvents(prev => prev.map(e => e.id === eventId ? { ...e, hidden_by_admin: false, hidden_at: null } : e));
        flash(true, 'Event reinstated.');
      });
  };

  // The only two legitimate paths into the Featured section are a paid
  // 'featured' promotion (activate_event_promotion) or this admin action
  // (admin_set_event_featured, migrations/20260801134748) — an event is
  // never featured just for being created, and a 'trending'/'boosted'
  // promotion purchase can no longer set is_featured as a side effect.
  const handleToggleFeatured = async (eventId: string, currentlyFeatured: boolean) => {
    const label = events.find(e => e.id === eventId)?.title || eventId;
    const nextFeatured = !currentlyFeatured;
    await submitOrExecute('toggle_event_featured',
      { target_type: 'event', target_id: eventId, target_label: label, previous: { is_featured: currentlyFeatured }, changes: { is_featured: nextFeatured } },
      async () => {
        const { error } = await supabase.rpc('admin_set_event_featured', {
          p_event_id: eventId,
          p_featured: nextFeatured,
          p_duration_days: nextFeatured ? 14 : null,
        });
        if (error) throw error;
        const featuredUntil = nextFeatured ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() : null;
        setEvents(prev => prev.map(e => e.id === eventId ? { ...e, is_featured: nextFeatured, featured_until: featuredUntil } : e));
        flash(true, nextFeatured ? 'Event featured for 14 days.' : 'Event removed from Featured.');
      });
  };

  // ── Flash ────────────────────────────────────────────────────────────────────
  // ROOT-CAUSE FIX (Admin Console "buffering" audit): this was a plain
  // inline function, recreated with a new identity on every render of this
  // (very large, frequently-re-rendering) component -- including every 20s
  // from refreshPendingCount's poll below. AdminActionsTab receives this as
  // a prop and includes it in a useCallback dependency array for its own
  // data-load effect, so a new `flash` identity every ~20s was silently
  // re-triggering that effect and resetting its `loading` state to true --
  // "repeatedly sitting on Loading requests…" was a real refetch loop, not
  // a stuck spinner. Only calls stable React state setters internally, so
  // an empty dependency array gives it a permanently stable identity.
  const flash = useCallback((ok: boolean, msg: string) => {
    if (ok) setSuccessMessage(msg); else setErrorMessage(msg);
    setTimeout(() => { setSuccessMessage(null); setErrorMessage(null); }, 3500);
  }, []);

  // ── Maker-checker gate (single source of truth for every admin action) ───────
  // Super Admins (Root + full Admin) execute immediately. Sub-Admins NEVER
  // execute directly — the action is turned into an Admin Action Request and
  // queued for approval. The backend independently enforces this (the underlying
  // RPCs are Super-Admin-gated), so this is both the UX and a mirror of the
  // server rule. `execute` runs ONLY for Super Admins.
  const submitOrExecute = async (
    actionType: string,
    meta: { target_type: string; target_id?: string | null; target_label?: string | null; payload?: any; previous?: any; changes?: any },
    execute: () => Promise<void>,
  ): Promise<void> => {
    if (isSuperAdmin) {
      try { await execute(); } catch (e: any) { flash(false, e?.message || 'Action failed.'); }
      return;
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
      flash(true, 'Request sent — waiting for Admin approval.');
      refreshPendingCount();
    } catch (e: any) {
      flash(false, e?.message || 'Could not submit request.');
    }
  };

  // ── User actions ─────────────────────────────────────────────────────────────
  const handleRoleChange = async (userId: string, newRole: string) => {
    if (userId === ROOT_UID) { flash(false, 'Root admin role cannot be changed.'); return; }
    const allowedRoles = isRoot ? ['attendee', 'organizer', 'sub-admin'] : ['attendee', 'organizer'];
    if (!allowedRoles.includes(newRole)) { flash(false, 'Invalid role.'); return; }
    const target = users.find(u => u.id === userId);
    if (isSubAdmin && target && ['admin', 'sub-admin'].includes(target.role)) {
      flash(false, 'Sub-Admins cannot alter Admin/Sub-Admin accounts.'); return;
    }
    setBusyId(userId);
    await submitOrExecute('set_user_role',
      { target_type: 'user', target_id: userId, target_label: target?.username || target?.email || userId, payload: { new_role: newRole }, previous: { role: target?.role }, changes: { role: newRole } },
      async () => {
        const { error } = await supabase.rpc('admin_set_user_role', { p_user_id: userId, p_new_role: newRole });
        if (error) throw error;
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u));
        flash(true, 'Role updated.');
      });
    setBusyId(null);
  };

  // banDays: number of days, or null for permanent
  const handleSuspend = async (u: UserRow, banDays: number | null = null) => {
    const label = u.username || u.email;
    if (u.status === 'suspended') {
      // Unban
      setBusyId(u.id);
      await submitOrExecute('unsuspend_user',
        { target_type: 'user', target_id: u.id, target_label: label, previous: { status: 'suspended' }, changes: { status: 'active' } },
        async () => {
          const { error } = await supabase.rpc('admin_unsuspend_user', { p_user_id: u.id });
          if (error) throw error;
          setUsers(prev => prev.map(x => x.id === u.id ? { ...x, status: 'active', banned_until: null } : x));
          flash(true, 'User reactivated.');
        });
      setBusyId(null);
      return;
    }
    // Ban
    const bannedUntil = banDays ? new Date(Date.now() + banDays * 86400000).toISOString() : null;
    setBusyId(u.id);
    await submitOrExecute('suspend_user',
      { target_type: 'user', target_id: u.id, target_label: label, payload: { banned_until: bannedUntil, ban_days: banDays ?? 'permanent' }, previous: { status: u.status }, changes: { status: 'suspended', banned_until: bannedUntil } },
      async () => {
        const { error } = await supabase.rpc('admin_suspend_user', { p_user_id: u.id, p_banned_until: bannedUntil, p_reason: null });
        if (error) throw error;
        setUsers(prev => prev.map(x => x.id === u.id ? { ...x, status: 'suspended', banned_until: bannedUntil } : x));
        flash(true, banDays ? `Banned for ${banDays} day(s).` : 'Permanently banned.');
      });
    setBusyId(null);
  };

  const handleSoftDelete = (u: UserRow) => {
    setConfirmModal({
      title: 'Delete Account',
      message: `Soft-delete @${u.username || u.email}? They will be blocked from login. You can reinstate them later.`,
      confirmLabel: 'Delete',
      danger: true,
      optionalReason: true,
      reasonPlaceholder: 'Reason (kept on the account record for the audit trail, optional)',
      onConfirm: async (reason) => {
        setConfirmModal(null);
        setBusyId(u.id);
        const reasonOrNull = reason?.trim() || null;
        await submitOrExecute('soft_delete_user',
          { target_type: 'user', target_id: u.id, target_label: u.username || u.email, payload: { reason: reasonOrNull }, previous: { status: u.status }, changes: { status: 'deleted', reason: reasonOrNull } },
          async () => {
            const { error } = await supabase.rpc('admin_soft_delete_user', { p_user_id: u.id, p_reason: reasonOrNull });
            if (error) throw error;
            // Deleted users move to the dedicated Deleted Users tab.
            setUsers(prev => prev.filter(x => x.id !== u.id));
            flash(true, 'User deleted. Use Reinstate (Deleted Users tab) to restore.');
          });
        setBusyId(null);
      },
    });
  };

  const handleReinstate = async (u: UserRow) => {
    setBusyId(u.id);
    await submitOrExecute('reinstate_user',
      { target_type: 'user', target_id: u.id, target_label: u.username || u.email, previous: { status: u.status }, changes: { status: 'active' } },
      async () => {
        const { error } = await supabase.rpc('admin_reinstate_user', { p_user_id: u.id });
        if (error) throw error;
        setUsers(prev => prev.map(x => x.id === u.id ? { ...x, status: 'active', banned_until: null, deleted_at: null } : x));
        setDeletedUsers(prev => prev.filter(x => x.id !== u.id));
        flash(true, 'User reinstated.');
      });
    setBusyId(null);
  };

  const handleToggleVerify = async (u: UserRow) => {
    const newVerified = !u.is_verified;
    setBusyId(u.id);
    await submitOrExecute('toggle_user_verified',
      { target_type: 'user', target_id: u.id, target_label: u.username || u.email, payload: { verified: newVerified }, previous: { is_verified: u.is_verified }, changes: { is_verified: newVerified } },
      async () => {
        const { error } = await supabase.rpc('admin_toggle_user_verified', { p_user_id: u.id, p_verified: newVerified, p_reason: null });
        if (error) throw error;
        setUsers(prev => prev.map(x => x.id === u.id ? { ...x, is_verified: newVerified } : x));
        flash(true, `User ${newVerified ? 'verified ✓' : 'unverified'}.`);
      });
    setBusyId(null);
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
          await supabase.from('app_config').update({ maintenance_mode: next, updated_by: currentUser.id }).eq('id', true);
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
          await supabase.from('app_config').update({ voice_notes_enabled: next, updated_by: currentUser.id }).eq('id', true);
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
          await supabase.from('app_config').update({ image_sharing_enabled: next, updated_by: currentUser.id }).eq('id', true);
          await writeAuditLog(currentUser,next ? 'ROOT_image_sharing_on' : 'ROOT_image_sharing_off', null, {});
          setImageSharingEnabled(next);
          flash(true, `Image sharing ${next ? 'enabled' : 'disabled'}.`);
        } catch (err: any) { flash(false, err?.message || 'Failed to update image sharing toggle.'); }
      },
    });
  };

  // Block 17 kill switches — one generic handler for all four, since they
  // share the exact same shape (toggle a single app_config boolean,
  // confirm, audit-log, flash).
  const KILL_SWITCH_META: Record<'disable_purchases' | 'disable_scanning' | 'disable_signups' | 'disable_payouts' | 'disable_location_sharing', { label: string; setter: (v: boolean) => void }> = {
    disable_purchases: { label: 'Ticket Purchases', setter: setDisablePurchases },
    disable_scanning: { label: 'QR Scanning', setter: setDisableScanning },
    disable_signups: { label: 'New Sign-ups', setter: setDisableSignups },
    disable_payouts: { label: 'Organizer Payouts', setter: setDisablePayouts },
    disable_location_sharing: { label: 'Location Sharing', setter: setDisableLocationSharing },
  };
  const handleToggleKillSwitch = (column: keyof typeof KILL_SWITCH_META, currentlyDisabled: boolean) => {
    const next = !currentlyDisabled; // next = the new "disabled" value
    const meta = KILL_SWITCH_META[column];
    setConfirmModal({
      title: next ? `Disable ${meta.label}?` : `Re-enable ${meta.label}?`,
      message: next
        ? `This immediately blocks ${meta.label.toLowerCase()} platform-wide, for every user. The backend enforces this even if bypassed via direct API call.`
        : `This restores ${meta.label.toLowerCase()} for all users immediately.`,
      confirmLabel: next ? 'Disable' : 'Re-enable',
      danger: next,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          await supabase.from('app_config').update({ [column]: next, updated_by: currentUser.id }).eq('id', true);
          await writeAuditLog(currentUser, next ? `ROOT_${column}_on` : `ROOT_${column}_off`, null, {});
          meta.setter(next);
          flash(true, `${meta.label} ${next ? 'disabled' : 're-enabled'}.`);
        } catch (err: any) { flash(false, err?.message || `Failed to update ${meta.label} kill switch.`); }
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
          const { data: recipientCount, error: broadcastErr } = await supabase
            .rpc('admin_broadcast', { p_title: 'Announcement from VENTS', p_body: broadcastMsg, p_type: 'promo' });
          if (broadcastErr) throw broadcastErr;
          const allUsers = { length: recipientCount ?? 0 };
          await writeAuditLog(currentUser,'ROOT_broadcast', null, { message: broadcastMsg, recipients: allUsers?.length ?? 0 });
          setBroadcastMsg('');
          flash(true, `Broadcast sent to ${allUsers?.length ?? 0} users.`);
        } catch (err: any) { console.error('Broadcast error:', JSON.stringify(err), err?.message, err?.code, err?.details); Sentry.captureException(err); flash(false, err?.message || 'Failed to broadcast.'); }
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
          const { data, error } = await supabase.rpc('cleanup_orphaned_records' as any);
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
          // Was a single direct UPDATE on users.status — bypassed
          // admin_suspend_user() entirely, so these suspensions never got
          // the per-user 'suspend_user' admin_logs entry that every other
          // suspend path (single-user, via submitOrExecute above) produces.
          // Routes through the same RPC per target instead, so bulk
          // suspends are indistinguishable from individual ones in the
          // audit trail — same trigger-compliant write path, same log.
          const { data: targets, error: fetchErr } = await supabase
            .from('users')
            .select('id')
            .eq('is_verified', false)
            .eq('status', 'active')
            .neq('id', ROOT_UID);
          if (fetchErr) throw fetchErr;

          let failed = 0;
          for (const t of targets || []) {
            const { error } = await supabase.rpc('admin_suspend_user', { p_user_id: t.id, p_banned_until: null, p_reason: 'Bulk suspend: unverified account' });
            if (error) failed++;
          }
          await writeAuditLog(currentUser, 'ROOT_bulk_suspend_unverified', null, { count: (targets || []).length, failed });
          flash(failed === 0, failed === 0 ? `${(targets || []).length} unverified account(s) suspended.` : `${failed} of ${(targets || []).length} failed — see individual admin_logs entries.`);
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
      const { data, error } = await supabase.rpc('admin_health_ping' as any);
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

  const tabs: { key: Tab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: 'admin-actions' as Tab, label: isSuperAdmin ? 'Admin Actions' : 'My Requests', icon: <Bell size={14} />, badge: pendingActionCount },
    { key: 'users' as Tab, label: 'Users', icon: <Users size={14} /> },
    { key: 'deleted' as Tab, label: 'Deleted Users', icon: <Trash2 size={14} /> },
    { key: 'events' as Tab, label: 'Events', icon: <Shield size={14} /> },
    { key: 'logs' as Tab, label: 'Audit Log', icon: <ClipboardList size={14} /> },
    { key: 'reports' as Tab, label: 'Reports', icon: <Flag size={14} /> },
    { key: 'vc' as Tab, label: 'VC', icon: <Swords size={14} /> },
    { key: 'stats' as Tab, label: 'Stats', icon: <Zap size={14} /> },
    { key: 'verify' as Tab, label: 'Verify', icon: <BadgeCheck size={14} /> },
    // Payouts stay Super-Admin-only: execution runs through the external
    // Paystack transfer endpoints, which cannot be deferred/replayed by the SQL
    // approval dispatcher, so there is no safe maker-checker path for them.
    ...(isSuperAdmin ? [{ key: 'payouts' as Tab, label: 'Payouts', icon: <Wallet size={14} /> }] : []),
    { key: 'org-requests' as Tab, label: 'Org Reqs', icon: <Megaphone size={14} /> },
    { key: 'sp-requests' as Tab, label: 'SP Reqs', icon: <Briefcase size={14} /> },
    { key: 'services-admin' as Tab, label: 'Services', icon: <Wrench size={14} /> },
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
          requireReason={confirmModal.requireReason}
          optionalReason={confirmModal.optionalReason}
          reasonPlaceholder={confirmModal.reasonPlaceholder}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 20px 14px', borderBottom: '1px solid rgba(168,85,247,0.1)', background: '#020005', flexShrink: 0, position: 'relative' }}>
        <button onClick={onBack} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, position: 'relative', zIndex: 1 }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div
          style={{
            position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', padding: '0 60px', textAlign: 'center',
          }}
        >
          <h1 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', margin: 0 }}>
            Admin Console
            {isRoot && <span style={{ marginLeft: '8px', fontSize: '11px', color: '#A855F7', background: 'rgba(168,85,247,0.15)', border: '1px solid rgba(168,85,247,0.3)', padding: '2px 8px', borderRadius: '6px', fontWeight: 700 }}>ROOT</span>}
            {isSubAdmin && <span style={{ marginLeft: '8px', fontSize: '11px', color: '#F59E0B', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.3)', padding: '2px 8px', borderRadius: '6px', fontWeight: 700 }}>SUB-ADMIN</span>}
          </h1>
          <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>Secure user management &amp; audit trail</p>
        </div>
        <Shield size={20} color={isRoot ? '#A855F7' : '#6B7280'} style={{ filter: isRoot ? 'drop-shadow(0 0 8px rgba(168,85,247,0.6))' : 'none', flexShrink: 0, position: 'relative', zIndex: 1, marginLeft: 'auto' }} />
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
            {!!t.badge && t.badge > 0 && (
              <span style={{ minWidth: '18px', height: '18px', padding: '0 5px', borderRadius: '100px', background: '#EF4444', color: '#fff', fontSize: '10px', fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 8px rgba(239,68,68,0.5)' }}>
                {t.badge > 99 ? '99+' : t.badge}
              </span>
            )}
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

      {/* ════════════════ ADMIN ACTIONS (approval queue) ═══════════════════ */}
      {tab === 'admin-actions' && (
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
          <AdminActionsTab isSuperAdmin={isSuperAdmin} flash={flash} onCountChange={refreshPendingCount} />
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
                        ) : isSubAdmin && ['admin', 'sub-admin'].includes(u.role) ? (
                          // A Sub-Admin may never touch an Admin/Sub-Admin row,
                          // even by request — handleRoleChange refuses it too.
                          <span style={{ fontSize: '11px', color: '#8B8FA8', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <Shield size={12} /> {u.role} — Super Admin only
                          </span>
                        ) : (
                          // Root sees Sub-Admin as an assignable option (so a
                          // demoted deputy can be re-promoted).
                          (() => {
                            const roleOptions = isRoot ? ['attendee', 'organizer', 'sub-admin'] : ['attendee', 'organizer'];
                            const roleLabels: Record<string, string> = { attendee: 'Attendee', organizer: 'Organizer', 'sub-admin': 'Sub-Admin' };
                            return (
                              <button
                                type="button"
                                onClick={() => setRolePickerUserId(u.id)}
                                disabled={isBusy}
                                style={{ background: '#060A12', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#F0F0FF', fontSize: '11px', padding: '4px 8px', cursor: isBusy ? 'not-allowed' : 'pointer', opacity: isBusy ? 0.6 : 1 }}
                              >
                                {roleLabels[u.role] || u.role}
                              </button>
                            );
                          })()
                        )}

                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {/* Verify toggle — unmounted entirely (not merely
                              disabled) for a Sub-Admin viewing the Root row */}
                          {!(isSubAdmin && isRootUser) && (
                            <button
                              onClick={() => handleToggleVerify(u)}
                              disabled={isBusy || isRootUser}
                              title={u.is_verified ? 'Remove verification' : 'Verify account'}
                              style={{ background: u.is_verified ? 'rgba(59,130,246,0.12)' : 'rgba(107,114,128,0.12)', border: `1px solid ${u.is_verified ? 'rgba(59,130,246,0.3)' : 'rgba(107,114,128,0.3)'}`, borderRadius: '8px', padding: '5px 8px', color: u.is_verified ? '#3B82F6' : '#6B7280', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                            >
                              <BadgeCheck size={13} />
                            </button>
                          )}

                          {/* Ban / Unban / Suspend — same guardrail */}
                          {!(isSubAdmin && isRootUser) && (
                            u.status === 'suspended' ? (
                              <button
                                onClick={() => handleSuspend(u)}
                                disabled={isBusy || isRootUser}
                                title={u.banned_until ? `Banned until ${new Date(u.banned_until).toLocaleDateString()}` : 'Permanently banned — click to unban'}
                                style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', padding: '5px 8px', color: '#10B981', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                              >
                                <UserCheck size={13} />
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setBanPickerUserId(u.id)}
                                disabled={isBusy || isRootUser}
                                style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '8px', color: '#F59E0B', fontSize: '11px', padding: '4px 6px', cursor: (isBusy || isRootUser) ? 'not-allowed' : 'pointer', opacity: (isBusy || isRootUser) ? 0.6 : 1 }}
                              >
                                🚫 Ban
                              </button>
                            )
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

      {rolePickerUserId && (() => {
        const u = users.find(x => x.id === rolePickerUserId);
        if (!u) return null;
        const roleOptions = isRoot ? ['attendee', 'organizer', 'sub-admin'] : ['attendee', 'organizer'];
        const roleLabels: Record<string, string> = { attendee: 'Attendee', organizer: 'Organizer', 'sub-admin': 'Sub-Admin' };
        return (
          <PickerSheet
            title="Change Role"
            searchable={false}
            options={roleOptions.map(r => ({ value: r, label: roleLabels[r] }))}
            value={u.role}
            onSelect={(v) => { handleRoleChange(u.id, v); setRolePickerUserId(null); }}
            onClose={() => setRolePickerUserId(null)}
          />
        );
      })()}

      {banPickerUserId && (() => {
        const u = users.find(x => x.id === banPickerUserId);
        if (!u) return null;
        return (
          <PickerSheet
            title="Ban User"
            searchable={false}
            options={[
              { value: '1', label: '1 day' },
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: 'permanent', label: 'Permanent' },
            ]}
            value=""
            onSelect={(v) => { handleSuspend(u, v === 'permanent' ? null : Number(v)); setBanPickerUserId(null); }}
            onClose={() => setBanPickerUserId(null)}
          />
        );
      })()}

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
            <button onClick={() => loadEvents(eventsFilter)} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '14px', padding: '0 14px', color: '#8B8FA8', cursor: 'pointer' }}>
              <RefreshCw size={15} />
            </button>
          </div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            {(['active', 'deleted'] as const).map(f => (
              <button key={f} onClick={() => setEventsFilter(f)} style={{
                flex: 1, padding: '8px', borderRadius: '10px', cursor: 'pointer', fontSize: '12px', fontWeight: 700,
                background: eventsFilter === f ? 'rgba(124,58,237,0.18)' : '#090514',
                color: eventsFilter === f ? '#A78BFA' : '#8B8FA8',
                border: `1px solid ${eventsFilter === f ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.07)'}`,
              }}>{f === 'active' ? 'Active' : 'Deleted'}</button>
            ))}
          </div>
          <span style={{ color: '#8B8FA8', fontSize: '12px', display: 'block', marginBottom: '8px' }}>
            {(eventSearch ? events.filter(ev => ev.title?.toLowerCase().includes(eventSearch.toLowerCase())) : events).length} {eventsFilter === 'deleted' ? 'deleted ' : ''}events
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
                      · {organizer?.username ? `@${organizer.username}` : organizer?.full_name || 'Unknown organizer'}
                      {organizer?.is_verified && <BadgeCheck size={12} color="#3B82F6" />}
                    </span>
                    <span style={{ color: '#555C7A', fontSize: '10px', display: 'block', marginTop: '2px' }}>
                      Created {new Date(ev.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}
                      {ev.event_date && ` · Event date ${new Date(ev.event_date).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}`}
                      {ev.hidden_by_admin && ev.hidden_at && ` · Hidden ${new Date(ev.hidden_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}`}
                    </span>
                  </div>
                  {!ev.deleted_at && (
                    <button
                      onClick={() => handleToggleFeatured(ev.id, !!ev.is_featured)}
                      title={ev.is_featured ? `Featured until ${ev.featured_until ? new Date(ev.featured_until).toLocaleDateString('en-NG') : 'unknown'}` : 'Not featured — only a paid Featured promotion or this action places an event here'}
                      style={{ background: ev.is_featured ? 'rgba(251,191,36,0.12)' : 'rgba(255,255,255,0.04)', border: `1px solid ${ev.is_featured ? 'rgba(251,191,36,0.35)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '10px', padding: '6px 12px', color: ev.is_featured ? '#FBBF24' : '#8B8FA8', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      {ev.is_featured ? '★ Featured' : '☆ Feature'}
                    </button>
                  )}
                  {ev.deleted_at ? (
                    <button
                      onClick={() => setConfirmModal({ title: 'Restore Event?', message: `Restore "${ev.title || 'this event'}"? It will become live again immediately.`, confirmLabel: 'Restore', danger: false, onConfirm: () => { setConfirmModal(null); handleRestoreEvent(ev.id); } })}
                      style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '10px', padding: '6px 12px', color: '#10B981', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      Restore
                    </button>
                  ) : (
                    <button
                      onClick={() => ev.hidden_by_admin ? handleReinstateEvent(ev.id) : setConfirmModal({ title: 'Hide Event?', message: isSuperAdmin
                          ? `Hide "${ev.title || 'this event'}" from all public feeds? You can reinstate it later.`
                          : `Send a request to hide "${ev.title || 'this event'}"? It stays visible until an Admin approves it.`, confirmLabel: isSuperAdmin ? 'Hide' : 'Send Request', danger: true, onConfirm: () => { setConfirmModal(null); handleHideEvent(ev.id); } })}
                      style={{ background: ev.hidden_by_admin ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${ev.hidden_by_admin ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`, borderRadius: '10px', padding: '6px 12px', color: ev.hidden_by_admin ? '#10B981' : '#EF4444', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}
                    >
                      {ev.hidden_by_admin ? 'Reinstate' : 'Hide'}
                    </button>
                  )}
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
                      Target: {log.target_user_id || '—'} · Admin: {log.admin_id ? `${log.admin_id.slice(0, 8)}…` : '—'}
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
                        <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(167,139,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden', position: 'relative' }}>
                          <span style={{ color: '#A78BFA', fontSize: '12px', fontWeight: 700 }}>{(reportedUser.full_name || reportedUser.username || '?')[0].toUpperCase()}</span>
                          {reportedUser.avatar_url && (
                            <img src={reportedUser.avatar_url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                          )}
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
              { label: 'VC in Circulation', value: vcAggregates.circulation.toLocaleString() },
              { label: 'Total Transactions', value: vcAggregates.totalTxns.toLocaleString() },
              { label: 'Credits', value: vcAggregates.credits.toLocaleString() },
              { label: 'Debits', value: vcAggregates.debits.toLocaleString() },
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
                    <div style={{ color: (txn.type === 'earn' || txn.type === 'referral') ? '#10B981' : '#EF4444', fontSize: '14px', fontWeight: 700 }}>
                      {(txn.type === 'earn' || txn.type === 'referral') ? '+' : '-'}{Number(txn.amount).toLocaleString()} VC
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
              {vcTxns.filter(t => t.type === 'earn' && t.reference_id?.startsWith('purchase')).length === 0 ? (
                <div style={{ padding: '20px 16px', color: '#8B8FA8', fontSize: '12px' }}>No purchase records with reference prefix "purchase".</div>
              ) : vcTxns.filter(t => t.type === 'earn' && t.reference_id?.startsWith('purchase')).map(txn => (
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
                    <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(167,139,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
                      <span style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 700 }}>{(u.full_name || u.username || '?')[0].toUpperCase()}</span>
                      {u.avatar_url && (
                        <img src={u.avatar_url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                      )}
                    </div>
                    <div>
                      <div style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600 }}>{u.full_name || u.username || 'Unknown'}</div>
                      <div style={{ color: '#8B8FA8', fontSize: '11px' }}>@{u.username} · {u.email}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Selected user preview */}
            {vcSelectedUser && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '10px', padding: '10px 12px' }}>
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(167,139,250,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
                  <span style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 700 }}>{(vcSelectedUser.full_name || vcSelectedUser.username || '?')[0].toUpperCase()}</span>
                  {vcSelectedUser.avatar_url && (
                    <img src={vcSelectedUser.avatar_url} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#10B981', fontSize: '13px', fontWeight: 700 }}>✓ {vcSelectedUser.full_name || vcSelectedUser.username}</div>
                  <div style={{ color: '#8B8FA8', fontSize: '11px' }}>{vcSelectedUser.email}</div>
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
                  // tickets.amount is already stored in naira, not kobo — the
                  // old '/ 100' here was double-scaling real revenue down to
                  // roughly a hundredth of its value (e.g. ₦500 -> "₦5.00").
                  { label: 'Total Revenue', value: '₦' + stats.revenue.toLocaleString('en-NG', { minimumFractionDigits: 2 }), color: '#34D399' },
                  { label: 'New Users This Week', value: stats.newThisWeek.toLocaleString(), color: '#60A5FA' },
                  { label: 'New Users This Month', value: stats.newThisMonth.toLocaleString(), color: '#818CF8' },
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
          {verifyStatsLoading && !verifyStats ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80px', color: '#8B8FA8', fontSize: '13px' }}>Loading stats…</div>
          ) : verifyStats ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '4px' }}>
              {[
                { label: 'Pending Review', value: verifyStats.pendingCount.toLocaleString(), color: '#F59E0B' },
                { label: 'Approved Today', value: verifyStats.approvedToday.toLocaleString(), color: '#10B981' },
                { label: 'Rejected Today', value: verifyStats.rejectedToday.toLocaleString(), color: '#EF4444' },
                { label: 'Avg. Review Time', value: verifyStats.avgReviewHours != null ? `${verifyStats.avgReviewHours} hrs` : '—', color: '#A78BFA' },
                { label: 'Total Verified', value: verifyStats.totalVerified.toLocaleString(), color: '#34D399' },
              ].map(card => (
                <div key={card.label} style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${card.color}25`, borderRadius: '14px', padding: '14px' }}>
                  <div style={{ color: '#8B8FA8', fontSize: '10.5px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>{card.label}</div>
                  <div style={{ color: card.color, fontSize: '20px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>{card.value}</div>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
            {(['cac', 'unverified'] as const).map(s => (
              <button key={s} onClick={() => setVerifySection(s)}
                style={{ padding: '6px 14px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '12px', background: verifySection === s ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.05)', color: verifySection === s ? '#A855F7' : '#8B8FA8' }}>
                {s === 'cac' ? 'Verification Requests' : 'Unverified Organizers'}
              </button>
            ))}
          </div>

          {verifySection === 'cac' ? (
            <>
              <div style={{ position: 'relative' }}>
                <Search size={14} color="#555C7A" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
                <input
                  value={cacSearchInput}
                  onChange={e => setCacSearchInput(e.target.value)}
                  placeholder="Search by business/organizer name, CAC/ID number, or email…"
                  style={{ width: '100%', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '10px 12px 10px 34px', color: '#F0F0FF', fontSize: '13px', outline: 'none', boxSizing: 'border-box', fontFamily: 'Inter, sans-serif' }}
                />
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {(['pending', 'approved', 'rejected', 'all'] as const).map(s => (
                  <button key={s} onClick={() => setCacStatusFilter(s)}
                    style={{ padding: '5px 12px', borderRadius: '7px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '11px', textTransform: 'capitalize', background: cacStatusFilter === s ? 'rgba(167,139,250,0.18)' : 'rgba(255,255,255,0.04)', color: cacStatusFilter === s ? '#A78BFA' : '#8B8FA8' }}>
                    {s}
                  </button>
                ))}
              </div>

              {cacRequestsLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>Loading…</div>
              ) : cacRequests.length === 0 ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '120px', color: '#8B8FA8', fontSize: '13px' }}>No {cacStatusFilter === 'all' ? '' : cacStatusFilter + ' '}brand verification requests</div>
              ) : cacRequests.map((r: any) => {
                const expanded = expandedCacId === r.request_id;
                const statusColor = r.status === 'pending' ? '#F59E0B' : r.status === 'approved' ? '#10B981' : '#EF4444';
                const isRejecting = cacRejectingId === r.request_id;
                return (
                  <div key={r.request_id} style={{ background: '#090514', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.05)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div onClick={() => setExpandedCacId(expanded ? null : r.request_id)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', cursor: 'pointer' }}>
                      <div>
                        <div style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>{r.company_name || r.owner_name || r.full_name}</div>
                        <div style={{ color: '#8B8FA8', fontSize: '12px' }}>{r.full_name || 'No Name'} · {r.state || 'No state'}</div>
                        <div style={{ color: '#555C7A', fontSize: '11px' }}>{r.email}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                        <span style={{ fontSize: '10px', color: statusColor, background: `${statusColor}1A`, padding: '2px 8px', borderRadius: '6px', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{r.status}</span>
                        <span style={{ fontSize: '9px', color: '#8B8FA8', background: 'rgba(255,255,255,0.06)', padding: '2px 7px', borderRadius: '6px', fontWeight: 600, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                          {r.organizer_type === 'individual' ? 'Individual' : 'Business'} · {r.country || 'NG'}
                        </span>
                      </div>
                    </div>
                    <div style={{ color: '#555C7A', fontSize: '10px' }}>Submitted {new Date(r.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</div>

                    {expanded && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {/* Organizer profile summary — AdminDashboardScreen has no
                            router access to a full UserProfileScreen, so this
                            inline card (matching the Reports tab's precedent)
                            is the "view organizer profile" affordance. */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', padding: '8px 10px' }}>
                          {r.avatar_url ? (
                            <img src={r.avatar_url} alt="" style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }} />
                          ) : (
                            <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(168,85,247,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#A855F7', fontSize: '13px', fontWeight: 700 }}>
                              {(r.full_name || r.email || '?').charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ color: '#F0F0FF', fontSize: '12px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
                              {r.full_name || 'No Name'}
                              {r.is_verified && <ShieldCheck size={11} color="#10B981" />}
                            </div>
                            <div style={{ color: '#8B8FA8', fontSize: '11px' }}>{r.phone_number || 'No phone on file'}</div>
                          </div>
                        </div>

                        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          <p style={{ margin: 0, fontSize: '12px', color: '#C4C9E0' }}><strong style={{ color: '#8B8FA8' }}>{r.organizer_type === 'individual' ? 'Full Name' : 'Owner/Director'}:</strong> {r.owner_name || '—'}</p>
                          {r.organizer_type === 'individual' ? (
                            <>
                              {r.identity_id_type && (
                                <p style={{ margin: 0, fontSize: '12px', color: '#C4C9E0' }}><strong style={{ color: '#8B8FA8' }}>{r.identity_id_type}:</strong> {r.identity_id_number || '—'}</p>
                              )}
                              {!r.identity_id_type && (
                                <p style={{ margin: 0, fontSize: '12px', color: '#555C7A' }}>No structured ID requirement for {r.country || 'this country'} yet — see uploaded document.</p>
                              )}
                            </>
                          ) : (
                            <>
                              {r.cac_number && (
                                <p style={{ margin: 0, fontSize: '12px', color: '#C4C9E0' }}><strong style={{ color: '#8B8FA8' }}>CAC Number:</strong> {r.cac_number}</p>
                              )}
                              <p style={{ margin: 0, fontSize: '12px', color: '#C4C9E0' }}><strong style={{ color: '#8B8FA8' }}>Registration Date:</strong> {r.registration_date ? new Date(r.registration_date).toLocaleDateString('en-NG', { dateStyle: 'medium' }) : '—'}</p>
                              <p style={{ margin: 0, fontSize: '12px', color: '#C4C9E0' }}><strong style={{ color: '#8B8FA8' }}>Business Email:</strong> {r.business_email || '—'}</p>
                              <p style={{ margin: 0, fontSize: '12px', color: '#C4C9E0' }}><strong style={{ color: '#8B8FA8' }}>Business Phone:</strong> {r.business_phone || '—'}</p>
                              <p style={{ margin: 0, fontSize: '12px', color: '#C4C9E0' }}><strong style={{ color: '#8B8FA8' }}>Business Address:</strong> {r.business_address || '—'}</p>
                            </>
                          )}
                          {r.status !== 'pending' && r.admin_note && (
                            <p style={{ margin: 0, fontSize: '12px', color: '#EF4444' }}><strong style={{ color: '#8B8FA8' }}>Rejection Reason:</strong> {r.admin_note}</p>
                          )}
                          {r.status !== 'pending' && r.reviewed_at && (
                            <p style={{ margin: 0, fontSize: '11px', color: '#555C7A' }}>Reviewed {new Date(r.reviewed_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</p>
                          )}
                          <button
                            onClick={() => handlePreviewCacDocument(r.request_id, r.document_url)}
                            disabled={cacPreviewLoadingId === r.request_id}
                            style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: '#A855F7', fontSize: '12px', fontWeight: 600, textDecoration: 'underline', cursor: cacPreviewLoadingId === r.request_id ? 'wait' : 'pointer' }}
                          >
                            {cacPreviewLoadingId === r.request_id ? 'Opening…' : 'Preview uploaded CAC document ↗'}
                          </button>
                        </div>

                        {isRejecting && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <textarea
                              value={cacRejectReason}
                              onChange={e => setCacRejectReason(e.target.value)}
                              placeholder="Reason for rejecting this request (shown to the organizer)…"
                              rows={2}
                              style={{ width: '100%', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '10px', padding: '8px 10px', color: '#F0F0FF', fontSize: '12px', outline: 'none', resize: 'none', boxSizing: 'border-box', fontFamily: 'Inter, sans-serif' }}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {r.status === 'pending' && (
                      <div style={{ display: 'flex', gap: '8px' }}>
                        {isRejecting ? (
                          <>
                            <button
                              onClick={() => handleRejectCac(r.request_id)}
                              disabled={cacActionLoading === r.request_id || !cacRejectReason.trim()}
                              style={{ flex: 1, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '8px', color: '#EF4444', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: (cacActionLoading === r.request_id || !cacRejectReason.trim()) ? 0.6 : 1 }}
                            >
                              {cacActionLoading === r.request_id ? 'Rejecting…' : 'Confirm Rejection'}
                            </button>
                            <button
                              onClick={() => { setCacRejectingId(null); setCacRejectReason(''); }}
                              style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', padding: '8px', color: '#8B8FA8', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => handleApproveCac(r.request_id)}
                              disabled={cacActionLoading === r.request_id}
                              style={{ flex: 1, background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '10px', padding: '8px', color: '#10B981', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: cacActionLoading === r.request_id ? 0.6 : 1 }}
                            >
                              {cacActionLoading === r.request_id ? 'Processing…' : 'Approve & Verify Brand'}
                            </button>
                            <button
                              onClick={() => { setExpandedCacId(r.request_id); setCacRejectingId(r.request_id); setCacRejectReason(''); }}
                              disabled={cacActionLoading === r.request_id}
                              style={{ flex: 1, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '10px', padding: '8px', color: '#EF4444', fontSize: '12px', fontWeight: 700, cursor: 'pointer', opacity: cacActionLoading === r.request_id ? 0.6 : 1 }}
                            >
                              Reject Verification
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
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
                    setBusyId(u.id);
                    await submitOrExecute('toggle_user_verified',
                      { target_type: 'user', target_id: u.id, target_label: u.username || u.email, payload: { verified: true }, previous: { is_verified: u.is_verified }, changes: { is_verified: true } },
                      async () => {
                        const { error } = await supabase.rpc('admin_toggle_user_verified', { p_user_id: u.id, p_verified: true, p_reason: null });
                        if (error) throw error;
                        await writeAuditLog(currentUser, 'verify_organizer', u.id, { username: u.username, email: u.email });
                        setPendingOrgs(prev => prev.filter(x => x.id !== u.id));
                        flash(true, `@${u.username} verified ✓`);
                      });
                    setBusyId(null);
                  }}
                  style={{ flex: 1, background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '10px', padding: '8px', color: '#3B82F6', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                >
                  <BadgeCheck size={13} style={{ display: 'inline', marginRight: '6px' }} />Verify
                </button>
                <button
                  onClick={async () => {
                    setBusyId(u.id);
                    await submitOrExecute('set_user_role',
                      { target_type: 'user', target_id: u.id, target_label: u.username || u.email, payload: { new_role: 'attendee' }, previous: { role: 'organizer' }, changes: { role: 'attendee' } },
                      async () => {
                        const { error } = await supabase.rpc('admin_set_user_role', { p_user_id: u.id, p_new_role: 'attendee' });
                        if (error) throw error;
                        await writeAuditLog(currentUser, 'reject_organizer', u.id, { username: u.username });
                        setPendingOrgs(prev => prev.filter(x => x.id !== u.id));
                        flash(false, `@${u.username} demoted to attendee.`);
                      });
                    setBusyId(null);
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

      {tab === 'sp-requests' && (
        <div style={{ padding: '16px', overflowY: 'auto', flex: 1 }}>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '12px' }}>Service Provider Requests</p>
          {spRequestsLoading ? (
            <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '40px' }}>Loading...</p>
          ) : spRequests.length === 0 ? (
            <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '40px' }}>No requests yet.</p>
          ) : (
            spRequests.map((req: any) => {
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
                  {(req.provider_type || req.country) && (
                    <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '0 0 6px' }}>
                      {[req.provider_type && req.provider_type.toUpperCase(), req.country, req.business_name, req.cac_number && `CAC ${req.cac_number}`, req.identity_id_number && `${req.identity_id_type || 'ID'} ${req.identity_id_number}`].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {req.reason && <p style={{ color: '#8B8FA8', fontSize: '13px', margin: '0 0 10px', lineHeight: 1.4 }}>{req.reason}</p>}
                  <p style={{ color: '#555C7A', fontSize: '11px', margin: '0 0 10px' }}>{new Date(req.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                  {req.document_url && (
                    <button
                      onClick={() => handlePreviewCacDocument(req.id, req.document_url)}
                      disabled={cacPreviewLoadingId === req.id}
                      style={{ width: '100%', height: '32px', borderRadius: '10px', background: 'rgba(123,47,247,0.12)', border: '1px solid rgba(123,47,247,0.3)', color: '#B794F6', fontSize: '12px', fontWeight: 600, cursor: 'pointer', marginBottom: '8px' }}
                    >
                      {cacPreviewLoadingId === req.id ? 'Loading...' : 'View Document'}
                    </button>
                  )}
                  {req.status === 'pending' && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button onClick={() => reviewSpRequest(req.id, 'approved')} style={{ flex: 1, height: '36px', borderRadius: '10px', background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', color: '#10B981', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Approve</button>
                      <button onClick={() => reviewSpRequest(req.id, 'rejected')} style={{ flex: 1, height: '36px', borderRadius: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#EF4444', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>Reject</button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ════════════════ SERVICES (ADMIN) TAB ═══════════════
          Two sub-views in one tab: a filterable provider list, and (once a
          provider is selected) that provider's profile summary + its
          service catalog. Every read/write here is the same is_admin()-
          gated RLS path (0034/0045/0048) the rest of this feature already
          uses -- this is a client UI over that, never a bypass of it. */}
      {tab === 'services-admin' && !svcSelectedProviderId && (
        <div style={{ padding: '16px', overflowY: 'auto', flex: 1 }}>
          <p style={{ color: '#8B8FA8', fontSize: '12px', marginBottom: '12px' }}>
            Service Providers &amp; Services
          </p>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <Search size={14} color="#6B7280" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
              <input
                value={svcSearch}
                onChange={(e) => setSvcSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') loadSvcProviders(); }}
                placeholder="Search business name..."
                style={{ width: '100%', boxSizing: 'border-box', height: '36px', paddingLeft: '32px', paddingRight: '10px', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
              />
            </div>
            <button onClick={() => loadSvcProviders()} style={{ height: '36px', padding: '0 14px', borderRadius: '10px', background: 'rgba(123,47,247,0.12)', border: '1px solid rgba(123,47,247,0.3)', color: '#B794F6', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
              Search
            </button>
          </div>

          {(() => {
            const chipStyle: React.CSSProperties = { height: '32px', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', color: '#C4C9E0', fontSize: '12px', padding: '0 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' };
            const countryLabel = svcCountryFilter ? COUNTRY_CODES.find((c) => c.iso === svcCountryFilter)?.name : 'All countries';
            const statusLabels: Record<string, string> = { all: 'All provider statuses', draft: 'Draft', approved: 'Approved', rejected: 'Rejected' };
            const serviceStatusLabels: Record<string, string> = { all: 'All service statuses', 'has-active': 'Has active service(s)', 'no-active': 'No active services' };
            return (
              <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
                <div style={chipStyle} onClick={() => setOpenSvcFilterPicker('country')}>{countryLabel || 'All countries'}</div>
                <div style={chipStyle} onClick={() => setOpenSvcFilterPicker('category')}>{svcCategoryFilter || 'All categories'}</div>
                <div style={chipStyle} onClick={() => setOpenSvcFilterPicker('status')}>{statusLabels[svcStatusFilter]}</div>
                <div style={chipStyle} onClick={() => setOpenSvcFilterPicker('serviceStatus')}>{serviceStatusLabels[svcServiceStatusFilter]}</div>
              </div>
            );
          })()}

          {openSvcFilterPicker === 'country' && (
            <PickerSheet
              title="Filter by Country"
              options={[{ value: '', label: 'All countries' }, ...COUNTRY_CODES.map((c) => ({ value: c.iso, label: c.name }))]}
              value={svcCountryFilter}
              onSelect={(v) => { setSvcCountryFilter(v); setOpenSvcFilterPicker(null); }}
              onClose={() => setOpenSvcFilterPicker(null)}
            />
          )}
          {openSvcFilterPicker === 'category' && (
            <PickerSheet
              title="Filter by Category"
              options={[{ value: '', label: 'All categories' }, ...SERVICE_CATEGORIES.map((c) => ({ value: c, label: c }))]}
              value={svcCategoryFilter}
              onSelect={(v) => { setSvcCategoryFilter(v); setOpenSvcFilterPicker(null); }}
              onClose={() => setOpenSvcFilterPicker(null)}
            />
          )}
          {openSvcFilterPicker === 'status' && (
            <PickerSheet
              title="Filter by Provider Status"
              searchable={false}
              options={[
                { value: 'all', label: 'All provider statuses' },
                { value: 'draft', label: 'Draft' },
                { value: 'approved', label: 'Approved' },
                { value: 'rejected', label: 'Rejected' },
              ]}
              value={svcStatusFilter}
              onSelect={(v) => { setSvcStatusFilter(v as any); setOpenSvcFilterPicker(null); }}
              onClose={() => setOpenSvcFilterPicker(null)}
            />
          )}
          {openSvcFilterPicker === 'serviceStatus' && (
            <PickerSheet
              title="Filter by Service Status"
              searchable={false}
              options={[
                { value: 'all', label: 'All service statuses' },
                { value: 'has-active', label: 'Has active service(s)' },
                { value: 'no-active', label: 'No active services' },
              ]}
              value={svcServiceStatusFilter}
              onSelect={(v) => { setSvcServiceStatusFilter(v as any); setOpenSvcFilterPicker(null); }}
              onClose={() => setOpenSvcFilterPicker(null)}
            />
          )}

          {svcProvidersError && <p style={{ color: '#EF4444', fontSize: '13px', marginBottom: '12px' }}>{svcProvidersError}</p>}

          {svcProvidersLoading ? (
            <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '40px' }}>Loading...</p>
          ) : !svcProviders || svcProviders.length === 0 ? (
            <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '40px' }}>No service providers match these filters.</p>
          ) : (
            svcProviders.map((p: any) => {
              const ownerName = p.owner?.full_name || p.owner?.username || p.owner?.email || p.user_id;
              return (
                <div
                  key={p.id}
                  onClick={() => setSvcSelectedProviderId(p.id)}
                  style={{ background: '#090514', borderRadius: '14px', padding: '14px', marginBottom: '10px', border: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>{p.business_name}</span>
                    <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '8px', background: p.status === 'approved' ? 'rgba(16,185,129,0.15)' : p.status === 'rejected' ? 'rgba(239,68,68,0.15)' : 'rgba(148,163,184,0.15)', color: p.status === 'approved' ? '#10B981' : p.status === 'rejected' ? '#EF4444' : '#94A3B8', textTransform: 'uppercase' as const }}>
                      {p.status}
                    </span>
                  </div>
                  <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '0 0 4px' }}>
                    {[p.category, p.country].filter(Boolean).join(' · ')}
                  </p>
                  <p style={{ color: '#6B7280', fontSize: '11px', margin: 0 }}>
                    Owner: {ownerName}
                  </p>
                  <p style={{ color: p.hasActiveService ? '#10B981' : '#6B7280', fontSize: '11px', margin: '6px 0 0', fontWeight: 600 }}>
                    {p.hasActiveService ? 'Has active service(s)' : 'No active services'}
                  </p>
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === 'services-admin' && svcSelectedProviderId && (
        <div style={{ padding: '16px', overflowY: 'auto', flex: 1 }}>
          <button
            onClick={() => setSvcSelectedProviderId(null)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: '#B794F6', fontSize: '12px', fontWeight: 600, cursor: 'pointer', padding: 0, marginBottom: '14px' }}
          >
            <ArrowLeft size={14} /> Back to all providers
          </button>

          {svcSelectedProvider && (
            <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '14px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>{svcSelectedProvider.business_name}</span>
                <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '8px', background: svcSelectedProvider.status === 'approved' ? 'rgba(16,185,129,0.15)' : svcSelectedProvider.status === 'rejected' ? 'rgba(239,68,68,0.15)' : 'rgba(148,163,184,0.15)', color: svcSelectedProvider.status === 'approved' ? '#10B981' : svcSelectedProvider.status === 'rejected' ? '#EF4444' : '#94A3B8', textTransform: 'uppercase' as const }}>
                  {svcSelectedProvider.status}
                </span>
              </div>
              <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '0 0 4px' }}>
                {[svcSelectedProvider.category, svcSelectedProvider.country].filter(Boolean).join(' · ')}
              </p>
              <p style={{ color: '#6B7280', fontSize: '11px', margin: 0 }}>
                Owner: {svcSelectedProvider.owner?.full_name || svcSelectedProvider.owner?.username || svcSelectedProvider.owner?.email || svcSelectedProvider.user_id}
                {' · '}Listing ID: {svcSelectedProvider.id}
              </p>
              {svcSelectedProvider.status !== 'approved' && (
                <p style={{ color: '#F59E0B', fontSize: '11px', margin: '8px 0 0' }}>
                  This listing is not approved -- none of its services (active or not) are visible to customers regardless of their own status.
                </p>
              )}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0 }}>Services</p>
            <button
              onClick={() => openSvcServiceForm(null)}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', height: '30px', padding: '0 12px', borderRadius: '8px', background: 'rgba(123,47,247,0.12)', border: '1px solid rgba(123,47,247,0.3)', color: '#B794F6', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
            >
              <Plus size={13} /> Add Service
            </button>
          </div>

          {svcServicesError && <p style={{ color: '#EF4444', fontSize: '13px', marginBottom: '12px' }}>{svcServicesError}</p>}

          {svcServicesLoading ? (
            <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '30px' }}>Loading...</p>
          ) : !svcServices || svcServices.length === 0 ? (
            <p style={{ color: '#8B8FA8', textAlign: 'center', marginTop: '30px' }}>No services yet for this provider.</p>
          ) : (
            svcServices.map((svc) => (
              <div key={svc.id} style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '14px', padding: '14px', marginBottom: '10px', opacity: svc.isActive ? 1 : 0.6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, margin: 0 }}>{svc.name}</p>
                    {svc.category && <p style={{ color: '#6B7280', fontSize: '11px', margin: '2px 0 0' }}>{svc.category}</p>}
                  </div>
                  <span style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '8px', background: svc.isActive ? 'rgba(16,185,129,0.15)' : 'rgba(148,163,184,0.15)', color: svc.isActive ? '#10B981' : '#94A3B8', flexShrink: 0 }}>
                    {svc.isActive ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>
                {svc.description && <p style={{ color: '#8B8FA8', fontSize: '12px', margin: '8px 0 0', lineHeight: 1.4 }}>{svc.description}</p>}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                  <span style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700 }}>
                    {svc.currency} {svc.price.toLocaleString('en-US')}
                    {svc.durationMinutes ? <span style={{ color: '#8B8FA8', fontWeight: 500 }}> · {svc.durationMinutes} min</span> : null}
                  </span>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => handleSvcToggleActive(svc)} disabled={svcServiceBusyId === svc.id} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '6px 10px', color: '#C4C9E0', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                      {svc.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button onClick={() => openSvcServiceForm(svc)} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                      <Pencil size={12} color="#C4C9E0" />
                    </button>
                    {/* Delete kept visually separated (red, own spacing) from
                        Activate/Edit -- the only destructive action here. */}
                    <button onClick={() => handleSvcDeleteService(svc)} disabled={svcServiceBusyId === svc.id} style={{ background: 'none', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                      <Trash2 size={12} color="#EF4444" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {svcServiceForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9998, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={() => !svcServiceSaving && setSvcServiceForm(null)}>
          <div style={{ background: '#090514', borderRadius: '20px 20px 0 0', padding: '20px', width: '100%', maxWidth: '460px', maxHeight: '85vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ color: '#F0F0FF', fontSize: '16px', fontWeight: 700, margin: '0 0 4px' }}>
              {svcServiceForm.editing ? 'Edit Service' : 'Add Service'}
            </h3>
            <input
              value={svcServiceForm.input.name}
              onChange={(e) => setSvcServiceForm({ ...svcServiceForm, input: { ...svcServiceForm.input, name: e.target.value } })}
              placeholder="Service name"
              style={{ height: '38px', background: '#060A12', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '0 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
            />
            <textarea
              value={svcServiceForm.input.description}
              onChange={(e) => setSvcServiceForm({ ...svcServiceForm, input: { ...svcServiceForm.input, description: e.target.value } })}
              placeholder="Description (optional)"
              rows={3}
              style={{ background: '#060A12', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '10px 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none', resize: 'none' }}
            />
            <PickerField
              value={svcServiceForm.input.category || ''}
              placeholder="No category"
              onOpen={() => setShowSvcServiceCategoryPicker(true)}
            />
            <div style={{ display: 'flex', gap: '8px', minWidth: 0 }}>
              <input
                type="number" min="0"
                value={svcServiceForm.input.price || ''}
                onChange={(e) => setSvcServiceForm({ ...svcServiceForm, input: { ...svcServiceForm.input, price: Number(e.target.value) } })}
                placeholder="Price"
                style={{ flex: 1, minWidth: 0, height: '38px', background: '#060A12', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '0 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
              />
              <div style={{ width: '100px', flexShrink: 0 }}>
                <PickerField
                  value={svcServiceForm.input.currency}
                  placeholder="Currency"
                  onOpen={() => setShowSvcServiceCurrencyPicker(true)}
                />
              </div>
            </div>
            <input
              type="number" min="1"
              value={svcServiceForm.input.durationMinutes ?? ''}
              onChange={(e) => setSvcServiceForm({ ...svcServiceForm, input: { ...svcServiceForm.input, durationMinutes: e.target.value ? Number(e.target.value) : null } })}
              placeholder="Duration in minutes (optional)"
              style={{ height: '38px', background: '#060A12', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '0 12px', color: '#F0F0FF', fontSize: '13px', outline: 'none' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', background: '#060A12', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px' }}>
              <span style={{ color: '#C4C9E0', fontSize: '12px', fontWeight: 600 }}>Published (visible to customers)</span>
              <div
                onClick={() => setSvcServiceForm({ ...svcServiceForm, input: { ...svcServiceForm.input, isActive: !svcServiceForm.input.isActive } })}
                style={{ width: '38px', height: '22px', borderRadius: '11px', background: svcServiceForm.input.isActive ? '#7B2FBE' : '#1A1625', cursor: 'pointer', position: 'relative' }}
              >
                <div style={{ position: 'absolute', top: '2px', left: svcServiceForm.input.isActive ? '18px' : '2px', width: '18px', height: '18px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s ease' }} />
              </div>
            </div>

            {svcServiceFormError && <p style={{ color: '#EF4444', fontSize: '12px', margin: 0 }}>{svcServiceFormError}</p>}

            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button onClick={() => setSvcServiceForm(null)} disabled={svcServiceSaving} style={{ flex: 1, height: '42px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#C4C9E0', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleSvcServiceSubmit} disabled={svcServiceSaving} style={{ flex: 1, height: '42px', borderRadius: '10px', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: svcServiceSaving ? 'wait' : 'pointer', opacity: svcServiceSaving ? 0.7 : 1 }}>
                {svcServiceSaving ? 'Saving...' : svcServiceForm.editing ? 'Save Changes' : 'Add Service'}
              </button>
            </div>
          </div>
        </div>
      )}

      {svcServiceForm && showSvcServiceCategoryPicker && (
        <PickerSheet
          title="Select Category"
          options={[{ value: '', label: 'No category' }, ...SERVICE_CATEGORIES.map((c) => ({ value: c, label: c }))]}
          value={svcServiceForm.input.category || ''}
          onSelect={(v) => { setSvcServiceForm({ ...svcServiceForm, input: { ...svcServiceForm.input, category: v } }); setShowSvcServiceCategoryPicker(false); }}
          onClose={() => setShowSvcServiceCategoryPicker(false)}
          zIndex={9999}
        />
      )}
      {svcServiceForm && showSvcServiceCurrencyPicker && (
        <PickerSheet
          title="Select Currency"
          options={CURRENCIES.map((c) => ({ value: c.code, label: c.code }))}
          value={svcServiceForm.input.currency}
          onSelect={(v) => { setSvcServiceForm({ ...svcServiceForm, input: { ...svcServiceForm.input, currency: v } }); setShowSvcServiceCurrencyPicker(false); }}
          onClose={() => setShowSvcServiceCurrencyPicker(false)}
          zIndex={9999}
        />
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

          {/* Kill Switches — Block 17 Operational Controls */}
          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: disablePurchases ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Ticket size={17} color={disablePurchases ? '#EF4444' : '#10B981'} />
                </div>
                <div>
                  <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Ticket Purchases</p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                    {disablePurchases ? 'Paused — "Buy Ticket" is blocked for every user' : 'Enabled — purchases are open'}
                  </p>
                </div>
              </div>
              <div onClick={() => handleToggleKillSwitch('disable_purchases', disablePurchases)} style={{ cursor: 'pointer' }}>
                {disablePurchases
                  ? <ToggleLeft size={32} color="#EF4444" />
                  : <ToggleRight size={32} color="#10B981" />}
              </div>
            </div>
          </div>

          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: disableScanning ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ScanLine size={17} color={disableScanning ? '#EF4444' : '#10B981'} />
                </div>
                <div>
                  <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>QR Scanning</p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                    {disableScanning ? 'Paused — check-in scanners are blocked for every organizer' : 'Enabled — check-in scanning is open'}
                  </p>
                </div>
              </div>
              <div onClick={() => handleToggleKillSwitch('disable_scanning', disableScanning)} style={{ cursor: 'pointer' }}>
                {disableScanning
                  ? <ToggleLeft size={32} color="#EF4444" />
                  : <ToggleRight size={32} color="#10B981" />}
              </div>
            </div>
          </div>

          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: disableSignups ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <UserPlus size={17} color={disableSignups ? '#EF4444' : '#10B981'} />
                </div>
                <div>
                  <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>New Sign-ups</p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                    {disableSignups ? 'Paused — new account creation is blocked' : 'Enabled — sign-ups are open'}
                  </p>
                </div>
              </div>
              <div onClick={() => handleToggleKillSwitch('disable_signups', disableSignups)} style={{ cursor: 'pointer' }}>
                {disableSignups
                  ? <ToggleLeft size={32} color="#EF4444" />
                  : <ToggleRight size={32} color="#10B981" />}
              </div>
            </div>
          </div>

          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: disablePayouts ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Banknote size={17} color={disablePayouts ? '#EF4444' : '#10B981'} />
                </div>
                <div>
                  <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Organizer Payouts</p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                    {disablePayouts ? 'Paused — approve/cancel/refund payout actions are blocked' : 'Enabled — payout actions are open'}
                  </p>
                </div>
              </div>
              <div onClick={() => handleToggleKillSwitch('disable_payouts', disablePayouts)} style={{ cursor: 'pointer' }}>
                {disablePayouts
                  ? <ToggleLeft size={32} color="#EF4444" />
                  : <ToggleRight size={32} color="#10B981" />}
              </div>
            </div>
          </div>

          <div style={{ background: '#090514', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.06)', padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: disableLocationSharing ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <MapPin size={17} color={disableLocationSharing ? '#EF4444' : '#10B981'} />
                </div>
                <div>
                  <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>Location Sharing</p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>
                    {disableLocationSharing ? 'Paused — sharing your location in chat is blocked' : 'Enabled — location sharing is open'}
                  </p>
                </div>
              </div>
              <div onClick={() => handleToggleKillSwitch('disable_location_sharing', disableLocationSharing)} style={{ cursor: 'pointer' }}>
                {disableLocationSharing
                  ? <ToggleLeft size={32} color="#EF4444" />
                  : <ToggleRight size={32} color="#10B981" />}
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
            {appVersionLabel()} · All root actions are immutably logged.
          </p>
        </div>
      )}
    </div>
  );
}
