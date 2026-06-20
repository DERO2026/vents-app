import React, { useState, useEffect, useCallback, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { Screen, TabId, AuthMode, Event, TicketType, PurchasedTicket, UserProfile, UserRole, OrganizerEvent } from './components/types';
import { NIGERIA_STATES } from './components/StateSelectScreen';
import { insforge, clearRefreshToken } from '../lib/insforge';

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
import { AttendeeListScreen } from './components/AttendeeListScreen';
import { UserProfileScreen } from './components/UserProfileScreen';
import { PromoteEventScreen } from './components/PromoteEventScreen';
import { NigeriaLiveScreen } from './components/NigeriaLiveScreen';
import { FollowingListScreen } from './components/FollowingListScreen';
import { AdminDashboardScreen } from './components/AdminDashboardScreen';
import { CheckinScannerScreen } from './components/CheckinScannerScreen';
import { ReferralScreen } from './components/ReferralScreen';
import { TransactionsScreen } from './components/TransactionsScreen';
import { InterestsScreen } from './components/InterestsScreen';
import { PrivacyScreen } from './components/PrivacyScreen';
import { TermsScreen } from './components/TermsScreen';
import { HelpPage } from './components/HelpPage';
import { PrivacySecurityScreen } from './components/PrivacySecurityScreen';

const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

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
  if (pathname === '/help') return <HelpPage />;

  const [screen, setScreen] = useState<Screen>('splash');
  const [activeTab, setActiveTab] = useState<TabId>('home');
  const [orgTab, setOrgTab] = useState<OrgTab>('home');
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [screenStack, setScreenStack] = useState<Screen[]>([]);
  const [currentUser, setCurrentUser] = useState<{ id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; avatar_url?: string; cover_url?: string; isOrganizer?: boolean } | null>(null);
  const [showInterests, setShowInterests] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [splashMinTimePassed, setSplashMinTimePassed] = useState(false);
  const [dbEvents, setDbEvents] = useState<Event[]>([]);
  const eventsPageRef = useRef(0);
  const [hasMoreEvents, setHasMoreEvents] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [userRole, setUserRole] = useState<UserRole>('attendee');
  const [language, setLanguage] = useState<string>(() => localStorage.getItem('vents_language') || 'en');
  const [resetToken, setResetToken] = useState<string | undefined>(undefined);
  const [followingFilter, setFollowingFilter] = useState<'following' | 'followers' | 'attendees' | 'all'>('following');
  const [unreadCount, setUnreadCount] = useState(0);

  const handleLanguageChange = useCallback((lang: string) => {
    setLanguage(lang);
    localStorage.setItem('vents_language', lang);
  }, []);

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
    if (ORGANIZER_ONLY_SCREENS.includes(next) && currentUser?.role !== 'organizer' && currentUser?.role !== 'admin' && currentUser?.id !== ROOT_UID) {
      console.warn(`Unauthorized attempt to access ${next} screen`);
      return;
    }
    setScreenStack((prev) => [...prev, screen]);
    setScreen(next);
  }, [currentUser, screen]);

  const goBack = useCallback(() => {
    const prev = screenStack[screenStack.length - 1];
    if (prev) {
      setScreenStack((s) => s.slice(0, -1));
      setScreen(prev);
    } else {
      setScreen('home');
      setActiveTab('home');
    }
  }, [screenStack, userRole]);

  const handleSplashComplete = useCallback(() => {
    setSplashMinTimePassed(true);
  }, []);

  // Load current user and profile on mount
  useEffect(() => {
    async function hydrateAuth() {
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
            })
            .catch((err) => console.error('Deep link event fetch failed:', err));
        }

        // 2. Fetch user session.
        // On localhost, the httpOnly refresh cookie is blocked cross-origin, so we
        // fall back to a refresh token stored in sessionStorage (set at login).
        let sessionUserId: string | null = null;
        let sessionUserEmail: string | null = null;

        const storedRt = sessionStorage.getItem('vents_rt');
        const hc = (insforge as any).getHttpClient?.();
        if (storedRt && hc && !hc.userToken) {
          try {
            const baseUrl = hc.baseUrl || import.meta.env.VITE_INSFORGE_URL;
            const refreshRes = await fetch(`${baseUrl}/api/auth/refresh?client_type=mobile`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refreshToken: storedRt, refresh_token: storedRt }),
            });
            if (refreshRes.ok) {
              const refreshJson = await refreshRes.json();
              if (refreshJson.accessToken) hc.userToken = refreshJson.accessToken;
              if (refreshJson.refreshToken) {
                hc.refreshToken = refreshJson.refreshToken;
                sessionStorage.setItem('vents_rt', refreshJson.refreshToken);
              }
              sessionUserId = refreshJson.user?.id || null;
              sessionUserEmail = refreshJson.user?.email || null;
            } else {
              sessionStorage.removeItem('vents_rt');
            }
          } catch { /* ignore — fall through to normal getCurrentUser */ }
        }

        // If we got the user from the manual refresh, skip SDK call
        if (!sessionUserId) {
          const { data, error } = await insforge.auth.getCurrentUser();
          if (error) {
            console.error("GetCurrentUser failed:", error);
            if (error.statusCode !== 401) {
              setAuthError(error.message || "Session restoration failed.");
            }
            setCurrentUser(null);
            setAuthLoading(false);
            return;
          }
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
          sessionStorage.removeItem('vents_rt');
          setCurrentUser(null);
          setAuthError('Your account has been suspended. To appeal, contact ventsappltd@gmail.com or WhatsApp +234 9030737368.');
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
          isOrganizer: (profile?.role === 'organizer' || profile?.role === 'organiser')
        });
      } catch (err: any) {
        console.error("Auth rehydration failed:", err);
        setAuthError(err?.message || "An unexpected error occurred during auth rehydration.");
        setCurrentUser(null);
      } finally {
        setAuthLoading(false);
      }
    }
    hydrateAuth();
  }, []);

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
        console.warn("Auth hydration safety timeout triggered. Forcing welcome screen.");
        setCurrentUser(null);
        setAuthLoading(false);
        setScreen('welcome');
      }
    }, 8000);
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
  const [following, setFollowing] = useState<string[]>([]);

  // Fetch user's follows from database
  useEffect(() => {
    async function fetchFollows() {
      if (!currentUser?.id) {
        setFollowing([]);
        return;
      }
      try {
        const { data, error } = await insforge.database
          .from('follows')
          .select('following_id')
          .eq('follower_id', currentUser.id);
        if (error) throw error;
        if (data) {
          setFollowing(data.map((f: any) => f.following_id));
        }
      } catch (err) {
        console.error("Failed to fetch follows:", err);
      }
    }
    fetchFollows();
  }, [currentUser]);

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
  const [bookingLoading, setBookingLoading] = useState(false);
  const [promotionEventId, setPromotionEventId] = useState<string>('');

  const fetchUserTickets = useCallback(async (userId: string) => {
    try {
      const { data, error } = await insforge.database
        .from('tickets')
        .select('*, events(*)')
        .eq('user_id', userId)
        .eq('status', 'active');
      
      if (error) throw error;
      
      if (data) {
        const mappedTickets: PurchasedTicket[] = data
          .filter((t: any) => t.events)
          .map((t: any) => {
            const dbEvent = t.events;
            const dt = new Date(dbEvent.event_date);
          const dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
          const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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
            attendees: dbEvent.attendee_count ?? 0,
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
            following_id: dbEvent.following_id,
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
            holderName: currentUser?.full_name || 'Attendee'
          };
        });

        setAllTickets(mappedTickets);
      }
    } catch (err) {
      console.error('Failed to fetch user tickets:', err);
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
      const start = nextPage * 10;
      const end = start + 9;

      // Calculate user's age for 18+ filtering
      const userDob = (currentUser as any)?.date_of_birth;
      const userAgeYears = userDob
        ? Math.floor((Date.now() - new Date(userDob).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
        : 99;

      let eventsQuery = insforge.database
        .from('events')
        .select('*, users!events_organizer_id_fkey(username, full_name)')
        .eq('hidden_by_admin', false);

      // Hide 18+ events from underage users
      if (userAgeYears < 18) {
        eventsQuery = (eventsQuery as any).eq('is_18_plus', false);
      }

      const { data: dbEventsData, error: dbEventsError } = await eventsQuery.range(start, end);

      if (dbEventsError) throw dbEventsError;

      if (dbEventsData) {
        const hasMore = dbEventsData.length === 10;
        setHasMoreEvents(hasMore);
        eventsPageRef.current = loadMore ? nextPage : 0;

        const eventIds = dbEventsData.map((e: any) => e.id);
        const mapped = dbEventsData.map((e: any) => {
          const orgUser = e.users;
          return mapDbEventToFrontend({
            ...e,
            organizer_name: orgUser?.username || orgUser?.full_name || null,
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

          const { data: ticketsRes } = await insforge.database
            .from('tickets')
            .select('event_id, status')
            .in('event_id', eventIds);
          if (ticketsRes) ticketsData = ticketsRes;

          // Fetch saves count per event for popularity score
          const { data: savesRes } = await insforge.database
            .from('saved_events')
            .select('event_id')
            .in('event_id', eventIds);
          if (savesRes) savesData = savesRes;
        }

        const bookingsCountMap: Record<string, number> = {};
        ticketsData.forEach((t: any) => {
          if (t.status === 'active') {
            bookingsCountMap[t.event_id] = (bookingsCountMap[t.event_id] || 0) + 1;
          }
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
      console.log("Already booked this event.");
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
  const [conversationUser, setConversationUser] = useState<{ id: string; name: string; avatarUrl?: string } | null>(null);
  const [conversationEventId, setConversationEventId] = useState<string | undefined>(undefined);
  const [conversationEventTitle, setConversationEventTitle] = useState<string | undefined>(undefined);

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
    setSelectedEvent(event);
    navigateTo('event-details');
  }, [navigateTo]);

  const handleGetTickets = useCallback((ticketType: TicketType) => {
    setSelectedTicketType(ticketType);
    navigateTo('ticket-select');
  }, [navigateTo]);

  const handleCheckoutSuccess = useCallback(async (ticket: PurchasedTicket) => {
    if (currentUser) {
      try {
        // Guard: check if an active ticket already exists for this user + event
        const { data: existingTicket, error: checkError } = await insforge.database
          .from('tickets')
          .select('id')
          .eq('event_id', ticket.event.id)
          .eq('user_id', currentUser.id)
          .eq('status', 'active')
          .maybeSingle();

        if (checkError) throw checkError;

        if (!existingTicket) {
          const { error: insertError } = await insforge.database.rpc('purchase_ticket', {
            p_event_id: ticket.event.id,
            p_ticket_type: ticket.ticketType?.name ?? 'General',
            p_quantity: ticket.quantity,
            p_payment_ref: ticket.ticketId ?? `VNT-${Date.now()}`,
            p_payment_status: 'paid',
          });
          if (insertError) throw insertError;

          // 3.6: Ticket confirmation notification
          insforge.database.from('notifications').insert([{
            user_id: currentUser.id,
            type: 'booking',
            title: 'Ticket confirmed! 🎉',
            body: `Your ${ticket.ticketType?.name ?? 'General'} ticket for ${ticket.event.title} is confirmed.`,
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
    setSelectedTicketType(ticketType);
    setSelectedTicketQty(qty);
    if ((ticketType.price ?? 0) * qty === 0) {
      const freeTicket: PurchasedTicket = {
        id: `free-${Date.now()}`,
        event: selectedEvent!,
        ticketType,
        quantity: qty,
        totalPaid: 0,
        purchaseDate: new Date().toISOString(),
        status: 'active',
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

  const handleToggleFollow = useCallback(async (userId: string) => {
    if (!currentUser) {
      console.warn("User must be logged in to follow");
      navigateTo('auth');
      return;
    }
    if (userId === currentUser.id) return;

    const isFollowing = following.includes(userId);
    // Optimistically update UI
    setFollowing((prev) =>
      isFollowing ? prev.filter((id) => id !== userId) : [...prev, userId]
    );

    try {
      if (isFollowing) {
        const { error } = await insforge.database
          .from('follows')
          .delete()
          .eq('follower_id', currentUser.id)
          .eq('following_id', userId);
        if (error) throw error;
      } else {
        const { error } = await insforge.database
          .from('follows')
          .insert([{
            follower_id: currentUser.id,
            following_id: userId
          }]);
        if (error) throw error;
        // 3.6: Notify the followed user
        const displayName = currentUser.username ? `@${currentUser.username}` : (currentUser.full_name || 'Someone');
        insforge.database.rpc('notify_user' as any, {
          p_user_id: userId,
          p_type: 'social',
          p_title: 'New follower',
          p_body: `${displayName} started following you`,
          p_icon: '👤',
        }).then(({ error: notifyErr }: any) => {
          if (notifyErr) console.warn('Follow notify failed:', notifyErr.message);
        });
      }
    } catch (err) {
      console.error("Failed to toggle follow in DB:", err);
      // Revert optimistic update
      setFollowing((prev) =>
        isFollowing ? [...prev, userId] : prev.filter((id) => id !== userId)
      );
    }
  }, [currentUser, following, navigateTo]);

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
    navigateTo(target as Screen);
  }, [navigateTo]);

  const handleAuthSuccess = useCallback(async (userProfile: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; avatar_url?: string; isOrganizer?: boolean }) => {
    const enriched = {
      ...userProfile,
      isOrganizer: userProfile.role === 'organizer' || userProfile.role === 'organiser' || !!userProfile.isOrganizer
    };
    setCurrentUser(enriched);
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
    clearRefreshToken();
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

  // Screens where the bottom nav is visible for both roles
  const navScreens = ['home', 'explore', 'my-tickets', 'profile'];
  const showBottomNav = !!currentUser && navScreens.includes(screen);

  // Determine if the current user is organizer/admin (for nav FAB)
  const isOrganizerOrAdmin =
    userRole === 'organizer' ||
    currentUser?.role === 'admin' ||
    currentUser?.id === ROOT_UID;

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
              onOpenConversation={(userId, userName, avatarUrl) => {
                setConversationUser({ id: userId, name: userName, avatarUrl });
                navigateTo('conversation');
              }}
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
              followingCount={following.length}
              onViewTicket={(ticket) => {
                setPurchasedTicket(ticket);
                navigateTo('payment-success');
              }}
              onNavigate={handleProfileNavigate}
              onNavigateToFollowingFilter={(filter) => {
                setFollowingFilter(filter);
                navigateTo('following-list');
              }}
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
          {screen === 'following-list' && (
            <FollowingListScreen
              following={following}
              onToggleFollow={handleToggleFollow}
              onBack={goBack}
              currentUserId={currentUser?.id}
              initialFilter={followingFilter}
              onUserPress={(user) => {
                setSelectedUser(user);
                navigateTo('user-profile');
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
              onBack={goBack}
              onViewTicket={(ticket) => {
                setPurchasedTicket(ticket);
                navigateTo('payment-success');
              }}
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
                setCurrentUser((prev) => prev ? { ...prev, ...fields, isOrganizer: fields.role === 'organizer' || prev.isOrganizer } : null);
              }}
              language={language}
              onLanguageChange={handleLanguageChange}
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
              event={selectedEvent}
              onBack={goBack}
              onGetTickets={handleTicketContinue}
              isSaved={savedEvents.includes(selectedEvent.id)}
              onToggleSave={() => handleToggleSave(selectedEvent.id)}
              isBooked={currentUser ? allTickets.some((t) => t.event.id === selectedEvent.id) : false}
              onBook={() => handleBookEvent(selectedEvent)}
              bookingLoading={bookingLoading}
              onEventPress={handleEventPress}
              following={following}
              onToggleFollow={handleToggleFollow}
              currentUserId={currentUser?.id}
              onOrganizerPress={async (organizerId) => {
                const { data } = await insforge.database
                  .from('public_profiles')
                  .select('id, full_name, username, avatar_url, cover_url, is_verified, state, role')
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
                const evtToScan = dbEvents.find(e => e.id === eventId);
                if (evtToScan) setSelectedEvent(evtToScan);
                navigateTo('checkin-scanner');
              }}
              onEventPress={(event) => {
                // Navigate to event management / analytics for this event
                const mapped = dbEvents.find(e => e.id === event.id);
                if (mapped) setSelectedEvent(mapped);
                navigateTo('event-details');
              }}
            />
          )}
          {screen === 'create-event' && (
            <CreateEventScreen
              currentUser={currentUser}
              onBack={goBack}
              onCreated={(event) => {
                setOrgEvents((prev) => [event, ...prev]);
                fetchEvents(true);
                setOrgTab('manage-events');
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

          {screen === 'transactions' && (
            <TransactionsScreen onBack={goBack} />
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

          {/* ── CONVERSATION ── */}
          {screen === 'conversation' && currentUser && conversationUser && (
            <ConversationScreen
              currentUser={currentUser}
              otherUser={conversationUser}
              eventId={conversationEventId}
              eventTitle={conversationEventTitle}
              onBack={goBack}
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
              isFollowing={following.includes(selectedUser.id)}
              onToggleFollow={() => handleToggleFollow(selectedUser.id)}
              onBack={goBack}
              onEventPress={handleEventPress}
              currentUserId={currentUser?.id}
              onMessage={(userId) => {
                setConversationUser({
                  id: userId,
                  name: selectedUser.name,
                  avatarUrl: selectedUser.avatar,
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