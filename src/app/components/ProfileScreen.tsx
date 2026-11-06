import { useState, useEffect, useRef } from 'react';
import { ventsColors } from '../../lib/ventsDesignTokens';
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
  Camera,
  WalletCards,
} from 'lucide-react';
import { Sentry } from '../../lib/sentry';
import { PurchasedTicket } from './types';
import { formatPrice } from './data';
import { supabase, getAuthToken } from '../../lib/supabase';
import { COUNTRY_CODES } from '../../lib/countries';
import { AppVersionFooter } from './shared/AppVersionFooter';
import { useWorkStatus } from './work/useWorkStatus';
import { HeroWork, Row, Chev, Chips, Pill } from './work/workUi';
import { organizerRole, providerRole, representativeRole } from '../../lib/workRoles';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

interface ProfileScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string; avatar_url?: string; cover_url?: string; isOrganizer?: boolean; vc_badge?: string; is_verified?: boolean; state?: string; is_service_provider?: boolean; country?: string } | null;
  onSignOut: () => void;
  tickets: PurchasedTicket[];
  savedCount: number;
  onViewTicket: (ticket: PurchasedTicket) => void;
  onNavigate: (screen: string) => void;
  setActiveView: (view: 'attendee' | 'organizer') => void;
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
  // Role statuses for the VENTS Work card chips (organizer_requests,
  // service_provider_requests, service_providers, recruiters, VC balance).
  const work = useWorkStatus(currentUser);

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

  if (!currentUser) {
    return (
      <div style={{ background: ventsColors.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '24px', color: ventsColors.ink3, fontFamily: 'Manrope, sans-serif', textAlign: 'center' }}>
        <div style={{ fontSize: '20px', fontWeight: 700, color: ventsColors.white }}>Sign in to view your profile</div>
        <div style={{ fontSize: '14px', color: ventsColors.ink3, maxWidth: '280px' }}>Create an account or sign in to manage tickets, follow organizers, and more.</div>
        <button
          onClick={() => onNavigate('auth')}
          style={{
            marginTop: '8px',
            width: '100%',
            maxWidth: '280px',
            height: '52px',
            padding: '0 28px',
            background: '#7B2FBE',
            border: 'none',
            borderRadius: '100px',
            color: '#fff',
            fontSize: '15px',
            fontWeight: 700,
            fontFamily: 'Manrope, sans-serif',
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
      icon: WalletCards,
      // One Wallet entry point for everyone -- routes to the universal
      // customer wallet (spendable balance, deposits), which itself exposes
      // an Earnings tab for organizers/admins via showEarningsTab below,
      // rather than sending organizers to a second, separate screen.
      label: 'Wallet',
      sublabel: 'Balance, deposits & statement',
      color: ventsColors.accent,
      screen: 'customer-wallet',
    },
    {
      icon: Bell,
      label: 'Notifications',
      sublabel: 'Manage alerts',
      color: ventsColors.pending,
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
      icon: Ticket,
      label: 'Payment Requests',
      sublabel: 'Tickets you sent or paid for someone',
      color: ventsColors.accentSoft,
      screen: 'payment-requests',
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
  // is_organizer (0121_organizer_capability_independent_of_role.sql) is an
  // independent capability, not a role value -- an account can be
  // Organizer + Service Provider + any staff tier simultaneously. Admins
  // implicitly get organizer capability too (matches the DB's is_organizer()
  // helper), same as before.
  const isOrganizer = !!currentUser?.isOrganizer || currentUser?.role === 'admin';
  const isServiceProvider = currentUser?.is_service_provider === true;
  const isAdmin = currentUser?.role === 'admin' || currentUser?.id === ROOT_UID;
  const isSubAdmin = currentUser?.role === 'sub-admin';
  const isVerified = currentUser?.is_verified === true || currentUser?.id === ROOT_UID;
  // Staff-tier badge only -- Organizer/Service Provider are shown as their
  // own separate capability chips (below), not folded into one mutually-
  // exclusive label. A plain account is a "User," never "Member".
  const roleLabel = isAdmin ? 'Admin' : isSubAdmin ? 'Sub-Admin' : 'User';
  const isStaff = isAdmin || isSubAdmin;
  // Only roles the person has engaged with get a chip (Start/Join rows
  // live in the hub), so the card never advertises roles as held.
  const workChips = work.loading ? [] : [
    organizerRole({ isOrganizer: !!currentUser?.isOrganizer, isStaff, isVerified, request: work.organizerRequest }),
    providerRole({ isProvider: currentUser?.is_service_provider === true, isStaff, request: work.providerRequest, profileStatus: work.providerProfileStatus }),
    representativeRole(work.representative),
  ].filter((r) => r.pill.tone !== 'off').map((r) => r.chip);
  
  const filteredMenuItems = menuItems.filter(item => {
    if (isOrganizer) {
      return item.screen !== 'my-tickets' && item.screen !== 'saved';
    }
    return true;
  });

  // Reflects the staff-tier chip only now that Organizer/Service Provider
  // render as their own separate chips above -- a plain User (even one who
  // is also an Organizer) gets the neutral fill, not the purple one,
  // since that's now the dedicated Organizer chip's color.
  const badgeFill = isAdmin
    ? '#DC2626'
    : isSubAdmin
    ? '#FBBF24'
    : '#FBBF24';

  const badgeTextColor = isAdmin ? '#fff' : '#000';
  const starColor = isAdmin ? '#fff' : '#000';

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: '#020005', position: 'relative' }}
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
      {/* Header -- matches the "Main Profile" export: a left-aligned
          uppercase eyebrow label instead of a centered "Profile" title,
          and a circular gear icon (real: opens Settings) instead of the
          avatar itself being the only way there. */}
      <div
        className="flex items-center justify-between px-5"
        style={{ paddingTop: 'calc(16px + env(safe-area-inset-top))', paddingBottom: '4px' }}
      >
        <span style={{ color: ventsColors.ink3, fontSize: '12px', fontWeight: 700, letterSpacing: '2px' }}>PROFILE</span>
        <button
          onClick={() => onNavigate('settings')}
          aria-label="Settings"
          style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
        >
          <Settings size={16} color={ventsColors.ink1} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none', paddingBottom: 'calc(110px + env(safe-area-inset-bottom))' }}>
        {/* Profile header -- centered avatar/name, matching the export.
            Cover image (real data, when set) still renders as a backdrop
            band behind the avatar rather than being dropped, since it's
            real uploaded content the export's generic mockup never had to
            account for. */}
        <div className="px-5 pt-2 pb-1" style={{ position: 'relative' }}>
          {effectiveCoverUrl && !coverLoadFailed && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '90px', borderRadius: '0 0 24px 24px', overflow: 'hidden' }}>
              <img src={effectiveCoverUrl} alt="cover" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={() => setCoverLoadFailed(true)} />
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '60%', background: 'rgba(6,10,18,0.75)' }} />
            </div>
          )}
          <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: effectiveCoverUrl && !coverLoadFailed ? '30px' : 0 }}>
            <button
              onClick={() => onNavigate('settings')}
              style={{ position: 'relative', padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}
              aria-label="Change profile photo"
            >
              <div
                style={{
                  width: '96px', height: '96px', borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                  background: '#7B2FBE',
                  boxShadow: `0 0 0 3px rgba(168,85,247,0.35), 0 0 30px rgba(168,85,247,0.5)`,
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
                  <span style={{ color: '#fff', fontSize: '34px', fontWeight: 800 }}>{initial}</span>
                )}
              </div>
              <div style={{
                position: 'absolute', bottom: -2, right: -2,
                background: ventsColors.accentSoft, borderRadius: '50%', width: '28px', height: '28px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: '2px solid #08050F',
              }}>
                <Camera size={13} color="#1A0B2E" />
              </div>
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '14px' }}>
              <h2 style={{ color: ventsColors.white, fontSize: '22px', fontWeight: 800, fontFamily: 'Manrope, sans-serif', margin: 0 }}>
                {displayName}
              </h2>
              {isVerified && (
                <span title="Verified" style={{ display: 'inline-flex' }}>
                  <BadgeCheck size={16} color={ventsColors.info} style={{ filter: 'drop-shadow(0 0 6px rgba(59,130,246,0.6))' }} />
                </span>
              )}
            </div>
            {currentUser?.state ? (
              <div className="flex items-center gap-1" style={{ marginTop: '4px' }}>
                <MapPin size={11} color={ventsColors.ink3} />
                <span style={{ color: ventsColors.ink3, fontSize: '13px' }}>
                  {currentUser.state}
                  {(() => {
                    const iso = currentUser.country || 'NG';
                    const name = COUNTRY_CODES.find((c) => c.iso === iso)?.name;
                    return name ? `, ${name}` : '';
                  })()}
                </span>
              </div>
            ) : (
              <button
                onClick={() => onNavigate('settings')}
                style={{ background: 'none', border: 'none', padding: 0, marginTop: '4px', color: ventsColors.accentSoft, fontSize: '13px', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
              >
                Add your state
              </button>
            )}

            <div className="flex items-center" style={{ flexWrap: 'wrap', gap: '6px', marginTop: '10px', justifyContent: 'center' }}>
              <div style={{ background: badgeFill, borderRadius: '5px', padding: '2px 7px', display: 'flex', alignItems: 'center', gap: '3px' }}>
                <Star size={10} color={starColor} fill={starColor} />
                <span style={{ color: badgeTextColor, fontSize: '10px', fontWeight: 700 }}>{roleLabel}</span>
              </div>
              {/* Organizer and Service Provider are independent capabilities
                  (0121_organizer_capability_independent_of_role.sql), not
                  alternatives to the account/staff-tier chip above -- both
                  can show at once alongside it. */}
              {isOrganizer && (
                <div style={{ background: '#7B2FBE', borderRadius: '5px', padding: '2px 7px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ color: '#fff', fontSize: '10px', fontWeight: 700 }}>Organizer</span>
                </div>
              )}
              {isServiceProvider && (
                <div style={{ background: '#0E7490', borderRadius: '5px', padding: '2px 7px', display: 'flex', alignItems: 'center' }}>
                  <span style={{ color: '#fff', fontSize: '10px', fontWeight: 700 }}>Service Provider</span>
                </div>
              )}
              <BadgeChip tier={currentUser?.vc_badge} />
            </div>
          </div>
        </div>

        {/* Stats row -- the export's version of this row is Events /
            Followers / Following, but VENTS has no follower/following
            system at all (no `follows` table, no counts anywhere in the
            schema) -- showing those would mean fabricating numbers, which
            the design source-of-truth rules explicitly forbid. Using the
            real, already-fetched equivalents instead: ticket count and
            saved-events count for attendees (both already passed into this
            screen as real props), or real Events-created/Attendees for
            organizers (already fetched above via eventsCreated/attendees). */}
        <div className="px-5" style={{ marginTop: '18px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '18px', padding: '16px 0' }}>
            {isOrganizer ? (
              <>
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ color: ventsColors.white, fontSize: '18px', fontWeight: 800 }}>{eventsCreated}</div>
                  <div style={{ color: ventsColors.ink3, fontSize: '11px', letterSpacing: '1px', marginTop: '3px' }}>EVENTS</div>
                </div>
                <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)' }} />
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ color: ventsColors.white, fontSize: '18px', fontWeight: 800 }}>{attendees}</div>
                  <div style={{ color: ventsColors.ink3, fontSize: '11px', letterSpacing: '1px', marginTop: '3px' }}>ATTENDEES</div>
                </div>
              </>
            ) : (
              <>
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ color: ventsColors.white, fontSize: '18px', fontWeight: 800 }}>{tickets.length}</div>
                  <div style={{ color: ventsColors.ink3, fontSize: '11px', letterSpacing: '1px', marginTop: '3px' }}>TICKETS</div>
                </div>
                <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)' }} />
                <div style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ color: ventsColors.white, fontSize: '18px', fontWeight: 800 }}>{savedCount}</div>
                  <div style={{ color: ventsColors.ink3, fontSize: '11px', letterSpacing: '1px', marginTop: '3px' }}>SAVED</div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Edit Profile CTA -- export pairs this with a share icon button;
            no real share/export-profile handler exists anywhere in the app
            today, so that button was left out rather than wired to a fake
            no-op. */}
        <div className="px-5" style={{ marginTop: '16px' }}>
          <button
            onClick={() => onNavigate('settings')}
            style={{ width: '100%', padding: '13px 0', borderRadius: '14px', background: '#7B2FBE', border: 'none', color: '#fff', fontWeight: 700, fontSize: '14px', cursor: 'pointer', boxShadow: '0 6px 20px rgba(142,92,247,0.35)' }}
          >
            Edit Profile
          </button>
        </div>

        {/* VENTS Work card (approved mockup A) -- replaces the VENTS Cents
            highlight card, the duplicate Vents Cents menu row and the two
            "Become..." buttons. Chips show each role's live state; every
            earning path opens from the VENTS Work hub. */}
        <div className="px-4" style={{ marginTop: '16px', marginBottom: '16px' }}>
          <HeroWork testId="profile-vents-work-card" onClick={() => onNavigate('vents-work')}>
            <Row
              title={<span style={{ fontSize: 14 }}>VENTS Work</span>}
              sub="Earn by running events, offering services and representing others"
              right={<Chev />}
            />
            <Chips>
              {workChips.map((c) => <Pill key={c.label} tone={c.tone}>{c.label}</Pill>)}
              {work.vcSpendable !== null && <Pill tone="off">VC {work.vcSpendable.toLocaleString()}</Pill>}
            </Chips>
          </HeroWork>
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
                    <Icon size={17} color={ventsColors.accentSoft} />
                  </div>
                  <div className="flex-1">
                    <p style={{ color: ventsColors.ink1, fontSize: '15px', fontWeight: 600 }}>
                      {item.label}
                    </p>
                    <p style={{ color: ventsColors.ink3, fontSize: '12px' }}>{item.sublabel}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.badge && (
                      <div
                        style={{
                          background: ventsColors.errorStrong,
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
                    <ChevronRight size={15} color={ventsColors.ink3} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Wallet now lives only in the menu list above ("Wallet" ->
            'customer-wallet' for everyone, with its own Earnings tab for
            organizers/admins) -- this used to be two separate standalone
            buttons here for the same destinations; removed rather than
            kept as a redundant shortcut. */}

        {/* Admin Dashboard (Admin/Sub-Admin/Root) */}
        {(isAdmin || isSubAdmin) && (
          <div className="px-4 mb-3">
            <button
              onClick={() => onNavigate('admin-console')}
              className="w-full flex items-center justify-center gap-2 p-4"
              style={{
                background: 'rgba(239,68,68,0.13)',
                backdropFilter: 'blur(20px) saturate(160%)',
                WebkitBackdropFilter: 'blur(20px) saturate(160%)',
                borderRadius: '14px',
                border: '1px solid rgba(239,68,68,0.3)',
                cursor: 'pointer',
              }}
            >
              <Shield size={16} color={ventsColors.error} />
              <span style={{ color: ventsColors.error, fontSize: '14px', fontWeight: 700, letterSpacing: '0.02em' }}>
                Admin Dashboard
              </span>
            </button>
          </div>
        )}

        {/* Main Profile export shows a "Log Out" row here after all --
            reinstated to match it. Calls the same real onSignOut the app
            already passes into this screen (identical to Settings' own
            Sign Out button) -- no new auth logic, no duplicated backend
            behavior, and Settings keeps its own Sign Out working exactly
            as before. */}
        <div className="px-4 mb-3">
          <button
            onClick={onSignOut}
            className="w-full text-center"
            style={{
              padding: '13px 0', borderRadius: '14px', fontSize: '14px', fontWeight: 600,
              color: '#F87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
              cursor: 'pointer',
            }}
          >
            Log Out
          </button>
        </div>

        <AppVersionFooter />
      </div>
    </div>
  );
}
