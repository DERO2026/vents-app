import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import {
  claimStateView, eligibilityReasonText, formatNaira, type ClaimStatus,
} from '../../../lib/workRoles';
import {
  workPage, workScroll, WorkBar, MLabel, MCard, Row, Ico, Pill, Tiles, Tile, NoteBand, WorkButton, ErrorNote, Loading,
} from './workUi';

interface Eligibility { eligible: boolean; reasons: string[]; is_free_event?: boolean; ended_at?: string }
interface Attribution {
  organizer_id: string; organizer_name: string | null; attributed_at: string;
  events: { event_id: string; title: string; eligibility: Eligibility }[];
}
interface Claim {
  id: string; organizer_id: string; organizer_name: string | null; event_title: string;
  status: ClaimStatus; amount_kobo: number; reward_month: string; decision_reason: string | null;
}
interface Expense { id: string; category: string; amount_kobo: number; description: string; incurred_on: string; status: string }
interface Rewards {
  representative: { status: string } | null;
  payouts_enabled: boolean; programme_open: boolean; funding_available: boolean;
  current_rate_kobo: number; rate_review_threshold: number;
  qualifying_this_month: number; qualifying_last_month: number;
  attributions: Attribution[]; claims: Claim[]; expenses: Expense[];
}

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
const inputStyle = {
  width: '100%', boxSizing: 'border-box' as const, minHeight: 44, background: ventsColors.elevated,
  border: `1px solid ${ventsColors.border}`, borderRadius: 10, padding: '8px 10px', color: ventsColors.ink1,
  fontFamily: 'inherit', fontSize: 13,
};

// Representative rewards: referred organizers, the ₦50,000 reward for each
// qualifying organizer, and transport/support expenses. Every rule is
// enforced server-side (migration 0201); this screen only shows state and
// calls the representative's own RPCs.
export function RepresentativeRewardsScreen({ currentUser, onBack, onNavigate }: {
  currentUser: { id: string } | null;
  onBack: () => void;
  onNavigate: (screen: string) => void;
}) {
  const [data, setData] = useState<Rewards | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // One idempotency key per claim attempt, reused on retry until it lands.
  const claimKeys = useRef<Record<string, string>>({});
  const expenseKey = useRef<string>(newKey());
  const [exp, setExp] = useState({ category: 'transport', amount: '', description: '', date: '' });

  const load = useCallback(async () => {
    setLoadError(null);
    const { data: d, error } = await supabase.rpc('get_my_representative_rewards' as any);
    if (error) { setLoadError(error.message || 'Could not load your rewards.'); return; }
    setData(d as Rewards);
  }, []);
  useEffect(() => { if (currentUser?.id) load(); }, [currentUser?.id, load]);

  const run = async (id: string, fn: () => PromiseLike<{ data: any; error: any }>, ok: (d: any) => string) => {
    setBusy(id); setActionError(null); setNotice(null);
    try {
      const { data: d, error } = await fn();
      if (error) throw error;
      setNotice(ok(d));
      await load();
      return true;
    } catch (e: any) {
      setActionError(e?.message || 'Something went wrong.');
      return false;
    } finally { setBusy(null); }
  };

  const submitClaim = (organizerId: string, eventId: string) =>
    run(`submit-${eventId}`, () => supabase.rpc('submit_representative_reward_claim' as any, { p_organizer_id: organizerId, p_event_id: eventId }),
      () => 'Sent to the organizer to confirm.');

  const claim = (c: Claim) => {
    claimKeys.current[c.id] ??= newKey();
    return run(`claim-${c.id}`, () => supabase.rpc('claim_representative_reward' as any, { p_claim_id: c.id, p_idempotency_key: claimKeys.current[c.id] }),
      (d) => d?.status === 'credited' ? 'Added to your earnings wallet. You can withdraw it from Earnings.'
        : d?.status === 'funded' ? 'Funded. Once payouts open, come back and tap Add to earnings wallet.'
        : 'VENTS profit does not cover this reward yet. Try again later.');
  };

  const submitExpense = async () => {
    const amountKobo = Math.round(Number(exp.amount) * 100);
    if (!amountKobo || amountKobo <= 0 || exp.description.trim().length < 3 || !exp.date) {
      setActionError('Enter an amount, a short description and the date.');
      return;
    }
    const ok = await run('expense', () => supabase.rpc('submit_representative_expense' as any, {
      p_category: exp.category, p_amount_kobo: amountKobo, p_description: exp.description.trim(),
      p_incurred_on: exp.date, p_organizer_id: null, p_idempotency_key: expenseKey.current,
    }), () => 'Expense sent for approval.');
    if (ok) { expenseKey.current = newKey(); setExp({ category: 'transport', amount: '', description: '', date: '' }); }
  };

  const claimedOrganizers = new Set((data?.claims ?? []).filter((c) => c.status !== 'rejected').map((c) => c.organizer_id));

  return (
    <div data-testid="representative-rewards-screen" style={workPage}>
      <WorkBar title="Rewards" sub="₦50,000 per qualifying organizer" onBack={onBack} />
      <div style={workScroll}>
        {loadError && <ErrorNote>{loadError}</ErrorNote>}
        {!data && !loadError && <Loading />}
        {data && !data.representative && (
          <MCard>
            <Row icon={<Ico tone="p">⇄</Ico>} title="Join as a Representative" sub="Bring organizers to VENTS" right={<Pill tone="off">Join</Pill>}
              onClick={() => onNavigate('representatives')} />
          </MCard>
        )}
        {data?.representative && (
          <>
            <Tiles>
              <Tile testId="rewards-tile-month" k="This month" v={data.qualifying_this_month}
                s={`Qualifying organizers · ${data.rate_review_threshold}+ can earn a higher rate`} />
              <Tile testId="rewards-tile-rate" k="Your rate" v={formatNaira(data.current_rate_kobo)} s="Per qualifying organizer" />
            </Tiles>
            <NoteBand>
              An organizer you referred qualifies after hosting an event that has ended, isn&apos;t cancelled and has
              finished settling. They confirm you referred them, then VENTS reviews it. Approved rewards are paid into your
              earnings wallet, which you can withdraw, once VENTS ticket profit covers them.
              {!data.programme_open && ' Rewards open once VENTS finishes moving representatives off the old commission plan.'}
              {data.programme_open && !data.payouts_enabled && ' Wallet payouts have not started yet.'}
            </NoteBand>
            {actionError && <ErrorNote>{actionError}</ErrorNote>}
            {notice && <NoteBand><span role="status">{notice}</span></NoteBand>}

            <MLabel>Rewards</MLabel>
            <MCard testId="rewards-claims">
              {data.claims.length === 0 && <Row title="No rewards yet" sub="Submit an organizer's event below once it qualifies" />}
              {data.claims.map((c) => {
                const v = claimStateView(c.status, { payoutsEnabled: data.payouts_enabled, fundingAvailable: data.funding_available });
                const canClaim = data.programme_open && ((c.status === 'approved' && data.funding_available) || (c.status === 'funded' && data.payouts_enabled));
                return (
                  <div key={c.id} style={{ display: 'grid', gap: 8 }}>
                    <Row testId={`claim-${c.id}`} icon={<Ico tone="g">₦</Ico>}
                      title={`${c.organizer_name || 'Organizer'} · ${formatNaira(c.amount_kobo)}`}
                      sub={`${c.event_title} · ${v.detail}${c.decision_reason && c.status !== 'credited' ? ` · ${c.decision_reason.replace(/_/g, ' ')}` : ''}`}
                      right={<Pill tone={v.tone}>{v.label}</Pill>} />
                    {canClaim && (
                      <WorkButton testId={`claim-button-${c.id}`} disabled={busy === `claim-${c.id}`} onClick={() => claim(c)}>
                        {c.status === 'funded' ? 'Add to earnings wallet' : 'Claim reward'}
                      </WorkButton>
                    )}
                  </div>
                );
              })}
            </MCard>

            <MLabel>Organizers you referred</MLabel>
            <MCard testId="rewards-attributions">
              {data.attributions.length === 0 && (
                <Row title="No organizers yet" sub="Invite organizers from your team page" right={<Pill tone="off">Invite</Pill>}
                  onClick={() => onNavigate('representatives')} />
              )}
              {data.attributions.map((a) => {
                const claimed = claimedOrganizers.has(a.organizer_id);
                const eligible = a.events.find((e) => e.eligibility.eligible);
                const next = a.events[0];
                return (
                  <div key={a.organizer_id} style={{ display: 'grid', gap: 8 }}>
                    <Row icon={<Ico tone="p" round>{(a.organizer_name || '?').slice(0, 2).toUpperCase()}</Ico>}
                      title={a.organizer_name || 'Organizer'}
                      sub={claimed ? 'Reward submitted'
                        : eligible ? `${eligible.title} qualifies`
                        : next ? `${next.title} · ${next.eligibility.reasons.map(eligibilityReasonText).join(', ')}`
                        : 'No event hosted since you referred them'}
                      right={<Pill tone={claimed ? 'on' : eligible ? 'on' : 'wait'}>{claimed ? 'Submitted' : eligible ? 'Ready' : 'Waiting'}</Pill>} />
                    {!claimed && eligible && (
                      <WorkButton testId={`submit-${eligible.event_id}`} disabled={busy === `submit-${eligible.event_id}`}
                        onClick={() => submitClaim(a.organizer_id, eligible.event_id)}>
                        Submit for review
                      </WorkButton>
                    )}
                  </div>
                );
              })}
            </MCard>

            <MLabel>Transport &amp; support expenses</MLabel>
            <MCard testId="rewards-expenses">
              {data.expenses.map((x) => (
                <Row key={x.id} icon={<Ico tone="y">⇢</Ico>} title={`${formatNaira(x.amount_kobo)} · ${x.category === 'transport' ? 'Transport' : 'Support'}`}
                  sub={`${x.description} · ${x.incurred_on}`}
                  right={<Pill tone={x.status === 'approved' ? 'on' : x.status === 'rejected' ? 'off' : 'wait'}>
                    {x.status === 'submitted' ? 'Pending' : x.status === 'approved' ? 'Approved' : 'Rejected'}
                  </Pill>} />
              ))}
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div role="radiogroup" aria-label="Expense type" style={{ display: 'flex', gap: 4, background: ventsColors.elevated, borderRadius: 10, padding: 4 }}>
                    {(['transport', 'support'] as const).map((c) => (
                      <button key={c} role="radio" aria-checked={exp.category === c} onClick={() => setExp({ ...exp, category: c })}
                        style={{ flex: 1, minHeight: 36, border: 'none', borderRadius: 8, fontFamily: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          background: exp.category === c ? ventsColors.accentStrong : 'transparent', color: exp.category === c ? ventsColors.white : ventsColors.ink2 }}>
                        {c === 'transport' ? 'Transport' : 'Support'}
                      </button>
                    ))}
                  </div>
                  <input aria-label="Amount in naira" inputMode="decimal" placeholder="Amount (₦)" value={exp.amount}
                    onChange={(e) => setExp({ ...exp, amount: e.target.value.replace(/[^0-9.]/g, '') })} style={inputStyle} />
                </div>
                <input aria-label="What was it for?" placeholder="What was it for?" maxLength={500} value={exp.description}
                  onChange={(e) => setExp({ ...exp, description: e.target.value })} style={inputStyle} />
                <input aria-label="Date" type="date" value={exp.date} onChange={(e) => setExp({ ...exp, date: e.target.value })} style={inputStyle} />
                <WorkButton ghost testId="expense-submit" disabled={busy === 'expense'} onClick={submitExpense}>Send for approval</WorkButton>
                <div style={{ fontSize: 10, color: ventsColors.ink3 }}>Expenses are reviewed by VENTS and tracked separately from rewards.</div>
              </div>
            </MCard>
          </>
        )}
      </div>
    </div>
  );
}
