import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import {
  claimStateView, eligibilityReasonText, formatNaira, isBackendUnavailable, REWARD_STAGES, type ClaimStatus,
} from '../../../lib/workRoles';
import { MLabel, MCard, Row, Ico, Pill, NoteBand, WorkButton, ErrorNote, Chips, Loading } from './workUi';

// Representative data and panels (migration 0201). Every figure comes from
// the representative's own RPCs; every rule is enforced server-side. Shared
// by the Rewards screen and the Representative dashboard.

export interface Eligibility { eligible: boolean; reasons: string[]; is_free_event?: boolean; ended_at?: string }
export interface Attribution {
  id: string; organizer_id: string; organizer_name: string | null; attributed_at: string;
  // A reward that is not rejected already exists for this organizer.
  claimed: boolean;
  events: { event_id: string; title: string; eligibility: Eligibility }[];
}
export interface Claim {
  id: string; organizer_id: string; organizer_name: string | null; event_title: string;
  status: ClaimStatus; amount_kobo: number; reward_month: string; decision_reason: string | null;
}
export interface Expense {
  id: string; category: string; amount_kobo: number; description: string; incurred_on: string;
  status: 'submitted' | 'approved' | 'rejected'; decision_reason?: string | null; created_at?: string;
}
export interface Rewards {
  representative: { status: string } | null;
  payouts_enabled: boolean; programme_open: boolean; funding_available: boolean;
  current_rate_kobo: number; rate_review_threshold: number;
  qualifying_this_month: number; qualifying_last_month: number;
}
type Tally = Record<string, { count: number; amount_kobo: number }>;
export interface Performance {
  representative: { status: string; created_at: string } | null;
  programme_open: boolean; payouts_enabled: boolean; current_month: string;
  rate_review_threshold: number; base_reward_kobo: number; settlement_hold_days: number;
  funnel: {
    invitations_sent: number; invitations_pending: number; invitations_accepted: number; invitations_declined: number;
    invitations_withdrawn?: number; partnerships_ended?: number;
    partnerships_active: number; organizers_attributed: number; organizers_hosting: number;
    organizers_qualified: number; organizers_paid: number;
  };
  lifecycle: Tally;
  months: { month: string; qualifying: number; rate_kobo: number; submitted: number; paid_kobo: number }[];
  expenses: Tally;
  wallet: { balance_kobo: number; pending_kobo: number; on_hold_kobo: number };
}
// Live-table fallback (before 0201 is deployed): invitation counts only.
export interface PartnershipCounts {
  sent: number; pending: number; accepted: number; declined: number; withdrawn: number; active: number; ended: number;
}

export interface RepresentativeData {
  loading: boolean;
  rewards: Rewards | null;
  performance: Performance | null;
  // The 0201 functions are missing (not deployed) or refused (Preview).
  rewardsUnavailable: boolean;
  partnerships: PartnershipCounts | null;
  error: string | null;
  reload: () => Promise<void>;
}

export function countPartnerships(rows: { status: string }[]): PartnershipCounts {
  const n = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;
  return {
    sent: rows.length, pending: n(['pending']), accepted: n(['accepted', 'revoked']), declined: n(['declined']),
    withdrawn: n(['withdrawn']), active: n(['accepted']), ended: n(['revoked']),
  };
}

export function useRepresentativeData(userId: string | null | undefined): RepresentativeData {
  const [state, setState] = useState<Omit<RepresentativeData, 'reload'>>({
    loading: true, rewards: null, performance: null, rewardsUnavailable: false, partnerships: null, error: null,
  });
  const load = useCallback(async () => {
    if (!userId) return;
    const settle = <T,>(p: PromiseLike<T>) => Promise.resolve(p).then((v) => v, (e) => ({ data: null, error: e }));
    const [rw, pf, pr] = await Promise.all([
      settle(supabase.rpc('get_my_representative_rewards' as any)),
      settle(supabase.rpc('get_my_representative_performance' as any)),
      settle(supabase.from('recruiter_partnerships').select('status').eq('recruiter_id', userId)),
    ]) as any[];
    // Rewards drive the reward screens; the dashboard figures are extra and
    // simply absent if that function is not deployed yet.
    const unavailable = isBackendUnavailable(rw?.error);
    const hardError = (!unavailable && rw?.error) || (pf?.error && !isBackendUnavailable(pf.error) ? pf.error : null);
    setState({
      loading: false,
      rewards: rw?.error ? null : (rw?.data as Rewards),
      performance: pf?.error ? null : (pf?.data as Performance),
      rewardsUnavailable: unavailable,
      partnerships: pr?.error ? null : countPartnerships(pr?.data ?? []),
      error: hardError ? (hardError.message || 'Could not load your representative data.') : null,
    });
  }, [userId]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

export const HISTORY_PAGE_SIZE = 20;
type HistoryKind = 'claims' | 'expenses' | 'attributions';
interface Cursor { at: string; id: string }
export interface History<T> {
  items: T[]; loading: boolean; loadingMore: boolean; hasMore: boolean; error: string | null;
  loadMore: () => Promise<void>; reset: () => Promise<void>;
}

// One list of the representative's own history, read a page at a time from
// get_my_representative_history (newest first, keyset cursor). Changing the
// status filter starts again from the first page; a response that arrives
// after the filter changed is dropped, and rows are never shown twice.
export function useRepHistory<T extends { id: string }>(kind: HistoryKind, status: string | null, enabled = true): History<T> {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<Cursor | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const fetchPage = useCallback(async (cursor: Cursor | null) => {
    const { data, error: e } = await Promise.resolve(supabase.rpc('get_my_representative_history' as any, {
      p_kind: kind, p_status: status, p_before_at: cursor?.at ?? null, p_before_id: cursor?.id ?? null, p_limit: HISTORY_PAGE_SIZE,
    })).then((v: any) => v, (err) => ({ data: null, error: err }));
    if (e) throw e;
    return { rows: ((data as any)?.items ?? []) as T[], next: ((data as any)?.next ?? null) as Cursor | null };
  }, [kind, status]);

  const reset = useCallback(async () => {
    if (!enabled) return;
    const my = ++seq.current;
    setLoading(true); setError(null);
    try {
      const page = await fetchPage(null);
      if (my !== seq.current) return;
      setItems(page.rows); setNext(page.next);
    } catch (e: any) {
      if (my !== seq.current) return;
      setItems([]); setNext(null);
      setError(isBackendUnavailable(e) ? 'This list is not available yet.' : (e?.message || 'Could not load this list.'));
    } finally { if (my === seq.current) setLoading(false); }
  }, [enabled, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!next || loadingMore) return;
    const my = seq.current;
    setLoadingMore(true); setError(null);
    try {
      const page = await fetchPage(next);
      if (my !== seq.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...page.rows.filter((r) => !seen.has(r.id))];
      });
      setNext(page.next);
    } catch (e: any) {
      if (my === seq.current) setError(e?.message || 'Could not load more.');
    } finally { setLoadingMore(false); }
  }, [next, loadingMore, fetchPage]);

  useEffect(() => { reset(); }, [reset]);
  return { items, loading, loadingMore, hasMore: !!next, error, loadMore, reset };
}

function MoreButton({ h, testId, label }: { h: History<any>; testId: string; label: string }) {
  if (!h.hasMore) return null;
  return (
    <WorkButton ghost testId={testId} disabled={h.loadingMore} onClick={() => h.loadMore()}>
      {h.loadingMore ? 'Loading…' : label}
    </WorkButton>
  );
}

function ListError({ h, testId }: { h: History<any>; testId: string }) {
  if (!h.error) return null;
  return (
    <div data-testid={testId} style={{ display: 'grid', gap: 6 }}>
      <ErrorNote>{h.error}</ErrorNote>
      <WorkButton ghost onClick={() => (h.items.length ? h.loadMore() : h.reset())}>Try again</WorkButton>
    </div>
  );
}

export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
const inputStyle = {
  width: '100%', boxSizing: 'border-box' as const, minHeight: 44, background: ventsColors.elevated,
  border: `1px solid ${ventsColors.border}`, borderRadius: 10, padding: '8px 10px', color: ventsColors.ink1,
  fontFamily: 'inherit', fontSize: 13,
};

function useAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (id: string, fn: () => PromiseLike<{ data: any; error: any }>, ok: (d: any) => string) => {
    setBusy(id); setError(null); setNotice(null);
    try {
      const { data: d, error } = await fn();
      if (error) throw error;
      setNotice(ok(d));
      await reload();
      return true;
    } catch (e: any) {
      setError(e?.message || 'Something went wrong.');
      return false;
    } finally { setBusy(null); }
  };
  return { busy, error, notice, run };
}

export function ChipButton({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button data-testid={testId} onClick={onClick} aria-pressed={active}
      style={{
        minHeight: 32, padding: '4px 10px', borderRadius: 999, fontFamily: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer',
        border: `1px solid ${active ? 'rgba(142,92,247,0.6)' : ventsColors.border}`,
        background: active ? 'rgba(142,92,247,0.18)' : 'transparent', color: active ? ventsColors.white : ventsColors.ink2,
      }}>
      {children}
    </button>
  );
}

// Rewards: the lifecycle (filterable by stage, on the server), then the
// organizers the representative referred, with the one action each state
// allows. Lists are paged; stage counts are the server's totals.
export function RewardsPanel({ rewards, totals, reload, onNavigate }: {
  rewards: Rewards; totals?: Tally | null; reload: () => Promise<void>; onNavigate: (screen: string) => void;
}) {
  const [stage, setStage] = useState<ClaimStatus | 'all'>('all');
  const claims = useRepHistory<Claim>('claims', stage === 'all' ? null : stage);
  const referred = useRepHistory<Attribution>('attributions', null);
  const refresh = async () => { await Promise.all([reload(), claims.reset(), referred.reset()]); };
  const { busy, error, notice, run } = useAction(refresh);
  const claimKeys = useRef<Record<string, string>>({});

  const submitClaim = (organizerId: string, eventId: string) =>
    run(`submit-${eventId}`, () => supabase.rpc('submit_representative_reward_claim' as any, { p_organizer_id: organizerId, p_event_id: eventId }),
      () => 'Sent to the organizer to confirm.');
  // One idempotency key per claim attempt, reused on retry until it lands.
  const claim = (c: Claim) => {
    claimKeys.current[c.id] ??= newKey();
    return run(`claim-${c.id}`, () => supabase.rpc('claim_representative_reward' as any, { p_claim_id: c.id, p_idempotency_key: claimKeys.current[c.id] }),
      (d) => d?.status === 'credited' ? 'Added to your earnings wallet. You can withdraw it from Earnings.'
        : d?.status === 'funded' ? 'Funded. Once payouts open, come back and tap Add to earnings wallet.'
        : 'VENTS profit does not cover this reward yet. Try again later.');
  };

  // Totals are the server's counts (get_my_representative_performance);
  // without them the chips carry no number rather than a partial one.
  const count = (s: ClaimStatus) => totals?.[s]?.count;
  const all = totals ? Object.values(totals).reduce((t, x) => t + (x?.count ?? 0), 0) : undefined;
  const n = (v: number | undefined) => (v === undefined ? '' : ` ${v}`);
  const filtered = stage !== 'all';

  return (
    <>
      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <NoteBand><span role="status">{notice}</span></NoteBand>}

      <MLabel>Rewards</MLabel>
      <Chips>
        <ChipButton testId="stage-all" active={stage === 'all'} onClick={() => setStage('all')}>All{n(all)}</ChipButton>
        {REWARD_STAGES.map((st) => (
          <ChipButton key={st.status} testId={`stage-${st.status}`} active={stage === st.status} onClick={() => setStage(st.status)}>
            {st.label}{n(count(st.status))}
          </ChipButton>
        ))}
        {(count('rejected') ?? 0) > 0 && (
          <ChipButton testId="stage-rejected" active={stage === 'rejected'} onClick={() => setStage('rejected')}>Rejected{n(count('rejected'))}</ChipButton>
        )}
      </Chips>
      <MCard testId="rewards-claims">
        {claims.loading && <Loading />}
        <ListError h={claims} testId="claims-error" />
        {!claims.loading && !claims.error && claims.items.length === 0 && (
          filtered ? <Row testId="claims-empty" title="Nothing at this stage" />
            : <Row testId="claims-empty" title="No rewards yet" sub="Submit an organizer's event below once it qualifies" />
        )}
        {!claims.loading && claims.items.map((c) => {
          const v = claimStateView(c.status, { payoutsEnabled: rewards.payouts_enabled, fundingAvailable: rewards.funding_available });
          const canClaim = rewards.programme_open && ((c.status === 'approved' && rewards.funding_available) || (c.status === 'funded' && rewards.payouts_enabled));
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
              {c.status === 'credited' && (
                <WorkButton ghost testId={`claim-wallet-${c.id}`} onClick={() => onNavigate('wallet')}>Open earnings wallet</WorkButton>
              )}
            </div>
          );
        })}
        {!claims.loading && <MoreButton h={claims} testId="claims-more" label="Show more rewards" />}
      </MCard>

      <MLabel>Organizers you referred</MLabel>
      <MCard testId="rewards-attributions">
        {referred.loading && <Loading />}
        <ListError h={referred} testId="attributions-error" />
        {!referred.loading && !referred.error && referred.items.length === 0 && (
          <Row testId="attributions-empty" title="No organizers yet" sub="Invite organizers from your team page" right={<Pill tone="off">Invite</Pill>}
            onClick={() => onNavigate('representatives')} />
        )}
        {!referred.loading && referred.items.map((a) => {
          const eligible = a.events.find((e) => e.eligibility.eligible);
          const next = a.events[0];
          return (
            <div key={a.id} style={{ display: 'grid', gap: 8 }}>
              <Row testId={`attribution-${a.organizer_id}`} icon={<Ico tone="p" round>{(a.organizer_name || '?').slice(0, 2).toUpperCase()}</Ico>}
                title={a.organizer_name || 'Organizer'}
                sub={a.claimed ? 'Reward submitted'
                  : eligible ? `${eligible.title} qualifies`
                  : next ? `${next.title} · ${next.eligibility.reasons.map(eligibilityReasonText).join(', ')}`
                  : 'No event created since you referred them'}
                right={<Pill tone={a.claimed || eligible ? 'on' : 'wait'}>{a.claimed ? 'Submitted' : eligible ? 'Ready' : 'Waiting'}</Pill>} />
              {!a.claimed && eligible && (
                <WorkButton testId={`submit-${eligible.event_id}`} disabled={busy === `submit-${eligible.event_id}`}
                  onClick={() => submitClaim(a.organizer_id, eligible.event_id)}>
                  Submit for review
                </WorkButton>
              )}
            </div>
          );
        })}
        {!referred.loading && <MoreButton h={referred} testId="attributions-more" label="Show more organizers" />}
      </MCard>
    </>
  );
}

const EXPENSE_LABEL = { submitted: 'Pending', approved: 'Approved', rejected: 'Rejected' } as const;

// Transport / support expenses: submit, then the paged history with the
// decision VENTS recorded. Two admins decide each one (0201). Approval
// records the expense; nothing in the app pays it out.
export function ExpensesPanel({ reload, totals }: { reload: () => Promise<void>; totals?: Tally | null }) {
  const [filter, setFilter] = useState<'all' | Expense['status']>('all');
  const list = useRepHistory<Expense>('expenses', filter === 'all' ? null : filter);
  const { busy, error, notice, run } = useAction(async () => { await Promise.all([reload(), list.reset()]); });
  const expenseKey = useRef<string>(newKey());
  const [exp, setExp] = useState({ category: 'transport', amount: '', description: '', date: '' });

  const submitExpense = async () => {
    const amountKobo = Math.round(Number(exp.amount) * 100);
    if (!amountKobo || amountKobo <= 0 || exp.description.trim().length < 3 || !exp.date) {
      return void run('expense-invalid', async () => ({ data: null, error: { message: 'Enter an amount, a short description and the date.' } }), () => '');
    }
    const ok = await run('expense', () => supabase.rpc('submit_representative_expense' as any, {
      p_category: exp.category, p_amount_kobo: amountKobo, p_description: exp.description.trim(),
      p_incurred_on: exp.date, p_organizer_id: null, p_idempotency_key: expenseKey.current,
    }), () => 'Expense sent for approval.');
    if (ok) { expenseKey.current = newKey(); setExp({ category: 'transport', amount: '', description: '', date: '' }); }
  };

  // Server totals only: a sum over the loaded page would undercount.
  const tally = (s: Expense['status']) => totals?.[s];
  const all = totals ? (['submitted', 'approved', 'rejected'] as const).reduce((t, s) => t + (totals[s]?.count ?? 0), 0) : undefined;

  return (
    <>
      <MLabel>Transport &amp; support expenses</MLabel>
      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <NoteBand><span role="status">{notice}</span></NoteBand>}
      <MCard testId="rewards-expenses">
        <div data-testid="expense-totals" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
          {(['submitted', 'approved', 'rejected'] as const).map((s) => (
            <div key={s} style={{ background: ventsColors.elevated, borderRadius: 10, padding: '6px 8px', minWidth: 0 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: ventsColors.ink3 }}>{EXPENSE_LABEL[s]}</div>
              <div style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
                {tally(s) ? formatNaira(tally(s)!.amount_kobo) : '—'}
              </div>
            </div>
          ))}
        </div>
        <Chips>
          {(['all', 'submitted', 'approved', 'rejected'] as const).map((f) => {
            const c = f === 'all' ? all : tally(f)?.count;
            return (
              <ChipButton key={f} testId={`expense-filter-${f}`} active={filter === f} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : EXPENSE_LABEL[f]}{c === undefined ? '' : ` ${c}`}
              </ChipButton>
            );
          })}
        </Chips>
        {list.loading && <Loading />}
        <ListError h={list} testId="expenses-error" />
        {!list.loading && !list.error && list.items.length === 0 && (
          <Row testId="expenses-empty" title={filter === 'all' ? 'No expenses yet' : 'Nothing here'}
            sub={filter === 'all' ? 'Claim transport or support costs below' : undefined} />
        )}
        {!list.loading && list.items.map((x) => (
          <Row key={x.id} testId={`expense-${x.id}`} icon={<Ico tone="y">⇢</Ico>} title={`${formatNaira(x.amount_kobo)} · ${x.category === 'transport' ? 'Transport' : 'Support'}`}
            sub={`${x.description} · ${x.incurred_on}${x.decision_reason ? ` · ${x.decision_reason}` : ''}`}
            right={<Pill tone={x.status === 'approved' ? 'on' : x.status === 'rejected' ? 'off' : 'wait'}>{EXPENSE_LABEL[x.status] ?? x.status}</Pill>} />
        ))}
        {!list.loading && <MoreButton h={list} testId="expenses-more" label="Show more expenses" />}
        <div style={{ display: 'grid', gap: 8, borderTop: `1px solid ${ventsColors.border}`, paddingTop: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
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
          <div data-testid="expense-note" style={{ fontSize: 10, color: ventsColors.ink3 }}>
            Two VENTS admins review each expense. Approval records the expense; it is not added to your earnings wallet
            and is separate from rewards.
          </div>
        </div>
      </MCard>
    </>
  );
}
