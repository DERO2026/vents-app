// VENTS Earn admin view: referral attributions, representative reward
// claims, the realized-profit pool, expenses, monthly counts and the audit
// trail (migration 0201). Nothing here moves money directly: every decision
// is filed with request_admin_action and executed only when a second
// admin approves it in Admin Actions (approve_admin_action blocks
// self-approval, and the earn executor also refuses the representative or
// organizer themselves as requester or approver).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { adminTheme, accentStrongFill } from './adminConsoleTheme';
import { formatNaira, eligibilityReasonText } from '../../../lib/workRoles';

interface Overview {
  settings: { payouts_enabled: boolean; legacy_commission_reconciled: boolean; settlement_hold_days: number; base_reward_kobo: number };
  pool: { available_kobo: number; reserved_kobo: number; credited_kobo: number };
  claims: { id: string; status: string; amount_kobo: number; reward_month: string; is_free_event: boolean; representative_id: string; representative_name: string | null; organizer_name: string | null; event_title: string; decision_reason: string | null }[];
  attributions: { id: string; representative_name: string | null; organizer_name: string | null; attributed_at: string; organizer_had_events_before: boolean }[];
  expenses: { id: string; representative_name: string | null; category: string; amount_kobo: number; description: string; incurred_on: string; status: string }[];
  monthly_counts: { representative_id: string; month: string; count: number }[];
  audit: { id: string; entity_type: string; action: string; created_at: string; details: Record<string, unknown> }[];
}

const card: React.CSSProperties = { background: adminTheme.panel, border: `1px solid ${adminTheme.border}`, borderRadius: 14, padding: 16, display: 'grid', gap: 10 };
const h: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 700, color: adminTheme.textStrong };
const muted: React.CSSProperties = { fontSize: 12, color: adminTheme.textMuted };
const input: React.CSSProperties = { width: '100%', background: adminTheme.panelAlt, border: `1px solid ${adminTheme.border}`, borderRadius: 10, padding: '10px 12px', color: adminTheme.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const btn = (ghost?: boolean): React.CSSProperties => ({
  minHeight: 36, padding: '6px 12px', borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer',
  ...(ghost ? { background: 'transparent', color: adminTheme.text, border: `1px solid ${adminTheme.borderChip}` } : { background: accentStrongFill, color: '#fff', border: 'none' }),
});

const STATUS_LABEL: Record<string, string> = {
  pending_organizer: 'Waiting for organizer', pending_review: 'Needs review', approved: 'Approved',
  funded: 'Funded', credited: 'In earnings wallet', rejected: 'Rejected', reversed: 'Reversed',
};

export function AdminEarnScreen() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const inFlight = useRef(false);

  const [eventId, setEventId] = useState('');
  const [candidate, setCandidate] = useState<any>(null);
  const [cost, setCost] = useState('');
  const [costNote, setCostNote] = useState('');
  const [rate, setRate] = useState({ repId: '', month: '', amount: '', reason: '' });

  const load = useCallback(async () => {
    setError(null);
    const { data: d, error: e } = await supabase.rpc('admin_get_vents_earn_overview' as any);
    if (e) { setError(e.message); return; }
    setData(d as Overview);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Files a dual-control request; a second admin approves it in Admin Actions.
  const request = async (actionType: string, label: string, payload: Record<string, unknown>, targetId: string | null = null) => {
    if (inFlight.current) return;
    inFlight.current = true; setMsg(null);
    try {
      const { error: e } = await supabase.rpc('request_admin_action' as any, {
        p_action_type: actionType, p_target_type: 'vents_earn', p_target_id: targetId, p_target_label: label, p_payload: payload,
      });
      if (e) throw e;
      setMsg(`✓ Request filed: ${label}. A second admin must approve it in Admin Actions.`);
    } catch (e: any) {
      setMsg(e?.message || 'Request failed.');
    } finally { inFlight.current = false; }
  };

  const ask = (q: string) => (window.prompt(q) || '').trim();
  // The approver sees target_label, not target_id, so name the representative.
  const repLabel = (id: string) => {
    const name = data?.claims.find((c) => c.representative_id === id)?.representative_name;
    return name ? `${name} (${id})` : id;
  };

  // Only the latest check may set the candidate, so a slow response for an
  // earlier Event ID can never become the one "Request: recognize" submits.
  const checkSeq = useRef(0);
  const checkEvent = async () => {
    const seq = ++checkSeq.current;
    setCandidate(null);
    const { data: d, error: e } = await supabase.rpc('admin_get_event_profit_candidate' as any, { p_event_id: eventId.trim() });
    if (seq !== checkSeq.current) return;
    if (e) { setMsg(e.message); return; }
    setCandidate(d);
  };

  if (error) return <div style={{ ...card, color: adminTheme.red }}>Could not load VENTS Earn: {error}</div>;
  if (!data) return <div style={muted}>Loading…</div>;
  const s = data.settings;

  return (
    <div style={{ display: 'grid', gap: 14 }} data-testid="admin-earn-screen">
      {msg && <div role="status" style={{ ...card, padding: 12, fontSize: 13, color: adminTheme.text }}>{msg}</div>}

      <div style={card}>
        <h3 style={h}>Programme</h3>
        <div style={muted}>
          Reward {formatNaira(s.base_reward_kobo)} per qualifying organizer · settlement hold {s.settlement_hold_days} days ·
          legacy 10% plan {s.legacy_commission_reconciled ? 'reconciled' : 'NOT reconciled (approvals blocked)'} ·
          wallet payouts {s.payouts_enabled ? 'ON' : 'OFF'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!s.legacy_commission_reconciled && (
            <button style={btn()} onClick={() => { const note = ask('Record how existing representatives were moved off the 10% plan:'); if (note) request('earn_update_settings', 'Reconcile legacy 10% plan', { legacy_commission_reconciled: true, note }); }}>
              Request: mark legacy plan reconciled
            </button>
          )}
          <button style={btn(true)} onClick={() => { const note = ask(`Reason to turn wallet payouts ${s.payouts_enabled ? 'OFF' : 'ON'}:`); if (note) request('earn_update_settings', `Payouts ${s.payouts_enabled ? 'off' : 'on'}`, { payouts_enabled: !s.payouts_enabled, note }); }}>
            Request: payouts {s.payouts_enabled ? 'off' : 'on'}
          </button>
        </div>
      </div>

      <div style={card}>
        <h3 style={h}>Realized profit pool</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          {[['Available', data.pool.available_kobo], ['Reserved for rewards', data.pool.reserved_kobo], ['Credited to wallets', data.pool.credited_kobo]].map(([k, v]) => (
            <div key={k as string} style={{ background: adminTheme.panelAlt, borderRadius: 10, padding: 10 }}>
              <div style={{ ...muted, fontSize: 11 }}>{k}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: adminTheme.textStrong }}>{formatNaira(v as number)}</div>
            </div>
          ))}
        </div>
        <div style={muted}>Profit is added per finished, settled event: recorded buyer fees minus refunds, minus the costs you state. Gross sales and pending money never count.</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input aria-label="Event ID" placeholder="Event ID" value={eventId} onChange={(e) => { checkSeq.current++; setCandidate(null); setEventId(e.target.value); }} style={input} />
          <button style={btn(true)} onClick={checkEvent} disabled={!eventId.trim()}>Check</button>
        </div>
        {candidate && (
          <div style={{ display: 'grid', gap: 8 }} data-testid="profit-candidate">
            <div style={muted}>
              {candidate.title} · fees recorded {formatNaira(candidate.fee_recorded_kobo)} · refunded fees {formatNaira(candidate.fee_refunded_kobo)} ·
              shortfall {formatNaira(candidate.refund_shortfall_kobo)} · <strong style={{ color: adminTheme.text }}>candidate {formatNaira(candidate.fee_candidate_kobo)}</strong>
              {candidate.already_recognized && ' · already recognized'}
            </div>
            {!candidate.eligible && <div style={{ ...muted, color: adminTheme.amber }}>Not settled: {(candidate.reasons as string[]).map(eligibilityReasonText).join(', ')}</div>}
            {candidate.eligible && !candidate.already_recognized && (
              <>
                <input aria-label="Costs to deduct (₦)" placeholder="Costs to deduct (₦): processor fees, VC rewards…" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^0-9.]/g, ''))} style={input} />
                <input aria-label="Cost note" placeholder="What the costs are" value={costNote} onChange={(e) => setCostNote(e.target.value)} style={input} />
                <button style={btn()} disabled={cost === '' || !costNote.trim()}
                  onClick={() => request('earn_recognize_event_profit', `Recognize profit: ${candidate.title}`, { event_id: candidate.event_id, cost_deductions_kobo: Math.round(Number(cost) * 100), note: costNote.trim() }, candidate.event_id)}>
                  Request: recognize {formatNaira(Math.max(0, candidate.fee_candidate_kobo - Math.round(Number(cost || 0) * 100)))}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div style={card}>
        <h3 style={h}>Reward claims</h3>
        {data.claims.length === 0 && <div style={muted}>No claims yet.</div>}
        {data.claims.map((c) => (
          <div key={c.id} style={{ borderTop: `1px solid ${adminTheme.borderSoft}`, paddingTop: 10, display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 13, color: adminTheme.text }}>
              <strong>{c.representative_name || 'Representative'}</strong> → {c.organizer_name || 'Organizer'} · {c.event_title} · {formatNaira(c.amount_kobo)} · {c.reward_month.slice(0, 7)}
              {c.is_free_event && ' · FREE EVENT'}
            </div>
            <div style={muted}>{STATUS_LABEL[c.status] ?? c.status}{c.decision_reason ? ` · ${c.decision_reason}` : ''}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {c.status === 'pending_review' && (
                <button style={btn()} onClick={() => {
                  if (c.is_free_event && !window.confirm('This is a free event. Confirm you verified it was a genuine event?')) return;
                  request('earn_approve_reward', `Approve reward: ${c.organizer_name}`, { claim_id: c.id, free_event_verified: c.is_free_event }, c.id);
                }}>Request approval</button>
              )}
              {['pending_organizer', 'pending_review', 'approved'].includes(c.status) && (
                <button style={btn(true)} onClick={() => { const reason = ask('Reason for rejecting:'); if (reason) request('earn_reject_reward', `Reject reward: ${c.organizer_name}`, { claim_id: c.id, reason }, c.id); }}>Request rejection</button>
              )}
              {['approved', 'funded', 'credited'].includes(c.status) && (
                <button style={btn(true)} onClick={() => { const reason = ask('Reason for reversing:'); if (reason) request('earn_reverse_reward', `Reverse reward: ${c.organizer_name}`, { claim_id: c.id, reason }, c.id); }}>Request reversal</button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={card}>
        <h3 style={h}>Expenses</h3>
        {data.expenses.length === 0 && <div style={muted}>No expenses submitted.</div>}
        {data.expenses.map((x) => (
          <div key={x.id} style={{ borderTop: `1px solid ${adminTheme.borderSoft}`, paddingTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200, fontSize: 13, color: adminTheme.text }}>
              {x.representative_name} · {x.category} · {formatNaira(x.amount_kobo)} · {x.description} · {x.incurred_on}
              <div style={muted}>{x.status}</div>
            </div>
            {x.status === 'submitted' && (
              <>
                <button style={btn()} onClick={() => request('earn_decide_expense', `Approve expense ${formatNaira(x.amount_kobo)}`, { expense_id: x.id, approve: true }, x.id)}>Request approval</button>
                <button style={btn(true)} onClick={() => { const reason = ask('Reason for rejecting:'); if (reason) request('earn_decide_expense', `Reject expense ${formatNaira(x.amount_kobo)}`, { expense_id: x.id, approve: false, reason }, x.id); }}>Request rejection</button>
              </>
            )}
          </div>
        ))}
      </div>

      <div style={card}>
        <h3 style={h}>Monthly qualifying organizers</h3>
        <div style={muted}>At 9 or more in a month, management may approve a higher rate for the next month. Rates never rise automatically.</div>
        {data.monthly_counts.map((m) => (
          <div key={`${m.representative_id}-${m.month}`} style={{ fontSize: 13, color: m.count >= 9 ? adminTheme.green : adminTheme.text }}>
            {data.claims.find((c) => c.representative_id === m.representative_id)?.representative_name || m.representative_id.slice(0, 8)} · {m.month.slice(0, 7)} · {m.count}
          </div>
        ))}
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <input aria-label="Representative ID" placeholder="Representative ID" value={rate.repId} onChange={(e) => setRate({ ...rate, repId: e.target.value })} style={input} />
          <input aria-label="Month" type="month" value={rate.month} onChange={(e) => setRate({ ...rate, month: e.target.value })} style={input} />
          <input aria-label="New rate (₦)" placeholder="New rate (₦), above 50,000" inputMode="decimal" value={rate.amount} onChange={(e) => setRate({ ...rate, amount: e.target.value.replace(/[^0-9.]/g, '') })} style={input} />
          <input aria-label="Reason" placeholder="Reason" value={rate.reason} onChange={(e) => setRate({ ...rate, reason: e.target.value })} style={input} />
        </div>
        <button style={btn()} disabled={!rate.repId || !rate.month || !rate.amount || !rate.reason.trim()}
          onClick={() => request('earn_set_monthly_rate', `Rate ${formatNaira(Math.round(Number(rate.amount) * 100))} for ${rate.month} · representative ${repLabel(rate.repId.trim())}`, { month: `${rate.month}-01`, reward_kobo: Math.round(Number(rate.amount) * 100), reason: rate.reason.trim() }, rate.repId.trim())}>
          Request higher rate
        </button>
      </div>

      <div style={card}>
        <h3 style={h}>Referral attributions</h3>
        {data.attributions.length === 0 && <div style={muted}>None yet.</div>}
        {data.attributions.map((a) => (
          <div key={a.id} style={{ fontSize: 13, color: adminTheme.text }}>
            {a.representative_name} → {a.organizer_name} · {new Date(a.attributed_at).toLocaleDateString()}
            {a.organizer_had_events_before && <span style={{ color: adminTheme.amber }}> · organizer already had events</span>}
          </div>
        ))}
      </div>

      <div style={card}>
        <h3 style={h}>Audit trail (latest 100)</h3>
        {data.audit.map((l) => (
          <div key={l.id} style={{ fontSize: 12, color: adminTheme.textMuted, fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>
            {new Date(l.created_at).toLocaleString()} · {l.entity_type} · {l.action}
          </div>
        ))}
      </div>
    </div>
  );
}
