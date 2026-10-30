import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import { formatNaira, REWARD_STAGES } from '../../../lib/workRoles';
import { useRepresentativeData, RewardsPanel, ExpensesPanel, type Performance, type RepresentativeData } from './representativePanels';
import { RewardRulesNote, RewardsNotLive } from './RepresentativeRewardsScreen';
import {
  workPage, workScroll, WorkBar, MLabel, MCard, Row, Ico, Pill, Tiles, Tile, WorkButton, ErrorNote, Loading, NoteBand,
} from './workUi';

export type RepTab = 'overview' | 'monthly' | 'rewards' | 'team' | 'expenses';
const TABS: { id: RepTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'rewards', label: 'Rewards' },
  { id: 'team', label: 'Team' },
  { id: 'expenses', label: 'Expenses' },
];

const monthLabel = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—');

// Representative dashboard: recruitment funnel, monthly performance, the
// reward lifecycle, the team and expenses -- all from the representative's
// own RPCs (0201) and the live partnership table. Nothing is estimated on
// the client; before 0201 is deployed (or in the read-only Preview) the
// reward parts say so and the live parts still work.
export function RepresentativeDashboardScreen({ currentUser, onBack, onNavigate, initialTab = 'overview' }: {
  currentUser: { id: string } | null;
  onBack: () => void;
  onNavigate: (screen: string) => void;
  initialTab?: RepTab;
}) {
  const rep = useRepresentativeData(currentUser?.id);
  const [tab, setTab] = useState<RepTab>(initialTab);
  const perf = rep.performance;
  const isRep = !!(perf?.representative || rep.rewards?.representative);
  const status = perf?.representative?.status ?? rep.rewards?.representative?.status;

  return (
    <div data-testid="representative-dashboard" style={workPage}>
      <WorkBar title="Representative" sub="Bring organizers to VENTS" onBack={onBack}
        right={status ? <Pill tone={status === 'active' ? 'on' : 'wait'}>{status === 'active' ? 'Active' : 'Paused'}</Pill> : undefined} />
      <div role="tablist" aria-label="Representative sections"
        style={{ display: 'grid', gridTemplateColumns: `repeat(${TABS.length}, minmax(0, 1fr))`, gap: 2, margin: '6px 12px 0', padding: 3, background: ventsColors.surface, border: `1px solid ${ventsColors.border}`, borderRadius: 12, flexShrink: 0 }}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" data-testid={`rep-tab-${t.id}`} aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            style={{
              minWidth: 0, minHeight: 36, padding: '0 2px', border: 'none', borderRadius: 9, cursor: 'pointer', whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
              background: tab === t.id ? ventsColors.accentStrong : 'transparent', color: tab === t.id ? ventsColors.white : ventsColors.ink2,
            }}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={workScroll}>
        {rep.error && <ErrorNote>{rep.error}</ErrorNote>}
        {rep.loading && <Loading />}
        {!rep.loading && rep.rewardsUnavailable && tab !== 'team' && <RewardsNotLive />}
        {!rep.loading && !rep.rewardsUnavailable && !isRep && !rep.error && (
          <MCard>
            <Row testId="rep-join" icon={<Ico tone="p">⇄</Ico>} title="Join as a Representative" sub="Earn ₦50,000 for each qualifying organizer you bring"
              right={<Pill tone="off">Join</Pill>} onClick={() => onNavigate('representatives')} />
          </MCard>
        )}

        {tab === 'overview' && !rep.loading && <Overview rep={rep} perf={perf} onNavigate={onNavigate} goTab={setTab} />}
        {tab === 'monthly' && perf?.representative && <Monthly perf={perf} />}
        {tab === 'rewards' && rep.rewards?.representative && (
          <>
            <RewardRulesNote programmeOpen={rep.rewards.programme_open} payoutsEnabled={rep.rewards.payouts_enabled}
              holdDays={rep.performance?.settlement_hold_days} />
            <RewardsPanel rewards={rep.rewards} reload={rep.reload} onNavigate={onNavigate} />
          </>
        )}
        {tab === 'team' && <Team userId={currentUser?.id ?? null} onNavigate={onNavigate} onChanged={rep.reload} />}
        {tab === 'expenses' && rep.rewards?.representative && (
          <ExpensesPanel rewards={rep.rewards} reload={rep.reload} totals={perf?.expenses} />
        )}
      </div>
    </div>
  );
}

function Overview({ rep, perf, onNavigate, goTab }: {
  rep: RepresentativeData; perf: Performance | null; onNavigate: (s: string) => void; goTab: (t: RepTab) => void;
}) {
  const f = perf?.funnel;
  const p = rep.partnerships;
  // Invitation steps are live in every environment; reward steps need 0201.
  const sent = f?.invitations_sent ?? p?.sent;
  const accepted = f?.invitations_accepted ?? p?.accepted;
  const steps: { k: string; label: string; v: number | undefined; base?: number }[] = [
    { k: 'sent', label: 'Invitations sent', v: sent },
    { k: 'accepted', label: 'Accepted', v: accepted, base: sent },
    { k: 'attributed', label: 'Organizers attributed to you', v: f?.organizers_attributed, base: accepted },
    { k: 'hosting', label: 'Hosted an event since', v: f?.organizers_hosting, base: f?.organizers_attributed },
    { k: 'qualified', label: 'Qualified (reward approved)', v: f?.organizers_qualified, base: f?.organizers_hosting },
    { k: 'paid', label: 'Paid', v: f?.organizers_paid, base: f?.organizers_qualified },
  ];
  const thisMonth = perf?.months?.[0];
  const threshold = perf?.rate_review_threshold ?? 0;
  const progress = thisMonth && threshold > 0 ? Math.min(1, thisMonth.qualifying / threshold) : 0;

  return (
    <>
      {perf?.representative && (
        <>
          <MLabel>Earnings wallet</MLabel>
          <Tiles>
            <Tile testId="rep-wallet-available" k="Withdrawable" v={formatNaira(perf.wallet.balance_kobo)} s="Earnings wallet ›" onClick={() => onNavigate('wallet')} />
            <Tile testId="rep-wallet-pending" k="Withdrawal pending" v={formatNaira(perf.wallet.pending_kobo)}
              s={perf.wallet.on_hold_kobo > 0 ? `${formatNaira(perf.wallet.on_hold_kobo)} on hold` : 'Two-admin approval'} />
          </Tiles>
          <WorkButton testId="rep-withdraw" onClick={() => onNavigate('wallet')}>Withdraw earnings</WorkButton>

          <MLabel>This month</MLabel>
          <MCard testId="rep-month-progress">
            <Row icon={<Ico tone="g">★</Ico>} title={`${thisMonth?.qualifying ?? 0} qualifying organizer${thisMonth?.qualifying === 1 ? '' : 's'}`}
              sub={`${formatNaira(thisMonth?.rate_kobo)} each · ${threshold} in a month can earn a higher rate next month (reviewed by two admins)`} />
            <div role="progressbar" aria-label="Progress toward the rate review" aria-valuemin={0} aria-valuemax={threshold} aria-valuenow={thisMonth?.qualifying ?? 0}
              style={{ height: 8, borderRadius: 999, background: ventsColors.elevated, overflow: 'hidden' }}>
              <div style={{ width: `${progress * 100}%`, height: '100%', background: ventsColors.accentStrong, borderRadius: 999 }} />
            </div>
          </MCard>
        </>
      )}

      {(sent !== undefined || f) && (
        <>
          <MLabel>Recruitment funnel</MLabel>
          <MCard testId="rep-funnel">
            {steps.filter((s) => s.v !== undefined).map((s) => (
              <Row key={s.k} testId={`funnel-${s.k}`} title={s.label}
                sub={s.base !== undefined ? `${pct(s.v ?? 0, s.base)} of the step before` : undefined}
                right={<span style={{ fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{s.v}</span>} />
            ))}
            {!f && <div style={{ fontSize: 10.5, color: ventsColors.ink3 }}>Attribution and reward steps appear once representative rewards are switched on.</div>}
            <WorkButton ghost testId="rep-invite" onClick={() => onNavigate('representatives')}>Invite an organizer</WorkButton>
          </MCard>
        </>
      )}

      {perf?.representative && (
        <>
          <MLabel>Reward lifecycle</MLabel>
          <MCard testId="rep-lifecycle">
            {REWARD_STAGES.map((st) => {
              const t = perf.lifecycle?.[st.status] ?? { count: 0, amount_kobo: 0 };
              return (
                <Row key={st.status} testId={`lifecycle-${st.status}`} title={st.label} sub={st.hint}
                  right={<span style={{ fontSize: 12, fontWeight: 800, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                    {t.count} · {formatNaira(t.amount_kobo)}</span>} />
              );
            })}
            <WorkButton ghost onClick={() => goTab('rewards')}>See rewards</WorkButton>
          </MCard>
        </>
      )}
    </>
  );
}

function Monthly({ perf }: { perf: Performance }) {
  const max = Math.max(1, perf.rate_review_threshold, ...perf.months.map((m) => m.qualifying));
  return (
    <>
      <MLabel>Last six months</MLabel>
      <MCard testId="rep-monthly">
        {perf.months.map((m) => (
          <div key={m.month} data-testid={`month-${m.month.slice(0, 7)}`} style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, minWidth: 0 }}>{monthLabel(m.month)}</span>
              <span style={{ fontSize: 11, color: ventsColors.ink3, whiteSpace: 'nowrap' }}>{m.qualifying} qualifying · {m.submitted} submitted</span>
            </div>
            <div aria-hidden style={{ height: 6, borderRadius: 999, background: ventsColors.elevated, overflow: 'hidden' }}>
              <div style={{ width: `${(m.qualifying / max) * 100}%`, height: '100%', background: m.qualifying >= perf.rate_review_threshold ? '#34D399' : ventsColors.accentStrong }} />
            </div>
            <div style={{ fontSize: 10.5, color: ventsColors.ink3 }}>
              Rate {formatNaira(m.rate_kobo)} · paid {formatNaira(m.paid_kobo)}
            </div>
          </div>
        ))}
      </MCard>
      <NoteBand>
        A month counts the rewards approved for organizers whose qualifying event ended that month (Lagos time).
        {` ${perf.rate_review_threshold}`} or more in a month can earn a higher rate the next month, after two VENTS admins review it.
      </NoteBand>
    </>
  );
}

interface PartnershipRow {
  id: string; status: string; organizer_id: string | null; provider_id: string | null; invited_at: string; responded_at: string | null;
}

// Team: the representative's own partnerships, live (recruiter_partnerships,
// RLS-scoped). Withdraw and end use the existing partnership functions.
function Team({ userId, onNavigate, onChanged }: { userId: string | null; onNavigate: (s: string) => void; onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<PartnershipRow[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const { data, error: e } = await supabase.from('recruiter_partnerships')
      .select('id, status, organizer_id, provider_id, invited_at, responded_at')
      .eq('recruiter_id', userId).order('invited_at', { ascending: false });
    if (e) { setError(e.message || 'Could not load your team.'); setRows([]); return; }
    const list = (data as PartnershipRow[]) || [];
    setRows(list);
    const orgIds = Array.from(new Set(list.map((r) => r.organizer_id).filter(Boolean))) as string[];
    const provIds = Array.from(new Set(list.map((r) => r.provider_id).filter(Boolean))) as string[];
    const [pp, sp] = await Promise.all([
      orgIds.length ? Promise.resolve(supabase.from('public_profiles').select('id, full_name, username').in('id', orgIds)).catch(() => null) : null,
      provIds.length ? Promise.resolve(supabase.from('service_providers').select('id, business_name').in('id', provIds)).catch(() => null) : null,
    ]);
    const map: Record<string, string> = {};
    for (const u of ((pp as any)?.data ?? [])) map[u.id] = u.full_name || u.username || 'Organizer';
    for (const s of ((sp as any)?.data ?? [])) map[s.id] = s.business_name || 'Service provider';
    setNames(map);
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  const act = async (id: string, fn: 'withdraw_recruiter_invitation' | 'revoke_recruiter_partnership') => {
    if (fn === 'revoke_recruiter_partnership' && !window.confirm('End this partnership? Organizers already attributed to you stay attributed.')) return;
    setBusy(id); setError(null);
    try {
      const { error: e } = await supabase.rpc(fn as any, { p_partnership_id: id });
      if (e) throw e;
      await load();
      await onChanged();
    } catch (e: any) { setError(e?.message || 'Could not update this partnership.'); } finally { setBusy(null); }
  };

  const pending = (rows ?? []).filter((r) => r.status === 'pending');
  const active = (rows ?? []).filter((r) => r.status === 'accepted');
  const past = (rows ?? []).filter((r) => !['pending', 'accepted'].includes(r.status));
  const roleOf = (r: PartnershipRow) => (r.organizer_id ? 'Organizer' : 'Service provider');
  const known = (r: PartnershipRow) => names[r.organizer_id ?? r.provider_id ?? ''];
  const nameOf = (r: PartnershipRow) => known(r) || roleOf(r);
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

  return (
    <>
      {error && <ErrorNote>{error}</ErrorNote>}
      <WorkButton testId="team-invite" onClick={() => onNavigate('representatives')}>Find and invite organizers</WorkButton>
      {rows === null && <Loading />}
      <MLabel>Active partnerships ({active.length})</MLabel>
      <MCard testId="team-active">
        {rows && active.length === 0 && <Row title="No active partnerships yet" sub="Invite an organizer or provider to partner with you" />}
        {active.map((r) => (
          <Row key={r.id} testId={`team-${r.id}`} icon={<Ico tone={r.organizer_id ? 'p' : 'c'} round>{nameOf(r).slice(0, 2).toUpperCase()}</Ico>}
            title={nameOf(r)} sub={`${known(r) ? `${roleOf(r)} · ` : ''}since ${when(r.responded_at)}`}
            right={<button data-testid={`team-end-${r.id}`} disabled={busy === r.id} onClick={() => act(r.id, 'revoke_recruiter_partnership')}
              style={{ minHeight: 32, padding: '0 10px', borderRadius: 8, border: `1px solid ${ventsColors.border}`, background: 'transparent', color: ventsColors.ink2, fontFamily: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>End</button>} />
        ))}
      </MCard>
      <MLabel>Invitations awaiting a reply ({pending.length})</MLabel>
      <MCard testId="team-pending">
        {rows && pending.length === 0 && <Row title="No invitations waiting" />}
        {pending.map((r) => (
          <Row key={r.id} testId={`team-${r.id}`} icon={<Ico tone="y">✉</Ico>} title={nameOf(r)} sub={`Invited ${when(r.invited_at)}`}
            right={<button data-testid={`team-withdraw-${r.id}`} disabled={busy === r.id} onClick={() => act(r.id, 'withdraw_recruiter_invitation')}
              style={{ minHeight: 32, padding: '0 10px', borderRadius: 8, border: `1px solid ${ventsColors.border}`, background: 'transparent', color: ventsColors.ink2, fontFamily: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Withdraw</button>} />
        ))}
      </MCard>
      {past.length > 0 && (
        <>
          <MLabel>History</MLabel>
          <MCard testId="team-history">
            {past.map((r) => (
              <Row key={r.id} title={nameOf(r)} sub={when(r.responded_at ?? r.invited_at)}
                right={<Pill tone="off">{r.status === 'declined' ? 'Declined' : r.status === 'revoked' ? 'Ended' : 'Withdrawn'}</Pill>} />
            ))}
          </MCard>
        </>
      )}
    </>
  );
}
