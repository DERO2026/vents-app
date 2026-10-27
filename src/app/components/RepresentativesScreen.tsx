import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowLeft, UserPlus, Users, Search } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { searchUsers, UserSearchResult } from '../../lib/userSearch';
import { ventsColors, ventsTypography, ventsSpacing, ventsRadii, ventsStatusColors } from '../../lib/ventsDesignTokens';

interface RepresentativesScreenProps {
  onBack: () => void;
  currentUser: { id: string; role?: string; full_name?: string | null; username?: string };
}

type SubTab = 'find' | 'invitations' | 'team';

interface Partnership {
  id: string;
  recruiter_id: string;
  organizer_id: string | null;
  provider_id: string | null;
  status: string;
  commission_split_bps: number;
  invited_at: string;
}

// VENTS Representatives -- frontend for the recruiter/organizer-provider
// partnership system (migration 0193). This UI calls the backend RPCs
// directly; it does NOT compute, display, or imply any commission amount
// or payout, since that logic is intentionally not built/approved yet.
// Reached from Settings (not the bottom nav, which is already at 5 items)
// since this is a secondary, opt-in role rather than a primary destination.
export function RepresentativesScreen({ onBack, currentUser }: RepresentativesScreenProps) {
  const [tab, setTab] = useState<SubTab>('find');
  const [isRecruiter, setIsRecruiter] = useState<boolean | null>(null);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [inviteTarget, setInviteTarget] = useState<UserSearchResult | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSent, setInviteSent] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  // The target's role is resolved on selection, not carried on
  // UserSearchResult (that type is shared with UserAutocomplete/checkout
  // and ticket-transfer flows -- adding a role field there would be an
  // unnecessary shared-type change for a resolution this screen alone
  // needs). 'both' prefers organizer, matching the previously-working
  // path; a UI toggle to let the recruiter pick instead was considered
  // but kept out to stay minimal, since a genuine both-roles target is
  // expected to be rare.
  const [targetRole, setTargetRole] = useState<'organizer' | 'provider' | 'both' | 'neither' | null>(null);
  const [targetProviderId, setTargetProviderId] = useState<string | null>(null);
  const [resolvingTarget, setResolvingTarget] = useState(false);

  const [incoming, setIncoming] = useState<Partnership[]>([]);
  const [team, setTeam] = useState<Partnership[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [listsError, setListsError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!inviteTarget) {
      setTargetRole(null);
      setTargetProviderId(null);
      return;
    }
    void resolveTargetRole(inviteTarget.id);
  }, [inviteTarget]);

  // Resolves whether a search result is an organizer (has at least one
  // event with organizer_id = their user id), a service provider (has a
  // service_providers row keyed by user_id), neither, or both -- the
  // backend's invite function needs the TARGET's service_providers.id,
  // not their raw user id, for the provider path.
  async function resolveTargetRole(userId: string) {
    setResolvingTarget(true);
    try {
      const [organizerRes, providerRes] = await Promise.all([
        supabase.from('events').select('id').eq('organizer_id', userId).maybeSingle(),
        supabase.from('service_providers').select('id').eq('user_id', userId).maybeSingle(),
      ]);
      const isOrganizer = !organizerRes.error && !!organizerRes.data;
      const isProvider = !providerRes.error && !!providerRes.data;
      setTargetProviderId(providerRes.data?.id ?? null);
      if (isOrganizer && isProvider) setTargetRole('both');
      else if (isOrganizer) setTargetRole('organizer');
      else if (isProvider) setTargetRole('provider');
      else setTargetRole('neither');
    } catch (err) {
      // A thrown exception here (network failure, client-side error) is
      // NOT the same as a Supabase-returned `{error}` field above -- it
      // would otherwise be an unhandled promise rejection that never
      // updates targetRole/resolvingTarget, leaving the invite form stuck
      // on "Checking organizer/provider status..." forever with no visible
      // failure. Surface it the same way a declared Supabase error would be.
      setInviteError(err instanceof Error ? err.message : 'Failed to check this user.');
      setTargetRole('neither');
    } finally {
      setResolvingTarget(false);
    }
  }

  useEffect(() => {
    void checkRecruiterStatus();
  }, []);

  useEffect(() => {
    if (tab === 'invitations' || tab === 'team') void loadPartnerships();
  }, [tab]);

  // recruiters.id IS the user's auth id (the table's PK references
  // public.users(id) directly) -- there is no separate user_id column.
  async function checkRecruiterStatus() {
    setStatusError(null);
    try {
      const { data, error } = await supabase.from('recruiters').select('id').eq('id', currentUser.id).maybeSingle();
      if (error) {
        setStatusError(error.message);
        setIsRecruiter(null);
        return;
      }
      setIsRecruiter(!!data);
    } catch (err) {
      // This is the one check that runs unconditionally on mount, before
      // the user has done anything. A thrown exception here (not a
      // Supabase-returned `{error}`, which is already handled above) is an
      // unhandled rejection that the caller (`void checkRecruiterStatus()`
      // in a useEffect with no .catch) would otherwise swallow entirely --
      // isRecruiter stays null forever and the screen is stuck on its
      // loading state indefinitely, with nothing visible changing and no
      // error reaching either React error boundary (this never throws
      // during render). Surfacing it here is what turns "stuck forever"
      // into "a loading state that resolves to a visible error."
      setStatusError(err instanceof Error ? err.message : 'Could not check Representative status.');
      setIsRecruiter(null);
    }
  }

  async function handleRegister() {
    setRegistering(true);
    setRegisterError(null);
    const { error } = await supabase.rpc('register_as_recruiter', {
      p_display_name: currentUser.full_name || currentUser.username || null,
      p_bio: null,
    });
    setRegistering(false);
    if (error) {
      setRegisterError(error.message);
      return;
    }
    setIsRecruiter(true);
  }

  async function handleSearch(value: string) {
    setQuery(value);
    setInviteSent(false);
    setInviteError(null);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      setResults(await searchUsers(value));
    } catch {
      setResults([]);
    }
  }

  // Commission is not negotiated through this screen: a Representative
  // always earns the full, fixed VENTS commission (10000 bps = 100% of
  // the recruiter's own designated commission share) on revenue from the
  // organizer/provider they recruit -- there is no 0-10% slider, no
  // partial split, and no "5%" default. FULL_COMMISSION_BPS is passed
  // unconditionally; nothing in this component ever reads or sets a
  // different value. (The underlying recruiter_partnerships.commission_split_bps
  // column and its 0-10000 CHECK constraint are unchanged -- this is a
  // UI/default-value correction, not a schema change: the column simply
  // never receives anything other than the maximum value from this UI.)
  const FULL_COMMISSION_BPS = 10000;

  async function handleSendInvite() {
    if (!inviteTarget) return;
    if (targetRole === 'neither' || targetRole === null) {
      setInviteError('This user is not an organizer or a service provider.');
      return;
    }
    setInviteBusy(true);
    setInviteError(null);
    // provider_id must be the target's service_providers.id (resolved by
    // resolveTargetRole), never their raw user id -- that is the exact
    // bug this fix closes. organizer_id is the target's own user id,
    // since events.organizer_id references it directly.
    const wantsProvider = targetRole === 'provider';
    const { error } = await supabase.rpc('invite_recruiter_partnership', {
      p_organizer_id: wantsProvider ? null : inviteTarget.id,
      p_provider_id: wantsProvider ? targetProviderId : null,
      p_commission_split_bps: FULL_COMMISSION_BPS,
    });
    setInviteBusy(false);
    if (error) {
      setInviteError(error.message);
      return;
    }
    setInviteSent(true);
    setInviteTarget(null);
    setQuery('');
    setResults([]);
  }

  // recruiter_partnerships.provider_id references service_providers.id,
  // NOT the user's own auth id -- a service-provider user's own
  // service_providers row must be resolved first. A user with no
  // service_providers row at all (not a provider) simply has no
  // provider-side invitations; that is not an error.
  async function resolveOwnProviderId(): Promise<string | null> {
    const { data, error } = await supabase
      .from('service_providers')
      .select('id')
      .eq('user_id', currentUser.id)
      .maybeSingle();
    if (error) {
      setListsError(error.message);
      return null;
    }
    return data?.id ?? null;
  }

  async function loadPartnerships() {
    setLoadingLists(true);
    setListsError(null);
    const providerId = await resolveOwnProviderId();
    const recipientFilter = providerId
      ? `organizer_id.eq.${currentUser.id},provider_id.eq.${providerId}`
      : `organizer_id.eq.${currentUser.id}`;
    const [recipientRes, recruiterRes] = await Promise.all([
      supabase
        .from('recruiter_partnerships')
        .select('*')
        .or(recipientFilter)
        .eq('status', 'pending'),
      supabase.from('recruiter_partnerships').select('*').eq('recruiter_id', currentUser.id),
    ]);
    if (recipientRes.error || recruiterRes.error) {
      setListsError(recipientRes.error?.message || recruiterRes.error?.message || 'Failed to load partnerships.');
    }
    setIncoming(recipientRes.data || []);
    setTeam(recruiterRes.data || []);
    setLoadingLists(false);
  }

  function withRowBusyGuard(id: string, run: () => Promise<void>) {
    if (busyIds.has(id)) return;
    setBusyIds((prev) => new Set(prev).add(id));
    void run().finally(() => {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
  }

  async function handleRespond(id: string, accept: boolean) {
    withRowBusyGuard(id, async () => {
      setActionError(null);
      const { error } = await supabase.rpc('respond_to_recruiter_invitation', { p_partnership_id: id, p_accept: accept });
      if (error) {
        setActionError(error.message);
        return;
      }
      await loadPartnerships();
    });
  }

  async function handleWithdraw(id: string) {
    withRowBusyGuard(id, async () => {
      setActionError(null);
      const { error } = await supabase.rpc('withdraw_recruiter_invitation', { p_partnership_id: id });
      if (error) {
        setActionError(error.message);
        return;
      }
      await loadPartnerships();
    });
  }

  async function handleRevoke(id: string) {
    withRowBusyGuard(id, async () => {
      setActionError(null);
      const { error } = await supabase.rpc('revoke_recruiter_partnership', { p_partnership_id: id });
      if (error) {
        setActionError(error.message);
        return;
      }
      await loadPartnerships();
    });
  }

  const statusBadge = (status: string): { bg: string; fg: string; label: string } => {
    switch (status) {
      case 'accepted':
        return { bg: ventsStatusColors.paid.bg, fg: ventsStatusColors.paid.fg, label: 'Accepted' };
      case 'pending':
        return { bg: ventsStatusColors.pending.bg, fg: ventsStatusColors.pending.fg, label: 'Pending' };
      case 'declined':
        return { bg: ventsStatusColors.error.bg, fg: ventsStatusColors.error.fg, label: 'Declined' };
      case 'revoked':
        return { bg: ventsStatusColors.expired.bg, fg: ventsStatusColors.expired.fg, label: 'Revoked' };
      case 'withdrawn':
        return { bg: ventsStatusColors.transferred.bg, fg: ventsStatusColors.transferred.fg, label: 'Withdrawn' };
      default:
        return { bg: ventsStatusColors.info.bg, fg: ventsStatusColors.info.fg, label: status };
    }
  };

  const primaryButtonStyle: CSSProperties = {
    background: ventsColors.accent,
    color: ventsColors.white,
    border: 'none',
    borderRadius: ventsRadii.md,
    padding: '0 20px',
    minHeight: ventsSpacing.minTouchTarget,
    fontFamily: ventsTypography.fontBody,
    ...ventsTypography.body,
    cursor: 'pointer',
    width: '100%',
  };

  const secondaryButtonStyle: CSSProperties = {
    background: ventsColors.glassBg,
    color: ventsColors.ink1,
    border: `1px solid ${ventsColors.glassBorder}`,
    borderRadius: ventsRadii.md,
    padding: '0 16px',
    minHeight: ventsSpacing.minTouchTarget,
    fontFamily: ventsTypography.fontBody,
    ...ventsTypography.bodySecondary,
    cursor: 'pointer',
  };

  const cardStyle: CSSProperties = {
    background: ventsColors.surface,
    border: `1px solid ${ventsColors.border}`,
    borderRadius: ventsRadii.lg,
    padding: ventsSpacing.cardPaddingLg,
    marginBottom: ventsSpacing.unit[3],
  };

  const inputStyle: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    background: ventsColors.elevated,
    border: `1px solid ${ventsColors.border}`,
    borderRadius: ventsRadii.md,
    padding: '12px 14px',
    minHeight: ventsSpacing.minTouchTarget,
    color: ventsColors.ink1,
    fontFamily: ventsTypography.fontBody,
    ...ventsTypography.body,
  };

  const errorTextStyle: CSSProperties = { color: ventsColors.error, ...ventsTypography.bodySecondary, margin: 0 };
  const mutedTextStyle: CSSProperties = { color: ventsColors.ink2, ...ventsTypography.bodySecondary, margin: 0 };

  return (
    // Root text color is set explicitly here because every descendant below
    // relies on CSS inheritance for it (no element in this component sets
    // its own `color`). Without this, the app's global `body { color: #000 }`
    // base style wins: every heading/paragraph/button renders literally
    // black-on-near-black (the app shell's #060A14 background), producing a
    // layout-correct, data-correct, zero-console-error screen that is
    // nonetheless completely invisible to every user -- confirmed by a real
    // headless-browser render where the DOM/text content was all present and
    // correct but the captured screenshot was solid black. This was the
    // actual root cause of the reported "black screen," distinct from (and
    // undiagnosable by) the stale-cache, CSP, network-failure, and
    // currentUser-guard theories tested and eliminated in prior rounds, all
    // of which only checked DOM/text presence, never rendered color.
    <div
      data-testid="representatives-screen"
      style={{
        minHeight: '100vh',
        width: '100%',
        boxSizing: 'border-box',
        background: ventsColors.bg,
        color: ventsColors.ink1,
        fontFamily: ventsTypography.fontBody,
        paddingBottom: ventsSpacing.scrollBottomPadding,
        overflowX: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: ventsSpacing.unit[2],
          padding: `${ventsSpacing.unit[3]}px ${ventsSpacing.pageMarginMobile}px`,
        }}
      >
        <button
          onClick={onBack}
          aria-label="Back"
          style={{
            width: ventsSpacing.minTouchTarget,
            height: ventsSpacing.minTouchTarget,
            minWidth: ventsSpacing.minTouchTarget,
            borderRadius: ventsRadii.pill,
            background: ventsColors.glassBg,
            border: `1px solid ${ventsColors.glassBorder}`,
            color: ventsColors.ink1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <ArrowLeft size={20} />
        </button>
        <h1 style={{ ...ventsTypography.heading, color: ventsColors.ink1, margin: 0 }}>Representatives</h1>
      </header>

      <div style={{ padding: `0 ${ventsSpacing.pageMarginMobile}px` }}>
        {statusError && (
          <div style={cardStyle}>
            <p role="alert" style={errorTextStyle}>Could not check Representative status: {statusError}</p>
          </div>
        )}

        {/* isRecruiter starts null (checkRecruiterStatus hasn't resolved yet)
            and previously rendered nothing in that state -- on a slow
            connection this looked identical to the blank-screen failure mode
            reported in production. An explicit loading row makes the
            "still checking" and "actually broken" states visually distinct. */}
        {isRecruiter === null && !statusError && (
          <div style={cardStyle} data-testid="representatives-loading">
            <p style={mutedTextStyle}>Loading...</p>
          </div>
        )}

        {isRecruiter === false && (
          <div style={cardStyle}>
            <p style={{ ...ventsTypography.bodySecondary, color: ventsColors.ink1, marginTop: 0 }}>
              Become a VENTS Representative to invite organizers and service providers into a partnership. You earn VENTS&apos; full commission on revenue from events belonging to the organizer you recruit — fixed, not negotiated.
            </p>
            <button
              onClick={handleRegister}
              disabled={registering}
              style={{ ...primaryButtonStyle, opacity: registering ? 0.6 : 1 }}
            >
              {registering ? 'Registering...' : 'Become a Representative'}
            </button>
            {registerError && <p role="alert" style={{ ...errorTextStyle, marginTop: ventsSpacing.unit[2] }}>{registerError}</p>}
          </div>
        )}

        <nav
          style={{
            display: 'flex',
            gap: ventsSpacing.unit[1],
            background: ventsColors.surface,
            border: `1px solid ${ventsColors.border}`,
            borderRadius: ventsRadii.md,
            padding: 4,
            marginBottom: ventsSpacing.unit[3],
          }}
        >
          {([
            { id: 'find' as const, label: 'Find', icon: <Search size={16} /> },
            { id: 'invitations' as const, label: 'Invitations', icon: <UserPlus size={16} /> },
            { id: 'team' as const, label: 'My Team', icon: <Users size={16} /> },
          ]).map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: 1,
                minHeight: ventsSpacing.minTouchTarget,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                border: 'none',
                borderRadius: ventsRadii.sm,
                background: tab === t.id ? ventsColors.accent : 'transparent',
                color: tab === t.id ? ventsColors.white : ventsColors.ink2,
                fontFamily: ventsTypography.fontBody,
                ...ventsTypography.caption,
                fontWeight: tab === t.id ? 800 : 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </nav>

        {tab === 'find' && (
          <div>
            <input
              placeholder="Search by VENTS username"
              value={query}
              onChange={(e) => void handleSearch(e.target.value)}
              style={{ ...inputStyle, marginBottom: ventsSpacing.unit[3] }}
            />
            {results.map((r) => (
              <div
                key={r.id}
                data-testid="search-result"
                style={{
                  ...cardStyle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: ventsSpacing.unit[2],
                }}
              >
                <span
                  style={{
                    ...ventsTypography.body,
                    color: ventsColors.ink1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {r.username || r.fullName}
                </span>
                <button onClick={() => setInviteTarget(r)} style={{ ...secondaryButtonStyle, flexShrink: 0 }}>
                  Invite
                </button>
              </div>
            ))}
            {inviteTarget && (
              <div data-testid="invite-form" style={{ ...cardStyle, background: ventsColors.elevated }}>
                <p style={{ ...ventsTypography.bodySecondary, color: ventsColors.ink1, marginTop: 0 }}>
                  Inviting <strong style={{ color: ventsColors.ink1 }}>{inviteTarget.username || inviteTarget.fullName}</strong>
                </p>
                {resolvingTarget && <p style={mutedTextStyle}>Checking organizer/provider status...</p>}
                {!resolvingTarget && targetRole === 'neither' && (
                  <p role="alert" data-testid="invite-ineligible" style={errorTextStyle}>
                    This user is not an organizer or a registered service provider, so they cannot be invited.
                  </p>
                )}
                {!resolvingTarget && targetRole && targetRole !== 'neither' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: ventsSpacing.unit[3] }}>
                    <p style={{ ...ventsTypography.label, color: ventsColors.ink2, margin: 0 }}>
                      You will earn VENTS&apos; full commission on revenue from this organizer&apos;s events. This is fixed and not negotiable.
                    </p>
                    <button
                      onClick={handleSendInvite}
                      disabled={inviteBusy}
                      style={{ ...primaryButtonStyle, opacity: inviteBusy ? 0.6 : 1 }}
                    >
                      {inviteBusy ? 'Sending...' : 'Send Invitation'}
                    </button>
                  </div>
                )}
                {inviteError && <p role="alert" style={{ ...errorTextStyle, marginTop: ventsSpacing.unit[2] }}>{inviteError}</p>}
              </div>
            )}
            {inviteSent && (
              <p style={{ ...mutedTextStyle, color: ventsColors.success }}>
                Invitation sent — it becomes an official partnership only once accepted.
              </p>
            )}
          </div>
        )}

        {actionError && (
          <p role="alert" style={{ ...errorTextStyle, marginBottom: ventsSpacing.unit[2] }}>{actionError}</p>
        )}

        {tab === 'invitations' && (
          <div data-testid="invitations-list">
            {loadingLists && <p style={mutedTextStyle}>Loading...</p>}
            {listsError && <p role="alert" style={errorTextStyle}>{listsError}</p>}
            {incoming.map((p) => {
              const badge = statusBadge(p.status);
              const busy = busyIds.has(p.id);
              return (
                <div key={p.id} data-testid="invitation-row" style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: ventsSpacing.unit[2], marginBottom: ventsSpacing.unit[2], flexWrap: 'wrap' }}>
                    <span
                      style={{
                        ...ventsTypography.label,
                        background: badge.bg,
                        color: badge.fg,
                        borderRadius: ventsRadii.pill,
                        padding: '4px 10px',
                      }}
                    >
                      {badge.label}
                    </span>
                    <span style={{ ...ventsTypography.bodySecondary, color: ventsColors.ink1 }}>
                      Partnership request · full VENTS commission
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: ventsSpacing.unit[2] }}>
                    <button
                      onClick={() => handleRespond(p.id, true)}
                      disabled={busy}
                      style={{ ...primaryButtonStyle, flex: 1, opacity: busy ? 0.6 : 1 }}
                    >
                      {busy ? 'Working...' : 'Accept'}
                    </button>
                    <button
                      onClick={() => handleRespond(p.id, false)}
                      disabled={busy}
                      style={{ ...secondaryButtonStyle, flex: 1, opacity: busy ? 0.6 : 1 }}
                    >
                      {busy ? 'Working...' : 'Decline'}
                    </button>
                  </div>
                </div>
              );
            })}
            {!loadingLists && incoming.length === 0 && <p style={mutedTextStyle}>No pending invitations.</p>}
          </div>
        )}

        {tab === 'team' && (
          <div data-testid="team-list">
            {loadingLists && <p style={mutedTextStyle}>Loading...</p>}
            {listsError && <p role="alert" style={errorTextStyle}>{listsError}</p>}
            {team.map((p) => {
              const badge = statusBadge(p.status);
              const busy = busyIds.has(p.id);
              return (
                <div key={p.id} data-testid="team-row" style={cardStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: ventsSpacing.unit[2], marginBottom: ventsSpacing.unit[2], flexWrap: 'wrap' }}>
                    <span
                      style={{
                        ...ventsTypography.label,
                        background: badge.bg,
                        color: badge.fg,
                        borderRadius: ventsRadii.pill,
                        padding: '4px 10px',
                      }}
                    >
                      {badge.label}
                    </span>
                    <span style={{ ...ventsTypography.bodySecondary, color: ventsColors.ink1 }}>
                      Full VENTS commission
                    </span>
                  </div>
                  {p.status === 'pending' && (
                    <button
                      onClick={() => handleWithdraw(p.id)}
                      disabled={busy}
                      style={{ ...secondaryButtonStyle, width: '100%', opacity: busy ? 0.6 : 1 }}
                    >
                      {busy ? 'Working...' : 'Withdraw'}
                    </button>
                  )}
                  {p.status === 'accepted' && (
                    <button
                      onClick={() => handleRevoke(p.id)}
                      disabled={busy}
                      style={{ ...secondaryButtonStyle, width: '100%', opacity: busy ? 0.6 : 1 }}
                    >
                      {busy ? 'Working...' : 'End Partnership'}
                    </button>
                  )}
                </div>
              );
            })}
            {!loadingLists && team.length === 0 && <p style={mutedTextStyle}>You have no partnerships yet.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
