import { useState, useEffect, useRef } from 'react';
import BadgeChip from './BadgeChip';
import {
  Settings,
  Bell,
  Heart,
  Ticket,
  ChevronRight,
  Star,
  Shield,
  MapPin,
  Users,
  BadgeCheck,
  ShieldCheck,
  Gift,
  Camera,
  Wallet,
  Briefcase,
} from 'lucide-react';
import { Sentry } from '../../lib/sentry';
import { PurchasedTicket } from './types';
import { formatPrice } from './data';
import { supabase, getAuthToken } from '../../lib/supabase';
import { getVcBalance } from '../../lib/vcBalanceCache';
import { COUNTRY_CODES } from '../../lib/countries';
import { AppVersionFooter } from './shared/AppVersionFooter';
import { CACVerificationScreen } from './SettingsScreen';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

interface ProfileScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string; avatar_url?: string; cover_url?: string; hasBeenOrganizer?: boolean; vc_badge?: string; is_verified?: boolean; state?: string; is_service_provider?: boolean; country?: string } | null;
  onSignOut: () => void;
  tickets: PurchasedTicket[];
  savedCount: number;
  onViewTicket: (ticket: PurchasedTicket) => void;
  onNavigate: (screen: string) => void;
  setActiveView: (view: 'attendee' | 'organizer') => void;
  onBecomeOrganizer?: () => void;
  userRole?: 'attendee' | 'organizer';
  unreadNotificationsCount?: number;
  // Bumped by App.tsx whenever the Profile tab is tapped while already
  // active (the same "tap active tab to refresh" gesture Home already
  // has) -- re-triggers the existing stats/hasProviderProfile fetch
  // effects below via profileRefreshKey, rather than adding new fetch
  // logic. A plain number (not a boolean) so repeated taps each still
  // register as a change.
  refreshSignal?: number;
}

export function ProfileScreen({
  currentUser,
  onSignOut,
  tickets,
  savedCount,
  onViewTicket,
  onNavigate,
  setActiveView,
  onBecomeOrganizer,
  userRole,
  unreadNotificationsCount = 0,
  refreshSignal,
}: ProfileScreenProps) {
  const [eventsCreated, setEventsCreated] = useState(0);
  const [attendees, setAttendees] = useState(0);
  const [profileRefreshKey, setProfileRefreshKey] = useState(0);
  useEffect(() => {
    if (refreshSignal) setProfileRefreshKey((k) => k + 1);
  }, [refreshSignal]);
  const [showOrgRequestModal, setShowOrgRequestModal] = useState(false);
  const [showCacVerify, setShowCacVerify] = useState(false);
  const [orgRequestReason, setOrgRequestReason] = useState('');
  // Tracks the actual DB state machine (pending/rejected/approved) instead
  // of squashing pending+approved into one 'already'/'sent' bucket -- same
  // fix pattern applied to the Service Provider flow above (see
  // spRequestStatus): a squashed status can't tell "nothing to do yet" from
  // "approved, should already have organizer access", and 'approved' here
  // is also trusted directly (isOrganizerEffective below) instead of
  // waiting on App.tsx's separate 15s role-sync poll to flip
  // currentUser.role -- closing the same race that could show/hide the
  // wrong section for a few seconds right after admin approval.
  const [orgRequestStatus, setOrgRequestStatus] = useState<'idle' | 'sending' | 'pending' | 'rejected' | 'approved'>('idle');
  const [orgRequestAdminNote, setOrgRequestAdminNote] = useState<string | null>(null);
  const [orgRequestError, setOrgRequestError] = useState('');
  const [hasOrgDraft, setHasOrgDraft] = useState(false);
  const [vcBalance, setVcBalance] = useState<number | null>(null);

  // Service Provider request — same pattern as the Organizer request above,
  // deliberately a separate independent state block (not shared) so an
  // existing Organizer can also request this capability, and so this can
  // evolve independently of the Organizer flow without risk to it.
  // ROOT CAUSE of the "approved application shows a dead 'Application
  // Submitted' button" bug: this used to collapse every non-rejected
  // status (both 'pending' AND 'approved') into a single 'already' bucket,
  // which the CTA below both disabled AND made unclickable (`if
  // (spRequestStatus === 'already') return;`) -- so an approved applicant
  // saw the exact same greyed-out, do-nothing button as someone still
  // pending review, with no way to open the application or continue into
  // setup until currentUser.is_service_provider happened to sync from its
  // separate 15s poll (App.tsx's syncRole effect) or a full reload. Now
  // tracks the actual DB status so 'approved' can be handled as its own
  // state instead of being indistinguishable from 'pending'.
  const [spRequestStatus, setSpRequestStatus] = useState<'idle' | 'pending' | 'approved'>('idle');

  useEffect(() => {
    if (!currentUser?.id) { setVcBalance(null); return; }
    getVcBalance(currentUser.id).then((result) => setVcBalance(result?.spendable ?? null));
  }, [currentUser?.id]);

  // Draft persistence for the organizer-onboarding textarea — if the user
  // closes the modal or navigates away before hitting "Submit Request", the
  // in-progress text survives (per-user key so it doesn't leak across
  // accounts on a shared device). Nothing is ever written to the database
  // until the explicit submit click.
  const orgDraftKey = currentUser?.id ? `vents_org_request_draft_${currentUser.id}` : null;

  useEffect(() => {
    if (!orgDraftKey) return;
    try {
      const saved = localStorage.getItem(orgDraftKey);
      if (saved) {
        setOrgRequestReason(saved);
        setHasOrgDraft(true);
      }
    } catch { /* ignore */ }
  }, [orgDraftKey]);

  const handleOrgReasonChange = (value: string) => {
    setOrgRequestReason(value);
    if (!orgDraftKey) return;
    try {
      if (value.trim()) {
        localStorage.setItem(orgDraftKey, value);
        setHasOrgDraft(true);
      } else {
        localStorage.removeItem(orgDraftKey);
        setHasOrgDraft(false);
      }
    } catch { /* ignore */ }
  };

  const [coverLoadFailed, setCoverLoadFailed] = useState(false);
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);
  const [freshCoverUrl, setFreshCoverUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    setCoverLoadFailed(false);
  }, [currentUser?.cover_url]);

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [currentUser?.avatar_url]);

  // currentUser.cover_url is now populated immediately at login/signup (see
  // AuthScreen.tsx), so this DB round-trip is only needed as a fallback for
  // the rare case where the prop is genuinely missing — not on every single
  // mount of this screen (it fully unmounts/remounts per tab visit), which
  // was the actual source of the visible cover-photo-rendering delay: the
  // prop already renders instantly, this fetch just used to run pointlessly
  // in the background on top of it every time.
  useEffect(() => {
    if (!currentUser?.id || currentUser?.cover_url) return;
    (async () => {
      try {
        await getAuthToken();
        const { data } = await supabase
          .from('users')
          .select('cover_url')
          .eq('id', currentUser.id)
          .maybeSingle();
        if (data?.cover_url) setFreshCoverUrl(data.cover_url);
      } catch { /* fall back silently to the prop value */ }
    })();
  }, [currentUser?.id, currentUser?.cover_url]);

  const effectiveCoverUrl = freshCoverUrl ?? currentUser?.cover_url;

  // Pull-to-refresh
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const pullStartY = useRef<number | null>(null);
  const handlePullTouchStart = (e: React.TouchEvent) => {
    pullStartY.current = e.touches[0].clientY;
  };
  const handlePullTouchEnd = async (e: React.TouchEvent) => {
    if (pullStartY.current === null) return;
    const dy = e.changedTouches[0].clientY - pullStartY.current;
    pullStartY.current = null;
    if (dy > 400 && !pullRefreshing) {
      setPullRefreshing(true);
      try { setProfileRefreshKey(r => r + 1); } finally { setPullRefreshing(false); }
    }
  };

  useEffect(() => {
    async function fetchStats() {
      if (!currentUser?.id) return;
      try {
        // 1. Events created count
        const { count: eCount } = await supabase
          .from('events')
          .select('id', { count: 'exact', head: true })
          .eq('organizer_id', currentUser.id)
          .is('deleted_at', null);
        setEventsCreated(eCount || 0);

        // 2. Attendees count (sum of active tickets sold for their created events)
        const { data: userEvents } = await supabase
          .from('events')
          .select('id')
          .eq('organizer_id', currentUser.id)
          .is('deleted_at', null);

        if (userEvents && userEvents.length > 0) {
          const eventIds = userEvents.map((e: any) => e.id);
          const { count: tCount } = await supabase
            .from('tickets')
            .select('id', { count: 'exact', head: true })
            .in('event_id', eventIds)
            .eq('status', 'active');
          setAttendees(tCount || 0);
        } else {
          setAttendees(0);
        }
      } catch (err) {
        console.error("Failed to fetch profile stats:", err);
        Sentry.captureException(err);
      }
    }
    fetchStats();
  }, [currentUser?.id, profileRefreshKey]);

  useEffect(() => {
    async function checkOrgRequest() {
      if (!currentUser?.id) return;
      const { data } = await supabase
        .from('organizer_requests')
        .select('status, admin_note')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        setOrgRequestStatus(data.status === 'approved' ? 'approved' : data.status === 'rejected' ? 'rejected' : 'pending');
        setOrgRequestAdminNote(data.admin_note ?? null);
      }
    }
    checkOrgRequest();
  }, [currentUser?.id]);

  const submitOrgRequest = async () => {
    if (!currentUser?.id || orgRequestStatus === 'sending') return;
    setOrgRequestStatus('sending');
    setOrgRequestError('');
    try {
      const { error } = await supabase
        .from('organizer_requests')
        .insert([{ user_id: currentUser.id, reason: orgRequestReason.trim() || null }]);
      if (error) throw error;
      if (orgDraftKey) { try { localStorage.removeItem(orgDraftKey); } catch { /* ignore */ } }
      setHasOrgDraft(false);
      setOrgRequestAdminNote(null);
      setOrgRequestStatus('pending');
      setShowOrgRequestModal(false);
    } catch (err: any) {
      // A duplicate-submit race (e.g. two tabs) hits the DB's own
      // organizer_requests_one_pending_per_user guard -- treat that as
      // "you already have one pending", not a generic failure back to idle.
      if (err?.code === '23505') {
        setOrgRequestStatus('pending');
        setShowOrgRequestModal(false);
        return;
      }
      setOrgRequestError(err?.message || 'Failed to submit request.');
      setOrgRequestStatus('idle');
    }
  };

  useEffect(() => {
    async function checkSpRequest() {
      if (!currentUser?.id) return;
      const { data } = await supabase
        .from('service_provider_requests')
        .select('status')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) setSpRequestStatus(data.status === 'rejected' ? 'idle' : data.status === 'approved' ? 'approved' : 'pending');
    }
    checkSpRequest();
  }, [currentUser?.id]);

  // Stage 3: does the capability holder already have a service_providers
  // listing? Drives the "Set Up Your Service Profile" vs "Edit Service
  // Profile" label -- independent of the capability-request status above
  // (spRequestStatus governs the request card, hasProviderProfile governs
  // the setup/edit card that only appears once the capability is granted).
  // Admin/Sub-Admin must have full access to Services -- same admin reach
  // as every other admin-managed section -- without being blocked by the
  // normal provider onboarding/KYC gate. Privileged writes still go through
  // RLS's own is_admin() policies server-side (0045_service_provider_admin_
  // access.sql); this only decides what the Profile UI offers them.
  const isAdminOrSubAdminForServices = currentUser?.role === 'admin' || currentUser?.role === 'sub-admin' || currentUser?.id === ROOT_UID;
  // Also trust spRequestStatus === 'approved' directly, not just the
  // currentUser.is_service_provider flag -- that flag is only refreshed by
  // App.tsx's 15s syncRole poll, so relying on it alone left a real (if
  // short-lived) window right after admin approval where this screen's own
  // service_provider_requests fetch already knows the applicant is
  // approved, but the CTA below hadn't caught up yet and still rendered as
  // a dead, disabled "Application Submitted" button.
  const canAccessProviderSetup = currentUser?.is_service_provider === true || isAdminOrSubAdminForServices || spRequestStatus === 'approved';

  const [hasProviderProfile, setHasProviderProfile] = useState<boolean | null>(null);
  useEffect(() => {
    if (!currentUser?.id || !canAccessProviderSetup) { setHasProviderProfile(null); return; }
    let cancelled = false;
    Promise.resolve(
      supabase
        .from('service_providers')
        .select('id')
        .eq('user_id', currentUser.id)
        .maybeSingle()
    )
      .then(({ data }: any) => { if (!cancelled) setHasProviderProfile(!!data); })
      .catch(() => { if (!cancelled) setHasProviderProfile(false); });
    return () => { cancelled = true; };
  }, [currentUser?.id, canAccessProviderSetup, profileRefreshKey]);

  if (!currentUser) {
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '24px', color: '#94A3B8', fontFamily: 'Inter, sans-serif', textAlign: 'center' }}>
        <div style={{ fontSize: '20px', fontWeight: 700, color: '#FFFFFF' }}>Sign in to view your profile</div>
        <div style={{ fontSize: '14px', color: '#94A3B8', maxWidth: '280px' }}>Create an account or sign in to manage tickets, follow organizers, and more.</div>
        <button
          onClick={() => onNavigate('auth')}
          style={{
            marginTop: '8px',
            width: '100%',
            maxWidth: '280px',
            height: '52px',
            padding: '0 28px',
            background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            border: 'none',
            borderRadius: '100px',
            color: '#fff',
            fontSize: '15px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: 'pointer',
            boxShadow: '0 8px 24px rgba(123,47,190,0.35)',
          }}
        >
          Sign In / Create Account
        </button>
      </div>
    );
  }

  const menuItems = [
    {
      icon: Bell,
      label: 'Notifications',
      sublabel: 'Manage alerts',
      color: '#F59E0B',
      screen: 'notifications',
      badge: unreadNotificationsCount > 0 ? unreadNotificationsCount : undefined,
    },
    {
      icon: Heart,
      label: 'Saved Events',
      sublabel: `${savedCount} saved`,
      color: '#EC4899',
      screen: 'saved',
    },
    {
      icon: Gift,
      label: 'Vents Cents',
      sublabel: 'Earn Vents Cents',
      color: '#FFB830',
      screen: 'referral',
    },
    {
      icon: Settings,
      label: 'Settings',
      sublabel: 'Account & preferences',
      color: '#22C55E',
      screen: 'settings',
    },
  ];

  const initial = (currentUser?.full_name || currentUser?.email || 'A').trim().charAt(0).toUpperCase();
  const displayName = currentUser?.full_name || currentUser?.email || 'Guest User';
  const isOrganizer = currentUser?.role === 'organizer' || currentUser?.role === 'organiser';
  const isAdmin = currentUser?.role === 'admin' || currentUser?.id === ROOT_UID;
  const isSubAdmin = currentUser?.role === 'sub-admin';
  // Trusts an 'approved' organizer_requests row immediately, rather than
  // only currentUser.role -- which is only refreshed by App.tsx's 15s
  // syncRole poll -- so approval doesn't leave a stale window where this
  // screen still renders the application CTA. Independent of, and does not
  // replace, isOrganizer: roleLabel/badge/menu filtering below intentionally
  // keep using the role-derived isOrganizer since those reflect the actual
  // account role, while capability GATING (below) uses this.
  const isOrganizerEffective = isOrganizer || orgRequestStatus === 'approved';
  const isVerified = currentUser?.is_verified === true || currentUser?.id === ROOT_UID;
  const roleLabel = isOrganizer ? 'Organizer' : isAdmin ? 'Admin' : isSubAdmin ? 'Sub-Admin' : 'Attendee';
  
  const filteredMenuItems = menuItems.filter(item => {
    if (isOrganizer) {
      return item.screen !== 'my-tickets' && item.screen !== 'saved';
    }
    return true;
  });

  const badgeGradient = isOrganizer
    ? 'linear-gradient(135deg, #C084FC, #7C3AED)'
    : isAdmin
    ? 'linear-gradient(135deg, #F87171, #EF4444)'
    : 'linear-gradient(135deg, #FFB830, #F59E0B)';

  const badgeTextColor = isAdmin ? '#fff' : '#000';
  const starColor = isAdmin ? '#fff' : '#000';

  // Get Verified as an Organizer (CAC submission) -- moved here from
  // Settings so both organizer-related capability entry points
  // (Become an Organizer / Get Verified as an Organizer) live in one place,
  // directly below Become a Service Provider.
  if (showCacVerify) {
    return (
      <CACVerificationScreen
        currentUser={currentUser}
        onBack={() => setShowCacVerify(false)}
        onContactSupport={() => { setShowCacVerify(false); onNavigate('help-support'); }}
      />
    );
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: 'radial-gradient(ellipse 600px 400px at 30% -5%, rgba(123,47,190,0.13) 0%, rgba(5,0,16,1) 45%, #020005 100%)', position: 'relative' }}
      onTouchStart={handlePullTouchStart}
      onTouchEnd={handlePullTouchEnd}
    >
      {pullRefreshing && (
        <div style={{
          position: 'fixed', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)', zIndex: 200,
        }}>
          <div style={{
            width: '40px', height: '40px', borderRadius: '50%',
            border: '3px solid rgba(123,47,247,0.2)',
            borderTop: '3px solid #7B2FF7',
            animation: 'spin 0.8s linear infinite',
          }} />
        </div>
      )}
      {/* Header */}
      <div
        className="flex items-center justify-center px-4 pb-3"
        style={{ paddingTop: 'calc(20px + env(safe-area-inset-top))' }}
      >
        <h1
          style={{
            color: '#F0F0FF',
            fontSize: '20px',
            fontWeight: 800,
            fontFamily: 'Space Grotesk, sans-serif',
          }}
        >
          Profile
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none', paddingBottom: 'calc(110px + env(safe-area-inset-bottom))' }}>
        {/* Profile card */}
        <div className="px-4 mb-4">
          <div
            className="p-5"
            style={{
              background: 'linear-gradient(135deg, rgba(123,47,190,0.16), rgba(79,70,229,0.1))',
              backdropFilter: 'blur(20px) saturate(160%)',
              WebkitBackdropFilter: 'blur(20px) saturate(160%)',
              borderRadius: '22px',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 10px 26px rgba(0,0,0,0.28)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {(!effectiveCoverUrl || coverLoadFailed) && (
              <div
                style={{
                  position: 'absolute',
                  top: '-40px',
                  right: '-40px',
                  width: '160px',
                  height: '160px',
                  background: 'radial-gradient(circle, rgba(123,47,190,0.25) 0%, transparent 70%)',
                  borderRadius: '50%',
                  pointerEvents: 'none',
                }}
              />
            )}

            {effectiveCoverUrl && !coverLoadFailed && (
              <div style={{ margin: '-20px -20px 16px', borderRadius: '20px 20px 0 0', overflow: 'hidden', height: '100px', position: 'relative' }}>
                <img src={effectiveCoverUrl} alt="cover" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={() => setCoverLoadFailed(true)} />
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(6,10,18,0) 50%, rgba(26,13,46,0.85) 100%)' }} />
              </div>
            )}

            <div className="flex items-center gap-4 mb-4">
              <button
                onClick={() => onNavigate('settings')}
                style={{ position: 'relative', padding: 0, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                aria-label="Change profile photo"
              >
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center overflow-hidden"
                  style={{
                    background: 'linear-gradient(135deg, #7B2FBE 0%, #5B3FCB 100%)',
                    boxShadow: '0 6px 18px rgba(0,0,0,0.3)',
                    border: '2px solid rgba(255,255,255,0.14)',
                    boxSizing: 'border-box',
                  }}
                >
                  {currentUser?.avatar_url && !avatarLoadFailed ? (
                    <img
                      src={currentUser.avatar_url}
                      alt="Avatar"
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={() => setAvatarLoadFailed(true)}
                    />
                  ) : (
                    <span style={{ color: '#fff', fontSize: '26px', fontWeight: 700 }}>{initial}</span>
                  )}
                </div>
                <div style={{
                  position: 'absolute', bottom: -4, right: -4,
                  background: '#7B2FBE', borderRadius: '50%', width: '22px', height: '22px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '2px solid #020005',
                }}>
                  <Camera size={11} color="#fff" />
                </div>
              </button>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <h2
                    style={{
                      color: '#FFFFFF',
                      fontSize: '20px',
                      fontWeight: 700,
                      fontFamily: 'Space Grotesk, sans-serif',
                      margin: 0,
                    }}
                  >
                    {displayName}
                  </h2>
                  {isVerified && (
                    <span title="Verified" style={{ display: 'inline-flex' }}>
                      <BadgeCheck size={16} color="#3B82F6" style={{ filter: 'drop-shadow(0 0 6px rgba(59,130,246,0.6))' }} />
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <MapPin size={12} color="#8B8FA8" />
                  {currentUser?.state ? (
                    <span style={{ color: '#8B8FA8', fontSize: '12px' }}>
                      {currentUser.state}
                      {(() => {
                        // Unset (legacy pre-country-column accounts) falls
                        // back to Nigeria -- accurate historical default,
                        // same reasoning as ProfileDetailsScreen's
                        // isNigeriaAccount. Previously this was a bare
                        // hardcoded ", Nigeria" regardless of the account's
                        // actual country.
                        const iso = currentUser.country || 'NG';
                        const name = COUNTRY_CODES.find((c) => c.iso === iso)?.name;
                        return name ? `, ${name}` : '';
                      })()}
                    </span>
                  ) : (
                    <button
                      onClick={() => onNavigate('settings')}
                      style={{ background: 'none', border: 'none', padding: 0, color: '#A78BFA', fontSize: '12px', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
                    >
                      Add your state
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1 mt-1" style={{ flexWrap: 'wrap', gap: '6px' }}>
                  <div
                    style={{
                      background: badgeGradient,
                      borderRadius: '5px',
                      padding: '2px 7px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '3px',
                    }}
                  >
                    <Star size={10} color={starColor} fill={starColor} />
                    <span style={{ color: badgeTextColor, fontSize: '10px', fontWeight: 700 }}>
                      {roleLabel}
                    </span>
                  </div>
                  <BadgeChip tier={currentUser?.vc_badge} />
                  {vcBalance !== null && (
                    <div
                      onClick={() => onNavigate('referral')}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate('referral'); } }}
                      role="button" tabIndex={0}
                      style={{
                        background: 'rgba(245,158,11,0.12)',
                        border: '1px solid rgba(245,158,11,0.3)',
                        borderRadius: '5px',
                        padding: '2px 7px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '3px',
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ fontSize: '10px', fontWeight: 700, color: '#F59E0B' }}>
                        ⭐ {vcBalance.toLocaleString()} VC
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Organizer/admin: switching is now via the Create tab FAB or the banner */}
          </div>
        </div>

        {/* Menu items */}
        <div className="px-4 mb-4">
          <div
            style={{
              background: 'rgba(255,255,255,0.04)',
              backdropFilter: 'blur(20px) saturate(160%)',
              WebkitBackdropFilter: 'blur(20px) saturate(160%)',
              borderRadius: '18px',
              border: '1px solid rgba(255,255,255,0.08)',
              overflow: 'hidden',
            }}
          >
            {filteredMenuItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  onClick={() => item.screen && onNavigate(item.screen)}
                  className="w-full flex items-center gap-3 p-4 text-left"
                  style={{
                    borderBottom:
                      index < filteredMenuItems.length - 1
                        ? '1px solid rgba(255,255,255,0.05)'
                        : 'none',
                    cursor: item.screen ? 'pointer' : 'default',
                  }}
                >
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(168,85,247,0.14)', border: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <Icon size={17} color="#C4B5FD" />
                  </div>
                  <div className="flex-1">
                    <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 600 }}>
                      {item.label}
                    </p>
                    <p style={{ color: '#9CA0BC', fontSize: '12px' }}>{item.sublabel}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.badge && (
                      <div
                        style={{
                          background: '#EF4444',
                          borderRadius: '50%',
                          width: '18px',
                          height: '18px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <span style={{ color: '#fff', fontSize: '10px', fontWeight: 700 }}>
                          {item.badge}
                        </span>
                      </div>
                    )}
                    <ChevronRight size={15} color="#94A3B8" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Organizer Wallet */}
        {(isOrganizerEffective || isAdmin || isSubAdmin) && (
          <div className="px-4 mb-3">
            <button
              onClick={() => onNavigate('wallet')}
              className="w-full flex items-center justify-center gap-2 p-4"
              style={{
                background: 'linear-gradient(135deg, rgba(79,70,229,0.15), rgba(168,85,247,0.1))',
                backdropFilter: 'blur(20px) saturate(160%)',
                WebkitBackdropFilter: 'blur(20px) saturate(160%)',
                borderRadius: '14px',
                border: '1px solid rgba(196,181,253,0.28)',
                cursor: 'pointer',
              }}
            >
              <Wallet size={16} color="#D8B4FE" />
              <span style={{ color: '#D8B4FE', fontSize: '14px', fontWeight: 700 }}>My Wallet</span>
            </button>
          </div>
        )}

        {/* Admin Dashboard (Admin/Sub-Admin/Root) */}
        {(isAdmin || isSubAdmin) && (
          <div className="px-4 mb-3">
            <button
              onClick={() => onNavigate('admin-dashboard')}
              className="w-full flex items-center justify-center gap-2 p-4"
              style={{
                background: 'linear-gradient(135deg, rgba(239,68,68,0.15), rgba(185,28,28,0.1))',
                backdropFilter: 'blur(20px) saturate(160%)',
                WebkitBackdropFilter: 'blur(20px) saturate(160%)',
                borderRadius: '14px',
                border: '1px solid rgba(239,68,68,0.3)',
                cursor: 'pointer',
              }}
            >
              <Shield size={16} color="#EF4444" />
              <span style={{ color: '#EF4444', fontSize: '14px', fontWeight: 700, letterSpacing: '0.02em' }}>
                Admin Dashboard
              </span>
            </button>
          </div>
        )}

        {/* Become a Service Provider — an independent capability, not a
            role. Deliberately not excluded for Organizers/Admins: this
            release's whole point is that a user can hold both the
            Organizer role and this capability on one account (see
            0033_service_provider_capability.sql). Admin/Sub-Admin skip the
            capability check entirely (canAccessProviderSetup) so they can
            always reach Services setup, matching their reach over every
            other admin-managed section -- the actual privileged write path
            still goes through is_admin() RLS server-side, never a client
            bypass alone (see 0045_service_provider_admin_access.sql). */}
        {canAccessProviderSetup ? (
          <div className="px-4 mb-3">
            <button
              onClick={() => onNavigate('service-provider-setup')}
              className="w-full flex items-center justify-center gap-2 p-4"
              style={{
                background: 'rgba(34,211,238,0.08)',
                backdropFilter: 'blur(20px) saturate(160%)',
                WebkitBackdropFilter: 'blur(20px) saturate(160%)',
                borderRadius: '14px',
                border: '1px solid rgba(34,211,238,0.25)',
                cursor: 'pointer',
              }}
            >
              <Briefcase size={16} color="#22D3EE" />
              <span style={{ color: '#22D3EE', fontSize: '14px', fontWeight: 700 }}>
                {hasProviderProfile ? 'Edit Service Profile' : 'Set Up Your Service Profile'}
              </span>
            </button>
          </div>
        ) : (
          <div className="px-4 mb-3">
            {/* Pending is the ONLY state that should read as "nothing to do
                yet" -- but it's still clickable, opening
                ServiceProviderVerificationScreen's own PendingCard, so the
                application itself is never unreachable (requirement: "the
                user cannot open the submitted application again" must not
                happen). 'idle' (never applied, or a past rejection) is a
                fresh application entry point. 'approved' never reaches this
                branch at all now -- canAccessProviderSetup above already
                covers it, sending the user straight to setup instead. */}
            <button
              onClick={() => onNavigate('service-provider-verify')}
              className="w-full flex items-center justify-center gap-2 p-4"
              style={{
                background: spRequestStatus === 'pending' ? 'rgba(34,211,238,0.04)' : 'rgba(34,211,238,0.08)',
                backdropFilter: 'blur(20px) saturate(160%)',
                WebkitBackdropFilter: 'blur(20px) saturate(160%)',
                borderRadius: '14px',
                border: `1px solid ${spRequestStatus === 'pending' ? 'rgba(34,211,238,0.15)' : 'rgba(34,211,238,0.25)'}`,
                cursor: 'pointer',
                opacity: spRequestStatus === 'pending' ? 0.7 : 1,
              }}
            >
              <Briefcase size={16} color="#22D3EE" />
              <span style={{ color: '#22D3EE', fontSize: '14px', fontWeight: 600 }}>
                {spRequestStatus === 'pending' ? 'Application Submitted' : 'Become a Service Provider'}
              </span>
            </button>
          </div>
        )}

        {/* Become an Organizer / Get Verified as an Organizer -- one
            capability lifecycle, directly below Become a Service Provider:
            not yet an organizer -> apply ("Become an Organizer" /
            "Application Submitted" / "Apply Again"); organizer but not yet
            CAC-verified -> "Get Verified as an Organizer"; verified ->
            a plain confirmation badge, nothing left to do. Gated on
            admin/sub-admin/root the same way the application CTA always
            was -- their reach doesn't route through this capability. */}
        {!isAdmin && !isSubAdmin && (
          isOrganizerEffective ? (
            isVerified ? (
              <div className="px-4 mb-3">
                <div
                  className="w-full flex items-center justify-center gap-2 p-4"
                  style={{ background: 'rgba(16,185,129,0.08)', backdropFilter: 'blur(20px) saturate(160%)', WebkitBackdropFilter: 'blur(20px) saturate(160%)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '14px' }}
                >
                  <ShieldCheck size={16} color="#10B981" />
                  <span style={{ color: '#10B981', fontSize: '14px', fontWeight: 700 }}>Verified Organizer</span>
                </div>
              </div>
            ) : (
              <div className="px-4 mb-3">
                <button
                  onClick={() => setShowCacVerify(true)}
                  className="w-full flex items-center justify-center gap-2 p-4"
                  style={{ background: 'rgba(124,58,237,0.08)', backdropFilter: 'blur(20px) saturate(160%)', WebkitBackdropFilter: 'blur(20px) saturate(160%)', borderRadius: '14px', border: '1px solid rgba(168,85,247,0.3)', cursor: 'pointer' }}
                >
                  <ShieldCheck size={16} color="#A78BFA" />
                  <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 700 }}>Get Verified as an Organizer</span>
                </button>
              </div>
            )
          ) : (
            <div className="px-4 mb-3">
              <button
                onClick={() => setShowOrgRequestModal(true)}
                className="w-full flex items-center justify-center gap-2 p-4"
                style={{
                  background: orgRequestStatus === 'pending' ? 'rgba(124,58,237,0.04)' : 'rgba(124,58,237,0.08)',
                  backdropFilter: 'blur(20px) saturate(160%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(160%)',
                  borderRadius: '14px',
                  border: `1px solid ${orgRequestStatus === 'pending' ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.25)'}`,
                  cursor: 'pointer',
                  opacity: orgRequestStatus === 'pending' ? 0.7 : 1,
                }}
              >
                <BadgeCheck size={16} color="#A78BFA" />
                <span style={{ color: '#A78BFA', fontSize: '14px', fontWeight: 600 }}>
                  {orgRequestStatus === 'pending' ? 'Application Submitted' : orgRequestStatus === 'rejected' ? 'Apply Again' : 'Become an Organizer'}
                </span>
                {orgRequestStatus === 'idle' && hasOrgDraft && (
                  <span style={{ marginLeft: '4px', fontSize: '10px', fontWeight: 700, color: '#F59E0B', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '6px', padding: '3px 7px', letterSpacing: '0.03em' }}>
                    PENDING COMPLETION
                  </span>
                )}
              </button>
            </div>
          )
        )}

        {/* Become Organizer modal -- always clickable (never a dead-end),
            per capability: idle/rejected shows the submission form,
            pending shows a read-only status view instead of hiding the
            application, so it stays reachable while under review. */}
        {showOrgRequestModal && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
            onClick={() => setShowOrgRequestModal(false)}>
            <div style={{ background: '#090514', borderRadius: '24px 24px 0 0', padding: '24px 20px 32px', width: '100%', maxWidth: '430px' }}
              onClick={(e) => e.stopPropagation()}>
              {orgRequestStatus === 'pending' ? (
                <>
                  <h3 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700, margin: '0 0 8px' }}>Application Submitted</h3>
                  <p style={{ color: '#8B8FA8', fontSize: '13px', margin: '0 0 16px', lineHeight: 1.5 }}>
                    Your organizer request is under review. Our team typically responds within 1–3 business days.
                  </p>
                  {orgRequestReason && (
                    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '12px', padding: '12px', color: '#F0F0FF', fontSize: '13px', lineHeight: 1.5 }}>
                      {orgRequestReason}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <h3 style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700, margin: '0 0 8px' }}>
                    {orgRequestStatus === 'rejected' ? 'Apply Again' : 'Become an Organizer'}
                  </h3>
                  <p style={{ color: '#8B8FA8', fontSize: '13px', margin: '0 0 16px', lineHeight: 1.5 }}>
                    Tell us briefly why you want to become an organizer. Our team will review your request within 1–3 business days.
                  </p>
                  {orgRequestStatus === 'rejected' && orgRequestAdminNote && (
                    <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '12px', padding: '12px', marginBottom: '12px' }}>
                      <p style={{ color: '#EF4444', fontSize: '12px', fontWeight: 700, margin: '0 0 4px' }}>Your previous application wasn't approved</p>
                      <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0 }}>{orgRequestAdminNote}</p>
                    </div>
                  )}
                  <textarea
                    value={orgRequestReason}
                    onChange={(e) => handleOrgReasonChange(e.target.value)}
                    placeholder="e.g. I want to host tech meetups in Lagos..."
                    rows={4}
                    style={{ width: '100%', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '12px', color: '#F0F0FF', fontSize: '14px', resize: 'none', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }}
                  />
                  {orgRequestError && <p style={{ color: '#EF4444', fontSize: '12px', marginTop: '8px' }}>{orgRequestError}</p>}
                  <button
                    onClick={submitOrgRequest}
                    disabled={orgRequestStatus === 'sending'}
                    style={{ marginTop: '16px', width: '100%', height: '48px', borderRadius: '14px', background: 'linear-gradient(135deg,#7B2FBE,#4F46E5)', border: 'none', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: orgRequestStatus === 'sending' ? 'wait' : 'pointer', opacity: orgRequestStatus === 'sending' ? 0.7 : 1 }}
                  >
                    {orgRequestStatus === 'sending' ? 'Submitting...' : 'Submit Request'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Sign Out lives only in Settings now -- a destructive account
            action showing up twice (once here, once in Settings) was
            redundant and inconsistent with every other account-management
            action, which is Settings-only. */}

        <AppVersionFooter />
      </div>
    </div>
  );
}
