// Batch 3 — Organizer Detail. Follows design-export's v_orgDetail block
// (~491-558, 5 tabs: Overview/Events/Payouts/KYC/Audit). Built from EXISTING
// users + events + organizer_verification_requests + organizer_wallets /
// organizer_withdrawal_requests — no new organizer backend invented.
//
// Real data sources:
//  - Profile: `users` row (role='organizer').
//  - Events: `events` filtered by organizer_id — the exact table/FK Batch
//    2's AdminEventsList already uses, just scoped to one organizer here.
//  - Verification/CAC: `organizer_verification_requests` filtered by
//    user_id (organizer_verif_select_own RLS, is_admin() OR own row) for
//    the full application detail; the approve/reject buttons call
//    admin_approve_organizer_verification / admin_reject_organizer_verification
//    through the SAME submitOrExecute maker-checker gate
//    (request_admin_action, action types organizer_verification_approve /
//    organizer_verification_reject — already wired in AdminActionsTab.tsx's
//    describe() map) as AdminDashboardScreen's existing Verify tab. A
//    Sub-Admin's click is queued for Super Admin approval; a Super Admin/
//    Root's click executes immediately — identical to Batch 2's suspend/
//    verify/hide gating.
//  - Payouts/wallet: `organizer_withdrawal_requests` and `organizer_wallets`
//    filtered by organizer_id — the same two tables the existing Payouts
//    tab in AdminDashboardScreen already reads (0002_tables.sql /
//    20260622001319_organizer-wallet.sql), scoped to this one organizer.
//  - Audit: `admin_logs` filtered by target_user_id, same pattern as
//    Batch 2's per-user Audit tab.
// No fabricated attendee/revenue aggregates — ticket revenue per organizer
// is not queried by any admin-accessible source today and is NOT shown.
import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { submitOrExecute } from './adminUserEventActions';

interface OrganizerRow { id: string; full_name: string | null; username: string | null; email: string; phone_number: string | null; state: string | null; is_verified: boolean; created_at: string; }
interface EventRow { id: string; title: string | null; event_date: string | null; deleted_at: string | null; }
interface VerifRequest {
  id: string; status: string; company_name: string | null; cac_number: string | null; owner_name: string | null;
  registration_date: string | null; business_email: string | null; business_phone: string | null;
  business_address: string | null; document_url: string | null; admin_note: string | null; created_at: string; reviewed_at: string | null;
}
interface WithdrawalRow { id: string; amount_kobo: number; status: string; created_at: string; }
interface WalletRow { balance_kobo: number; pending_kobo: number; total_earned_kobo: number; total_withdrawn_kobo: number; }
interface AuditRow { id: string; action: string; details: Record<string, any>; created_at: string; actor_role: string | null; }

type Tab = 'overview' | 'events' | 'payouts' | 'kyc' | 'audit';
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'events', label: 'Events' },
  { key: 'payouts', label: 'Payouts' },
  { key: 'kyc', label: 'KYC' },
  { key: 'audit', label: 'Audit' },
];

const NGN = (kobo: number) => '₦' + Math.round(kobo / 100).toLocaleString('en-NG');

function NotAvailable({ reason }: { reason: string }) {
  return (
    <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>
      Not available — {reason}
    </div>
  );
}

export function AdminOrganizerDetail({ organizerId, isSuperAdmin, isMobile, onBack }: {
  organizerId: string; isSuperAdmin: boolean; isMobile: boolean; onBack: () => void;
}) {
  const [organizer, setOrganizer] = useState<OrganizerRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);

  const [verif, setVerif] = useState<VerifRequest | null>(null);
  const [verifLoading, setVerifLoading] = useState(false);
  const [verifFetched, setVerifFetched] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectBox, setShowRejectBox] = useState(false);

  const [withdrawals, setWithdrawals] = useState<WithdrawalRow[] | null>(null);
  const [wallet, setWallet] = useState<WalletRow | null>(null);
  const [payoutsLoading, setPayoutsLoading] = useState(false);
  const [payoutsError, setPayoutsError] = useState<string | null>(null);

  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data, error: err } = await supabase
        .from('users')
        .select('id, full_name, username, email, phone_number, state, is_verified, created_at')
        .eq('id', organizerId)
        .maybeSingle();
      if (err) throw err;
      if (!data) throw new Error('Organizer not found.');
      setOrganizer(data);
    } catch (e: any) {
      setError(e?.message || 'Failed to load organizer.');
    } finally { setLoading(false); }
  }, [organizerId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab !== 'events' || events || eventsLoading) return;
    setEventsLoading(true);
    Promise.resolve(
      supabase.from('events').select('id, title, event_date, deleted_at')
        .eq('organizer_id', organizerId).is('deleted_at', null)
        .order('event_date', { ascending: false }).limit(100),
    )
      .then(({ data }: any) => setEvents(data || []))
      .finally(() => setEventsLoading(false));
  }, [tab, organizerId, events, eventsLoading]);

  const loadVerif = useCallback(async () => {
    setVerifLoading(true);
    try {
      const { data, error: err } = await supabase
        .from('organizer_verification_requests')
        .select('id, status, company_name, cac_number, owner_name, registration_date, business_email, business_phone, business_address, document_url, admin_note, created_at, reviewed_at')
        .eq('user_id', organizerId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (err) throw err;
      setVerif(data || null);
    } finally { setVerifLoading(false); setVerifFetched(true); }
  }, [organizerId]);

  useEffect(() => { if (tab === 'kyc' && !verifFetched && !verifLoading) loadVerif(); }, [tab, verifFetched, verifLoading, loadVerif]);

  useEffect(() => {
    if (tab !== 'payouts' || withdrawals) return;
    setPayoutsLoading(true); setPayoutsError(null);
    Promise.all([
      supabase.from('organizer_withdrawal_requests').select('id, amount_kobo, status, created_at').eq('organizer_id', organizerId).order('created_at', { ascending: false }).limit(50),
      supabase.from('organizer_wallets').select('balance_kobo, pending_kobo, total_earned_kobo, total_withdrawn_kobo').eq('organizer_id', organizerId).maybeSingle(),
    ]).then(([wRes, walRes]) => {
      if (wRes.error) throw wRes.error;
      setWithdrawals(wRes.data || []);
      setWallet(walRes.data || null);
    }).catch((e: any) => setPayoutsError(e?.message || 'Failed to load payouts.'))
      .finally(() => setPayoutsLoading(false));
  }, [tab, organizerId, withdrawals]);

  useEffect(() => {
    if (tab !== 'audit') return;
    setAuditLoading(true);
    Promise.resolve(
      supabase.from('admin_logs').select('id, action, details, created_at, actor_role')
        .eq('target_user_id', organizerId).order('created_at', { ascending: false }).limit(50),
    )
      .then(({ data }: any) => setAudit(data || []))
      .finally(() => setAuditLoading(false));
  }, [tab, organizerId]);

  const decide = async (status: 'approved' | 'rejected') => {
    if (!verif) return;
    if (status === 'rejected' && !rejectReason.trim()) { flash(false, 'A rejection reason is required.'); return; }
    setBusy(true);
    const actionType = status === 'approved' ? 'organizer_verification_approve' : 'organizer_verification_reject';
    const rpcName = status === 'approved' ? 'admin_approve_organizer_verification' : 'admin_reject_organizer_verification';
    const payload: any = { request_id: verif.id };
    if (status === 'rejected') payload.reason = rejectReason.trim();
    const res = await submitOrExecute(isSuperAdmin, actionType,
      { target_type: 'verification', target_id: verif.id, target_label: organizer?.username || organizer?.email || 'Organizer verification', payload },
      async () => {
        const { error: err } = await supabase.rpc(rpcName as any, status === 'approved'
          ? { p_request_id: verif.id }
          : { p_request_id: verif.id, p_reason: rejectReason.trim() });
        if (err) throw new Error(err.message);
      });
    flash(res.ok, res.message);
    if (res.ok && isSuperAdmin) await loadVerif();
    setShowRejectBox(false);
    setRejectReason('');
    setBusy(false);
  };

  if (loading) return <div style={{ color: adminTheme.textFaint, fontSize: 12.5, padding: 32, textAlign: 'center' }}>Loading organizer…</div>;
  if (error || !organizer) return (
    <div>
      <div onClick={onBack} style={{ cursor: 'pointer', fontSize: 12.5, color: adminTheme.accentText, marginBottom: 14 }}>← Back to Organizers</div>
      <div style={{ color: adminTheme.red, fontSize: 12.5 }}>{error || 'Organizer not found.'}</div>
    </div>
  );

  const verifChip = organizer.is_verified
    ? { bg: 'rgba(96,165,250,.12)', fg: adminTheme.blue, label: 'Verified' }
    : { bg: adminTheme.borderChip, fg: adminTheme.textFaint, label: 'Unverified' };

  return (
    <div data-testid="admin-organizer-detail">
      <div onClick={onBack} style={{ cursor: 'pointer', fontSize: 12.5, color: adminTheme.accentText, marginBottom: 14 }}>← Back to Organizers</div>
      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text, marginBottom: 10 }}>{msg}</div>}

      <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: isMobile ? 16 : '20px 22px', marginBottom: 18 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: adminTheme.textStrong }}>{organizer.full_name || organizer.username || 'No name'}</div>
        <div style={{ fontSize: 12.5, color: adminTheme.textMuted, marginTop: 4 }}>{organizer.email} · {organizer.state || 'Unknown state'}</div>
        <span style={{ display: 'inline-block', marginTop: 8, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: verifChip.bg, color: verifChip.fg }}>{verifChip.label}</span>
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${adminTheme.borderSoft}`, marginBottom: 18, overflowX: 'auto', whiteSpace: 'nowrap' }}>
        {TABS.map((t) => (
          <div key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', flexShrink: 0,
            color: tab === t.key ? adminTheme.text : adminTheme.textFaint,
            borderBottom: tab === t.key ? `2px solid ${adminTheme.accentFrom}` : '2px solid transparent',
          }}>{t.label}</div>
        ))}
      </div>

      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: 14 }}>
          {[
            { label: 'PHONE', value: organizer.phone_number || '—' },
            { label: 'STATE', value: organizer.state || '—' },
            { label: 'JOINED', value: new Date(organizer.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' }) },
            { label: 'ORGANIZER ID', value: organizer.id.slice(0, 8) + '…' },
          ].map((s) => (
            <div key={s.label} style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 11, color: adminTheme.textFainter, fontWeight: 600, marginBottom: 8 }}>{s.label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: adminTheme.textStrong, wordBreak: 'break-word' }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'events' && (
        eventsLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading events…</div>
        : !events || events.length === 0 ? (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No events hosted yet.</div>
        ) : (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
            {events.map((ev) => (
              <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${adminTheme.borderSoft}`, fontSize: 12.5 }}>
                <div style={{ color: adminTheme.text, fontWeight: 600 }}>{ev.title || '(Untitled)'}</div>
                <div style={{ color: adminTheme.textMuted }}>{ev.event_date ? new Date(ev.event_date).toLocaleDateString('en-NG', { dateStyle: 'medium' }) : '—'}</div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'payouts' && (
        payoutsLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading payouts…</div>
        : payoutsError ? <NotAvailable reason={payoutsError} />
        : (
          <div>
            <div style={{ display: 'flex', gap: 14, marginBottom: 18, flexWrap: 'wrap' }}>
              {[
                { label: 'BALANCE', value: NGN(wallet?.balance_kobo || 0) },
                { label: 'PENDING', value: NGN(wallet?.pending_kobo || 0) },
                { label: 'TOTAL EARNED', value: NGN(wallet?.total_earned_kobo || 0) },
                { label: 'TOTAL WITHDRAWN', value: NGN(wallet?.total_withdrawn_kobo || 0) },
              ].map((s) => (
                <div key={s.label} style={{ flex: '1 1 140px', background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 16 }}>
                  <div style={{ fontSize: 11, color: adminTheme.textFainter, fontWeight: 600, marginBottom: 8 }}>{s.label}</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: adminTheme.textStrong }}>{s.value}</div>
                </div>
              ))}
            </div>
            {!wallet && <NotAvailable reason="no organizer_wallets row exists yet for this organizer — they have never earned or withdrawn funds." />}
            {withdrawals && withdrawals.length > 0 && (
              <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '11px 16px', fontSize: 10.5, fontWeight: 700, letterSpacing: .4, color: adminTheme.textFaint, borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
                  <div>DATE</div><div>AMOUNT</div><div>STATUS</div>
                </div>
                {withdrawals.map((w) => (
                  <div key={w.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '12px 16px', fontSize: 12.5, borderBottom: `1px solid ${adminTheme.borderSoft}` }}>
                    <div style={{ color: adminTheme.textMuted }}>{new Date(w.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}</div>
                    <div style={{ color: adminTheme.text, fontWeight: 600 }}>{NGN(w.amount_kobo)}</div>
                    <div style={{ color: adminTheme.text, textTransform: 'capitalize' }}>{w.status}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      )}

      {tab === 'kyc' && (
        verifLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading verification…</div>
        : !verif ? <NotAvailable reason="no organizer_verification_requests row exists for this organizer — they have not submitted CAC verification." />
        : (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 18, fontSize: 12.5, color: adminTheme.text, lineHeight: 1.7 }}>
            <div>Status: <strong style={{ textTransform: 'capitalize' }}>{verif.status}</strong></div>
            <div>Company: {verif.company_name || '—'} · CAC {verif.cac_number || '—'}</div>
            <div>Owner: {verif.owner_name || '—'} · {verif.business_email || '—'} · {verif.business_phone || '—'}</div>
            <div>Address: {verif.business_address || '—'}</div>
            <div>Submitted: {new Date(verif.created_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}
              {verif.reviewed_at && ` · Reviewed ${new Date(verif.reviewed_at).toLocaleDateString('en-NG', { dateStyle: 'medium' })}`}</div>
            {verif.admin_note && <div>Note: {verif.admin_note}</div>}

            {verif.status === 'pending' && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                <button disabled={busy} onClick={() => decide('approved')}
                  style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.3)', color: adminTheme.green, cursor: busy ? 'not-allowed' : 'pointer' }}>
                  {isSuperAdmin ? 'Approve' : 'Request Approve'}
                </button>
                {!showRejectBox ? (
                  <button disabled={busy} onClick={() => setShowRejectBox(true)}
                    style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', color: adminTheme.red, cursor: busy ? 'not-allowed' : 'pointer' }}>
                    {isSuperAdmin ? 'Reject' : 'Request Reject'}
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%' }}>
                    <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Rejection reason…"
                      style={{ flex: 1, minWidth: 180, background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '9px 12px', fontSize: 12.5, color: adminTheme.text, outline: 'none' }} />
                    <button disabled={busy} onClick={() => decide('rejected')}
                      style={{ fontSize: 12, fontWeight: 600, padding: '9px 14px', borderRadius: 8, background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', color: adminTheme.red, cursor: busy ? 'not-allowed' : 'pointer' }}>
                      Confirm
                    </button>
                  </div>
                )}
                {!isSuperAdmin && (
                  <div style={{ fontSize: 11, color: adminTheme.textFaint, width: '100%' }}>Sub-Admin: this sends a request for Super Admin approval via request_admin_action — it does not execute directly.</div>
                )}
              </div>
            )}
          </div>
        )
      )}

      {tab === 'audit' && (
        auditLoading ? <div style={{ color: adminTheme.textFaint, fontSize: 12.5, textAlign: 'center', padding: 24 }}>Loading audit trail…</div>
        : audit.length === 0 ? <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, padding: 24, textAlign: 'center', color: adminTheme.textFaint, fontSize: 12.5 }}>No admin actions recorded for this organizer.</div>
        : (
          <div style={{ background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 12, overflow: 'hidden' }}>
            {audit.map((a) => (
              <div key={a.id} style={{ display: 'flex', gap: 12, padding: '13px 16px', borderBottom: `1px solid ${adminTheme.borderSoft}`, fontSize: 12.5, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                <div style={{ color: adminTheme.textFaint, width: isMobile ? '100%' : 130, flexShrink: 0 }}>{new Date(a.created_at).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</div>
                <div style={{ color: adminTheme.text, flex: 1 }}>{a.action.replace(/_/g, ' ')}</div>
                <div style={{ color: adminTheme.textMuted }}>{a.actor_role || '—'}</div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
