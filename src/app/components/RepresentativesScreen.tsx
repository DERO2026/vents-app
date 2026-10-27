import { useEffect, useState } from 'react';
import { ArrowLeft, UserPlus, Users, Search } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { searchUsers, UserSearchResult } from '../../lib/userSearch';

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
  const [splitPercent, setSplitPercent] = useState(5);
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

  async function handleSendInvite() {
    if (!inviteTarget) return;
    if (targetRole === 'neither' || targetRole === null) {
      setInviteError('This user is not an organizer or a service provider.');
      return;
    }
    const bps = Math.round(splitPercent * 100);
    if (bps < 0 || bps > 1000) {
      setInviteError('Commission split must be between 0% and 10%.');
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
      p_commission_split_bps: bps,
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

  return (
    <div data-testid="representatives-screen" style={{ minHeight: '100vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 16 }}>
        <button onClick={onBack} aria-label="Back"><ArrowLeft /></button>
        <h1>Representatives</h1>
      </header>

      {statusError && (
        <div style={{ padding: 16 }}>
          <p role="alert">Could not check Representative status: {statusError}</p>
        </div>
      )}

      {/* isRecruiter starts null (checkRecruiterStatus hasn't resolved yet)
          and previously rendered nothing in that state -- on a slow
          connection this looked identical to the blank-screen failure mode
          reported in production. An explicit loading row makes the
          "still checking" and "actually broken" states visually distinct. */}
      {isRecruiter === null && !statusError && (
        <div style={{ padding: 16 }} data-testid="representatives-loading">
          <p>Loading...</p>
        </div>
      )}

      {isRecruiter === false && (
        <div style={{ padding: 16 }}>
          <p>Become a VENTS Representative to invite organizers and service providers into a partnership.</p>
          <button onClick={handleRegister} disabled={registering}>
            {registering ? 'Registering...' : 'Become a Representative'}
          </button>
          {registerError && <p role="alert">{registerError}</p>}
        </div>
      )}

      <nav style={{ display: 'flex', gap: 8, padding: '0 16px' }}>
        <button role="tab" aria-selected={tab === 'find'} onClick={() => setTab('find')}><Search size={16} /> Find</button>
        <button role="tab" aria-selected={tab === 'invitations'} onClick={() => setTab('invitations')}><UserPlus size={16} /> Invitations</button>
        <button role="tab" aria-selected={tab === 'team'} onClick={() => setTab('team')}><Users size={16} /> My Team</button>
      </nav>

      {tab === 'find' && (
        <div style={{ padding: 16 }}>
          <input
            placeholder="Search by VENTS username"
            value={query}
            onChange={(e) => void handleSearch(e.target.value)}
          />
          {results.map((r) => (
            <div key={r.id} data-testid="search-result" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{r.username || r.fullName}</span>
              <button onClick={() => setInviteTarget(r)}>Invite</button>
            </div>
          ))}
          {inviteTarget && (
            <div data-testid="invite-form">
              <p>Inviting {inviteTarget.username || inviteTarget.fullName}</p>
              {resolvingTarget && <p>Checking organizer/provider status...</p>}
              {!resolvingTarget && targetRole === 'neither' && (
                <p role="alert" data-testid="invite-ineligible">
                  This user is not an organizer or a registered service provider, so they cannot be invited.
                </p>
              )}
              {!resolvingTarget && targetRole && targetRole !== 'neither' && (
                <>
                  <label>
                    Agreed commission split (%)
                    <input
                      type="number"
                      min={0}
                      max={10}
                      step={0.5}
                      value={splitPercent}
                      onChange={(e) => setSplitPercent(Number(e.target.value))}
                    />
                  </label>
                  <button onClick={handleSendInvite} disabled={inviteBusy}>
                    {inviteBusy ? 'Sending...' : 'Send Invitation'}
                  </button>
                </>
              )}
              {inviteError && <p role="alert">{inviteError}</p>}
            </div>
          )}
          {inviteSent && <p>Invitation sent — it becomes an official partnership only once accepted.</p>}
        </div>
      )}

      {actionError && <p role="alert">{actionError}</p>}

      {tab === 'invitations' && (
        <div style={{ padding: 16 }} data-testid="invitations-list">
          {loadingLists && <p>Loading...</p>}
          {listsError && <p role="alert">{listsError}</p>}
          {incoming.map((p) => (
            <div key={p.id} data-testid="invitation-row">
              <span>Partnership request · agreed split {(p.commission_split_bps / 100).toFixed(1)}%</span>
              <button onClick={() => handleRespond(p.id, true)} disabled={busyIds.has(p.id)}>
                {busyIds.has(p.id) ? 'Working...' : 'Accept'}
              </button>
              <button onClick={() => handleRespond(p.id, false)} disabled={busyIds.has(p.id)}>
                {busyIds.has(p.id) ? 'Working...' : 'Decline'}
              </button>
            </div>
          ))}
          {!loadingLists && incoming.length === 0 && <p>No pending invitations.</p>}
        </div>
      )}

      {tab === 'team' && (
        <div style={{ padding: 16 }} data-testid="team-list">
          {loadingLists && <p>Loading...</p>}
          {listsError && <p role="alert">{listsError}</p>}
          {team.map((p) => (
            <div key={p.id} data-testid="team-row">
              <span>Status: {p.status} · agreed split {(p.commission_split_bps / 100).toFixed(1)}%</span>
              {p.status === 'pending' && (
                <button onClick={() => handleWithdraw(p.id)} disabled={busyIds.has(p.id)}>
                  {busyIds.has(p.id) ? 'Working...' : 'Withdraw'}
                </button>
              )}
              {p.status === 'accepted' && (
                <button onClick={() => handleRevoke(p.id)} disabled={busyIds.has(p.id)}>
                  {busyIds.has(p.id) ? 'Working...' : 'End Partnership'}
                </button>
              )}
            </div>
          ))}
          {!loadingLists && team.length === 0 && <p>You have no partnerships yet.</p>}
        </div>
      )}
    </div>
  );
}
