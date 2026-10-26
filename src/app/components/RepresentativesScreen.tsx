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

  const [incoming, setIncoming] = useState<Partnership[]>([]);
  const [team, setTeam] = useState<Partnership[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [listsError, setListsError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
    const { data, error } = await supabase.from('recruiters').select('id').eq('id', currentUser.id).maybeSingle();
    if (error) {
      setStatusError(error.message);
      setIsRecruiter(null);
      return;
    }
    setIsRecruiter(!!data);
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
    const bps = Math.round(splitPercent * 100);
    if (bps < 0 || bps > 1000) {
      setInviteError('Commission split must be between 0% and 10%.');
      return;
    }
    setInviteBusy(true);
    setInviteError(null);
    // The invite call itself determines whether the target is an organizer
    // or a service provider; the backend rejects an invalid target.
    const { error } = await supabase.rpc('invite_recruiter_partnership', {
      p_organizer_id: inviteTarget.id,
      p_provider_id: null,
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

  async function handleRespond(id: string, accept: boolean) {
    setActionError(null);
    const { error } = await supabase.rpc('respond_to_recruiter_invitation', { p_partnership_id: id, p_accept: accept });
    if (error) {
      setActionError(error.message);
      return;
    }
    void loadPartnerships();
  }

  async function handleWithdraw(id: string) {
    setActionError(null);
    const { error } = await supabase.rpc('withdraw_recruiter_invitation', { p_partnership_id: id });
    if (error) {
      setActionError(error.message);
      return;
    }
    void loadPartnerships();
  }

  async function handleRevoke(id: string) {
    setActionError(null);
    const { error } = await supabase.rpc('revoke_recruiter_partnership', { p_partnership_id: id });
    if (error) {
      setActionError(error.message);
      return;
    }
    void loadPartnerships();
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
              <button onClick={() => handleRespond(p.id, true)}>Accept</button>
              <button onClick={() => handleRespond(p.id, false)}>Decline</button>
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
              {p.status === 'pending' && <button onClick={() => handleWithdraw(p.id)}>Withdraw</button>}
              {p.status === 'accepted' && <button onClick={() => handleRevoke(p.id)}>End Partnership</button>}
            </div>
          ))}
          {!loadingLists && team.length === 0 && <p>You have no partnerships yet.</p>}
        </div>
      )}
    </div>
  );
}
