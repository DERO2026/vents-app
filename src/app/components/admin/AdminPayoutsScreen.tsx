// Payouts. Withdrawal requests (0213: PayoutRequestsPanel -- review,
// approve for payment, Authorize & Pay with the VENTS Admin Payout PIN),
// Organizer Wallets, User Wallets, held earnings, booking disputes, payout
// exceptions and Reconcile. The design export's separate "Finance / VENTS
// Wallet / Payments / Refunds" nav entries all point at this one screen.
import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme } from './adminConsoleTheme';
import { EarningsAdjustmentForm } from './EarningsAdjustmentForm';
import { PayoutRequestsPanel } from './PayoutRequestsPanel';
import { apiUrl } from '../../../lib/apiBase';
import { withTimeoutFallback } from '../../../lib/withTimeoutFallback';
import { Sentry } from '../../../lib/sentry';

// isSuperAdmin is no longer used for payouts: every payout button comes from
// the server's can_* columns for THIS admin (0213). Kept for callers.
export function AdminPayoutsScreen(_props: { isSuperAdmin?: boolean } = {}) {
  const [wallets, setWallets] = useState<any[]>([]);
  // 0203: held earnings of one organizer/provider, opened from the wallets list.
  const [holdsFor, setHoldsFor] = useState<string | null>(null);
  const [holds, setHolds] = useState<any[] | null>(null);
  const [memberWallets, setMemberWallets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [payoutsDisabled, setPayoutsDisabled] = useState(false);
  useEffect(() => {
    supabase.from('app_config').select('disable_payouts').maybeSingle()
      .then(({ data }) => setPayoutsDisabled(!!data?.disable_payouts), () => {});
  }, []);
  const [activeSection, setActiveSection] = useState<'requests' | 'wallets' | 'member-wallets'>('requests');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [checkingExceptions, setCheckingExceptions] = useState(false);
  const [showAdjustment, setShowAdjustment] = useState(false);
  const [exceptionReport, setExceptionReport] = useState<any[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (ok: boolean, m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3500); };
  // Audit finding: unlike Approve (protected server-side by
  // admin_claim_payout_for_processing's atomic status compare-and-swap),
  // admin_reject_organizer_payout and admin_cancel_processing_payout both
  // do an unlocked SELECT of the current status followed by a SEPARATE
  // UPDATE not reconditioned on that status (confirmed live via
  // pg_get_functiondef) -- a genuine TOCTOU race: two concurrent calls for
  // the same request could both read 'pending'/'processing', both pass,
  // and both refund the organizer's wallet, double-crediting it. That
  // needs a database fix (prepared separately, not applied here). This ref
  // is the only mitigation available without a migration: it closes the
  // client-side half of the race (a double-click on the modal's own
  // Confirm button, which has no busy state of its own) so this app can
  // never be the one that fires the second call.
  const actionInFlightRef = useRef<string | null>(null);

  // Wallet lists only; withdrawal requests and their totals come from the
  // server inside PayoutRequestsPanel (0213).
  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [walRes, memberWalRes] = await withTimeoutFallback(
        Promise.all([
          supabase.from('organizer_wallets').select('*').order('balance_kobo', { ascending: false }).limit(100),
          supabase.from('user_wallets').select('user_id, balance_kobo').order('balance_kobo', { ascending: false }).limit(100),
        ]),
        { timeoutMs: 15000, timeoutMessage: 'This is taking longer than expected. Please check your connection and try again.' }
      );
      const { data: walsRaw, error: walError } = walRes;
      const { data: memberWalsRaw, error: memberWalError } = memberWalRes;
      if (walError || memberWalError) {
        Sentry.captureException(walError || memberWalError);
        setLoadError((walError || memberWalError)?.message || 'Failed to load wallets.');
      }
      let wals = walsRaw || [];
      let memberWals = memberWalsRaw || [];
      const ids = [...wals.map((w: any) => w.organizer_id), ...memberWals.map((w: any) => w.user_id)];
      if (ids.length > 0) {
        const { data: userRows } = await supabase.from('users').select('id, username, full_name').in('id', ids);
        const userMap: Record<string, any> = {};
        (userRows || []).forEach((u: any) => { userMap[u.id] = u; });
        wals = wals.map((w: any) => ({ ...w, users: userMap[w.organizer_id] || null }));
        memberWals = memberWals.map((w: any) => ({ ...w, users: userMap[w.user_id] || null }));
      }
      setWallets(wals);
      setMemberWallets(memberWals);
    } catch (err: any) {
      Sentry.captureException(err);
      setLoadError(err?.message || 'Failed to load wallets.');
    } finally { setLoading(false); }
  };

  useEffect(() => { if (activeSection !== 'requests') load(); }, [activeSection]);

  // 0203: open customer disputes of completed bookings. Each is decided by
  // two admins (request here, approve in Admin Actions); until then the
  // provider's earnings for that booking stay held. Empty (and hidden) on a
  // database without 0203.
  const [disputes, setDisputes] = useState<any[]>([]);
  const loadDisputes = async () => {
    const { data, error } = await supabase.from('service_booking_disputes' as any)
      .select('id, booking_id, reason, opened_at, status, resolution_note').in('status', ['open', 'resolved_for_customer'])
      .order('opened_at', { ascending: true }).limit(50);
    setDisputes(error ? [] : ((data as any[]) || []));
  };
  useEffect(() => { loadDisputes(); }, []);
  const requestDisputeResolution = async (d: any, outcome: 'provider' | 'customer') => {
    const note = window.prompt(outcome === 'provider'
      ? 'Why should the provider be paid? (shown to the approving admin)'
      : 'Why is the customer right? (the earnings stay held for a refund)');
    if (!note?.trim()) return;
    const { error } = await supabase.rpc('request_admin_action' as any, {
      p_action_type: 'resolve_booking_dispute', p_target_type: 'booking', p_target_id: d.booking_id,
      p_target_label: `Booking dispute ${String(d.id).slice(0, 8)}`,
      p_payload: { dispute_id: d.id, outcome, note: note.trim() },
    });
    if (error) { flash(false, error.message || 'Could not request the resolution'); return; }
    flash(true, 'Resolution requested — a different super admin must approve it in Admin Actions.');
  };
  // Upheld for the customer (two admins already decided): refund through the
  // existing booking refund path. A VENTS Wallet booking is refunded at once;
  // a Paystack booking goes refund_pending and the refund webhook finishes it.
  // The database refuses a completed booking without an upheld dispute.
  const refundDisputedBooking = async (d: any) => {
    if (!window.confirm('Refund the customer in full for this booking? The provider gives back their earnings for it.')) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = d.booking_id;
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch(apiUrl('/api/v1/wallet/refund-ticket'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData.session?.access_token}` },
        body: JSON.stringify({ booking_id: d.booking_id, reason: `Dispute upheld: ${d.resolution_note || 'customer complaint'}` }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Refund failed');
      flash(true, json.status === 'refund_pending' ? 'Refund sent to Paystack — it completes when Paystack confirms.' : 'Customer refunded.');
      await loadDisputes();
    } catch (e: any) { flash(false, e.message || 'Refund failed'); } finally { actionInFlightRef.current = null; }
  };

  const handleReconcile = async () => {
    setReconciling(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/reconcile-payouts'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Reconcile failed');
      const resolved = (json.results || []).filter((r: any) => r.outcome === 'completed' || r.outcome === 'failed').length;
      flash(true, `Checked ${json.checked ?? 0} processing payout(s) against Paystack — ${resolved} resolved.`);
      await load();
    } catch (e: any) { flash(false, e.message || 'Reconcile failed'); } finally { setReconciling(false); }
  };

  // Report-only: transfers Paystack may have paid while VENTS shows the
  // request as cancelled, failed or rejected (2026-07 incident). Changes
  // nothing; resolving one is a two-admin decision.
  const handleCheckExceptions = async () => {
    setCheckingExceptions(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch(apiUrl('/api/v1/wallet/reconcile-payouts'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: 'exceptions' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Exception check failed');
      setExceptionReport(Array.isArray(json.report) ? json.report : []);
    } catch (e: any) { flash(false, e.message || 'Exception check failed'); } finally { setCheckingExceptions(false); }
  };

  const fmt = (kobo: number) => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 });

  const loadHolds = async (ownerId: string) => {
    setHoldsFor(ownerId);
    setHolds(null);
    const { data, error } = await supabase.rpc('get_earnings_holds' as any, { p_owner: ownerId });
    if (error) { flash(false, error.message || 'Could not load held earnings'); setHolds([]); return; }
    setHolds((data as any[]) || []);
  };
  // Any admin may place a review hold; lifting one needs a super admin who is
  // not the earner (enforced by admin_set_earnings_hold). Both are audited.
  const setEarningsHold = async (holdId: string, hold: boolean) => {
    const reason = window.prompt(hold ? 'Why are these earnings being held?' : 'Why is this hold being lifted?');
    if (!reason?.trim()) return;
    const { error } = await supabase.rpc('admin_set_earnings_hold' as any, { p_hold_id: holdId, p_hold: hold, p_reason: reason.trim() });
    if (error) { flash(false, error.message || 'Could not update the hold'); return; }
    flash(true, hold ? 'Hold placed — these earnings will not be released until it is lifted.' : 'Hold lifted — the earnings release once nothing else blocks them.');
    if (holdsFor) await loadHolds(holdsFor);
  };

  return (
    <div data-testid="admin-payouts" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {payoutsDisabled && (
        <div style={{ background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 12, padding: '12px 16px' }}>
          <p style={{ margin: 0, fontSize: 13, color: adminTheme.red, fontWeight: 700 }}>⚠ Payouts are temporarily disabled platform-wide</p>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: adminTheme.textMuted }}>Approving, paying and rejecting withdrawals are paused until this kill switch is turned off in System.</p>
        </div>
      )}
      {msg && <div style={{ fontSize: 12.5, color: adminTheme.text }}>{msg}</div>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(['requests', 'wallets', 'member-wallets'] as const).map((s) => (
          <button key={s} onClick={() => setActiveSection(s)} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 12, background: activeSection === s ? adminTheme.accentSoftBg : adminTheme.panel, color: activeSection === s ? adminTheme.accentText : adminTheme.textMuted }}>
            {s === 'requests' ? 'Requests' : s === 'wallets' ? 'Organizer Wallets' : 'User Wallets'}
          </button>
        ))}
        <button onClick={handleReconcile} disabled={reconciling} title="Poll Paystack directly for any payout stuck in Processing and resolve it" style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(96,165,250,.3)', cursor: reconciling ? 'wait' : 'pointer', fontWeight: 600, fontSize: 12, background: 'rgba(96,165,250,.1)', color: adminTheme.blue, opacity: reconciling ? 0.6 : 1 }}>
          {reconciling ? 'Reconciling…' : '⟳ Reconcile Processing'}
        </button>
        <button data-testid="payout-exceptions-check" onClick={handleCheckExceptions} disabled={checkingExceptions} title="Ask Paystack about requests that ended cancelled, failed or rejected while holding a transfer code. Changes nothing." style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid rgba(251,191,36,.3)', cursor: checkingExceptions ? 'wait' : 'pointer', fontWeight: 600, fontSize: 12, background: 'rgba(251,191,36,.1)', color: '#FBBF24', opacity: checkingExceptions ? 0.6 : 1 }}>
          {checkingExceptions ? 'Checking…' : 'Check payout exceptions'}
        </button>
        <button data-testid="earnings-adjustment-toggle" onClick={() => setShowAdjustment((v) => !v)} title="File an audited correction for a second admin to approve (0206). Moves nothing by itself." style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${adminTheme.border}`, cursor: 'pointer', fontWeight: 600, fontSize: 12, background: adminTheme.panel, color: adminTheme.textMuted }}>
          {showAdjustment ? 'Hide adjustment form' : 'Request earnings adjustment'}
        </button>
      </div>

      {showAdjustment && <EarningsAdjustmentForm />}

      {exceptionReport && (
        <div data-testid="payout-exceptions-report" style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#FBBF24' }}>
            Payout exceptions ({exceptionReport.length}) · report only, nothing was changed
          </p>
          {exceptionReport.length === 0 && <p style={{ margin: 0, fontSize: 12, color: adminTheme.textMuted }}>None: every transfer code matches its request.</p>}
          {exceptionReport.map((r: any) => (
            <div key={r.request_id} data-testid={`payout-exception-${r.request_id}`} style={{ fontSize: 12, color: adminTheme.textMuted }}>
              <b style={{ color: r.finding === 'paid_not_recorded' ? adminTheme.red : adminTheme.text }}>
                {r.finding === 'paid_not_recorded' ? 'Paid by Paystack, not recorded in VENTS'
                  : r.finding === 'not_paid_consistent' ? 'Not paid (consistent)'
                  : r.finding === 'still_pending_on_paystack' ? 'Still pending on Paystack'
                  : r.finding === 'no_transfer_code' ? 'Recorded exception (no transfer code)'
                  : 'Paystack lookup failed'}
              </b>
              {' · '}{fmt(Number(r.amount_kobo) || 0)}{' · request '}{String(r.request_id).slice(0, 8)}{' · VENTS status '}{r.request_status}
              {r.paystack_status ? ` · Paystack ${r.paystack_status}` : ''}
            </div>
          ))}
          {exceptionReport.some((r: any) => r.finding === 'paid_not_recorded') && (
            <p style={{ margin: 0, fontSize: 11, color: adminTheme.textMuted }}>
              Resolve with two admins per docs/production-readiness-batch-d.md (payout exceptions). Do not edit these records directly.
            </p>
          )}
        </div>
      )}

      {disputes.length > 0 && (
        <div data-testid="admin-booking-disputes" style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: adminTheme.amber }}>Booking disputes ({disputes.length})</p>
          {disputes.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: adminTheme.text }}>
              <span style={{ flex: 1 }}>{new Date(d.opened_at).toLocaleString('en-NG')} · {d.reason}{d.status === 'resolved_for_customer' ? ' · UPHELD' : ''}</span>
              {d.status === 'open' ? (
                <>
                  <button onClick={() => requestDisputeResolution(d, 'provider')} style={{ background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '4px 8px', color: adminTheme.text, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Pay provider</button>
                  <button onClick={() => requestDisputeResolution(d, 'customer')} style={{ background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '4px 8px', color: adminTheme.text, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Uphold customer</button>
                </>
              ) : (
                <button data-testid="dispute-refund" onClick={() => refundDisputedBooking(d)} disabled={payoutsDisabled} style={{ background: 'rgba(248,113,113,.12)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 8, padding: '4px 8px', color: adminTheme.red, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Refund customer</button>
              )}
            </div>
          ))}
        </div>
      )}
      {loadError && <div style={{ background: 'rgba(248,113,113,.1)', border: '1px solid rgba(248,113,113,.3)', borderRadius: 10, padding: '10px 14px', color: adminTheme.red, fontSize: 12 }}>{loadError}</div>}

      {activeSection !== 'requests' && loading ? (
        <p style={{ color: adminTheme.textFaint, fontSize: 13 }}>Loading…</p>
      ) : activeSection === 'member-wallets' ? (
        memberWallets.length === 0 ? <p style={{ color: adminTheme.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>No user wallets yet</p> : memberWallets.map((w: any) => (
          <div key={w.user_id} style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: adminTheme.textStrong }}>{w.users?.username || w.users?.full_name || w.user_id.slice(0, 8)}</p>
            <span style={{ fontSize: 12, color: adminTheme.accentText }}>Balance: <strong>{fmt(w.balance_kobo)}</strong></span>
          </div>
        ))
      ) : activeSection === 'wallets' ? (
        wallets.length === 0 ? <p style={{ color: adminTheme.textFaint, fontSize: 13, textAlign: 'center', padding: '24px 0' }}>No organizer wallets yet</p> : wallets.map((w: any) => {
          const u = w.users;
          return (
            <div key={w.organizer_id} style={{ background: adminTheme.panelAlt, borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: adminTheme.textStrong }}>{u?.username || u?.full_name || w.organizer_id.slice(0, 8)}</p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: adminTheme.accentText }}>Balance: <strong>{fmt(w.balance_kobo)}</strong></span>
                {(w.pending_kobo ?? 0) > 0 && <span style={{ fontSize: 12, color: adminTheme.amber }}>Pending: {fmt(w.pending_kobo)}</span>}
                {(w.on_hold_kobo ?? 0) > 0 && <span style={{ fontSize: 12, color: adminTheme.textMuted }}>On hold: {fmt(w.on_hold_kobo)}</span>}
                <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Earned: {fmt(w.total_earned_kobo)}</span>
                <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Withdrawn: {fmt(w.total_withdrawn_kobo ?? 0)}</span>
              </div>
              {(w.on_hold_kobo ?? 0) > 0 && (
                <button onClick={() => (holdsFor === w.organizer_id ? setHoldsFor(null) : loadHolds(w.organizer_id))} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: adminTheme.blue, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  {holdsFor === w.organizer_id ? 'Hide held earnings' : 'Held earnings'}
                </button>
              )}
              {holdsFor === w.organizer_id && (
                <div data-testid="admin-earnings-holds" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {holds === null ? <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Loading…</span>
                    : holds.length === 0 ? <span style={{ fontSize: 12, color: adminTheme.textMuted }}>Nothing held.</span>
                    : holds.map((h: any) => {
                      const blockers: string[] = Array.isArray(h.blockers) ? h.blockers : [];
                      const held = blockers.includes('admin_hold') || blockers.includes('payment_dispute');
                      return (
                        <div key={h.hold_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: adminTheme.text }}>
                          <span style={{ flex: 1 }}>
                            {fmt(h.amount_kobo)} · {h.source_kind === 'ticket_sale' ? (h.event_title || 'Ticket sale') : 'Service booking'}
                            {h.release_at ? ` · releases ${new Date(h.release_at).toLocaleString('en-NG')}` : ''}
                            {blockers.filter((b) => b !== 'not_yet').length > 0 ? ` · paused: ${blockers.filter((b) => b !== 'not_yet').join(', ')}` : ''}
                            {h.admin_hold_reason ? ` (${h.admin_hold_reason})` : ''}
                          </span>
                          <button onClick={() => setEarningsHold(h.hold_id, !held)} style={{ background: adminTheme.borderChip, border: `1px solid ${adminTheme.border}`, borderRadius: 8, padding: '4px 8px', color: adminTheme.text, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                            {held ? 'Lift hold' : 'Hold'}
                          </button>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          );
        })
      ) : (
        <PayoutRequestsPanel payoutsDisabled={payoutsDisabled} />
      )}

    </div>
  );
}
