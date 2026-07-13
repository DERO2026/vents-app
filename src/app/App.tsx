import React, { useState, useEffect, useCallback, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { Screen, TabId, AuthMode, Event, TicketType, PurchasedTicket, UserProfile, UserRole, OrganizerEvent } from './components/types';
import { NIGERIA_STATES } from './components/StateSelectScreen';
import { insforge, clearRefreshToken, getAuthToken, readRefreshToken, saveRefreshToken } from '../lib/insforge';
import { initPushAlert, setPushAlertSubscriber, trackPushEvent } from '../lib/pushAlert';
import { identifyUser, trackEvent } from '../lib/analytics';
import { sendSMS } from '../lib/sendchamp';

import { SplashScreen } from './components/SplashScreen';
import { WelcomeScreen } from './components/WelcomeScreen';
import { RoleSelectScreen } from './components/RoleSelectScreen';
import { AuthScreen } from './components/AuthScreen';
import { HomeScreen, mapDbEventToFrontend } from './components/HomeScreen';
import { ExploreScreen, mapDbUserToUserProfile } from './components/ExploreScreen';
import { SavedScreen } from './components/SavedScreen';
import { ProfileScreen } from './components/ProfileScreen';
import { BottomNav } from './components/BottomNav';
import { OrganizerBottomNav, OrgTab } from './components/OrganizerBottomNav';
import { NotificationsScreen } from './components/NotificationsScreen';
import { MyTicketsScreen } from './components/MyTicketsScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { PrivacyPolicyScreen } from './components/PrivacyPolicyScreen';
import { HelpSupportScreen } from './components/HelpSupportScreen';
import { InboxScreen } from './components/InboxScreen';
import { ConversationScreen } from './components/ConversationScreen';
import { EventDetailsScreen } from './components/EventDetailsScreen';
import { TicketSelectScreen } from './components/TicketSelectScreen';
import { CheckoutScreen } from './components/CheckoutScreen';
import { PaymentSuccessScreen } from './components/PaymentSuccessScreen';
import { OrganizerDashboard } from './components/OrganizerDashboard';
import { CreateEventScreen } from './components/CreateEventScreen';
import { ManageEventsScreen } from './components/ManageEventsScreen';
import { SalesAnalyticsScreen } from './components/SalesAnalyticsScreen';
import { WalletScreen } from './components/WalletScreen';
import { AttendeeListScreen } from './components/AttendeeListScreen';
import { UserProfileScreen } from './components/UserProfileScreen';
import { PromoteEventScreen } from './components/PromoteEventScreen';
import { NigeriaLiveScreen } from './components/NigeriaLiveScreen';
import { AdminDashboardScreen } from './components/AdminDashboardScreen';
import { CheckinScannerScreen } from './components/CheckinScannerScreen';
import { ReferralScreen } from './components/ReferralScreen';
import { InterestsScreen } from './components/InterestsScreen';
import { PrivacyScreen } from './components/PrivacyScreen';
import { TermsScreen } from './components/TermsScreen';
import { RefundPolicyScreen } from './components/RefundPolicyScreen';
import { HelpPage } from './components/HelpPage';
import { PrivacySecurityScreen } from './components/PrivacySecurityScreen';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

// Bump this on every release. Compared against app_config.min_client_version
// on launch — if this build is older, the client shows a blocking update
// screen instead of the app.
const APP_VERSION = '1.1.0';

function isVersionOlder(current: string, minimum: string): boolean {
  const a = current.split('.').map((n) => parseInt(n, 10) || 0);
  const b = minimum.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] || 0, bv = b[i] || 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}

const TAB_SCREENS: Record<TabId, Screen> = {
  home: 'home',
  explore: 'explore',
  'my-tickets': 'my-tickets',
  profile: 'profile',
};

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          width: '100%',
          height: '100%',
          background: '#060A12',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          textAlign: 'center',
          boxSizing: 'border-box'
        }}>
          <span style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</span>
          <h1 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '8px' }}>
            Application Crash
          </h1>
          <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.6, marginBottom: '24px' }}>
            A runtime error occurred in this screen. You can try reloading the application.
          </p>
          <pre style={{
            background: '#131629',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '12px',
            padding: '12px',
            color: '#EF4444',
            fontSize: '11px',
            fontFamily: 'monospace',
            textAlign: 'left',
            width: '100%',
            overflowX: 'auto',
            marginBottom: '24px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all'
          }}>
            {this.state.error?.message || "Unknown error"}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
              border: 'none',
              borderRadius: '14px',
              padding: '12px 28px',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(123,47,190,0.3)'
            }}
          >
            Reload App
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  // Serve public legal pages without the app shell
  const pathname = window.location.pathname;
  if (pathname === '/privacy') return <PrivacyScreen />;
  if (pathname === '/terms') return <TermsScreen />;
  if (pathname === '/refunds') return <RefundPolicyScreen />;
  if (pathname === '/help') return <HelpPage />;

  const [screen, setScreen] = useState<Screen>('splash');
  const [activeTab, setActiveTab] = useState<TabId>('home');
  const [orgTab, setOrgTab] = useState<OrgTab>('home');
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [screenStack, setScreenStack] = useState<Screen[]>([]);
  // Tracks events viewed via the in-page "Related Events" carousel while
  // already on the event-details screen. navigateTo('event-details') is a
  // no-op for `screen` when it's already that value (React bails the
  // update), so without this, Back had nothing to actually restore — the
  // view got stuck on whichever related event was tapped last.
  const [eventHistoryStack, setEventHistoryStack] = useState<Event[]>([]);
  const [currentUser, setCurrentUser] = useState<{ id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; avatar_url?: string; cover_url?: string; isOrganizer?: boolean; vc_badge?: string; is_verified?: boolean } | null>(null);
  const [showInterests, setShowInterests] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [splashMinTimePassed, setSplashMinTimePassed] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  // Kill switch flags (Block 17) — scoped feature disables, distinct from
  // maintenance_mode's app-wide gate. Each RPC also enforces its own flag
  // server-side (purchases_disabled/scanning_disabled/signups_disabled/
  // payouts_disabled), so this state is purely for graceful UI
  // degradation, not the actual security boundary.
  const [featureFlags, setFeatureFlags] = useState({
    disablePurchases: false,
    disableScanning: false,
    disableSignups: false,
    disablePayouts: false,
  });
  const [dbEvents, setDbEvents] = useState<Event[]>([]);
  const eventsPageRef = useRef(0);
  const [hasMoreEvents, setHasMoreEvents] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [userRole, setUserRole] = useState<UserRole>('attendee');
  const [resetToken, setResetToken] = useState<string | undefined>(undefined);
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatRefreshKey, setChatRefreshKey] = useState(0);

  const handleSwitchToAttendee = useCallback(() => {
    setUserRole('attendee');
    setActiveTab('home');
    setScreen('home');
    if (currentUser?.id) {
      setCurrentUser(prev => prev ? { ...prev, isOrganizer: true } : null);
    }
  }, [currentUser]);

  const ORGANIZER_ONLY_SCREENS: Screen[] = ['create-event', 'promote-event', 'manage-events', 'sales-analytics', 'attendee-list', 'checkin-scanner'];
  const navigateTo = useCallback((next: Screen) => {
    if (ORGANIZER_ONLY_SCREENS.includes(next) && currentUser?.role !== 'organizer' && currentUser?.role !== 'organiser' && currentUser?.role !== 'admin' && currentUser?.role !== 'sub-admin' && currentUser?.id !== ROOT_UID) {
      console.warn(`Unauthorized attempt to access ${next} screen`);
      return;
    }
    setScreenStack((prev) => [...prev, screen]);
    setScreen(next);
  }, [currentUser, screen]);

  const goBack = useCallback(() => {
    // Returning from a "Related Events" hop: restore the previously viewed
    // event instead of trying to change `screen` (which is already
    // 'event-details' and wouldn't trigger a re-render on its own).
    if (screen === 'event-details' && eventHistoryStack.length > 0) {
      const previousEvent = eventHistoryStack[eventHistoryStack.length - 1];
      setEventHistoryStack((s) => s.slice(0, -1));
      setScreenStack((s) => s.slice(0, -1));
      setSelectedEvent(previousEvent);
      return;
    }
    const prev = screenStack[screenStack.length - 1];
    if (screen === 'conversation') setChatRefreshKey((k) => k + 1);
    if (prev) {
      setScreenStack((s) => s.slice(0, -1));
      setScreen(prev);
    } else {
      setScreen('home');
      setActiveTab('home');
    }
  }, [screenStack, screen, userRole, eventHistoryStack]);

  const handleSplashComplete = useCallback(() => {
    setSplashMinTimePassed(true);
  }, []);

  // Forced-update gate + maintenance-mode gate: both read from the same
  // app_config singleton an admin can flip. Polled (not just fetched once)
  // so a maintenance toggle takes effect for already-open tabs without
  // requiring a manual reload.
  useEffect(() => {
    let cancelled = false;
    const checkAppConfig = () => {
      insforge.database
        .from('app_config')
        .select('min_client_version, maintenance_mode, disable_purchases, disable_scanning, disable_signups, disable_payouts')
        .maybeSingle()
        .then(({ data }) => {
          if (cancelled) return;
          if (data?.min_client_version && isVersionOlder(APP_VERSION, data.min_client_version)) {
            setUpdateRequired(true);
          }
          setMaintenanceMode(!!data?.maintenance_mode);
          setFeatureFlags({
            disablePurchases: !!data?.disable_purchases,
            disableScanning: !!data?.disable_scanning,
            disableSignups: !!data?.disable_signups,
            disablePayouts: !!data?.disable_payouts,
          });
        }, () => {});
    };
    checkAppConfig();
    const interval = setInterval(checkAppConfig, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Mount-once: initPushAlert() itself guards against double-injection
  // (module-level flag + a DOM check for an existing script tag), so this
  // stays safe even under React 18 StrictMode's double-invoke in dev.
  useEffect(() => {
    initPushAlert();
  }, []);

  // Keep currentUser.role in sync with the DB. Without this, a role change
  // made server-side (e.g. Root promoting someone to Sub-Admin from the
  // Admin Console) would never be reflected client-side until the affected
  // user fully logs out and back in — the Sub-Admin badge and Admin
  // Dashboard link would keep rendering against the stale cached role.
  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    const syncRole = () => {
      insforge.database
        .from('users')
        .select('role')
        .eq('id', currentUser.id)
        .maybeSingle()
        .then(({ data }) => {
          if (cancelled || !data?.role || data.role === currentUser.role) return;
          setCurrentUser(prev => (prev ? { ...prev, role: data.role } : prev));
        }, () => {});
    };
    const interval = setInterval(syncRole, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [currentUser?.id, currentUser?.role]);

  // Load current user and profile. Extracted as a stable callback (not just
  // inline in the mount effect) so it can also be re-run on bfcache restore
  // (see the pageshow effect below) — without that, backgrounding the app on
  // mobile and returning to it could show a frozen, stale-role snapshot of
  // the page indefinitely, since bfcache restores the DOM without re-running
  // React effects.
  const hydrateAuth = useCallback(async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        
        // 1. Audit URL for callback/oauth errors and display them
        const urlError = params.get('insforge_error') || params.get('error');
        if (urlError) {
          setAuthError(decodeURIComponent(urlError));
          const cleanUrl = window.location.pathname + window.location.hash;
          window.history.replaceState({}, document.title, cleanUrl);
        }

        // Intercept password reset tokens
        // Accept any non-null insforge_status — the exact value depends on the backend version
        const status = params.get('insforge_status');
        const type = params.get('insforge_type');
        const token = params.get('token');
        if (token && type === 'reset_password' && status !== null) {
          setResetToken(token);
          setAuthMode('reset');
          setScreen('auth');
          const cleanUrl = window.location.pathname + window.location.hash;
          window.history.replaceState({}, document.title, cleanUrl);
        }

        // Store referral code from ?ref= so it can be claimed after signup
        const refCode = params.get('ref');
        if (refCode && refCode.length === 8) {
          sessionStorage.setItem('vents_ref_code', refCode.toUpperCase());
          const cleanUrl = window.location.pathname + window.location.hash;
          window.history.replaceState({}, document.title, cleanUrl);
        }

        // Intercept event deep links: ?event=<eventId>
        const eventDeepLink = params.get('event');
        if (eventDeepLink) {
          const cleanUrl = window.location.pathname + window.location.hash;
          window.history.replaceState({}, document.title, cleanUrl);
          // Fetch event from DB and navigate (mapDbEventToFrontend is statically imported)
          insforge.database
            .from('events')
            .select('*')
            .eq('id', eventDeepLink)
            .maybeSingle()
            .then(({ data: evtData, error: evtError }) => {
              if (evtError) {
                console.error('Failed to load event from deep link:', evtError);
                return;
              }
              if (evtData) {
                setSelectedEvent(mapDbEventToFrontend(evtData));
                setScreen('event-details');
              }
            }, (err) => console.error('Deep link event fetch failed:', err));
        }

        // 2. Fetch user session.
        // On localhost, the httpOnly refresh cookie is blocked cross-origin, so we
        // fall back to a refresh token stored in secure storage (set at login) —
        // see src/lib/insforge.ts for the native Keychain/Keystore vs
        // sessionStorage split.
        let sessionUserId: string | null = null;
        let sessionUserEmail: string | null = null;

        const storedRt = await readRefreshToken();
        const hc = (insforge as any).getHttpClient?.();
        if (storedRt && hc && !hc.userToken) {
          try {
            const baseUrl = hc.baseUrl || import.meta.env.VITE_INSFORGE_URL;
            const refreshAbort = new AbortController();
            const refreshAbortTimer = setTimeout(() => refreshAbort.abort(), 12000);
            const refreshRes = await fetch(`${baseUrl}/api/auth/refresh?client_type=mobile`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refreshToken: storedRt, refresh_token: storedRt }),
              signal: refreshAbort.signal,
            });
            clearTimeout(refreshAbortTimer);
            if (refreshRes.ok) {
              const refreshJson = await refreshRes.json();
              const at = refreshJson.accessToken || refreshJson.access_token;
              if (at) {
                hc.userToken = at;
                // Try user info from refresh response first, then via direct API call
                sessionUserId = refreshJson.user?.id || null;
                sessionUserEmail = refreshJson.user?.email || null;
                if (!sessionUserId) {
                  try {
                    const userRes = await fetch(`${baseUrl}/api/auth/user`, {
                      headers: { Authorization: `Bearer ${at}` },
                    });
                    if (userRes.ok) {
                      const ud = await userRes.json();
                      sessionUserId = ud.user?.id || ud.id || null;
                      sessionUserEmail = ud.user?.email || ud.email || null;
                    }
                  } catch { /* ignore */ }
                }
              }
              const newRt = refreshJson.refreshToken || refreshJson.refresh_token;
              if (newRt) {
                hc.refreshToken = newRt;
                await saveRefreshToken(newRt);
              }
            } else {
              await clearRefreshToken();
            }
          } catch (refreshErr: any) {
            console.warn('Auth refresh token exchange failed:', refreshErr?.name === 'AbortError' ? 'timed out after 12s' : refreshErr?.message || refreshErr);
          }
        }

        // If we got the user from the manual refresh, skip SDK call
        if (!sessionUserId) {
          // A thrown error or non-401 statusCode here is a transient
          // network/cold-start failure, not proof the session is invalid —
          // treating it as "logged out" on the first try is what caused
          // users to be intermittently dropped back to the Welcome screen
          // on refresh. Only a genuine 401/403 means "not authenticated";
          // anything else gets one retry before giving up.
          let getCurrentUserData: any = null;
          let getCurrentUserError: any = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const result = await insforge.auth.getCurrentUser();
              getCurrentUserData = result.data;
              getCurrentUserError = result.error;
            } catch (err: any) {
              getCurrentUserError = err;
            }
            const statusCode = getCurrentUserError?.statusCode;
            const isDefinitelyUnauthenticated = statusCode === 401 || statusCode === 403;
            if (!getCurrentUserError || isDefinitelyUnauthenticated) break;
            if (attempt === 0) {
              console.warn('GetCurrentUser failed, retrying once:', getCurrentUserError?.message || getCurrentUserError);
              await new Promise((r) => setTimeout(r, 800));
            }
          }
          if (getCurrentUserError) {
            console.warn("GetCurrentUser failed after retry:", getCurrentUserError?.statusCode || getCurrentUserError?.message);
            setCurrentUser(null);
            setAuthLoading(false);
            return;
          }
          const data = getCurrentUserData;
          if (!data?.user) {
            setCurrentUser(null);
            setAuthLoading(false);
            return;
          }
          sessionUserId = data.user.id;
          sessionUserEmail = data.user.email;
        }

        if (!sessionUserId) {
          setCurrentUser(null);
          setAuthLoading(false);
          return;
        }

        // Fetch user profile from public schema to get the role and full name
        const { data: profile } = await insforge.database
          .from('users')
          .select('*')
          .eq('id', sessionUserId)
          .maybeSingle();

        // Item 20: reject suspended users immediately on session restore
        if (profile?.status === 'suspended') {
          await insforge.auth.signOut().catch(() => {});
          await clearRefreshToken();
          setCurrentUser(null);
          setAuthError('Your account has been suspended. To appeal, contact support@getvents.com or WhatsApp +234 9030737368.');
          setAuthLoading(false);
          return;
        }

        setCurrentUser({
          id: sessionUserId,
          email: sessionUserEmail || profile?.email || '',
          full_name: profile?.full_name || (sessionUserEmail || '').split('@')[0],
          role: profile?.role || 'user',
          username: profile?.username,
          phone_number: profile?.phone_number,
          state: profile?.state,
          avatar_url: profile?.avatar_url,
          cover_url: profile?.cover_url,
          isOrganizer: (profile?.role === 'organizer' || profile?.role === 'organiser'),
          vc_badge: profile?.vc_badge,
          is_verified: profile?.is_verified === true,
        });
      } catch (err: any) {
        console.error("Auth rehydration failed:", err);
        setAuthError(err?.message || "An unexpected error occurred during auth rehydration.");
        setCurrentUser(null);
      } finally {
        setAuthLoading(false);
      }
  }, []);

  useEffect(() => { hydrateAuth(); }, [hydrateAuth]);

  // Re-validate the session whenever the page is restored from the
  // back/forward cache (bfcache) — e.g. a mobile browser backgrounded and
  // resumed. Without this, the user could briefly (or indefinitely, until
  // some other effect happens to re-fire) see whatever role-gated UI was
  // frozen into the cached snapshot before it was backgrounded.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setAuthLoading(true);
        hydrateAuth();
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [hydrateAuth]);

  // Item 4: Load organizer's events from DB on mount/user change
  useEffect(() => {
    if (!currentUser?.id || (currentUser.role !== 'organizer' && currentUser.role !== 'organiser' && currentUser.id !== ROOT_UID)) return;
    insforge.database
      .from('events')
      .select('*')
      .eq('organizer_id', currentUser.id)
      .then(({ data: dbOrgEvents }) => {
        if (!dbOrgEvents) return;
        setOrgEvents((dbOrgEvents as any[]).map((e: any) => ({
          id: e.id,
          title: e.title || '',
          category: e.category || 'Other',
          description: e.description || '',
          date: e.event_date ? e.event_date.split('T')[0] : '',
          startTime: e.event_date ? (e.event_date.includes('T') ? e.event_date.split('T')[1].slice(0, 5) : '') : '',
          venue: e.location || '',
          city: '',
          capacity: String(e.ticket_goal || 1000),
          ticketName: 'Regular',
          ticketPrice: String(e.price || '0'),
          ticketQty: String(e.ticket_goal || 1000),
          contactPhone: '',
          showPhone: false,
          status: (e.status === 'live' ? 'approved' : e.status === 'draft' ? 'under_review' : e.status) as any,
          createdAt: new Date(e.created_at).getTime(),
        })));
      });
  }, [currentUser?.id, currentUser?.role]);

  // Safety Timeout to prevent stuck splash screen on network/auth hang
  useEffect(() => {
    const safetyTimeout = setTimeout(() => {
      if (authLoading) {
        console.warn("Auth hydration safety timeout (15s) triggered. Forcing welcome screen. Check network or InsForge backend latency.");
        setCurrentUser(null);
        setAuthLoading(false);
        setScreen('welcome');
      }
    }, 15000);
    return () => clearTimeout(safetyTimeout);
  }, [authLoading]);

  // Sync userRole Effect (initialize once on user load)
  const userLoadedRef = useRef(false);
  useEffect(() => {
    if (currentUser && !userLoadedRef.current) {
      setUserRole(
        currentUser.role === 'admin' ? 'attendee'
        : (currentUser.role === 'organizer' || currentUser.isOrganizer) ? 'organizer'
        : 'attendee'
      );
      userLoadedRef.current = true;
    }
    if (!currentUser) {
      userLoadedRef.current = false;
    }
  }, [currentUser]);

  // Splash Routing Effect
  useEffect(() => {
    if (screen === 'splash' && splashMinTimePassed && !authLoading) {
      if (currentUser) {
        if (currentUser.role !== 'organizer') {
          setUserRole('attendee');
          setScreen('home');
          setActiveTab('home');
        } else {
          setUserRole('organizer');
          setOrgTab('home');
          setScreen('home');
          setActiveTab('home');
        }
      } else {
        setScreen('welcome');
      }
    }
  }, [screen, splashMinTimePassed, authLoading, currentUser]);

  // Post-auth redirection when currentUser session is fully loaded in state
  useEffect(() => {
    if (currentUser && screen === 'auth') {
      if (currentUser.role === 'organizer' || currentUser.isOrganizer) {
        setUserRole('organizer');
        setOrgTab('home');
        setScreen('home');
        setActiveTab('home');
      } else {
        setUserRole('attendee');
        setScreen('home');
        setActiveTab('home');
      }
    }
  }, [currentUser, screen]);

  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [selectedTicketType, setSelectedTicketType] = useState<TicketType | null>(null);
  const [selectedTicketQty, setSelectedTicketQty] = useState(1);
  const [purchasedTicket, setPurchasedTicket] = useState<PurchasedTicket | null>(null);

  const [savedEvents, setSavedEvents] = useState<string[]>([]);

  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  // Fetch the user's blocked-organizer list so the main feed can exclude
  // their events (App Store Guideline 1.2 UGC requirement).
  useEffect(() => {
    async function fetchBlocked() {
      if (!currentUser?.id) {
        setBlockedIds(new Set());
        return;
      }
      try {
        const { data, error } = await insforge.database
          .from('blocked_users')
          .select('blocked_id')
          .eq('blocker_id', currentUser.id);
        if (error) throw error;
        if (data) setBlockedIds(new Set(data.map((b: any) => b.blocked_id)));
      } catch (err) {
        console.error('Failed to fetch blocked users:', err);
      }
    }
    fetchBlocked();
  }, [currentUser?.id]);

  // fetchEvents below is a useCallback with a stable [] dependency array, so
  // it can't read blockedIds from closure without going stale — mirror it
  // into a ref instead (same technique the function already uses for
  // lastFetchRef).
  const blockedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => { blockedIdsRef.current = blockedIds; }, [blockedIds]);

  // Same stale-closure hazard as blockedIdsRef above: fetchEvents is a
  // stable useCallback ([] deps) and would otherwise permanently close over
  // whatever currentUser was at first render — usually null, before auth
  // hydrates — silently disabling the 18+ content filter for the entire
  // session. Mirror date_of_birth into a ref so fetchEvents always reads
  // the current value.
  const currentUserDobRef = useRef<string | undefined>(undefined);
  useEffect(() => { currentUserDobRef.current = (currentUser as any)?.date_of_birth; }, [currentUser]);

  // Fetch user's saved events from database
  useEffect(() => {
    async function fetchSavedEvents() {
      if (!currentUser?.id) {
        setSavedEvents([]);
        return;
      }
      try {
        const { data, error } = await insforge.database
          .from('saved_events')
          .select('event_id')
          .eq('user_id', currentUser.id);
        if (error) throw error;
        if (data) {
          setSavedEvents(data.map((item: any) => item.event_id));
        }
      } catch (err) {
        console.error("Failed to fetch saved events:", err);
      }
    }
    fetchSavedEvents();
  }, [currentUser]);
  const [allTickets, setAllTickets] = useState<PurchasedTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [bookingLoading, setBookingLoading] = useState(false);
  const [promotionEventId, setPromotionEventId] = useState<string>('');
  const [editingEventId, setEditingEventId] = useState<string | null>(null);

  const fetchUserTickets = useCallback(async (userId: string) => {
    setTicketsLoading(true);
    try {
      const { data, error } = await insforge.database
        .from('tickets')
        .select('*, events(*)')
        .eq('user_id', userId)
        .eq('status', 'active');
      
      if (error) throw error;

      if (data) {
        // Single source of truth for the embedded event's "attendees"
        // figure — previously read events.attendee_count, a column that
        // was never created in any migration, so this always silently
        // fell back to 0.
        const ticketEventIds = [...new Set(data.filter((t: any) => t.events).map((t: any) => t.events.id))];
        let statsByEventId: Record<string, number> = {};
        if (ticketEventIds.length > 0) {
          const { data: statsRes } = await insforge.database.rpc('get_event_ticket_stats', { p_event_ids: ticketEventIds });
          (statsRes || []).forEach((s: any) => { statsByEventId[s.event_id] = s.sold_count || 0; });
        }
        const mappedTickets: PurchasedTicket[] = data
          .filter((t: any) => t.events)
          .map((t: any) => {
            const dbEvent = t.events;
            const dt = dbEvent.event_date ? new Date(dbEvent.event_date) : null;
          const dateStr = dt ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
          const timeStr = dt ? dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
          const parts = (dbEvent.location || '').split(',');
          const venue = (parts[0] || '').trim();
          const city = (parts[1] || 'Lagos').trim();

          const categoryIconMap: Record<string, string> = {
            'Music': '🎵',
            'Technology': '💻',
            'Food & Drinks': '🍔',
            'Comedy Shows': '🎤',
            'Arts & Culture': '🎨',
            'Sports & Wellness': '⚽',
            'Conferences': '💼',
            'Family Events': '👨‍👩‍👧‍👦'
          };

          const eventMapped: Event = {
            id: dbEvent.id,
            title: dbEvent.title,
            category: dbEvent.category || 'Music',
            categoryIcon: categoryIconMap[dbEvent.category] || '🎵',
            date: dateStr,
            time: timeStr,
            endTime: '',
            venue: venue,
            area: venue,
            city: city,
            state: city + ' State',
            price: Number(dbEvent.price || 0),
            image: dbEvent.image_url || 'https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?w=800',
            description: dbEvent.description || '',
            organizer: 'Verified Organizer',
            organizerVerified: true,
            isFeatured: false,
            isTrending: false,
            attendees: statsByEventId[dbEvent.id] ?? 0,
            capacity: dbEvent.ticket_goal ?? 0,
            rating: 0,
            reviewCount: 0,
            ticketTypes: [
              {
                id: 't1',
                name: 'Regular',
                price: Number(dbEvent.price || 0),
                description: 'General Admission',
                available: 500
              }
            ],
            event_date: dbEvent.event_date
          };

          return {
            event: eventMapped,
            ticketType: {
              id: 't1',
              name: 'Regular',
              price: Number(dbEvent.price || 0),
              description: 'General Admission',
              available: 500
            },
            quantity: t.quantity || 1,
            ticketId: t.id,
            purchasedAt: t.created_at,
            totalAmount: Number(dbEvent.price || 0) * (t.quantity || 1),
            // Each row is one individual attendee's ticket (see the
            // multi-attendee-tickets migration) — show who it's actually
            // for, not just the purchaser's own name on every card.
            holderName: t.holder_name || currentUser?.full_name || 'Attendee',
            holderEmail: t.holder_email || undefined,
          };
        });

        setAllTickets(mappedTickets);
      }
    } catch (err) {
      console.error('Failed to fetch user tickets:', err);
    } finally {
      setTicketsLoading(false);
    }
  }, [currentUser?.id, currentUser?.full_name]);

  const lastFetchRef = useRef<number>(0);
  const fetchEvents = useCallback(async (force = false, loadMore = false) => {
    if (!force && !loadMore && Date.now() - lastFetchRef.current < 5000) {
      return;
    }
    lastFetchRef.current = Date.now();
    setLoadingEvents(true);
    try {
      const nextPage = loadMore ? eventsPageRef.current + 1 : 0;
      const start = nextPage * 20;
      const end = start + 19;

      // Calculate user's age for 18+ filtering. Read from the ref, not the
      // closed-over currentUser — see currentUserDobRef above.
      const userDob = currentUserDobRef.current;
      const userAgeYears = userDob
        ? Math.floor((Date.now() - new Date(userDob).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
        : 99;

      let eventsQuery = insforge.database
        .from('events')
        .select('*, users!events_organizer_id_fkey(username, full_name, vc_badge)')
        .eq('hidden_by_admin', false)
        .gte('event_date', new Date().toISOString().split('T')[0])
        .in('status', ['live', 'published']);

      // Hide 18+ events from underage users
      if (userAgeYears < 18) {
        eventsQuery = (eventsQuery as any).eq('is_18_plus', false);
      }

      // Hide events from organizers this user has blocked (App Store
      // Guideline 1.2 UGC requirement).
      const blockedNow = blockedIdsRef.current;
      if (blockedNow.size > 0) {
        eventsQuery = (eventsQuery as any).not('organizer_id', 'in', `(${[...blockedNow].join(',')})`);
      }

      const { data: dbEventsData, error: dbEventsError } = await eventsQuery.range(start, end);

      if (dbEventsError) throw dbEventsError;

      if (dbEventsData) {
        const hasMore = dbEventsData.length === 20;
        setHasMoreEvents(hasMore);
        eventsPageRef.current = loadMore ? nextPage : 0;

        const eventIds = dbEventsData.map((e: any) => e.id);
        const mapped = dbEventsData.map((e: any) => {
          const orgUser = e.users;
          return mapDbEventToFrontend({
            ...e,
            organizer_name: orgUser?.username || orgUser?.full_name || null,
            organizer_vc_badge: orgUser?.vc_badge || null,
          });
        });

        let promotionsData: any[] = [];
        let ticketsData: any[] = [];
        let savesData: any[] = [];

        if (eventIds.length > 0) {
          const nowStr = new Date().toISOString();
          const { data: promoRes } = await insforge.database
            .from('event_promotions')
            .select('*')
            .eq('status', 'active')
            .lte('start_date', nowStr)
            .gte('end_date', nowStr)
            .in('event_id', eventIds);
          if (promoRes) promotionsData = promoRes;

          // Single source of truth for "tickets sold" across the whole
          // app — see get_event_ticket_stats (Data Consistency migration).
          // Previously this queried tickets directly and counted any
          // status='active' row regardless of payment_status, which could
          // disagree with SalesAnalyticsScreen/OrganizerDashboard's
          // payment_status='paid'-only counts for the same event.
          const { data: statsRes } = await insforge.database.rpc('get_event_ticket_stats', { p_event_ids: eventIds });
          if (statsRes) ticketsData = statsRes;

          // Fetch saves count per event for popularity score
          const { data: savesRes } = await insforge.database
            .from('saved_events')
            .select('event_id')
            .in('event_id', eventIds);
          if (savesRes) savesData = savesRes;
        }

        const bookingsCountMap: Record<string, number> = {};
        ticketsData.forEach((t: any) => {
          bookingsCountMap[t.event_id] = t.sold_count || 0;
        });

        const savesCountMap: Record<string, number> = {};
        (savesData as any[]).forEach((s: any) => {
          savesCountMap[s.event_id] = (savesCountMap[s.event_id] || 0) + 1;
        });

        const promotionPlanMap: Record<string, string> = {};
        promotionsData.forEach((promo: any) => {
          const currentPlan = promotionPlanMap[promo.event_id];
          const newPlan = promo.plan_type;
          if (!currentPlan) {
            promotionPlanMap[promo.event_id] = newPlan;
          } else {
            const priority: Record<string, number> = { trending: 3, featured: 2, boosted: 1 };
            if (priority[newPlan] > priority[currentPlan]) {
              promotionPlanMap[promo.event_id] = newPlan;
            }
          }
        });

        const enriched = mapped.map(evt => {
          const promoPlan = promotionPlanMap[evt.id];
          const bookings = bookingsCountMap[evt.id] || 0;
          const saves = savesCountMap[evt.id] || 0;
          return {
            ...evt,
            isPromoted: !!promoPlan,
            promoPlan: promoPlan || null,
            bookingsCount: bookings,
            attendees: bookings,
            savesCount: saves,
          };
        });

        enriched.sort((a: any, b: any) => {
          if (a.isPromoted && !b.isPromoted) return -1;
          if (!a.isPromoted && b.isPromoted) return 1;
          if (a.isPromoted && b.isPromoted) {
            const priority: Record<string, number> = { trending: 3, featured: 2, boosted: 1 };
            const prioA = priority[a.promoPlan] || 0;
            const prioB = priority[b.promoPlan] || 0;
            if (prioA !== prioB) {
              return prioB - prioA;
            }
          }

          if (a.bookingsCount !== b.bookingsCount || (a as any).savesCount !== (b as any).savesCount) {
            // Popularity score: tickets × 3 + saves × 1
            const scoreA = (a.bookingsCount || 0) * 3 + ((a as any).savesCount || 0);
            const scoreB = (b.bookingsCount || 0) * 3 + ((b as any).savesCount || 0);
            if (scoreA !== scoreB) return scoreB - scoreA;
          }

          const rawA = dbEventsData.find((x: any) => x.id === a.id)?.created_at || '';
          const rawB = dbEventsData.find((x: any) => x.id === b.id)?.created_at || '';
          return new Date(rawB).getTime() - new Date(rawA).getTime();
        });

        if (loadMore) {
          setDbEvents(prev => {
            const merged = [...prev];
            enriched.forEach(newEvt => {
              if (!merged.some(x => x.id === newEvt.id)) {
                merged.push(newEvt);
              }
            });
            return merged;
          });
        } else {
          setDbEvents(enriched);
        }
      }
    } catch (err) {
      console.error('Failed to fetch events / rank feed centrally:', err);
    } finally {
      setLoadingEvents(false);
    }
  }, []);

  // Fetch events on mount and when navigating to home screen
  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    if (screen === 'home') {
      fetchEvents();
    }
  }, [screen, fetchEvents]);

  const fetchUnreadCount = useCallback(async () => {
    if (!currentUser?.id) {
      setUnreadCount(0);
      return;
    }
    try {
      const { count, error } = await insforge.database
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', currentUser.id)
        .eq('read', false);
      if (!error && count !== null) {
        setUnreadCount(count);
      }
    } catch (err) {
      console.error("Failed to fetch unread notifications count:", err);
    }
  }, [currentUser]);

  useEffect(() => {
    fetchUnreadCount();
  }, [currentUser, fetchUnreadCount]);

  // Realtime: subscribe to user channel for badge updates
  useEffect(() => {
    if (!currentUser?.id) return;
    const channel = `user:${currentUser.id}`;
    let subscribed = false;
    insforge.realtime.connect().then(() => {
      insforge.realtime.subscribe(channel).then(() => { subscribed = true; });
    }).catch(() => {});
    const onNotif = () => fetchUnreadCount();
    insforge.realtime.on('new_notification', onNotif);
    return () => {
      insforge.realtime.off?.('new_notification', onNotif);
      if (subscribed) insforge.realtime.unsubscribe(channel);
    };
  }, [currentUser?.id, fetchUnreadCount]);

  useEffect(() => {
    if (currentUser?.id) {
      fetchUserTickets(currentUser.id);
    } else {
      setAllTickets([]);
    }
  }, [currentUser]);

  const handleBookEvent = useCallback((event: Event) => {
    if (!currentUser) {
      console.warn("User must be logged in to book / RSVP");
      navigateTo('auth');
      return;
    }

    const alreadyBooked = allTickets.some((t) => t.event.id === event.id);
    if (alreadyBooked) {
      return;
    }

    const defaultTicketType = event.ticketTypes?.[0] || {
      id: 't1',
      name: 'Regular',
      price: Number(event.price || 0),
      description: 'General Admission',
      available: 500
    };

    setSelectedTicketType(defaultTicketType);
    setSelectedTicketQty(1);
    navigateTo('checkout');
  }, [currentUser, allTickets, navigateTo]);
  // Midnight Neon is always enforced
  const isDark = true;
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);
  const [conversationUser, setConversationUser] = useState<{ id: string; name: string; avatarUrl?: string; vc_badge?: string } | null>(null);
  const [conversationEventId, setConversationEventId] = useState<string | undefined>(undefined);
  const [conversationEventTitle, setConversationEventTitle] = useState<string | undefined>(undefined);
  const [exploreTab, setExploreTab] = useState<'people' | 'chats'>('people');

  const [selectedState, setSelectedState] = useState<string>(() => {
    return localStorage.getItem('selected_state_preference') || NIGERIA_STATES[0].name;
  });

  const [pendingSignup, setPendingSignup] = useState(false);
  const [orgEvents, setOrgEvents] = useState<OrganizerEvent[]>([]);

  // Simulate review pipeline: under_review → approved (after 5s) → live (after 3s more)
  const underReviewIds = orgEvents.filter((e) => e.status === 'under_review').map((e) => e.id).join(',');
  const approvedIds = orgEvents.filter((e) => e.status === 'approved').map((e) => e.id).join(',');

  useEffect(() => {
    if (!underReviewIds) return;
    const ids = underReviewIds.split(',').filter(Boolean);
    const timers = ids.map((id) =>
      setTimeout(() => {
        setOrgEvents((prev) =>
          prev.map((e) => (e.id === id && e.status === 'under_review' ? { ...e, status: 'approved' } : e))
        );
      }, 5000)
    );
    return () => timers.forEach(clearTimeout);
  }, [underReviewIds]);

  useEffect(() => {
    if (!approvedIds) return;
    const ids = approvedIds.split(',').filter(Boolean);
    const timers = ids.map((id) =>
      setTimeout(() => {
        setOrgEvents((prev) =>
          prev.map((e) => (e.id === id && e.status === 'approved' ? { ...e, status: 'live' } : e))
        );
      }, 3000)
    );
    return () => timers.forEach(clearTimeout);
  }, [approvedIds]);



  const handleTabChange = useCallback((tab: TabId) => {
    setActiveTab(tab);
    setScreen(TAB_SCREENS[tab]);
    setScreenStack([]);
  }, []);

  const handleOrgTabChange = useCallback((tab: OrgTab) => {
    setOrgTab(tab);
    setActiveTab(tab as TabId);
    setScreen(TAB_SCREENS[tab as TabId] ?? (tab as Screen));
    setScreenStack([]);
  }, []);

  const handleEventPress = useCallback((event: Event) => {
    trackEvent('event_viewed', { eventId: event.id });
    // Jumping straight from one event's details to another (e.g. tapping a
    // "Related Events" card) — stash the current event so Back can restore
    // it instead of getting stuck (see eventHistoryStack above).
    if (screen === 'event-details' && selectedEvent && selectedEvent.id !== event.id) {
      setEventHistoryStack((s) => [...s, selectedEvent]);
    }
    setSelectedEvent(event);
    navigateTo('event-details');
  }, [navigateTo, screen, selectedEvent]);

  const handleGetTickets = useCallback((ticketType: TicketType) => {
    setSelectedTicketType(ticketType);
    navigateTo('ticket-select');
  }, [navigateTo]);

  const handleCheckoutSuccess = useCallback(async (ticket: PurchasedTicket) => {
    if (currentUser) {
      try {
        // Guard: skip re-inserting if this user already has active ticket(s)
        // for this event. A group purchase creates one row per attendee, so
        // this can no longer assume "at most one" row — .limit(1) instead of
        // .maybeSingle(), which would throw once more than one row exists.
        const { data: existingTickets, error: checkError } = await insforge.database
          .from('tickets')
          .select('id')
          .eq('event_id', ticket.event.id)
          .eq('user_id', currentUser.id)
          .eq('status', 'active')
          .limit(1);

        if (checkError) throw checkError;

        if (!existingTickets || existingTickets.length === 0) {
          // Every ticket in the group needs its own name+email so each gets
          // a distinct row (and QR code) the door scanner can check in
          // individually. CheckoutScreen always supplies `attendees` for
          // group (quantity > 1) purchases; fall back to a single entry
          // built from the ticket's own holder fields for the instant
          // free-ticket path (quantity === 1, no CheckoutScreen involved).
          const attendees = ticket.attendees && ticket.attendees.length > 0
            ? ticket.attendees
            : [{ name: ticket.holderName || currentUser.full_name || 'Guest', email: currentUser.email }];

          // p_payment_status is no longer accepted from the client — the RPC
          // now derives paid/pending purely from the event's own server-side
          // price, and only confirm_ticket_payment (webhook-verified) can
          // ever flip a priced ticket to 'paid'.
          // purchase_ticket re-validates the promo code itself (expiry,
          // usage limit, active flag) rather than trusting that it was
          // still valid at the moment CheckoutScreen's "Apply" check ran —
          // if it's since gone stale, this call throws and no ticket is
          // created, same as any other validation failure here.
          const { error: insertError } = await insforge.database.rpc('purchase_ticket', {
            p_event_id: ticket.event.id,
            p_ticket_type: ticket.ticketType?.name ?? 'General',
            p_attendees: attendees,
            p_payment_ref: ticket.ticketId ?? `VNT-${Date.now()}`,
            p_promo_code: ticket.promoCode || null,
          });
          if (insertError) throw insertError;
          if (currentUser?.phone_number) {
            sendSMS({
              to: currentUser.phone_number,
              message: `Your ticket for ${ticket.event.title} has been confirmed! Check the Vents app for your QR code. - Vents`,
            }).catch(() => {});
          }
          trackPushEvent('ticket_purchased', { eventId: ticket.event.id, eventTitle: ticket.event.title });
          trackEvent('ticket_booked', { eventId: ticket.event.id, amount: ticket.totalAmount });

          // 3.6: Ticket confirmation notification
          insforge.database.from('notifications').insert([{
            user_id: currentUser.id,
            type: 'booking',
            title: 'Ticket confirmed! 🎉',
            body: attendees.length > 1
              ? `Your ${attendees.length} ${ticket.ticketType?.name ?? 'General'} tickets for ${ticket.event.title} are confirmed.`
              : `Your ${ticket.ticketType?.name ?? 'General'} ticket for ${ticket.event.title} is confirmed.`,
            icon: '🎟️',
          }]).then(({ error: notifyErr }: any) => {
            if (notifyErr) console.warn('Ticket notify failed:', notifyErr.message);
          });
        }

        // Wait for tickets and events list refresh
        await fetchUserTickets(currentUser.id);
        await fetchEvents(true);
      } catch (err) {
        console.error("Failed to insert ticket on checkout:", err);
      }
    }
    setPurchasedTicket(ticket);
    setScreenStack([]);
    setScreen('payment-success');
  }, [currentUser, fetchEvents, fetchUserTickets]);

  const handleTicketContinue = useCallback((ticketType: TicketType, qty: number) => {
    if (!currentUser) {
      navigateTo('auth');
      return;
    }
    setSelectedTicketType(ticketType);
    setSelectedTicketQty(qty);
    // A single free ticket can skip straight to confirmation. Anything
    // needing more than one attendee's details -- including a free group
    // RSVP -- goes through CheckoutScreen's attendee form so every ticket
    // in the group gets its own name/email (and its own QR code).
    if ((ticketType.price ?? 0) === 0 && qty === 1) {
      const freeTicket: PurchasedTicket = {
        ticketId: `VNT-FREE-${Date.now()}`,
        event: selectedEvent!,
        ticketType,
        quantity: qty,
        totalAmount: 0,
        purchasedAt: new Date().toISOString(),
        holderName: currentUser.full_name || currentUser.username || '',
      };
      handleCheckoutSuccess(freeTicket);
      return;
    }
    navigateTo('checkout');
  }, [navigateTo, selectedEvent, handleCheckoutSuccess]);

  const handleToggleSave = useCallback(async (eventId: string) => {
    if (!currentUser) {
      console.warn("User must be logged in to save events");
      navigateTo('auth');
      return;
    }

    const isSaved = savedEvents.includes(eventId);
    trackEvent(isSaved ? 'event_unsaved' : 'event_saved', { eventId });
    // Optimistic update
    setSavedEvents((prev) =>
      isSaved ? prev.filter((id) => id !== eventId) : [...prev, eventId]
    );

    try {
      if (isSaved) {
        const { error } = await insforge.database
          .from('saved_events')
          .delete()
          .eq('user_id', currentUser.id)
          .eq('event_id', eventId);
        if (error) throw error;
      } else {
        const { error } = await insforge.database
          .from('saved_events')
          .insert([{
            user_id: currentUser.id,
            event_id: eventId
          }]);
        if (error) throw error;
      }
    } catch (err) {
      console.error("Failed to toggle save event:", err);
      // Revert optimistic update
      setSavedEvents((prev) =>
        isSaved ? [...prev, eventId] : prev.filter((id) => id !== eventId)
      );
    }
  }, [currentUser, savedEvents]);

  const handleProfileNavigate = useCallback((target: string) => {
    if (target === 'welcome') {
      setScreen('welcome');
      setScreenStack([]);
      return;
    }
    if (target === 'saved') {
      navigateTo('saved');
      return;
    }
    navigateTo(target as Screen);
  }, [handleTabChange, navigateTo]);

  const handleTicketsPress = useCallback(() => {
    navigateTo('my-tickets');
  }, [navigateTo]);

  const handleOrgNavigate = useCallback((target: string) => {
    // A generic "Create Event" entry point (not the edit flow's own
    // onOpenEdit, which sets editingEventId itself) — always start fresh.
    if (target === 'create-event') setEditingEventId(null);
    navigateTo(target as Screen);
  }, [navigateTo]);

  const handleAuthSuccess = useCallback(async (userProfile: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; avatar_url?: string; cover_url?: string; isOrganizer?: boolean; is_verified?: boolean; vc_badge?: string }) => {
    const enriched = {
      ...userProfile,
      isOrganizer: userProfile.role === 'organizer' || userProfile.role === 'organiser' || !!userProfile.isOrganizer
    };
    setCurrentUser(enriched);
    setPushAlertSubscriber(userProfile.id, userProfile.email);
    identifyUser(userProfile.id, { email: userProfile.email, role: userProfile.role, username: userProfile.username });
    setScreenStack([]);
    // Check if new user needs to pick interests
    try {
      const { data } = await insforge.database.from('users').select('interests').eq('id', userProfile.id).maybeSingle();
      if (!data?.interests || data.interests.length === 0) {
        setShowInterests(true);
      }
    } catch { /* ignore — don't block login on interests check failure */ }
  }, []);

  const handleSignOut = useCallback(async () => {
    setAuthLoading(true);
    await clearRefreshToken();
    try {
      await insforge.auth.signOut();
    } catch (err) {
      console.error("Sign out error:", err);
    }
    setCurrentUser(null);
    setUserRole('attendee');
    setScreen('welcome');
    setScreenStack([]);
    setActiveTab('home');
    setAuthLoading(false);
  }, []);

  // Screens where the bottom nav is visible for both roles.
  // Guests browse these screens too (home-first flow) — the nav must stay
  // visible for them; individual screens handle their own auth prompts.
  const navScreens = ['home', 'explore', 'my-tickets', 'profile'];
  const showBottomNav = navScreens.includes(screen);

  // Determine if the current user is organizer/admin (for nav FAB)
  const isOrganizerOrAdmin =
    userRole === 'organizer' ||
    currentUser?.role === 'admin' ||
    currentUser?.id === ROOT_UID;

  if (updateRequired) {
    return (
      <div
        style={{
          background: '#020005', width: '100%', height: '100vh', display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '32px 24px', textAlign: 'center', fontFamily: 'Inter, sans-serif',
        }}
      >
        <div style={{ width: '72px', height: '72px', borderRadius: '20px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px', boxShadow: '0 8px 30px rgba(123,47,190,0.35)' }}>
          <span style={{ fontSize: '32px' }}>⬆️</span>
        </div>
        <h1 style={{ color: '#FFFFFF', fontSize: '20px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '10px' }}>
          Update Required
        </h1>
        <p style={{ color: '#94A3B8', fontSize: '14px', lineHeight: 1.6, marginBottom: '28px', maxWidth: '300px' }}>
          A new version of Vents is available with important fixes. Please refresh to continue.
        </p>
        <button
          onClick={() => window.location.href = 'https://getvents.com'}
          style={{ background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', border: 'none', borderRadius: '100px', padding: '14px 32px', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: 'pointer' }}
        >
          Reload Vents
        </button>
      </div>
    );
  }

  // Maintenance-mode gate: locks the app for everyone except admins/root,
  // who always bypass so the platform can be managed while it's "down" for
  // everyone else. Held off until auth has resolved so we know whether the
  // current user qualifies for the bypass before deciding to block them.
  const isMaintenanceBypass = currentUser?.role === 'admin' || currentUser?.role === 'sub-admin' || currentUser?.id === ROOT_UID;
  if (maintenanceMode && !authLoading && !isMaintenanceBypass) {
    return (
      <div
        style={{
          background: '#020005', width: '100%', height: '100vh', display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '32px 24px', textAlign: 'center', fontFamily: 'Inter, sans-serif',
        }}
      >
        <div style={{ width: '72px', height: '72px', borderRadius: '20px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px', boxShadow: '0 8px 30px rgba(123,47,190,0.35)' }}>
          <span style={{ fontSize: '32px' }}>🛠️</span>
        </div>
        <h1 style={{ color: '#FFFFFF', fontSize: '20px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '10px' }}>
          Under Maintenance
        </h1>
        <p style={{ color: '#94A3B8', fontSize: '14px', lineHeight: 1.6, maxWidth: '300px' }}>
          Vents is temporarily down for scheduled maintenance. We'll be back shortly — thanks for your patience.
        </p>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{
        background: 'linear-gradient(135deg, #050010 0%, #000000 50%, #080014 100%)',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      <style>{`
        .light-theme { color-scheme: light; }
        .phone-frame {
          position: fixed;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
          width: 390px;
          max-width: 100vw;
          height: 100%;
        }
      `}</style>
      {/* Phone frame */}
      <div
        className="phone-frame relative overflow-hidden"
        style={{ background: '#000000' }}
      >
        <ErrorBoundary>
          {authError && (
            <div
              style={{
                position: 'absolute',
                top: '50px',
                left: '16px',
                right: '16px',
                background: 'rgba(239, 68, 68, 0.95)',
                color: '#fff',
                padding: '12px 16px',
                borderRadius: '12px',
                fontSize: '13px',
                fontWeight: 600,
                zIndex: 9999,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
              }}
            >
              <span style={{ marginRight: '8px' }}>{authError}</span>
              <button
                onClick={() => setAuthError(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#fff',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  padding: '0 4px'
                }}
              >
                ✕
              </button>
            </div>
          )}
          <div className="absolute inset-0">
            {/* ── AUTH FLOW ── */}
            {authLoading ? (
              <SplashScreen onComplete={handleSplashComplete} />
            ) : (
              <>
                {screen === 'splash' && (
                  <SplashScreen onComplete={handleSplashComplete} />
                )}
                {screen === 'welcome' && (
            <WelcomeScreen
              onGetStarted={() => {
                setPendingSignup(true);
                setAuthMode('signup');
                navigateTo('role-select');
              }}
              onSignIn={() => {
                setPendingSignup(false);
                setAuthMode('login');
                navigateTo('auth');
              }}
              onPickState={() => {
                setPendingSignup(true);
                setAuthMode('signup');
                navigateTo('role-select');
              }}
              onBrowseGuest={() => {
                setScreen('home');
                setActiveTab('home');
              }}
            />
          )}
          {screen === 'role-select' && (
            <RoleSelectScreen
              onBack={goBack}
              onSelect={async (role) => {
                if (currentUser) {
                  // Already logged in — switch mode directly without re-auth
                  if (role === 'organizer') {
                    setUserRole('organizer');
                    setOrgTab('home');
                    setActiveTab('home');
                    setScreen('home');
                    setScreenStack([]);
                    if (currentUser.id && currentUser.role !== 'admin') {
                      setCurrentUser(prev => prev ? { ...prev, role: 'organizer', isOrganizer: true } : null);
                      localStorage.setItem(`vents_was_organizer_${currentUser.id}`, '1');
                      try {
                        await insforge.database.rpc('promote_to_organizer');
                      } catch (err) {
                        console.error('Failed to promote to organizer:', err);
                      }
                    }
                  } else {
                    setUserRole('attendee');
                    setScreen('home');
                    setActiveTab('home');
                    setScreenStack([]);
                  }
                } else {
                  setUserRole(role);
                  navigateTo('auth');
                }
              }}
            />
          )}
          {screen === 'auth' && (
            <AuthScreen
              initialMode={authMode}
              userRole={userRole}
              selectedState={selectedState}
              onBack={goBack}
              onSuccess={handleAuthSuccess}
              resetToken={resetToken}
              signupsDisabled={featureFlags.disableSignups}
            />
          )}

          {/* ── INTERESTS ONBOARDING (new users) ── */}
          {showInterests && currentUser && (
            <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: '#060A12' }}>
              <InterestsScreen
                userId={currentUser.id}
                onDone={() => setShowInterests(false)}
              />
            </div>
          )}

          {/* ── ATTENDEE MAIN TABS ── */}
          {screen === 'home' && (
            <HomeScreen
              onEventPress={handleEventPress}
              savedEvents={savedEvents}
              onToggleSave={handleToggleSave}
              onSearchPress={() => handleTabChange('explore')}
              onNotificationsPress={() => navigateTo('notifications')}
              onProfilePress={() => handleTabChange('profile')}
              onCreatePress={() => navigateTo('org-dashboard')}
              onUserPress={async (u) => {
                const { data } = await insforge.database
                  .from('public_profiles')
                  .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role, interests, bio, vc_badge')
                  .eq('id', u.id)
                  .maybeSingle();
                if (data) { setSelectedUser(mapDbUserToUserProfile(data)); navigateTo('user-profile'); }
              }}
              selectedState={selectedState}
              onStateChange={setSelectedState}
              onLiveMapPress={() => navigateTo('nigeria-live')}
              dbEvents={dbEvents}
              loading={loadingEvents}
              fetchEvents={fetchEvents}
              currentUser={currentUser}
              hasMore={hasMoreEvents}
              onLoadMore={() => fetchEvents(false, true)}
              unreadNotificationsCount={unreadCount}
            />
          )}
          {screen === 'explore' && (
            <ExploreScreen
              onUserPress={(user) => {
                setSelectedUser(user);
                navigateTo('user-profile');
              }}
              currentUserId={currentUser?.id}
              onOpenConversation={(userId, userName, avatarUrl, vcBadge) => {
                setConversationUser({ id: userId, name: userName, avatarUrl, vc_badge: vcBadge });
                setExploreTab('chats');
                navigateTo('conversation');
              }}
              chatRefreshKey={chatRefreshKey}
              initialTab={exploreTab}
              onTabChange={setExploreTab}
            />
          )}
          {screen === 'saved' && (
            <SavedScreen
              savedEventIds={savedEvents}
              onEventPress={handleEventPress}
              onToggleSave={handleToggleSave}
              dbEvents={dbEvents}
              onBack={screenStack.length > 0 ? goBack : undefined}
            />
          )}
          {screen === 'profile' && (
            <ProfileScreen
              currentUser={currentUser ? { ...currentUser, hasBeenOrganizer: localStorage.getItem(`vents_was_organizer_${currentUser.id}`) === '1' } : null}
              userRole={userRole}
              onSignOut={handleSignOut}
              tickets={allTickets}
              savedCount={savedEvents.length}
              onViewTicket={(ticket) => {
                setPurchasedTicket(ticket);
                navigateTo('payment-success');
              }}
              onNavigate={handleProfileNavigate}
              unreadNotificationsCount={unreadCount}
              onBecomeOrganizer={async () => {
                setUserRole('organizer');
                setOrgTab('home');
                setActiveTab('home');
                setScreen('home');
                setScreenStack([]);
                if (currentUser?.id && currentUser.role !== 'admin') {
                  setCurrentUser(prev => prev ? { ...prev, role: 'organizer', isOrganizer: true } : null);
                  localStorage.setItem(`vents_was_organizer_${currentUser.id}`, '1');
                  const { error: promoteErr1 } = await insforge.database.rpc('promote_to_organizer');
                  if (!promoteErr1 || promoteErr1?.message?.includes('already been set')) {
                    const { error: logErr1 } = await insforge.database.rpc('log_organizer_promotion' as any, {
                      p_user_id: currentUser.id,
                      p_email: currentUser.email || '',
                      p_username: currentUser.username || '',
                    });
                    if (logErr1) console.warn('Organizer log failed:', logErr1.message, logErr1.code);
                  }
                }
              }}
              setActiveView={async (view) => {
                if (view === 'organizer') {
                  // Always update local nav state; admin skips DB/badge changes
                  setUserRole('organizer');
                  setOrgTab('home');
                  setActiveTab('home');
                  setScreen('home');
                  if (currentUser?.id) {
                    localStorage.setItem(`vents_was_organizer_${currentUser.id}`, '1');
                    if (currentUser.role !== 'admin') {
                      setCurrentUser(prev => prev ? { ...prev, role: 'organizer' } : null);
                      const { error: promoteErr } = await insforge.database.rpc('promote_to_organizer');
                      const alreadyOrganizer = promoteErr?.message?.includes('already been set');
                      if (promoteErr && !alreadyOrganizer) {
                        console.error('Failed to promote to organizer:', JSON.stringify(promoteErr));
                        setCurrentUser(prev => prev ? { ...prev, role: 'user' } : null);
                        setUserRole('attendee');
                        setScreen('profile');
                      } else {
                        const { error: logErr2 } = await insforge.database.rpc('log_organizer_promotion' as any, {
                          p_user_id: currentUser.id,
                          p_email: currentUser.email || '',
                          p_username: currentUser.username || '',
                        });
                        if (logErr2) console.warn('Organizer log failed:', logErr2.message, logErr2.code);
                      }
                    }
                    // Fetch this organizer's events from DB and populate orgEvents
                    try {
                      const { data: dbOrgEvents } = await insforge.database
                        .from('events')
                        .select('*')
                        .eq('organizer_id', currentUser.id);
                      if (dbOrgEvents && dbOrgEvents.length > 0) {
                        const mapped: OrganizerEvent[] = (dbOrgEvents as any[]).map((e: any) => ({
                          id: e.id,
                          title: e.title || '',
                          category: e.category || 'Other',
                          description: e.description || '',
                          date: e.event_date ? e.event_date.split('T')[0] : '',
                          startTime: e.event_date ? (e.event_date.includes('T') ? e.event_date.split('T')[1].slice(0, 5) : '') : '',
                          venue: e.location || '',
                          city: '',
                          capacity: '1000',
                          ticketName: 'Regular',
                          ticketPrice: String(e.price || '0'),
                          ticketQty: '1000',
                          contactPhone: '',
                          showPhone: false,
                          status: (e.status === 'live' ? 'approved' : e.status === 'draft' ? 'under_review' : e.status) as any,
                          createdAt: new Date(e.created_at).getTime(),
                        }));
                        setOrgEvents(mapped);
                      }
                    } catch (err) {
                      console.error('Failed to fetch organizer events:', err);
                    }
                  }
                } else {
                  setUserRole('attendee');
                  setActiveTab('home');
                  setScreen('home');
                  if (currentUser?.id) {
                    setCurrentUser(prev => prev ? { ...prev, isOrganizer: true } : null);
                  }
                }
              }}
            />
          )}
          {screen === 'admin-dashboard' && (
            <AdminDashboardScreen
              onBack={goBack}
              currentUser={currentUser}
            />
          )}

          {screen === 'checkin-scanner' && (
            <CheckinScannerScreen
              onBack={goBack}
              currentUser={currentUser}
              selectedEvent={selectedEvent}
              scanningDisabled={featureFlags.disableScanning}
            />
          )}

          {/* ── UTILITY SCREENS ── */}
          {screen === 'notifications' && (
            <NotificationsScreen
              onBack={goBack}
              currentUser={currentUser}
              onRefreshUnread={fetchUnreadCount}
            />
          )}
          {screen === 'my-tickets' && (
            <MyTicketsScreen
              tickets={allTickets}
              loading={ticketsLoading}
              onBack={goBack}
              onViewTicket={(ticket) => {
                setPurchasedTicket(ticket);
                navigateTo('payment-success');
              }}
              onRefresh={currentUser ? () => fetchUserTickets(currentUser.id) : undefined}
            />
          )}
          {screen === 'settings' && (
          <SettingsScreen
              currentUser={currentUser}
              onBack={goBack}
              onSignOut={handleSignOut}
              onNavigate={navigateTo}
              isDark={true}
              onToggleDark={() => {}}
              onProfileUpdated={(fields) => {
                setCurrentUser((prev) => prev ? { ...prev, ...fields } : null);
              }}
            />
          )}

          {screen === 'privacy-policy' && (
            <PrivacyPolicyScreen onBack={goBack} />
          )}

          {screen === 'help-support' && (
            <HelpSupportScreen onBack={goBack} />
          )}

          {screen === 'privacy-security' && (
            <PrivacySecurityScreen currentUser={currentUser} onBack={goBack} />
          )}

          {/* ── EVENT FLOW ── */}
          {screen === 'event-details' && selectedEvent && (
            <EventDetailsScreen
              key={selectedEvent.id}
              event={selectedEvent}
              onBack={goBack}
              onGetTickets={handleTicketContinue}
              isSaved={savedEvents.includes(selectedEvent.id)}
              onToggleSave={() => handleToggleSave(selectedEvent.id)}
              isBooked={currentUser ? allTickets.some((t) => t.event.id === selectedEvent.id) : false}
              onBook={() => handleBookEvent(selectedEvent)}
              bookingLoading={bookingLoading}
              onEventPress={handleEventPress}
              currentUserId={currentUser?.id}
              currentUserRole={currentUser?.role}
              onOpenDoorScanner={() => navigateTo('checkin-scanner')}
              purchasesDisabled={featureFlags.disablePurchases}
              onOrganizerPress={async (organizerId) => {
                const { data } = await insforge.database
                  .from('public_profiles')
                  .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role, interests, bio, vc_badge')
                  .eq('id', organizerId)
                  .maybeSingle();
                if (data) { setSelectedUser(mapDbUserToUserProfile(data)); navigateTo('user-profile'); }
              }}
              onMessageOrganizer={async (organizerId, eventId, eventTitle) => {
                const { data } = await insforge.database
                  .from('public_profiles')
                  .select('id, full_name, username, avatar_url')
                  .eq('id', organizerId)
                  .maybeSingle();
                setConversationUser({
                  id: organizerId,
                  name: data?.full_name || data?.username || 'Organizer',
                  avatarUrl: data?.avatar_url,
                });
                setConversationEventId(eventId);
                setConversationEventTitle(eventTitle);
                navigateTo('conversation');
              }}
            />
          )}
          {screen === 'ticket-select' && selectedEvent && (
            <TicketSelectScreen
              event={selectedEvent}
              onBack={goBack}
              onContinue={handleTicketContinue}
            />
          )}
          {screen === 'checkout' && selectedEvent && selectedTicketType && (
            <CheckoutScreen
              event={selectedEvent}
              ticketType={selectedTicketType}
              quantity={selectedTicketQty}
              currentUser={currentUser}
              onBack={goBack}
              onSuccess={handleCheckoutSuccess}
            />
          )}
          {screen === 'payment-success' && purchasedTicket && (
            <PaymentSuccessScreen
              ticket={purchasedTicket}
              onViewTickets={() => {
                setScreenStack([]);
                setScreen('my-tickets');
              }}
              onGoHome={() => {
                setScreen('home');
                setActiveTab('home');
                setScreenStack([]);
              }}
            />
          )}

          {/* ── ORGANIZER FLOW ── */}
          {screen === 'org-dashboard' && (
            <OrganizerDashboard
              currentUser={currentUser}
              onBack={goBack}
              onNavigate={handleOrgNavigate}
              setActiveView={(view) => {
                if (view === 'attendee') {
                  handleSwitchToAttendee();
                }
              }}
              onScanTickets={(eventId) => {
                // Try dbEvents first, fall back to a minimal event object so scan always opens
                const evtToScan = dbEvents.find(e => e.id === eventId);
                if (evtToScan) {
                  setSelectedEvent(evtToScan);
                } else {
                  // Create a minimal event proxy so CheckinScannerScreen gets the ID
                  setSelectedEvent({ id: eventId } as any);
                }
                navigateTo('checkin-scanner');
              }}
              onEventPress={(event) => {
                // Navigate to event management / analytics for this event
                const mapped = dbEvents.find(e => e.id === event.id);
                if (mapped) setSelectedEvent(mapped);
                navigateTo('event-details');
              }}
              onManageEvents={() => navigateTo('manage-events')}
            />
          )}
          {screen === 'create-event' && (
            <CreateEventScreen
              currentUser={currentUser}
              onBack={() => { setEditingEventId(null); goBack(); }}
              editEventId={editingEventId || undefined}
              onCreated={(event) => {
                trackPushEvent('event_created', { eventId: event.id, eventTitle: event.title });
                trackEvent('event_created', { eventId: event.id });
                setOrgEvents((prev) => [event, ...prev]);
                fetchEvents(true);
                setOrgTab('home');
                setScreen('manage-events');
                setScreenStack([]);
              }}
              onUpdated={(event) => {
                setOrgEvents((prev) => prev.map((e) => (e.id === event.id ? event : e)));
                fetchEvents(true);
                setEditingEventId(null);
                setOrgTab('home');
                setScreen('manage-events');
                setScreenStack([]);
              }}
            />
          )}
          {screen === 'manage-events' && (
            <ManageEventsScreen
              onBack={goBack}
              onNavigate={handleOrgNavigate}
              orgEvents={orgEvents}
              onEditEvent={(id, updates) =>
                setOrgEvents((prev) => prev.map((e) => (e.id === id ? { ...e, ...updates } : e)))
              }
              onOpenEdit={(eventId) => {
                setEditingEventId(eventId);
                navigateTo('create-event');
              }}
              onDeleteEvent={(id) =>
                setOrgEvents((prev) => prev.filter((e) => e.id !== id))
              }
              onPromoteEvent={(eventId) => {
                setPromotionEventId(eventId);
                navigateTo('promote-event');
              }}
            />
          )}
          {screen === 'sales-analytics' && (
            <SalesAnalyticsScreen currentUser={currentUser} onBack={goBack} />
          )}
          {screen === 'attendee-list' && (
            <AttendeeListScreen onBack={goBack} eventId={selectedEvent?.id} eventTitle={selectedEvent?.title} />
          )}
          {screen === 'promote-event' && (
            <PromoteEventScreen
              onBack={() => {
                setPromotionEventId('');
                goBack();
              }}
              currentUser={currentUser}
              initialEventId={promotionEventId}
              onPromoted={() => fetchEvents(true)}
            />
          )}

          {/* ── REFERRAL ── */}
          {screen === 'referral' && (
            <ReferralScreen onBack={goBack} currentUser={currentUser} />
          )}

          {/* ── INBOX ── */}
          {screen === 'inbox' && currentUser && (
            <InboxScreen
              currentUser={currentUser}
              onBack={goBack}
              onOpenConversation={(other) => {
                setConversationUser(other);
                navigateTo('conversation');
              }}
            />
          )}

          {/* ── WALLET ── */}
          {screen === 'wallet' && (
            <WalletScreen currentUser={currentUser} onBack={goBack} />
          )}

          {/* ── CONVERSATION ── */}
          {screen === 'conversation' && currentUser && conversationUser && (
            <ConversationScreen
              currentUser={currentUser}
              otherUser={conversationUser}
              eventId={conversationEventId}
              eventTitle={conversationEventTitle}
              onBack={goBack}
              onNavigateToProfile={async (userId) => {
                const { data } = await insforge.database
                  .from('public_profiles')
                  .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role, interests, bio, vc_badge')
                  .eq('id', userId)
                  .maybeSingle();
                if (data) { setSelectedUser(mapDbUserToUserProfile(data)); navigateTo('user-profile'); }
              }}
            />
          )}

          {/* ── NIGERIA LIVE MAP ── */}
          {screen === 'nigeria-live' && (
            <NigeriaLiveScreen onBack={goBack} />
          )}

          {/* ── USER PROFILE ── */}
          {screen === 'user-profile' && selectedUser && (
            <UserProfileScreen
              user={selectedUser}
              onBack={goBack}
              onEventPress={handleEventPress}
              currentUserId={currentUser?.id}
              onMessage={(userId) => {
                setConversationUser({
                  id: userId,
                  name: selectedUser.name,
                  avatarUrl: selectedUser.avatar_url,
                });
                setConversationEventId(undefined);
                setConversationEventTitle(undefined);
                navigateTo('conversation');
              }}
            />
          )}
              </>
            )}
          </div>

        {/* Bottom navigation — shared for attendees (4 tabs) and organizers/admin (5 tabs) */}
        {showBottomNav && (
          <BottomNav
            activeTab={activeTab}
            onTabChange={handleTabChange}
            onFabPress={() => {
              if (isOrganizerOrAdmin) {
                navigateTo('org-dashboard');
              } else {
                handleTicketsPress();
              }
            }}
            isOrganizer={isOrganizerOrAdmin}
          />
        )}

        </ErrorBoundary>
      </div>
    </div>
  );
}