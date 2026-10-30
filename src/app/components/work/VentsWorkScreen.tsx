import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  organizerRole, providerRole, representativeRole, formatNaira,
  type RoleAction, type RoleRow,
} from '../../../lib/workRoles';
import { CACVerificationScreen } from '../SettingsScreen';
import { OrganizerRequestSheet } from './OrganizerRequestSheet';
import { useWorkStatus, type WorkUser } from './useWorkStatus';
import {
  workPage, workScroll, WorkBar, MLabel, MCard, Row, Ico, Pill, Tiles, Tile, ErrorNote, WorkButton, Chev,
} from './workUi';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

interface Confirmation { id: string; status: string; representative_name: string | null; event_title: string | null }

// VENTS Work hub (approved mockup B): earnings first, then roles, then
// opportunities. Every role row opens that role's existing flow in
// whatever state the person is in; nothing here grants a capability.
export function VentsWorkScreen({ currentUser, onBack, onNavigate, onOpenCreatorStudio, onOpenProviderBookings }: {
  currentUser: (WorkUser & { full_name?: string | null; email?: string }) | null;
  onBack: () => void;
  onNavigate: (screen: string) => void;
  onOpenCreatorStudio: () => void;
  // Opens the caller's own provider bookings (resolves their provider id).
  onOpenProviderBookings?: () => void;
}) {
  const status = useWorkStatus(currentUser);
  const [withdrawableKobo, setWithdrawableKobo] = useState<number | null>(null);
  const [vcTier, setVcTier] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showOrgSheet, setShowOrgSheet] = useState(false);
  const [showCac, setShowCac] = useState(false);

  const loadMoney = useCallback(async () => {
    if (!currentUser?.id) return;
    const [wallet, tier, conf] = await Promise.all([
      Promise.resolve(supabase.from('organizer_wallets').select('balance_kobo').eq('organizer_id', currentUser.id).maybeSingle()).catch(() => null),
      Promise.resolve(supabase.rpc('vc_tier_and_multiplier_for_user' as any, { p_user_id: currentUser.id })).catch(() => null),
      Promise.resolve(supabase.rpc('get_my_referral_confirmations' as any)).catch(() => null),
    ]);
    // No earnings-wallet row means nothing earned yet: a real ₦0.
    setWithdrawableKobo((wallet as any)?.error ? null : ((wallet as any)?.data?.balance_kobo ?? 0));
    const tierRow = Array.isArray((tier as any)?.data) ? (tier as any).data[0] : (tier as any)?.data;
    setVcTier(tierRow?.tier ?? null);
    const rows = (conf as any)?.data;
    setConfirmations(Array.isArray(rows) ? rows.filter((r: Confirmation) => r.status === 'pending_organizer') : []);
  }, [currentUser?.id]);

  useEffect(() => { loadMoney(); }, [loadMoney]);

  if (!currentUser) return null;

  const isStaff = currentUser.role === 'admin' || currentUser.role === 'sub-admin' || currentUser.id === ROOT_UID;
  const isVerified = currentUser.is_verified === true || currentUser.id === ROOT_UID;
  const isProviderActive = currentUser.is_service_provider === true && status.providerProfileStatus !== 'suspended';
  const rows: { row: RoleRow; icon: { tone: 'p' | 'c'; glyph: string } }[] = [
    { row: organizerRole({ isOrganizer: !!currentUser.isOrganizer, isStaff, isVerified, request: status.organizerRequest }), icon: { tone: 'p', glyph: '★' } },
    { row: providerRole({ isProvider: currentUser.is_service_provider === true, isStaff, request: status.providerRequest, profileStatus: status.providerProfileStatus }), icon: { tone: 'c', glyph: '✦' } },
    { row: representativeRole(status.representative), icon: { tone: 'p', glyph: '⇄' } },
  ];

  const open = (action: RoleAction) => {
    switch (action) {
      case 'organizer-apply': setShowOrgSheet(true); break;
      case 'organizer-verify': setShowCac(true); break;
      case 'organizer-studio': onOpenCreatorStudio(); break;
      case 'provider-verify': onNavigate('service-provider-verify'); break;
      case 'provider-setup': onNavigate('service-provider-setup'); break;
      // An active representative lands on their dashboard; anyone else on
      // the existing join / invitations screen.
      case 'representative': onNavigate(status.representative === 'active' ? 'representative-dashboard' : 'representatives'); break;
      case 'support': onNavigate('help-support'); break;
      case 'none': break;
    }
  };

  const respond = async (id: string, confirm: boolean) => {
    setBusyId(id); setActionError(null);
    try {
      const { error } = await supabase.rpc('respond_to_representative_reward_claim' as any, { p_claim_id: id, p_confirm: confirm });
      if (error) throw error;
      await loadMoney();
    } catch (e: any) {
      setActionError(e?.message || 'Could not send your reply.');
    } finally { setBusyId(null); }
  };

  if (showCac) {
    return (
      <CACVerificationScreen
        currentUser={currentUser}
        onBack={() => { setShowCac(false); status.refresh(); }}
        onContactSupport={() => { setShowCac(false); onNavigate('help-support'); }}
      />
    );
  }

  return (
    <div data-testid="vents-work-screen" style={workPage}>
      <WorkBar title="VENTS Work" sub="Earn with VENTS" onBack={onBack} />
      <div style={workScroll}>
        <MLabel>Earnings</MLabel>
        <Tiles>
          <Tile testId="work-tile-withdrawable" k="Withdrawable"
            v={withdrawableKobo === null ? '—' : formatNaira(withdrawableKobo)} s="Earnings wallet ›"
            onClick={() => onNavigate('vents-earnings')} />
          <Tile testId="work-tile-vc" k="VENTS Cents"
            v={status.vcSpendable === null ? '—' : `${status.vcSpendable.toLocaleString()} VC`}
            s={vcTier ? `${vcTier} · convert ›` : 'Convert ›'}
            onClick={() => onNavigate('referral')} />
        </Tiles>

        {confirmations.length > 0 && (
          <>
            <MLabel>Needs your reply</MLabel>
            <MCard testId="work-confirmations">
              {confirmations.map((c) => (
                <div key={c.id} style={{ display: 'grid', gap: 8 }}>
                  <Row icon={<Ico tone="y">?</Ico>} title={`${c.representative_name || 'A representative'} says they referred you`}
                    sub={c.event_title ? `For ${c.event_title}` : undefined} right={<Pill tone="wait">Confirm</Pill>} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <WorkButton testId={`confirm-${c.id}`} disabled={busyId === c.id} onClick={() => respond(c.id, true)}>Yes, they did</WorkButton>
                    <WorkButton ghost disabled={busyId === c.id} onClick={() => respond(c.id, false)}>No</WorkButton>
                  </div>
                </div>
              ))}
              {actionError && <ErrorNote>{actionError}</ErrorNote>}
            </MCard>
          </>
        )}

        <MLabel>Your roles</MLabel>
        <MCard testId="work-roles">
          {rows.map(({ row, icon }) => (
            <Row key={row.key} testId={`work-role-${row.key}`} icon={<Ico tone={icon.tone}>{icon.glyph}</Ico>}
              title={row.title} sub={status.loading ? 'Checking…' : row.subtitle}
              right={status.loading ? undefined : <Pill tone={row.pill.tone}>{row.pill.label}</Pill>}
              onClick={status.loading || row.action === 'none' ? undefined : () => open(row.action)} />
          ))}
        </MCard>

        {/* Shortcuts for the roles the person actually holds, each opening an
            existing screen. Shown only once the role is active. */}
        {!status.loading && (currentUser.isOrganizer || isProviderActive || status.representative === 'active') && (
          <>
            <MLabel>Shortcuts</MLabel>
            <MCard testId="work-shortcuts">
              {currentUser.isOrganizer && (
                <>
                  <Row testId="shortcut-studio" icon={<Ico tone="p">★</Ico>} title="Creator Studio" sub="Create and manage your events" right={<Chev />} onClick={onOpenCreatorStudio} />
                  <Row testId="shortcut-events" icon={<Ico tone="p">☰</Ico>} title="Manage events" sub="Edit, sales and attendees" right={<Chev />} onClick={() => onNavigate('manage-events')} />
                </>
              )}
              {isProviderActive && (
                <>
                  {onOpenProviderBookings && (
                    <Row testId="shortcut-bookings" icon={<Ico tone="c">✦</Ico>} title="Service bookings" sub="Confirm, complete and refund bookings" right={<Chev />} onClick={onOpenProviderBookings} />
                  )}
                  <Row testId="shortcut-services" icon={<Ico tone="c">✎</Ico>} title="Your services" sub="Profile, services and location" right={<Chev />} onClick={() => onNavigate('service-provider-setup')} />
                </>
              )}
              {status.representative === 'active' && (
                <Row testId="shortcut-representative" icon={<Ico tone="p">⇄</Ico>} title="Representative dashboard" sub="Funnel, monthly performance, rewards and team" right={<Chev />} onClick={() => onNavigate('representative-dashboard')} />
              )}
              <Row testId="shortcut-wallet" icon={<Ico tone="g">₦</Ico>} title="Earnings wallet" sub="Withdraw to your bank · statement" right={<Chev />} onClick={() => onNavigate('wallet')} />
            </MCard>
          </>
        )}

        <MLabel>Opportunities</MLabel>
        <MCard>
          <Row icon={<Ico tone="y">◇</Ico>} title="Work Opportunities" sub="Paid gigs at events near you" right={<Pill tone="soon">Coming soon</Pill>} />
        </MCard>
      </div>

      {showOrgSheet && (
        <OrganizerRequestSheet
          userId={currentUser.id}
          status={status.organizerRequest}
          adminNote={status.organizerAdminNote}
          submittedReason={status.organizerReason}
          onClose={() => setShowOrgSheet(false)}
          onSubmitted={() => status.refresh()}
        />
      )}
    </div>
  );
}
