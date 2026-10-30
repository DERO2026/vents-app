import { formatNaira } from '../../../lib/workRoles';
import { useRepresentativeData, RewardsPanel, ExpensesPanel } from './representativePanels';
import { workPage, workScroll, WorkBar, MCard, Row, Ico, Pill, Tiles, Tile, NoteBand, ErrorNote, Loading } from './workUi';

// Representative rewards: referred organizers, the ₦50,000 reward for each
// qualifying organizer, and transport/support expenses. Every rule is
// enforced server-side (migration 0201); this screen only shows state and
// calls the representative's own RPCs.
export function RepresentativeRewardsScreen({ currentUser, onBack, onNavigate }: {
  currentUser: { id: string } | null;
  onBack: () => void;
  onNavigate: (screen: string) => void;
}) {
  const rep = useRepresentativeData(currentUser?.id);
  const data = rep.rewards;

  return (
    <div data-testid="representative-rewards-screen" style={workPage}>
      <WorkBar title="Rewards" sub="₦50,000 per qualifying organizer" onBack={onBack} />
      <div style={workScroll}>
        {rep.error && <ErrorNote>{rep.error}</ErrorNote>}
        {rep.loading && <Loading />}
        {!rep.loading && rep.rewardsUnavailable && <RewardsNotLive />}
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
            <RewardRulesNote programmeOpen={data.programme_open} payoutsEnabled={data.payouts_enabled} />
            <RewardsPanel rewards={data} reload={rep.reload} onNavigate={onNavigate} />
            <ExpensesPanel rewards={data} reload={rep.reload} totals={rep.performance?.expenses} />
          </>
        )}
      </div>
    </div>
  );
}

export function RewardRulesNote({ programmeOpen, payoutsEnabled }: { programmeOpen: boolean; payoutsEnabled: boolean }) {
  return (
    <NoteBand>
      An organizer you referred qualifies after hosting an event that has ended, isn&apos;t cancelled and has finished its
      7-day settlement. The organizer must be verified; they confirm you referred them, then two VENTS admins review it.
      Approved rewards are paid into your earnings wallet, which you can withdraw, once VENTS ticket profit covers them.
      {!programmeOpen && ' Rewards open once VENTS finishes moving representatives off the old commission plan.'}
      {programmeOpen && !payoutsEnabled && ' Wallet payouts have not started yet.'}
    </NoteBand>
  );
}

// The 0201 functions are not deployed (or the read-only Preview refuses
// them): say so plainly, never show invented figures.
export function RewardsNotLive() {
  return (
    <div data-testid="rewards-not-live">
      <NoteBand>
        Representative rewards are not switched on yet, so there are no reward figures to show. Your invitations and team
        are live.
      </NoteBand>
    </div>
  );
}
