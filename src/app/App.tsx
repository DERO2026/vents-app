import React, { useState, useEffect, useCallback, useMemo, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { Screen, TabId, AuthMode, Event, TicketType, PurchasedTicket, UserProfile, UserRole, ServiceProvider } from './components/types';
import { supabase, getAuthToken } from '../lib/supabase';
import { Sentry } from '../lib/sentry';
import { registerPushNotifications, unregisterPushNotifications, setPushActionHandler } from '../lib/pushNotifications';
import { Capacitor } from '@capacitor/core';
import { apiUrl } from '../lib/apiBase';
import { getPendingVerification, clearPendingVerification } from '../lib/pendingVerification';
import { openExternalUrl } from '../lib/externalLink';
import { identifyUser, capturePageview } from '../lib/analytics';
import { analytics } from '../lib/analyticsEvents';
import { prefetchTicketTokens, cacheTicketToken, ensureTicketToken } from '../lib/ticketToken';
import { hasCapability, hasAnyOrganizerCapability, SCREEN_CAPABILITY, ROOT_UID } from '../lib/permissions';
import { PermissionSheetHost } from './components/shared/PermissionSheetHost';
import { useSwipeBack } from '../lib/useSwipeBack';

import { WelcomeScreen } from './components/WelcomeScreen';
import { CountrySelectScreen } from './components/CountrySelectScreen';
import { ServicesHomeScreen } from './components/ServicesHomeScreen';
import { ServiceCategoryScreen } from './components/ServiceCategoryScreen';
import { ServiceProviderProfileScreen } from './components/ServiceProviderProfileScreen';
import { ServiceProviderSetupScreen } from './components/ServiceProviderSetupScreen';
import { AuthScreen } from './components/AuthScreen';
import { HomeScreen, mapDbEventToFrontend } from './components/HomeScreen';
import { ExploreScreen, mapDbUserToUserProfile } from './components/ExploreScreen';
import { SavedScreen } from './components/SavedScreen';
import { ProfileScreen } from './components/ProfileScreen';
import { BottomNav } from './components/BottomNav';
import { OrgTab } from './components/OrganizerBottomNav';
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
import { PaymentFailedScreen } from './components/PaymentFailedScreen';
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
import { DoorManagerScreen } from './components/DoorManagerScreen';
import { ReferralScreen } from './components/ReferralScreen';
import { InterestsScreen } from './components/InterestsScreen';
import { PrivacySecurityScreen } from './components/PrivacySecurityScreen';

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
    Sentry.captureException(error, { extra: { componentStack: errorInfo.componentStack } });
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
  const [screen, setScreen] = useState<Screen>('splash');
  // Flips true the first time the user reaches Home, then stays true for
  // the rest of the session -- see the HomeScreen render call site below,
  // which uses this (instead of `screen === 'home'`) to decide whether to
  // mount HomeScreen at all, so it mounts once and is only ever hidden/
  // shown afterward, never destroyed and recreated on every tab switch.
  const [homeEverMounted, setHomeEverMounted] = useState(false);
  useEffect(() => {
    if (screen === 'home') setHomeEverMounted(true);
  }, [screen]);
  const [activeTab, setActiveTab] = useState<TabId>('home');
  const [orgTab, setOrgTab] = useState<OrgTab>('home');
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | undefined>(undefined);
  const [pendingResetEmail, setPendingResetEmail] = useState<string | undefined>(undefined);
  const [pendingPaymentRef, setPendingPaymentRef] = useState<string | undefined>(undefined);
  const [screenStack, setScreenStack] = useState<Screen[]>([]);
  // Tracks events viewed via the in-page "Related Events" carousel while
  // already on the event-details screen. navigateTo('event-details') is a
  // no-op for `screen` when it's already that value (React bails the
  // update), so without this, Back had nothing to actually restore — the
  // view got stuck on whichever related event was tapped last.
  const [eventHistoryStack, setEventHistoryStack] = useState<Event[]>([]);
  // Kept in sync below so the backButton listener (registered once on mount)
  // always sees current values without re-subscribing on every navigation.
  const screenRef = useRef(screen);
  const screenStackRef = useRef(screenStack);
  const goBackRef = useRef<() => void>(() => {});
  const [currentUser, setCurrentUser] = useState<{ id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; avatar_url?: string; cover_url?: string; isOrganizer?: boolean; vc_badge?: string; is_verified?: boolean; is_service_provider?: boolean; country?: string } | null>(null);
  const [showInterests, setShowInterests] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  // Set when the 15s hydration safety timeout fires — lets the Splash
  // Routing Effect below still route a currentUser that arrives late (after
  // Welcome was already shown as a fallback) into the app, instead of
  // stranding a genuinely-logged-in user on the sign-in screen.
  const [hydrationTimedOut, setHydrationTimedOut] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // A ?event=/?user= deep link fetch is async and can resolve after the
  // splash routing effect below has already flipped away from 'splash' —
  // that's harmless on its own (the deep link's setScreen call still wins,
  // last write applies regardless of order), but the splash effect could
  // otherwise route to home/welcome WHILE the fetch is still in flight, and
  // if that fetch then fails or the event is missing/deleted, the user is
  // left on home with the URL already cleaned and no way to retry or even
  // know a link was intended. This ref blocks the splash effect from
  // routing away until any in-flight deep link has resolved one way or the
  // other, and appToastError surfaces a real message on failure instead of
  // silence.
  // Real state, not a ref — the splash routing effect below needs to
  // re-evaluate once a pending deep link resolves, which a ref's mutation
  // alone can't trigger.
  const [deepLinkPending, setDeepLinkPending] = useState(false);
  const [appToastError, setAppToastError] = useState<string | null>(null);
  const [appToastSuccess, setAppToastSuccess] = useState<string | null>(null);
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
  // Bumped on every Home-tab tap so HomeScreen can scroll itself back to
  // top -- see handleTabChange below.
  const [homeScrollSignal, setHomeScrollSignal] = useState(0);
  const [userRole, setUserRole] = useState<UserRole>('attendee');
  const [resetToken, setResetToken] = useState<string | undefined>(undefined);
  const [unreadCount, setUnreadCount] = useState(0);
  const [chatRefreshKey, setChatRefreshKey] = useState(0);
  // Bumped on a Profile-tab re-tap (see handleTabChange) -- forwarded to
  // ProfileScreen as refreshSignal, which turns it into its own internal
  // profileRefreshKey to re-run its existing stats fetch effects.
  const [profileTabRefreshSignal, setProfileTabRefreshSignal] = useState(0);

  const handleSwitchToAttendee = useCallback(() => {
    setUserRole('attendee');
    setActiveTab('home');
    setScreen('home');
    if (currentUser?.id) {
      setCurrentUser(prev => prev ? { ...prev, isOrganizer: true } : null);
    }
  }, [currentUser]);

  const navigateTo = useCallback((next: Screen) => {
    // Capability-based, not a hardcoded role list — see src/lib/permissions.ts.
    const requiredCapability = SCREEN_CAPABILITY[next];
    if (requiredCapability && !hasCapability(currentUser, requiredCapability)) {
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

  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { screenStackRef.current = screenStack; }, [screenStack]);
  useEffect(() => { goBackRef.current = goBack; }, [goBack]);

  // iOS-style edge-swipe-to-go-back — same "can we actually go back" check
  // as the hardware back-button listener above, so both paths agree on when
  // a swipe/press should pop the stack vs. do nothing.
  const swipeBack = useSwipeBack(screenStack.length > 0 || screen === 'event-details', goBack);

  // Forced-update gate + maintenance-mode gate: both read from the same
  // app_config singleton an admin can flip. Polled (not just fetched once)
  // so a maintenance toggle takes effect for already-open tabs without
  // requiring a manual reload.
  useEffect(() => {
    let cancelled = false;
    const checkAppConfig = () => {
      supabase
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

  // Native push registration happens after login (handleAuthSuccess), once we
  // have a user to key the device token to — no mount-time work needed here.

  // Manual $pageview tracking. Navigation here swaps the `screen` state and
  // never changes the URL, so PostHog's automatic pageview capture can't see
  // it — every tab/route change (handleTabChange sets `screen` too) is fired
  // as an explicit $pageview keyed to the screen name. The ref dedupes so a
  // re-render that doesn't change the screen doesn't double-count.
  const lastPageviewRef = useRef<string>('');
  useEffect(() => {
    if (screen === 'splash') return;
    if (lastPageviewRef.current === screen) return;
    lastPageviewRef.current = screen;
    capturePageview(screen, { screen, tab: activeTab });
  }, [screen, activeTab]);

  // Keep currentUser.role in sync with the DB. Without this, a role change
  // made server-side (e.g. Root promoting someone to Sub-Admin from the
  // Admin Console) would never be reflected client-side until the affected
  // user fully logs out and back in — the Sub-Admin badge and Admin
  // Dashboard link would keep rendering against the stale cached role.
  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    const syncRole = () => {
      supabase
        .from('users')
        .select('role')
        .eq('id', currentUser.id)
        .maybeSingle()
        .then(({ data }) => {
          if (cancelled || !data?.role || data.role === currentUser.role) return;
          setCurrentUser(prev => (prev ? { ...prev, role: data.role } : prev));
        }, () => {});
    };
    syncRole(); // run IMMEDIATELY — a just-promoted organizer must not wait 15s
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
        } else if (window.location.hash.includes('error=')) {
          // Supabase's own /auth/v1/verify redirect (an expired or already-
          // used email confirmation link) appends error info as a URL
          // FRAGMENT, not a query param — the check above alone misses it
          // entirely, so a user hitting a dead link previously just landed
          // silently on the welcome screen with zero explanation.
          const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
          const hashErrorCode = hashParams.get('error_code');
          const hashErrorDescription = hashParams.get('error_description');
          if (hashParams.get('error')) {
            setAuthError(
              hashErrorCode === 'otp_expired'
                ? 'This confirmation link has expired. Please sign up again or request a new code.'
                : (hashErrorDescription ? decodeURIComponent(hashErrorDescription.replace(/\+/g, ' ')) : 'This confirmation link is invalid or has already been used.')
            );
            window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
          }
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

        // Intercept the "Verify Account" link from the verification email:
        // ?verify_email=<email> — jump straight to the OTP screen with the
        // email pre-filled instead of dropping the user on the welcome page.
        const verifyEmailParam = params.get('verify_email');
        if (verifyEmailParam) {
          // Best-effort handoff to the native app when this link is opened
          // in a mobile browser (i.e. we're NOT already running inside the
          // Capacitor WebView — Capacitor.isNativePlatform() is false there,
          // same as everywhere else this distinction is made in this file).
          // vents:// is already handled by the appUrlOpen listener below.
          // If the app isn't installed, or the OS/browser can't resolve the
          // custom scheme, this silently no-ops and the code below still
          // runs, keeping the existing web OTP screen as the fallback —
          // never a dead end either way.
          if (!Capacitor.isNativePlatform()) {
            try {
              window.location.href = `vents://verify?email=${encodeURIComponent(verifyEmailParam)}`;
            } catch { /* unsupported scheme handling — web fallback below still runs */ }
          }
          setPendingVerificationEmail(verifyEmailParam);
          setAuthMode('signup');
          setScreen('auth');
          const cleanUrl = window.location.pathname + window.location.hash;
          window.history.replaceState({}, document.title, cleanUrl);
        }

        // Same handoff pattern as verify_email above, for the "Reset
        // Password" link in the recovery email: ?reset_email=<email> — jump
        // straight to the forgot-password OTP screen with the email
        // pre-filled, instead of dropping the user on the welcome page. The
        // code itself was already sent by the email that carries this link,
        // so this only resumes the in-app OTP step — it must NOT call
        // resetPasswordForEmail again (that would silently invalidate the
        // very code the user is holding).
        const resetEmailParam = params.get('reset_email');
        if (resetEmailParam) {
          if (!Capacitor.isNativePlatform()) {
            try {
              window.location.href = `vents://reset?email=${encodeURIComponent(resetEmailParam)}`;
            } catch { /* unsupported scheme handling — web fallback below still runs */ }
          }
          setPendingResetEmail(resetEmailParam);
          setAuthMode('forgot');
          setScreen('auth');
          const cleanUrl = window.location.pathname + window.location.hash;
          window.history.replaceState({}, document.title, cleanUrl);
        }

        // Recovery path for a Paystack redirect this code doesn't itself
        // trigger — CheckoutScreen.tsx's PaystackPop.setup() call has no
        // callback_url of its own (confirmed against Paystack's docs: the
        // Inline/popup method it uses doesn't support that option; the
        // JS `callback` is the only completion signal for every channel,
        // unchanged). This only fires if the Paystack MERCHANT DASHBOARD's
        // own default callback URL (Settings → Preferences → Payment) is
        // separately configured to point at this app's origin — Paystack
        // appends `?reference=...&trxref=...` when it uses that. Not yet
        // confirmed whether that dashboard setting is configured for this
        // account; harmless either way (a no-op if it never fires) and left
        // in place as a safety net for any channel/challenge flow that
        // leaves the iframe. This is only ever a signal to go verify; the
        // pendingPaymentRef resolver effect is what actually confirms it
        // server-side before showing any success state.
        const paystackRef = params.get('reference') || params.get('trxref');
        if (paystackRef) {
          if (!Capacitor.isNativePlatform()) {
            try {
              window.location.href = `vents://payment?ref=${encodeURIComponent(paystackRef)}`;
            } catch { /* unsupported scheme handling — web fallback below still runs */ }
          }
          setPendingPaymentRef(paystackRef);
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
          setDeepLinkPending(true);
          // Fetch event from DB and navigate (mapDbEventToFrontend is
          // statically imported). Wrapped in Promise.resolve — the
          // PostgREST query builder is a thenable, not a real Promise, so
          // it doesn't reliably support .finally().
          Promise.resolve(
            supabase
              .from('events')
              .select('*')
              .eq('id', eventDeepLink)
              .maybeSingle()
          )
            .then(({ data: evtData, error: evtError }: any) => {
              if (evtError) {
                console.error('Failed to load event from deep link:', evtError);
                Sentry.captureException(evtError);
                setAppToastError('Could not open that event link. Please try again.');
                return;
              }
              // A deleted event is still readable by its own organizer/admin
              // under RLS (soft-delete is restorable) — but a deep link should
              // never open a deleted event for anyone, including its owner.
              if (evtData && !evtData.deleted_at) {
                setSelectedEvent(mapDbEventToFrontend(evtData));
                setScreen('event-details');
              } else {
                setAppToastError('This event is no longer available.');
              }
            }, (err: any) => {
              console.error('Deep link event fetch failed:', err);
              Sentry.captureException(err);
              setAppToastError('Could not open that event link. Please try again.');
            })
            .finally(() => { setDeepLinkPending(false); });
        }

        // Intercept profile deep links: ?user=<userId> — the format both
        // InboxScreen and UserProfileScreen's "Share Profile" buttons
        // generate. Previously unhandled (App.tsx only parsed
        // insforge_error/insforge_status/token/verify_email/ref/event), so
        // every shared profile link opened the app to the home screen.
        const userDeepLink = params.get('user');
        if (userDeepLink) {
          const cleanUrl = window.location.pathname + window.location.hash;
          window.history.replaceState({}, document.title, cleanUrl);
          setDeepLinkPending(true);
          Promise.resolve(
            supabase
              .from('public_profiles')
              .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role, interests, bio, vc_badge')
              .eq('id', userDeepLink)
              .maybeSingle()
          )
            .then(({ data: userData, error: userError }: any) => {
              if (userError || !userData) {
                setAppToastError('This profile is no longer available.');
                return;
              }
              setSelectedUser(mapDbUserToUserProfile(userData));
              setScreen('user-profile');
            }, (err: any) => {
              console.error('Deep link user fetch failed:', err);
              Sentry.captureException(err);
              setAppToastError('Could not open that profile link. Please try again.');
            })
            .finally(() => { setDeepLinkPending(false); });
        }

        // 2. Fetch user session.
        // Supabase's client (src/lib/supabase.ts) persists and refreshes the
        // session internally (autoRefreshToken + persistSession) — no manual
        // cookie/refresh-token plumbing needed here. The InsForge version of
        // this block did that by hand because its httpOnly refresh cookie
        // doesn't work cross-origin on localhost; Supabase's client reads
        // from its own storage adapter instead, so that whole workaround is
        // gone. getSession() resolves from cache/storage and only hits the
        // network if the cached token is actually expired, so there's no
        // separate "transient network failure vs definitely logged out"
        // ambiguity to retry around the way InsForge's getCurrentUser() had.
        let sessionUserId: string | null = null;
        let sessionUserEmail: string | null = null;

        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) {
          // A thrown/returned error here is a genuine client-side failure
          // (e.g. corrupted storage), not proof of "logged out" — preserve
          // whatever session state was already known rather than bouncing a
          // signed-in user back to Welcome on a transient hiccup (same
          // intent as the old 401-vs-transient distinction).
          console.warn('getSession failed during hydration — preserving cached user:', sessionError.message);
          setCurrentUser(prev => prev);
          setAuthLoading(false);
          return;
        }
        if (!sessionData.session) {
          setCurrentUser(null);
          setAuthLoading(false);
          return;
        }
        sessionUserId = sessionData.session.user.id;
        sessionUserEmail = sessionData.session.user.email ?? null;

        if (!sessionUserId) {
          setCurrentUser(null);
          setAuthLoading(false);
          return;
        }

        // Fetch user profile from public schema to get the role and full name.
        // The error is NOT swallowed: a failed fetch used to silently hydrate a
        // valid organizer session as role 'user' (the "Access Denied on Create
        // Event" bug). Retry once; on persistent failure, preserve the
        // known-good cached role instead of downgrading it.
        let profile: any = null;
        let profileError: any = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', sessionUserId)
            .maybeSingle();
          profile = data; profileError = error;
          if (!profileError) break;
          await new Promise((r) => setTimeout(r, 600));
        }
        if (profileError && !profile) {
          console.warn('Profile fetch failed during hydration — preserving cached role:', profileError?.message || profileError);
          setCurrentUser(prev =>
            prev && prev.id === sessionUserId
              ? prev // keep the known-good state (including role) — never downgrade on a fetch failure
              : {
                  id: sessionUserId!,
                  email: sessionUserEmail || '',
                  full_name: (sessionUserEmail || '').split('@')[0],
                  role: 'user', // unknown fresh session — the 15s role-sync corrects this
                }
          );
          setAuthLoading(false);
          return;
        }

        // Item 20: reject suspended users immediately on session restore
        if (profile?.status === 'suspended') {
          await supabase.auth.signOut().catch(() => {});
          // Same as the normal sign-out path below — without this the
          // suspended user's device keeps its push token registered (and
          // its registration listener bound to their id), so it keeps
          // receiving pushes, and a different user logging in on the same
          // device could have their token misattributed to the suspended
          // account (see pushNotifications.ts's currentUserId fix).
          if (sessionUserId) await unregisterPushNotifications(sessionUserId).catch(() => {});
          setCurrentUser(null);
          setAuthError('Your account has been suspended. To appeal, contact support@getvents.com or WhatsApp +234 9030737368.');
          setAuthLoading(false);
          return;
        }

        // Closes the historical bug where clicking the raw email
        // confirmation link (rather than entering the OTP in-app) lands a
        // user here authenticated but with a bare profile row: the
        // handle_new_user() DB trigger only ever inserts id/email/role (it
        // has no access to the rest of the signup form), and the
        // AuthScreen.tsx completion write only runs from within the in-app
        // OTP flow — a path the magic link skips entirely. hydrateAuth is
        // the one code path that always runs on session restore regardless
        // of how the session was established, so it's the right place to
        // catch this: if the profile looks freshly-created (no username —
        // the field every real profile ends up with, since it's required
        // at signup) and a matching pending-signup payload is still in
        // localStorage, complete the profile here before the user ever
        // sees themselves as "done" onboarding.
        if (profile && !profile.username) {
          const pending = getPendingVerification();
          if (pending?.email?.toLowerCase() === (sessionUserEmail || '').toLowerCase() && pending.profile) {
            const completion = Object.fromEntries(
              Object.entries(pending.profile).filter(([, v]) => v != null && v !== '')
            );
            if (Object.keys(completion).length > 0) {
              const { data: completedProfile, error: completeError } = await supabase
                .from('users')
                .update(completion)
                .eq('id', sessionUserId)
                .select('*')
                .maybeSingle();
              if (completeError) {
                console.warn('Profile completion on session restore failed:', completeError.message);
              } else if (completedProfile) {
                profile = completedProfile;
                clearPendingVerification();
              }
            }
          }
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
          is_service_provider: profile?.is_service_provider === true,
          country: profile?.country || undefined,
        });
      } catch (err: any) {
        console.error("Auth rehydration failed:", err);
        Sentry.captureException(err);
        setAuthError(err?.message || "An unexpected error occurred during auth rehydration.");
        setCurrentUser(null);
      } finally {
        setAuthLoading(false);
      }
  }, []);

  useEffect(() => { hydrateAuth(); }, [hydrateAuth]);

  // Lightweight presence for messaging's "online" indicator — bumps
  // users.last_active_at every 30s while a signed-in user has the app
  // foregrounded. "Online" is then just "seen in the last 60s", computed
  // client-side wherever it's shown (ConversationScreen/InboxScreen) —
  // not a real presence channel, an honest approximation.
  useEffect(() => {
    if (!currentUser?.id) return;
    const beat = () => { supabase.rpc('heartbeat_presence', {}).then(() => {}, () => {}); };
    beat();
    const interval = setInterval(beat, 30000);
    return () => clearInterval(interval);
  }, [currentUser?.id]);

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

  // Safety Timeout to prevent stuck splash screen on network/auth hang.
  //
  // Used to also force setCurrentUser(null) + setScreen('welcome') directly
  // here -- which meant a hydrateAuth() call that was merely slow (not
  // actually logged-out: a retried profile fetch, a slow network refresh of
  // an expired-but-still-valid session) got permanently treated as a
  // sign-out. Worse, since the Splash Routing Effect below only ever routes
  // on `screen === 'splash'`, once this handler force-set screen to
  // 'welcome' that effect could never fire again for this mount -- so even
  // when hydrateAuth() went on to complete successfully in the background
  // moments later and called setCurrentUser() with a fully valid, restored
  // session, nothing was left to route the user back into the app. A
  // real user with a real session could get stuck on the sign-in screen
  // permanently, purely because hydration took a few seconds too long.
  //
  // Now this only stops BLOCKING (authLoading=false) so the splash isn't
  // frozen forever -- it never touches currentUser or screen itself.
  // hydrationTimedOut records that this happened, so the Splash Routing
  // Effect below can still route a late-arriving currentUser into the app
  // even after it's already shown Welcome once as a result.
  useEffect(() => {
    const safetyTimeout = setTimeout(() => {
      if (authLoading) {
        console.warn("Auth hydration safety timeout (15s) triggered — no longer blocking, but hydrateAuth() keeps running in the background so a valid session can still restore.");
        setHydrationTimedOut(true);
        setAuthLoading(false);
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
    // Waits for any in-flight ?event=/?user= deep link fetch — otherwise
    // this could route to home/welcome while the fetch is still running,
    // and if it later fails, the URL is already cleaned with no way back.
    //
    // Also fires when hydrationTimedOut is set and screen is still
    // 'welcome' -- that's the fallback the 15s safety timeout landed the
    // user on before hydrateAuth() finished. Without this second
    // condition, a currentUser that arrives after the timeout (a real,
    // valid, just-slow-to-restore session) would have nothing left to
    // route it anywhere: this effect used to only ever fire on
    // `screen === 'splash'`, and the timeout used to move screen straight
    // to 'welcome' itself, permanently skipping this effect for the rest
    // of the mount. Scoped to `screen === 'welcome'` specifically (not
    // any later screen) so it can't yank a user out of something they've
    // since started doing on purpose, like filling in the signup form.
    const shouldRoute = (screen === 'splash' || (hydrationTimedOut && screen === 'welcome')) && !authLoading && !deepLinkPending;
    if (shouldRoute) {
      if (currentUser) {
        setHydrationTimedOut(false);
        if (currentUser.role !== 'organizer' && currentUser.role !== 'organiser') {
          setUserRole('attendee');
          setScreen('home');
          setActiveTab('home');
        } else {
          setUserRole('organizer');
          setOrgTab('home');
          setScreen('home');
          setActiveTab('home');
        }
      } else if (screen === 'splash') {
        // A signup left mid-verification (app closed/backgrounded before the
        // OTP was entered) resumes straight into the OTP screen instead of
        // dropping the user on the welcome page and losing their place.
        const pending = getPendingVerification();
        if (pending) {
          setPendingVerificationEmail(pending.email);
          setAuthMode('signup');
          setScreen('auth');
        } else {
          setScreen('welcome');
        }
      }
      // else: screen is already 'welcome' (the timeout's fallback) and
      // currentUser is still null — nothing to do, already showing the
      // right thing.
    }
  }, [screen, authLoading, currentUser, deepLinkPending, hydrationTimedOut]);

  // Routes to Welcome if currentUser disappears while the user is already
  // deep in the app (not on splash/welcome/auth, which handle a null
  // currentUser themselves). Nothing else in this file does this generically
  // -- every other place that nulls currentUser (handleSignOut, the
  // suspended-account branch in hydrateAuth) also explicitly manages screen
  // itself, which was fine while hydrateAuth only ever ran before the app
  // was shown (mount) or while backgrounded (pageshow/bfcache). Now that it
  // also re-runs on native resume/foreground while the user may be actively
  // using an authenticated screen, a session that turns out to have been
  // genuinely revoked/expired needs somewhere to send the user other than
  // silently leaving them on a now-unauthenticated version of whatever
  // screen they were already on.
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const hadUser = prevUserIdRef.current !== null;
    prevUserIdRef.current = currentUser?.id ?? null;
    if (hadUser && !currentUser && screen !== 'splash' && screen !== 'welcome' && screen !== 'auth') {
      setUserRole('attendee');
      setScreen('welcome');
      setScreenStack([]);
      setActiveTab('home');
    }
  }, [currentUser, screen]);

  useEffect(() => {
    if (!appToastError) return;
    const t = setTimeout(() => setAppToastError(null), 5000);
    return () => clearTimeout(t);
  }, [appToastError]);

  useEffect(() => {
    if (!appToastSuccess) return;
    const t = setTimeout(() => setAppToastSuccess(null), 5000);
    return () => clearTimeout(t);
  }, [appToastSuccess]);

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
  const [selectedServiceCategory, setSelectedServiceCategory] = useState<string | null>(null);
  const [selectedServiceProvider, setSelectedServiceProvider] = useState<ServiceProvider | null>(null);
  // Single shared discovery-country state for both Home and Services (Stage
  // B) -- previously each screen kept its own local country state
  // (HomeScreen's own `countryFilter`, and this `discoveryCountryIso` for
  // Services alone), which is exactly what let them disagree: opening
  // Services from Home could show a stale/different country than whatever
  // Home was actively browsing. One piece of state, read and written by
  // both screens, makes that structurally impossible instead of relying on
  // a reset-on-navigate patch (which is what the previous, incomplete fix
  // here did). Deliberately NOT persisted to users.country or localStorage
  // under the account-country key -- this is a session-only browsing
  // preference, distinct from selectedCountryIso (the signup/account
  // country, below) which it defaults from exactly once (see the effect
  // near selectedCountryIso) but never overwrites once the user has picked
  // a discovery country themselves.
  // Falls back to 'NG' only for the brief window before auth hydrates (or
  // permanently for a guest session with no account country at all) --
  // the effect below immediately replaces this with the real
  // currentUser.country the moment it's known, same as HomeScreen's own
  // prior default did.
  const [discoveryCountryIso, setDiscoveryCountryIso] = useState<string>(() => currentUser?.country || 'NG');
  const discoveryCountryTouchedRef = useRef(false);
  const handleDiscoveryCountryChange = useCallback((iso: string) => {
    discoveryCountryTouchedRef.current = true;
    setDiscoveryCountryIso(iso);
  }, []);
  // Default the shared discovery country to the account's own country
  // (users.country) the moment it's known -- currentUser is often still
  // null on first render while auth is hydrating, so this can't just be the
  // useState initializer above. Adopts it exactly once; a country the user
  // has already deliberately picked (in Home or Services, either sets the
  // same touched flag) is never silently overwritten by this effect again,
  // even if currentUser?.country changes identity on an unrelated update.
  useEffect(() => {
    if (discoveryCountryTouchedRef.current) return;
    if (currentUser?.country) setDiscoveryCountryIso(currentUser.country);
  }, [currentUser?.country]);
  const [selectedTicketType, setSelectedTicketType] = useState<TicketType | null>(null);
  const [selectedTicketQty, setSelectedTicketQty] = useState(1);
  const [purchasedTicket, setPurchasedTicket] = useState<PurchasedTicket | null>(null);
  // Set when Paystack has already captured payment but purchase_ticket_with_tokens
  // failed server-side (sold out, stale promo, dropped connection, etc.) — the
  // success screen must never render in this case since no ticket was issued.
  const [paymentFailure, setPaymentFailure] = useState<{ eventTitle: string; reference: string; message: string } | null>(null);

  const [savedEvents, setSavedEvents] = useState<string[]>([]);

  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  // Stable array identity for HomeScreen's blockedUserIds prop -- passing
  // `[...blockedIds]` inline at the render call site made a brand new array
  // (and downstream, via HomeScreen's own `useMemo(() => new Set(...), [blockedUserIds])`,
  // a brand new Set) on every single App re-render, not just when the block
  // list itself changed. That unstable Set reference feeds directly into
  // HomeScreen's country/category/price filter effect's dependency array,
  // so any unrelated App-level state change (a 15s timer tick, an unread
  // count update, etc.) was silently re-triggering that effect -- and its
  // skeleton -- while the user was just browsing. Only recomputed when
  // `blockedIds` itself changes.
  const blockedUserIdsArray = useMemo(() => [...blockedIds], [blockedIds]);

  // Fetch the user's blocked-organizer list so the main feed can exclude
  // their events (App Store Guideline 1.2 UGC requirement).
  useEffect(() => {
    async function fetchBlocked() {
      if (!currentUser?.id) {
        setBlockedIds(new Set());
        return;
      }
      try {
        const { data, error } = await supabase
          .from('blocked_users')
          .select('blocked_id')
          .eq('blocker_id', currentUser.id);
        if (error) throw error;
        if (data) setBlockedIds(new Set(data.map((b: any) => b.blocked_id)));
      } catch (err) {
        console.error('Failed to fetch blocked users:', err);
        Sentry.captureException(err);
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
        const { data, error } = await supabase
          .from('saved_events')
          .select('event_id')
          .eq('user_id', currentUser.id);
        if (error) throw error;
        if (data) {
          setSavedEvents(data.map((item: any) => item.event_id));
        }
      } catch (err) {
        console.error("Failed to fetch saved events:", err);
        Sentry.captureException(err);
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
      const { data, error } = await supabase
        .from('tickets')
        .select('*, events(*)')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (data) {
        // Single source of truth for the embedded event's "attendees"
        // figure — previously read events.attendee_count, a column that
        // was never created in any migration, so this always silently
        // fell back to 0.
        const ticketEventIds = [...new Set(data.filter((t: any) => t.events).map((t: any) => t.events.id))];
        let statsByEventId: Record<string, number> = {};
        if (ticketEventIds.length > 0) {
          const { data: statsRes } = await supabase.rpc('get_event_ticket_stats', { p_event_ids: ticketEventIds });
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
            country: dbEvent.country || 'NG',
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
            checkedIn: !!t.checked_in,
          };
        });

        setAllTickets(mappedTickets);
        // Warm the signed-token cache for every ticket as soon as the list is
        // known — so opening any pass (a fresh purchase, or a past/upcoming
        // ticket) renders its QR instantly instead of minting on open.
        prefetchTicketTokens(mappedTickets.map((t) => t.ticketId));
      }
    } catch (err) {
      console.error('Failed to fetch user tickets:', err);
      Sentry.captureException(err, { tags: { area: 'fetchUserTickets' } });
    } finally {
      setTicketsLoading(false);
    }
  }, [currentUser?.id, currentUser?.full_name]);

  const lastFetchRef = useRef<number>(0);
  // Request-ordering guard: force=true (handleTabChange's Home-tap refresh,
  // several "revalidate after X" call sites) bypasses the 5s debounce above,
  // so two overlapping fetchEvents calls are possible (e.g. a fast
  // double-tap on the Home tab). Without this, whichever request's series
  // of awaits happens to resolve last always wins and sets dbEvents,
  // regardless of which one was actually started last -- an older request
  // finishing after a newer one could silently replace fresher data with
  // stale data. Bumped once per call; a response only gets to write state
  // if it's still the most recently *started* call by the time it resolves.
  const fetchRequestIdRef = useRef(0);
  const fetchEvents = useCallback(async (force = false, loadMore = false) => {
    if (!force && !loadMore && Date.now() - lastFetchRef.current < 5000) {
      return;
    }
    lastFetchRef.current = Date.now();
    const requestId = ++fetchRequestIdRef.current;
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

      let eventsQuery = supabase
        .from('events')
        .select('*, users!events_organizer_id_fkey(username, full_name, vc_badge)')
        .eq('hidden_by_admin', false)
        .is('deleted_at', null)
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

      // A newer fetchEvents call has started since this one began -- its
      // response (whenever it lands) is the one that should win. Bail out
      // before touching any state so this stale response can't stomp
      // fresher data or flip loading back on/off out of turn.
      if (requestId !== fetchRequestIdRef.current) return;

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
        let trendingScoreData: any[] = [];

        if (eventIds.length > 0) {
          const nowStr = new Date().toISOString();
          const { data: promoRes } = await supabase
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
          const { data: statsRes } = await supabase.rpc('get_event_ticket_stats', { p_event_ids: eventIds });
          if (statsRes) ticketsData = statsRes;

          // Fetch saves count per event for popularity score
          const { data: savesRes } = await supabase
            .from('saved_events')
            .select('event_id')
            .in('event_id', eventIds);
          if (savesRes) savesData = savesRes;

          // Real trending score — recent booking velocity (last 72h) weighted
          // far above lifetime sales/saves, computed server-side so it can't
          // be gamed by anything client-side and stays accurate as sales
          // happen. Used only by HomeScreen's dedicated Trending section;
          // does not affect the Explore feed's own promoted-first sort below.
          const { data: trendingRes } = await supabase.rpc('get_event_trending_scores', { p_event_ids: eventIds });
          if (trendingRes) trendingScoreData = trendingRes;
        }

        const bookingsCountMap: Record<string, number> = {};
        ticketsData.forEach((t: any) => {
          bookingsCountMap[t.event_id] = t.sold_count || 0;
        });

        const savesCountMap: Record<string, number> = {};
        (savesData as any[]).forEach((s: any) => {
          savesCountMap[s.event_id] = (savesCountMap[s.event_id] || 0) + 1;
        });

        const trendingScoreMap: Record<string, number> = {};
        trendingScoreData.forEach((t: any) => {
          trendingScoreMap[t.event_id] = Number(t.trending_score) || 0;
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
            trendingScore: trendingScoreMap[evt.id] || 0,
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
      Sentry.captureException(err);
    } finally {
      // Same guard as above -- a stale request resolving (success or error)
      // after a newer one has already started must not flip loading back
      // off while that newer request is still in flight.
      if (requestId === fetchRequestIdRef.current) setLoadingEvents(false);
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
      const { count, error } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', currentUser.id)
        .eq('read', false);
      if (!error && count !== null) {
        setUnreadCount(count);
      }
    } catch (err) {
      console.error("Failed to fetch unread notifications count:", err);
      Sentry.captureException(err);
    }
  }, [currentUser]);

  useEffect(() => {
    fetchUnreadCount();
  }, [currentUser, fetchUnreadCount]);

  // Realtime: subscribe to user channel for badge updates
  useEffect(() => {
    if (!currentUser?.id) return;
    const channel = supabase.channel(`user:${currentUser.id}`, { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'new_notification' }, () => fetchUnreadCount());
    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
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

  // Legacy relic of the pre-country-select signup flow (see AuthScreen's
  // signupState, which is now what actually drives the signup form's own
  // state field) -- nothing live ever calls setSelectedState anymore
  // (HomeScreen's selectedState/onStateChange props are unread), so this
  // was previously just a silent fallback that could inject a hardcoded
  // Nigerian state ('Abia', NIGERIA_STATES[0]) into a non-Nigerian
  // signup's `state` field if signupState was ever empty (AuthScreen.tsx:
  // `state: signupState || selectedState || ...`). Defaulting to '' means
  // that fallback can never silently supply the wrong country's state.
  const [selectedState, setSelectedState] = useState<string>(() => {
    return localStorage.getItem('selected_state_preference') || '';
  });

  // Account/home country chosen via CountrySelectScreen (ISO 3166-1 alpha-2,
  // e.g. 'NG', 'US') -- persisted account metadata only, never an
  // event-visibility restriction (see select_events RLS policy: purely
  // deletion/ownership based, no country/state predicate anywhere). Reused
  // across a fresh signup attempt the same way selectedState is, above.
  const [selectedCountryIso, setSelectedCountryIso] = useState<string | undefined>(() => {
    return localStorage.getItem('selected_country_preference') || undefined;
  });
  useEffect(() => {
    if (selectedCountryIso) localStorage.setItem('selected_country_preference', selectedCountryIso);
  }, [selectedCountryIso]);

  const [pendingSignup, setPendingSignup] = useState(false);
  // Per-event context for screens navigated to from ManageEventsScreen
  // (Analytics needs to know which event to scope to; undefined = aggregate).
  const [analyticsEventId, setAnalyticsEventId] = useState<string | undefined>(undefined);
  const [analyticsEventTitle, setAnalyticsEventTitle] = useState<string | undefined>(undefined);

  const handleTabChange = useCallback((tab: TabId) => {
    const wasAlreadyActive = activeTab === tab;
    setActiveTab(tab);
    setScreen(TAB_SCREENS[tab]);
    setScreenStack([]);
    // Revalidate Home's event list on every tap of the Home tab — not just
    // when navigating to Home from elsewhere. The existing "fetch on
    // screen === 'home'" effect below only fires when `screen` actually
    // changes value, so tapping Home while already on Home (the common
    // "tap the active tab to refresh/scroll-to-top" gesture) previously did
    // nothing — newly published/updated events wouldn't appear without a
    // full app restart. force=true bypasses fetchEvents' own 5s debounce
    // (a deliberate tap should always refresh, not be silently skipped),
    // and running it here means the 5s debounce it also shares with that
    // other effect naturally prevents a duplicate second query when this
    // same tap also causes `screen` to change to 'home'.
    if (tab === 'home') {
      fetchEvents(true);
      // Bumping this on every Home tap (not just re-taps) is deliberate:
      // HomeScreen now stays mounted across tab switches (see homeEverMounted
      // above) rather than remounting, so scrollToTopSignal is what actually
      // scrolls it back to top on switch-in -- this only has a visible
      // effect exactly when it matters -- tapping Home while already on it.
      setHomeScrollSignal(s => s + 1);
    } else if (wasAlreadyActive) {
      // Same "tap the active tab to refresh" gesture as Home, extended to
      // the other three tabs -- but ONLY on a re-tap (unlike Home's
      // always-fires approach above), since these three don't already
      // remount/refetch on every switch-in the way HomeScreen does.
      // Each reuses its existing fetch/revalidation path, no new fetch
      // logic: My Tickets calls the same fetchUserTickets already used by
      // MyTicketsScreen's own pull-to-refresh; Chats bumps chatRefreshKey,
      // the same signal ConversationScreen's own goBack already uses to
      // make ExploreScreen's inbox list refetch; Profile bumps
      // profileTabRefreshSignal, which ProfileScreen turns into its own
      // internal profileRefreshKey (already-existing stats/service-
      // provider-profile fetch effects, previously dead since nothing
      // ever incremented it).
      if (tab === 'my-tickets' && currentUser?.id) {
        fetchUserTickets(currentUser.id);
      } else if (tab === 'explore') {
        setChatRefreshKey(k => k + 1);
      } else if (tab === 'profile') {
        setProfileTabRefreshSignal(s => s + 1);
      }
    }
  }, [fetchEvents, activeTab, currentUser?.id, fetchUserTickets]);

  const handleOrgTabChange = useCallback((tab: OrgTab) => {
    setOrgTab(tab);
    setActiveTab(tab as TabId);
    setScreen(TAB_SCREENS[tab as TabId] ?? (tab as Screen));
    setScreenStack([]);
  }, []);

  const handleEventPress = useCallback((event: Event) => {
    analytics.eventViewed({ eventId: event.id, eventTitle: event.title, category: event.category });
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
    if (!currentUser) {
      setPurchasedTicket(ticket);
      setScreenStack([]);
      setScreen('payment-success');
      return;
    }

    // Real ticket id + signed token from the server (used for the instant QR).
    let primaryTicketId: string | undefined;
    let primaryToken: string | undefined;

    try {
      // Every ticket in the group needs its own name+email so each gets
      // a distinct row (and QR code) the door scanner can check in
      // individually. CheckoutScreen always supplies `attendees` for
      // group (quantity > 1) purchases; fall back to a single entry
      // built from the ticket's own holder fields for the instant
      // free-ticket path (quantity === 1, no CheckoutScreen involved).
      const attendees = ticket.attendees && ticket.attendees.length > 0
        ? ticket.attendees
        : [{ name: ticket.holderName || currentUser.full_name || 'Guest', email: currentUser.email }];

      // Paid purchases: the payment intent (event, ticket type, attendees,
      // promo, amount) was already persisted server-side by
      // create_pending_purchase BEFORE the Paystack popup ever opened
      // (CheckoutScreen.tsx), keyed on ticket.ticketId (the server-issued
      // reference actually charged). finalize_pending_purchase is the same
      // idempotent ticket-creation logic purchase_ticket used to run here
      // directly, now reading from that persisted row instead of raw
      // params — and it's ALSO the exact call the webhook makes if this
      // client never gets here at all (app killed/crashed/offline right
      // after Paystack's charge succeeds). Whichever of the two calls it
      // first wins; the other is a no-op against the same locked row, so
      // this can never create two ticket sets for one payment.
      //
      // Free tickets never touch Paystack or pending_purchases — they still
      // go straight through purchase_ticket_with_tokens with a client-side
      // reference, unchanged from before.
      const isFree = (ticket.totalAmount ?? 0) === 0;

      let rows: Array<{ ticket_id: string; token: string }>;

      if (isFree) {
        const { data: tokenRows, error: insertError } = await supabase.rpc('purchase_ticket_with_tokens', {
          p_event_id: ticket.event.id,
          p_ticket_type: ticket.ticketType?.name ?? 'General',
          p_attendees: attendees,
          p_payment_ref: ticket.ticketId ?? `VNT-${Date.now()}`,
          p_promo_code: ticket.promoCode || null,
        });
        if (insertError) throw insertError;
        rows = Array.isArray(tokenRows) ? tokenRows : [];
      } else {
        // Paid purchases: NEVER treat "the Paystack popup called back" as
        // proof of payment — that's just the client's own JS reporting
        // success, which is nothing a scripted caller couldn't fake, and
        // some channels (bank transfer/ussd/mobile money) don't even call
        // this reliably at all. api/webhook/paystack.ts (?action=verify) is the actual
        // server-side check: it calls Paystack's own GET /transaction/
        // verify/:reference with the secret key before finalizing anything.
        // finalize_pending_purchase/confirm_ticket_payment (real ticket
        // creation + payment_status='paid') are project_admin-only now
        // (supabase/migrations/0031_restrict_finalize_pending_purchase.sql)
        // — this endpoint and the webhook are the only two ways in, so a
        // client can no longer manufacture a working ticket by calling the
        // old RPC directly without ever paying.
        const token = await getAuthToken();
        const verifyRes = await fetch(apiUrl('/api/webhook/paystack?action=verify'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ reference: ticket.ticketId }),
        });
        const verifyJson = await verifyRes.json().catch(() => null);

        if (!verifyRes.ok || verifyJson?.status !== 'success') {
          const reason = verifyJson?.status === 'abandoned'
            ? 'Payment was not completed. If you were charged, contact support with your reference.'
            : verifyJson?.status === 'failed'
            ? 'Payment failed. You have not been charged for this order.'
            : (verifyJson?.error || 'Could not verify this payment. If you were charged, contact support with your reference.');
          throw new Error(reason);
        }

        const ticketIds: string[] = Array.isArray(verifyJson.ticketIds) ? verifyJson.ticketIds : [];

        if (ticketIds.length === 0 && verifyJson.ticketLookupPending) {
          // Payment IS confirmed at this point (api/webhook/paystack.ts (?action=verify) only
          // ever sets this flag after confirm_ticket_payment already
          // succeeded) — a transient failure reading the ticket ids back is
          // not a payment failure and must never be shown as one. Fall back
          // to the same recovery UX as the redirect/deep-link path below:
          // refresh from the buyer's own authenticated connection (which
          // may well succeed even though the project_admin-side lookup
          // didn't) and surface success via toast + Wallet rather than the
          // rich instant-QR success screen this path has no data left for.
          await fetchUserTickets(currentUser.id);
          await fetchEvents(true);
          setAppToastSuccess('Payment confirmed! Your ticket is in Wallet.');
          setScreenStack([]);
          setScreen('wallet');
          return;
        }

        if (ticketIds.length === 0) {
          throw new Error('Payment verified, but no ticket was found for this order. Contact support with your reference.');
        }

        // generate_ticket_token requires auth.uid() = the ticket's owner
        // (0004_functions.sql) — called here, under the buyer's own
        // session, rather than from api/webhook/paystack.ts (?action=verify)'s project_admin
        // connection, which has no user JWT/RLS context to satisfy that
        // check with.
        rows = await Promise.all(ticketIds.map(async (id) => {
          const { data: tok, error: tokErr } = await supabase.rpc('generate_ticket_token', { p_ticket_id: id });
          if (tokErr) throw tokErr;
          return { ticket_id: id, token: tok as string };
        }));
      }

      if (rows.length === 0) {
        throw new Error('No ticket was returned by the server.');
      }
      // Seed the offline token cache immediately and capture the primary
      // ticket's real id + token for the success screen (instant QR).
      rows.forEach((r) => cacheTicketToken(r.ticket_id, r.token));
      primaryTicketId = rows[0].ticket_id;
      primaryToken = rows[0].token;

      // Confirmation SMS is now sent server-side (see api/notify/status-email.ts,
      // request_type: 'ticket') using the on-file phone number — the client no
      // longer holds a Sendchamp key to send it directly.
      // Email confirmation with full ticket details + validation info. The
      // endpoint authenticates the buyer and emails only their own address
      // with details pulled server-side — best-effort, never blocks.
      (async () => {
        try {
          const token = await getAuthToken();
          if (!token) return;
          await fetch(apiUrl('/api/notify/status-email'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ request_type: 'ticket', event_id: ticket.event.id }),
          });
        } catch { /* ignore */ }
      })();
      // Single canonical purchase-completion event (fired here, at the real
      // RPC success — not in CheckoutScreen, which used to double/triple-count).
      analytics.ticketPurchased({
        eventId: ticket.event.id,
        eventTitle: ticket.event.title,
        ticketType: ticket.ticketType?.name,
        quantity: ticket.quantity,
        amount: ticket.totalAmount,
        free: (ticket.totalAmount ?? 0) === 0,
        reference: ticket.ticketId ?? undefined,
      });

      // 3.6: Ticket confirmation notification. Paid purchases only — for
      // those, confirm_ticket_payment (0004_functions.sql, run server-side
      // by finalizeAndConfirmPurchase above) already inserts this exact
      // notification itself once payment is confirmed. Free tickets never
      // touch confirm_ticket_payment at all (purchase_ticket_with_tokens
      // has no notification of its own), so this remains their only source.
      if (isFree) {
        supabase.from('notifications').insert([{
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

      // Hand the success screen the REAL ticket id + pre-generated token so
      // its QR renders instantly from cache — never "Generating…".
      setPurchasedTicket({ ...ticket, ticketId: primaryTicketId, token: primaryToken });
      setScreenStack([]);
      setScreen('payment-success');
    } catch (err: any) {
      // Paystack has already captured this payment (or it was a free
      // ticket, in which case there's nothing to reconcile) — a failure
      // here must never route to the success screen. Surface it with the
      // reference so the user can get support, and never trigger a
      // duplicate charge automatically.
      console.error('Failed to create ticket after payment:', err);
      Sentry.captureException(err);
      setPaymentFailure({
        eventTitle: ticket.event.title,
        reference: ticket.ticketId ?? 'unknown',
        message: err?.message || 'Something went wrong while confirming your ticket.',
      });
      setScreenStack([]);
      setScreen('payment-failed');
    }
  }, [currentUser, fetchEvents, fetchUserTickets]);

  // Resolves a payment reference that arrived via Paystack's own post-
  // payment redirect (?reference=/?trxref= on web, vents://payment?ref= on
  // native — see the URL/deep-link handling above) rather than through
  // CheckoutScreen's in-iframe JS callback. This is the recovery path for
  // channels (bank transfer/ussd/mobile money) that leave the iframe
  // entirely and don't reliably fire that callback, or for a card payment
  // completed after the app was backgrounded/killed. There's no live
  // CheckoutScreen state to resume across that gap (event/ticketType/
  // attendees are gone), so unlike handleCheckoutSuccess this doesn't try
  // to rebuild a PurchasedTicket for the success screen — it verifies,
  // waits for the same fetchUserTickets/fetchEvents refresh, and surfaces
  // the result as a toast; the new ticket then shows up in Wallet like any
  // other, which is where a user who left the app mid-payment naturally
  // looks for it. Requires currentUser because create_pending_purchase
  // itself requires auth.uid() — there is no guest-checkout paid path for
  // this to apply to.
  useEffect(() => {
    if (!pendingPaymentRef || !currentUser) return;
    const reference = pendingPaymentRef;
    setPendingPaymentRef(undefined);

    (async () => {
      try {
        const token = await getAuthToken();
        const verifyRes = await fetch(apiUrl('/api/webhook/paystack?action=verify'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ reference }),
        });
        const verifyJson = await verifyRes.json().catch(() => null);

        if (!verifyRes.ok || verifyJson?.status !== 'success') {
          const message = verifyJson?.status === 'abandoned'
            ? 'Payment was not completed. If you were charged, contact support with your reference.'
            : verifyJson?.status === 'failed'
            ? 'Payment failed. You have not been charged for this order.'
            : (verifyJson?.error || 'Could not verify a recent payment. If you were charged, contact support with your reference.');
          setAppToastError(message);
          return;
        }

        await fetchUserTickets(currentUser.id);
        await fetchEvents(true);
        setAppToastSuccess('Payment confirmed! Your ticket is in Wallet.');
      } catch (err: any) {
        console.error('Failed to resolve pending payment reference:', err);
        Sentry.captureException(err);
        setAppToastError('Could not verify a recent payment. If you were charged, contact support with your reference.');
      }
    })();
  }, [pendingPaymentRef, currentUser, fetchEvents, fetchUserTickets]);

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
    analytics.eventSaveToggled(eventId, !isSaved);
    // Optimistic update
    setSavedEvents((prev) =>
      isSaved ? prev.filter((id) => id !== eventId) : [...prev, eventId]
    );

    try {
      if (isSaved) {
        const { error } = await supabase
          .from('saved_events')
          .delete()
          .eq('user_id', currentUser.id)
          .eq('event_id', eventId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('saved_events')
          .insert([{
            user_id: currentUser.id,
            event_id: eventId
          }]);
        if (error) throw error;
      }
    } catch (err) {
      console.error("Failed to toggle save event:", err);
      Sentry.captureException(err);
      // Revert optimistic update
      setSavedEvents((prev) =>
        isSaved ? [...prev, eventId] : prev.filter((id) => id !== eventId)
      );
      // Previously the heart just silently flicked back with no
      // explanation — reusing the same lightweight banner ?event=/?user=
      // deep-link failures use.
      setAppToastError(isSaved ? "Couldn't remove from saved. Please try again." : "Couldn't save event. Please try again.");
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

  const handleOrgNavigate = useCallback((target: string) => {
    // A generic "Create Event" entry point (not the edit flow's own
    // onOpenEdit, which sets editingEventId itself) — always start fresh.
    if (target === 'create-event') setEditingEventId(null);
    navigateTo(target as Screen);
  }, [navigateTo]);

  // Resolve a ManageEventsScreen row (OrganizerEventOverview, which is
  // real-time but not the full public Event shape) into the richer `Event`
  // object that AttendeeListScreen/DoorManagerScreen/CheckinScannerScreen
  // expect as `selectedEvent`. Prefer the fully-mapped row from the public
  // feed (dbEvents) when this event is live and already in it; otherwise
  // (draft, ended, or not yet in the feed) fall back to a minimal object
  // built from the overview row itself — same fallback shape already used
  // by the working onScanTickets pattern elsewhere in this file.
  const resolveOrgEventSelection = useCallback((ov: { id: string; title: string; description: string | null; location: string | null; eventDate: string | null; price: number }): Event => {
    const fromFeed = dbEvents.find((e) => e.id === ov.id);
    if (fromFeed) return fromFeed;
    return {
      id: ov.id,
      title: ov.title,
      description: ov.description || '',
      venue: ov.location || '',
      date: ov.eventDate ? ov.eventDate.split('T')[0] : '',
      price: ov.price,
    } as any;
  }, [dbEvents]);

  // Tapping a push notification previously did nothing — the plugin
  // listener (pushNotifications.ts) only fired an analytics event; the
  // "route deep links here" comment above it was never implemented. Wired
  // via a ref so the handler registered once with the native plugin always
  // dispatches through the LATEST navigation closures, not whatever was in
  // scope the moment the listener was attached (which could be stale by
  // the time a user actually taps a notification, possibly minutes later
  // with the app backgrounded).
  const pushActionRef = useRef<(data: Record<string, any>) => void>(() => {});
  pushActionRef.current = (data: Record<string, any>) => {
    // Checked before the generic data.eventId/data.userId branches below —
    // a "sale" push carries both eventId and screen:'sales-analytics', and a
    // "message" push carries userId + screen:'chat'; without this ordering
    // they'd fall into the generic event-details/user-profile routes instead.
    if (data.screen === 'sales-analytics' && data.eventId) {
      supabase
        .from('events')
        .select('id, title')
        .eq('id', data.eventId)
        .maybeSingle()
        .then(({ data: evtData, error: evtError }) => {
          if (evtError || !evtData) return;
          setAnalyticsEventId(evtData.id);
          setAnalyticsEventTitle(evtData.title);
          setScreenStack([]);
          setScreen('sales-analytics');
        });
      return;
    }
    if (data.screen === 'chat' && data.userId) {
      supabase
        .from('public_profiles')
        .select('id, full_name, username, avatar_url, vc_badge')
        .eq('id', data.userId)
        .maybeSingle()
        .then(({ data: userData, error: userError }) => {
          if (userError || !userData) return;
          setConversationUser({
            id: userData.id,
            name: userData.full_name || userData.username || 'User',
            avatarUrl: userData.avatar_url || undefined,
            vc_badge: userData.vc_badge || undefined,
          });
          // Clear any stale event-context banner left over from whatever
          // conversation was open before this push was tapped.
          setConversationEventId(undefined);
          setScreenStack([]);
          setScreen('conversation');
        });
      return;
    }
    if (data.eventId) {
      supabase
        .from('events')
        .select('*')
        .eq('id', data.eventId)
        .maybeSingle()
        .then(({ data: evtData, error: evtError }) => {
          if (evtError || !evtData || evtData.deleted_at) return;
          setSelectedEvent(mapDbEventToFrontend(evtData));
          setScreenStack([]);
          setScreen('event-details');
        });
      return;
    }
    if (data.userId) {
      supabase
        .from('public_profiles')
        .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role, interests, bio, vc_badge')
        .eq('id', data.userId)
        .maybeSingle()
        .then(({ data: userData, error: userError }) => {
          if (userError || !userData) return;
          setSelectedUser(mapDbUserToUserProfile(userData));
          setScreenStack([]);
          setScreen('user-profile');
        });
      return;
    }
    if (data.screen === 'notifications') { setScreenStack([]); setScreen('notifications'); return; }
    if (data.screen === 'my-tickets') { setScreenStack([]); setScreen('my-tickets'); return; }
    if (data.screen === 'wallet') { setScreenStack([]); setScreen('wallet'); return; }
  };

  useEffect(() => {
    setPushActionHandler((data) => pushActionRef.current(data));
    return () => setPushActionHandler(null);
  }, []);

  // Native deep links (a shared https://getvents.com/?event=… or vents://
  // link opened while the app is installed) previously had no handler at
  // all — there was no @capacitor/app listener anywhere in the codebase, so
  // App.tsx's URL parsing (which only runs once, off window.location.search
  // during the initial hydrateAuth pass) never saw these: a Capacitor
  // WebView's window.location is the local bundle URL, not the link that
  // opened the app. This requires the platform-side association to route
  // getvents.com/vents:// links to the app in the first place — Android's
  // intent-filter is set up in AndroidManifest.xml; a full domain-verified
  // Android App Link additionally needs a hosted
  // /.well-known/assetlinks.json with the release signing certificate's
  // SHA-256 fingerprint, and iOS Universal Links need an
  // apple-app-site-association file plus the Associated Domains
  // entitlement — neither is wired up yet (no iOS project exists in this
  // repo yet, and the Android release fingerprint isn't available here).
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let removeListener: (() => void) | undefined;
    (async () => {
      const { App: CapacitorApp } = await import('@capacitor/app');
      const sub = await CapacitorApp.addListener('appUrlOpen', ({ url }) => {
        try {
          const parsed = new URL(url);
          // vents://verify?email=... — completes the handoff started by the
          // "Verify Account" email button's best-effort vents:// redirect
          // (App.tsx's verify_email query-param handling above). Same
          // pre-fill-the-OTP-screen behavior as the web ?verify_email= path,
          // just reached via the custom scheme instead of a query param.
          const verifyEmail = parsed.hostname === 'verify' ? parsed.searchParams.get('email') : null;
          // vents://reset?email=... — same round trip as verify above, for
          // the "Reset Password" email link's best-effort native redirect
          // (App.tsx's reset_email query-param handling). Jumps straight to
          // the forgot-password OTP screen; does NOT re-request a code.
          const resetEmail = parsed.hostname === 'reset' ? parsed.searchParams.get('email') : null;
          // vents://payment?ref=... — same round trip, for Paystack's own
          // post-payment redirect (App.tsx's ?reference=/?trxref= handling
          // above) on channels that leave the iframe entirely.
          const paymentRef = parsed.hostname === 'payment' ? parsed.searchParams.get('ref') : null;
          const eventId = parsed.searchParams.get('event');
          const userId = parsed.searchParams.get('user');
          const screen = parsed.searchParams.get('screen');
          if (verifyEmail) {
            setPendingVerificationEmail(verifyEmail);
            setAuthMode('signup');
            setScreen('auth');
          }
          else if (resetEmail) {
            setPendingResetEmail(resetEmail);
            setAuthMode('forgot');
            setScreen('auth');
          }
          else if (paymentRef) {
            setPendingPaymentRef(paymentRef);
          }
          else if (eventId) pushActionRef.current({ eventId, screen: screen || undefined });
          else if (userId) pushActionRef.current({ userId, screen: screen || undefined });
          else if (screen) pushActionRef.current({ screen });
        } catch (err) {
          console.warn('[deep-link] failed to parse appUrlOpen url:', err);
        }
      });
      removeListener = () => sub.remove();
    })();
    return () => removeListener?.();
  }, []);

  // Android hardware back button — navigation here is in-memory (screenStack),
  // not a web router, so nothing was intercepting it before: it fell through to
  // Capacitor's default behavior, which exits the app from any screen instead of
  // popping the internal stack. Reuse the same goBack() the on-screen back arrows
  // call; only let the OS handle it (minimize/exit) once we're already at the
  // root of the stack.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let removeListener: (() => void) | undefined;
    (async () => {
      const { App: CapacitorApp } = await import('@capacitor/app');
      const sub = await CapacitorApp.addListener('backButton', () => {
        if (screenStackRef.current.length > 0 || screenRef.current === 'event-details') {
          goBackRef.current();
        } else {
          CapacitorApp.minimizeApp();
        }
      });
      removeListener = () => sub.remove();
    })();
    return () => removeListener?.();
  }, []);

  // Re-validate the session on native resume/foreground. The existing
  // pageshow/bfcache listener above only covers the web case (a browser tab
  // actually being frozen and restored) -- a Capacitor WebView backgrounded
  // by the OS is usually never actually unloaded, so pageshow rarely or
  // never fires there. Meanwhile Supabase's autoRefreshToken relies on a
  // JS timer that mobile OSes throttle or pause entirely while the app is
  // backgrounded, so a session's access token can genuinely go stale during
  // a long background period with nothing to notice or fix it until some
  // API call eventually fails. Calling hydrateAuth() again here (it already
  // safely no-ops into "preserve known-good state" on any transient
  // failure, per its own getSession()-error handling above) gives the
  // client a chance to refresh proactively right as the user returns,
  // instead of only reactively after something breaks.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let removeListener: (() => void) | undefined;
    (async () => {
      const { App: CapacitorApp } = await import('@capacitor/app');
      const sub = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) hydrateAuth();
      });
      removeListener = () => sub.remove();
    })();
    return () => removeListener?.();
  }, [hydrateAuth]);

  const handleAuthSuccess = useCallback(async (userProfile: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; avatar_url?: string; cover_url?: string; isOrganizer?: boolean; is_verified?: boolean; vc_badge?: string; is_service_provider?: boolean; country?: string }) => {
    const enriched = {
      ...userProfile,
      isOrganizer: userProfile.role === 'organizer' || userProfile.role === 'organiser' || !!userProfile.isOrganizer
    };
    setCurrentUser(enriched);
    // Register this device for native push (no-op on web); token is synced to
    // the backend keyed to the user.
    registerPushNotifications(userProfile.id);
    identifyUser(userProfile.id, { email: userProfile.email, role: userProfile.role, username: userProfile.username });
    setScreenStack([]);
    // Check if new user needs to pick interests
    try {
      const { data } = await supabase.from('users').select('interests').eq('id', userProfile.id).maybeSingle();
      if (!data?.interests || data.interests.length === 0) {
        setShowInterests(true);
      }
    } catch { /* ignore — don't block login on interests check failure */ }
  }, []);

  // toForgotPassword: used by ChangePasswordScreen's "I don't remember my
  // current password" link -- signs out (a user who doesn't know their
  // current password can't safely stay in an authenticated Change Password
  // flow anyway) and lands directly on the login screen with the existing
  // forgot-password flow pre-selected, instead of just Welcome. Does not
  // change what that flow itself requires (still email OTP-gated) -- this
  // only saves the extra "tap Sign In, then tap Forgot Password" steps.
  const handleSignOut = useCallback(async (toForgotPassword?: boolean) => {
    setAuthLoading(true);
    analytics.loggedOut();
    // Drop this device's push token so a signed-out user stops receiving pushes.
    if (currentUser?.id) await unregisterPushNotifications(currentUser.id).catch(() => {});
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.error("Sign out error:", err);
      Sentry.captureException(err);
    }
    setCurrentUser(null);
    setUserRole('attendee');
    setScreenStack([]);
    setActiveTab('home');
    // Strict === true, not a truthy check -- this is the one call this
    // function makes that decides whether a sign-out lands on Welcome/Login
    // (the only correct destination for a plain Sign Out) or detours into
    // Forgot Password, and a caller passing this straight through as a
    // React event handler (as SettingsScreen's Sign Out row previously did)
    // would otherwise leak a truthy SyntheticEvent into this parameter.
    if (toForgotPassword === true) {
      setAuthMode('forgot');
      setScreen('auth');
    } else {
      setScreen('welcome');
    }
    setAuthLoading(false);
  }, [currentUser?.id]);

  // Screens where the bottom nav is visible for both roles.
  // Guests browse these screens too (home-first flow) — the nav must stay
  // visible for them; individual screens handle their own auth prompts.
  const navScreens = ['home', 'explore', 'my-tickets', 'profile'];
  const showBottomNav = navScreens.includes(screen);

  if (updateRequired) {
    return (
      <div
        style={{
          background: '#020005', width: '100%', height: '100dvh', display: 'flex',
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
          onClick={() => openExternalUrl('https://getvents.com')}
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
          background: '#020005', width: '100%', height: '100dvh', display: 'flex',
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
      {appToastError && (
        <div
          style={{
            position: 'fixed', top: 'calc(16px + env(safe-area-inset-top))', left: '50%', transform: 'translateX(-50%)',
            zIndex: 10000, background: '#EF4444', borderRadius: '12px', padding: '10px 18px',
            display: 'flex', alignItems: 'center', gap: '10px', maxWidth: '90vw', boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          }}
        >
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>{appToastError}</span>
          <button
            onClick={() => setAppToastError(null)}
            style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '15px', fontWeight: 700, lineHeight: 1, padding: 0 }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      {appToastSuccess && (
        <div
          style={{
            position: 'fixed', top: 'calc(16px + env(safe-area-inset-top))', left: '50%', transform: 'translateX(-50%)',
            zIndex: 10000, background: '#22C55E', borderRadius: '12px', padding: '10px 18px',
            display: 'flex', alignItems: 'center', gap: '10px', maxWidth: '90vw', boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          }}
        >
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 600 }}>{appToastSuccess}</span>
          <button
            onClick={() => setAppToastSuccess(null)}
            style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '15px', fontWeight: 700, lineHeight: 1, padding: 0 }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      <PermissionSheetHost />
      <style>{`
        .light-theme { color-scheme: light; }
        .phone-frame {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          /* Centering via margin auto (not transform: translateX(-50%)) —
             position:fixed combined with a transform on the SAME element is
             a well-documented iOS Safari bug: after a native UI interruption
             (the photo/file picker sheet, the keyboard), Safari can detach a
             fixed+transformed element from the true viewport and let it
             drift with document scroll instead of staying pinned, which
             looks exactly like "the top of the screen scrolled out of view
             while the bottom stays visible" — matching the missing
             header/stuck-crop-screen report. margin:auto with left/right
             achieves identical centering with no transform involved. */
          margin: 0 auto;
          width: 390px;
          max-width: 100vw;
          /* iOS Safari's address bar dynamically shows/hides, and a plain
             height:100% on a position:fixed element can be computed against
             a stale viewport size after a native UI interruption (the photo
             picker sheet, the keyboard) dismisses — leaving fixed/absolute
             descendants (like the flyer crop modal) undersized or
             misaligned. 100dvh tracks the ACTUAL visible viewport and is
             kept live by the browser itself; height:100% remains as the
             fallback for engines without dvh support. */
          height: 100%;
          height: 100dvh;
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
          <div className="absolute inset-0" style={swipeBack.style} {...swipeBack.handlers}>
            {/* ── AUTH FLOW ── */}
            {authLoading || screen === 'splash' ? null : (
              <>
                {screen === 'welcome' && (
            <WelcomeScreen
              onGetStarted={() => {
                setPendingSignup(true);
                setAuthMode('signup');
                // Registration no longer forces an Attendee/Organizer choice
                // up front -- every new account starts as 'attendee'.
                // Existing users can still become an Organizer afterwards
                // via ProfileScreen's "Become an Organizer" request flow
                // (onBecomeOrganizer below), which is unaffected by this.
                setUserRole('attendee');
                navigateTo('country-select');
              }}
              onSignIn={() => {
                setPendingSignup(false);
                setAuthMode('login');
                navigateTo('auth');
              }}
              onPickState={() => {
                setPendingSignup(true);
                setAuthMode('signup');
                setUserRole('attendee');
                navigateTo('country-select');
              }}
              onBrowseGuest={() => {
                setScreen('home');
                setActiveTab('home');
              }}
            />
          )}
          {screen === 'country-select' && (
            <CountrySelectScreen
              onBack={goBack}
              selectedIso={selectedCountryIso}
              onContinue={(country) => {
                setSelectedCountryIso(country.iso);
                navigateTo('auth');
              }}
            />
          )}
          {screen === 'services-home' && (
            <ServicesHomeScreen
              onBack={goBack}
              accountCountryIso={currentUser?.country || selectedCountryIso}
              discoveryCountryIso={discoveryCountryIso}
              onDiscoveryCountryChange={handleDiscoveryCountryChange}
              onCategoryPress={(category) => {
                setSelectedServiceCategory(category);
                navigateTo('services-category');
              }}
              onProviderPress={(provider) => {
                setSelectedServiceProvider(provider);
                navigateTo('service-provider-profile');
              }}
            />
          )}
          {screen === 'services-category' && selectedServiceCategory && (
            <ServiceCategoryScreen
              category={selectedServiceCategory}
              onBack={goBack}
              onProviderPress={(provider) => {
                setSelectedServiceProvider(provider);
                navigateTo('service-provider-profile');
              }}
            />
          )}
          {screen === 'service-provider-profile' && selectedServiceProvider && (
            <ServiceProviderProfileScreen
              providerId={selectedServiceProvider.id}
              initialProvider={selectedServiceProvider}
              onBack={goBack}
              onContactProvider={currentUser ? async (provider) => {
                try {
                  // "First provider photo, falling back to user avatar" --
                  // the PROVIDER's own account avatar, not the viewer's, so
                  // this needs a lookup (public_profiles, same safe public
                  // read every other cross-account avatar fetch in this
                  // file uses) when the listing itself has no photos yet.
                  let avatarUrl = provider.photoUrls[0] || undefined;
                  if (!avatarUrl) {
                    const { data } = await supabase
                      .from('public_profiles')
                      .select('avatar_url')
                      .eq('id', provider.userId)
                      .maybeSingle();
                    avatarUrl = data?.avatar_url || undefined;
                  }
                  setConversationUser({ id: provider.userId, name: provider.businessName, avatarUrl });
                  // No event context for a Services contact -- clear any
                  // leftover eventId/eventTitle from a previous event-
                  // context chat so ConversationScreen doesn't show a
                  // stale event banner here.
                  setConversationEventId(undefined);
                  setConversationEventTitle(undefined);
                  navigateTo('conversation');
                } catch (err) {
                  console.error('Failed to open provider conversation:', err);
                  Sentry.captureException(err);
                  setAppToastError("Couldn't start the conversation. Please try again.");
                }
              } : undefined}
            />
          )}
          {screen === 'service-provider-setup' && currentUser && (
            <ServiceProviderSetupScreen
              currentUser={{ id: currentUser.id, country: currentUser.country }}
              onBack={goBack}
              onSaved={() => goBack()}
            />
          )}
          {screen === 'auth' && (
            <AuthScreen
              initialMode={authMode}
              userRole={userRole}
              selectedState={selectedState}
              selectedCountryIso={selectedCountryIso}
              onBack={goBack}
              onSuccess={handleAuthSuccess}
              resetToken={resetToken}
              pendingVerificationEmail={pendingVerificationEmail}
              onPendingVerificationConsumed={() => setPendingVerificationEmail(undefined)}
              pendingResetEmail={pendingResetEmail}
              onPendingResetConsumed={() => setPendingResetEmail(undefined)}
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
          {/* HomeScreen mounts once (the first time the user reaches Home)
              and then stays mounted for the rest of the session -- switching
              to another tab/screen only hides it (display:none), it no
              longer unmounts. Previously `{screen === 'home' && <HomeScreen/>}`
              destroyed and recreated the component on every tab switch,
              which reset its local filter/search state and re-ran its
              mount-time fetch every time, on top of the dedicated
              `screen === 'home'` fetch effect and handleTabChange's own
              refresh-on-tap -- three redundant fetch triggers stacked on
              top of a full remount. Home's own scrollToTopSignal prop
              already handles "tapping the active tab scrolls to top"
              independently of mount/unmount, so nothing here changes that
              behavior. */}
          {homeEverMounted && (
            <div style={{ display: screen === 'home' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
              <HomeScreen
              onEventPress={handleEventPress}
              savedEvents={savedEvents}
              onToggleSave={handleToggleSave}
              onSearchPress={() => handleTabChange('explore')}
              onNotificationsPress={() => navigateTo('notifications')}
              onProfilePress={() => handleTabChange('profile')}
              onCreatePress={() => navigateTo('org-dashboard')}
              onUserPress={async (u) => {
                const { data } = await supabase
                  .from('public_profiles')
                  .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role, interests, bio, vc_badge')
                  .eq('id', u.id)
                  .maybeSingle();
                if (data) { setSelectedUser(mapDbUserToUserProfile(data)); navigateTo('user-profile'); }
              }}
              selectedState={selectedState}
              onStateChange={setSelectedState}
              onLiveMapPress={() => navigateTo('nigeria-live')}
              onServicesPress={() => navigateTo('services-home')}
              dbEvents={dbEvents}
              loading={loadingEvents}
              fetchEvents={fetchEvents}
              currentUser={currentUser}
              hasMore={hasMoreEvents}
              onLoadMore={() => fetchEvents(false, true)}
              unreadNotificationsCount={unreadCount}
              blockedUserIds={blockedUserIdsArray}
              scrollToTopSignal={homeScrollSignal}
              countryFilter={discoveryCountryIso}
              onCountryFilterChange={handleDiscoveryCountryChange}
            />
            </div>
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
              refreshSignal={profileTabRefreshSignal}
              onBecomeOrganizer={async () => {
                setUserRole('organizer');
                setOrgTab('home');
                setActiveTab('home');
                setScreen('home');
                setScreenStack([]);
                if (currentUser?.id && currentUser.role !== 'admin') {
                  setCurrentUser(prev => prev ? { ...prev, role: 'organizer', isOrganizer: true } : null);
                  localStorage.setItem(`vents_was_organizer_${currentUser.id}`, '1');
                  const { error: promoteErr1 } = await supabase.rpc('promote_to_organizer');
                  if (!promoteErr1 || promoteErr1?.message?.includes('already been set')) {
                    const { error: logErr1 } = await supabase.rpc('log_organizer_promotion' as any, {
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
                      const { error: promoteErr } = await supabase.rpc('promote_to_organizer');
                      const alreadyOrganizer = promoteErr?.message?.includes('already been set');
                      if (promoteErr && !alreadyOrganizer) {
                        console.error('Failed to promote to organizer:', JSON.stringify(promoteErr));
                        Sentry.captureException(promoteErr);
                        setCurrentUser(prev => prev ? { ...prev, role: 'user' } : null);
                        setUserRole('attendee');
                        setScreen('profile');
                      } else {
                        const { error: logErr2 } = await supabase.rpc('log_organizer_promotion' as any, {
                          p_user_id: currentUser.id,
                          p_email: currentUser.email || '',
                          p_username: currentUser.username || '',
                        });
                        if (logErr2) console.warn('Organizer log failed:', logErr2.message, logErr2.code);
                      }
                    }
                    // My Events (ManageEventsScreen) now loads its own data live
                    // via useOrganizerEvents — nothing to prefetch here.
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

          {screen === 'door-manager' && selectedEvent && (
            <DoorManagerScreen
              event={selectedEvent}
              currentUser={currentUser}
              onBack={goBack}
              onOpenScanner={() => navigateTo('checkin-scanner')}
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
              currentUserId={currentUser?.id}
            />
          )}
          {screen === 'settings' && (
          <SettingsScreen
              currentUser={currentUser}
              onBack={goBack}
              onSignOut={handleSignOut}
              onForgotPassword={() => handleSignOut(true)}
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
              onOpenDoorManager={() => navigateTo('door-manager')}
              purchasesDisabled={featureFlags.disablePurchases}
              onOrganizerPress={async (organizerId) => {
                const { data } = await supabase
                  .from('public_profiles')
                  .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role, interests, bio, vc_badge')
                  .eq('id', organizerId)
                  .maybeSingle();
                if (data) { setSelectedUser(mapDbUserToUserProfile(data)); navigateTo('user-profile'); }
              }}
              onMessageOrganizer={async (organizerId, eventId, eventTitle) => {
                const { data } = await supabase
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
          {screen === 'payment-failed' && paymentFailure && (
            <PaymentFailedScreen
              eventTitle={paymentFailure.eventTitle}
              reference={paymentFailure.reference}
              message={paymentFailure.message}
              onGoHome={() => {
                setPaymentFailure(null);
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
                if (editingEventId) {
                  analytics.eventEdited(event.id);
                } else {
                  const priceNum = parseFloat(String(event.ticketPrice).replace(/[^0-9.]/g, '')) || 0;
                  analytics.eventCreated({ eventId: event.id, isFree: priceNum === 0, price: priceNum });
                }
                // My Events refetches itself live (realtime-subscribed via
                // useOrganizerEvents) — the events/tickets triggers this
                // create/update just landed will fire it automatically.
                fetchEvents(true);
                setOrgTab('home');
                setScreen('manage-events');
                setScreenStack([]);
                // A brand-new LIVE publish (never a draft or an edit) gets an
                // immediate, impossible-to-miss chance to promote it — with
                // "manage-events" already sitting under it on the stack so
                // skipping lands the organizer straight on My Events, exactly
                // where they'd otherwise promote it later.
                if (!editingEventId && event.status === 'live') {
                  setPromotionEventId(event.id);
                  setScreen('promote-event');
                  setScreenStack(['manage-events']);
                }
              }}
              onUpdated={(event) => {
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
              currentUser={currentUser}
              onCreateEvent={() => { setEditingEventId(null); navigateTo('create-event'); }}
              onOpenEdit={(eventId) => {
                setEditingEventId(eventId);
                navigateTo('create-event');
              }}
              onViewAttendees={(event) => {
                setSelectedEvent(resolveOrgEventSelection(event));
                navigateTo('attendee-list');
              }}
              onViewAnalytics={(event) => {
                setAnalyticsEventId(event.id);
                setAnalyticsEventTitle(event.title);
                navigateTo('sales-analytics');
              }}
              onOpenDoorManager={(event) => {
                setSelectedEvent(resolveOrgEventSelection(event));
                navigateTo('door-manager');
              }}
              onOpenScanner={(event) => {
                setSelectedEvent(resolveOrgEventSelection(event));
                navigateTo('checkin-scanner');
              }}
              onPromoteEvent={(eventId) => {
                setPromotionEventId(eventId);
                navigateTo('promote-event');
              }}
              onEventDeleted={(eventId) => {
                // Evict from every other in-memory cache immediately — the
                // Home feed / Saved / event-details "isSaved" checks all
                // derive from this same dbEvents array, and would otherwise
                // keep showing the deleted event until the next throttled
                // fetchEvents() call.
                setDbEvents((prev) => prev.filter((e) => e.id !== eventId));
                setSavedEvents((prev) => prev.filter((id) => id !== eventId));
                if (selectedEvent?.id === eventId) setSelectedEvent(null);
              }}
            />
          )}
          {screen === 'sales-analytics' && (
            <SalesAnalyticsScreen currentUser={currentUser} onBack={goBack} eventId={analyticsEventId} eventTitle={analyticsEventTitle} />
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
                const { data } = await supabase
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

        {/* Bottom navigation — 4 tabs, shared by every role. It has no FAB
            (see BottomNav.tsx) and is never mounted on create-event (see
            navScreens above), so it cannot be the source of a stray
            floating button on the event wizard. */}
        {showBottomNav && (
          <BottomNav
            activeTab={activeTab}
            onTabChange={handleTabChange}
          />
        )}

        </ErrorBoundary>
      </div>
    </div>
  );
}