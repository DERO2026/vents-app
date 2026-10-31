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
        {tab === 'monthly' && !rep.loading && !perf && rep.rewards?.representative && (
          <div data-testid="monthly-unavailable"><NoteBand>Monthly figures are not available yet.</NoteBand></div>
        )}
        {tab === 'rewards' && rep.rewards?.representative && (
          <>
            <RewardRulesNote programmeOpen={rep.rewards.programme_open} payoutsEnabled={rep.rewards.payouts_enabled}
              holdDays={rep.performance?.settlement_hold_days} />
            <RewardsPanel rewards={rep.rewards} totals={perf?.lifecycle} reload={rep.reload} onNavigate={onNavigate} />
          </>
        )}
        {tab === 'team' && <Team userId={currentUser?.id ?? null} onNavigate={onNavigate} onChanged={rep.reload} />}
        {tab === 'expenses' && rep.rewards?.representative && (
          <ExpensesPanel reload={rep.reload} totals={perf?.expenses} />
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
  // Plain counts, no conversion rates: the steps are not strict subsets of
  // each other (an organizer can be attributed without a partnership in this
  // list, and invitations include service providers), so a percentage
  // between rows would mislead. Invitation counts are live in every
  // environment; the referred-organizer counts need 0201.
  const inv = f ? {
    sent: f.invitations_sent, pending: f.invitations_pending, accepted: f.invitations_accepted,
    active: f.partnerships_active, ended: f.partnerships_ended, declined: f.invitations_declined, withdrawn: f.invitations_withdrawn,
  } : p ? { ...p } : null;
  const invitationRows: { k: string; label: string; sub?: string; v: number | undefined }[] = inv ? [
    { k: 'sent', label: 'Invitations sent', sub: 'All time, organizers and service providers', v: inv.sent },
    { k: 'pending', label: 'Awaiting a reply', v: inv.pending },
    { k: 'accepted', label: 'Accepted (all time)', sub: 'Includes partnerships that have since ended', v: inv.accepted },
    { k: 'active', label: 'Active partnerships now', sub: 'Your current team', v: inv.active },
    { k: 'ended', label: 'Ended after accepting', v: inv.ended },
    { k: 'declined', label: 'Declined', v: inv.declined },
    { k: 'withdrawn', label: 'Withdrawn by you', v: inv.withdrawn },
  ] : [];
  const organizerRows: { k: string; label: string; sub?: string; v: number }[] = f ? [
    { k: 'attributed', label: 'Organizers referred by you', sub: 'Stays yours even if the partnership ends', v: f.organizers_attributed },
    { k: 'hosting', label: 'Created an event since', sub: 'An event created after they accepted', v: f.organizers_hosting },
    { k: 'qualified', label: 'Reward approved', sub: 'Approved, available or paid; not reversed', v: f.organizers_qualified },
    { k: 'paid', label: 'Reward paid', sub: 'Added to your earnings wallet', v: f.organizers_paid },
  ] : [];
  const big = { fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums' as const };
  const thisMonth = perf?.months?.[0];
  const threshold = perf?.rate_review_threshold ?? 0;
  const progress = thisMonth && threshold > 0 ? Math.min(1, thisMonth.qualifying / threshold) : 0;

  return (
    <>
      {perf?.representative && (
        <>
          <MLabel>Earnings wallet</MLabel>
          <Tiles>
            <Tile testId="rep-wallet-available" k="Withdrawable" v={formatNaira(perf.wallet.balance_kobo)} s="All your VENTS earnings ›" onClick={() => onNavigate('wallet')} />
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

      {inv && (
        <>
          <MLabel>Partnership invitations</MLabel>
          <MCard testId="rep-funnel">
            {invitationRows.filter((r) => r.v !== undefined).map((r) => (
              <Row key={r.k} testId={`funnel-${r.k}`} title={r.label} sub={r.sub} right={<span style={big}>{r.v}</span>} />
            ))}
            <WorkButton ghost testId="rep-invite" onClick={() => onNavigate('representatives')}>Invite an organizer</WorkButton>
          </MCard>
        </>
      )}

      {f ? (
        <>
          <MLabel>Referred organizers</MLabel>
          <MCard testId="rep-referred">
            {organizerRows.map((r) => (
              <Row key={r.k} testId={`funnel-${r.k}`} title={r.label} sub={r.sub} right={<span style={big}>{r.v}</span>} />
            ))}
          </MCard>
        </>
      ) : inv && (
        <div data-testid="rep-referred-unavailable" style={{ fontSize: 10.5, color: ventsColors.ink3, padding: '0 4px' }}>
          Referred-organizer and reward counts are not available yet.
        </div>
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
        A month counts the rewards approved for organizers whose qualifying event ended that month (Lagos time), so a
        month&apos;s count can still rise after it ends while reviews finish.
        {` ${perf.rate_review_threshold}`} or more in a month can earn a higher rate the next month, after two VENTS admins review it.
        Nothing rises automatically.
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
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    const { data, error: e } = await supabase.from('recruiter_partnerships')
      .select('id, status, organizer_id, provider_id, invited_at, responded_at')
      .eq('recruiter_id', userId).order('invited_at', { ascending: false });
    // A failed read shows the error only, never an empty team.
    if (e) { setError(e.message || 'Could not load your team.'); setRows(null); setFailed(true); return; }
    setFailed(false);
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
      {rows === null && !failed && <Loading />}
      {failed && <WorkButton ghost testId="team-retry" onClick={() => load()}>Try again</WorkButton>}
      {rows && (<>
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
      </>)}
    </>
  );
}
