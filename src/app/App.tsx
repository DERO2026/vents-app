import React, { useState, useEffect, useCallback, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { Screen, TabId, AuthMode, Event, TicketType, PurchasedTicket, UserProfile, UserRole, OrganizerEvent } from './components/types';
import { NIGERIA_STATES } from './components/StateSelectScreen';
import { insforge } from '../lib/insforge';

import { SplashScreen } from './components/SplashScreen';
import { WelcomeScreen } from './components/WelcomeScreen';
import { StateSelectScreen } from './components/StateSelectScreen';
import { RoleSelectScreen } from './components/RoleSelectScreen';
import { AuthScreen } from './components/AuthScreen';
import { HomeScreen, mapDbEventToFrontend } from './components/HomeScreen';
import { ExploreScreen } from './components/ExploreScreen';
import { SavedScreen } from './components/SavedScreen';
import { ProfileScreen } from './components/ProfileScreen';
import { BottomNav } from './components/BottomNav';
import { OrganizerBottomNav, OrgTab } from './components/OrganizerBottomNav';
import { NotificationsScreen } from './components/NotificationsScreen';
import { MyTicketsScreen } from './components/MyTicketsScreen';
import { SettingsScreen } from './components/SettingsScreen';
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

const TAB_SCREENS: Record<TabId, Screen> = {
  home: 'home',
  explore: 'explore',
  saved: 'saved',
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
          width: '390px',
          height: '844px',
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
  const [activeTab, setActiveTab] = useState<TabId>('home');
  const [orgTab, setOrgTab] = useState<OrgTab>('org-dashboard');
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [screenStack, setScreenStack] = useState<Screen[]>([]);
  const [currentUser, setCurrentUser] = useState<{ id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [splashMinTimePassed, setSplashMinTimePassed] = useState(false);
  const [dbEvents, setDbEvents] = useState<Event[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [userRole, setUserRole] = useState<UserRole>('attendee');

  const navigateTo = useCallback((next: Screen) => {
    if ((next === 'create-event' || next === 'promote-event') && currentUser?.role !== 'organizer') {
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
      if (userRole === 'organizer') {
        setScreen('org-dashboard');
      } else {
        setScreen('home');
        setActiveTab('home');
      }
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

        // 2. Fetch user session (Google OAuth exchange is auto-run by SDK on init, so getCurrentUser will automatically await it)
        const { data, error } = await insforge.auth.getCurrentUser();
        
        if (error) {
          console.error("GetCurrentUser failed:", error);
          // Only show error banner if it's a real failure, not just a missing session
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

        // Fetch user profile from public schema to get the role and full name
        const { data: profile } = await insforge.database
          .from('users')
          .select('*')
          .eq('id', data.user.id)
          .maybeSingle();

        setCurrentUser({
          id: data.user.id,
          email: data.user.email,
          full_name: profile?.full_name || data.user.email.split('@')[0],
          role: profile?.role || 'user',
          username: profile?.username,
          phone_number: profile?.phone_number,
          state: profile?.state
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

  // Safety Timeout to prevent stuck splash screen on network/auth hang
  useEffect(() => {
    const safetyTimeout = setTimeout(() => {
      if (authLoading) {
        console.warn("Auth hydration safety timeout triggered. Forcing welcome screen.");
        setCurrentUser(null);
        setAuthLoading(false);
        setScreen('welcome');
      }
    }, 4000);
    return () => clearTimeout(safetyTimeout);
  }, [authLoading]);

  // Sync userRole Effect
  useEffect(() => {
    if (currentUser) {
      setUserRole(currentUser.role === 'organizer' ? 'organizer' : 'attendee');
    }
  }, [currentUser]);

  // Splash Routing Effect
  useEffect(() => {
    if (screen === 'splash' && splashMinTimePassed && !authLoading) {
      if (currentUser) {
        if (currentUser.role === 'organizer') {
          setUserRole('organizer');
          setOrgTab('org-dashboard');
          setScreen('org-dashboard');
        } else {
          setUserRole('attendee');
          setScreen('home');
          setActiveTab('home');
        }
      } else {
        setScreen('welcome');
      }
    }
  }, [screen, splashMinTimePassed, authLoading, currentUser]);

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
            attendees: 150,
            capacity: 1000,
            rating: 4.9,
            reviewCount: 36,
            ticketTypes: [
              {
                id: 't1',
                name: 'Regular',
                price: Number(dbEvent.price || 0),
                description: 'General Admission',
                available: 500
              }
            ],
            organizer_id: dbEvent.organizer_id,
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
  }, [currentUser]);

  const lastFetchRef = useRef<number>(0);
  const fetchEvents = useCallback(async (force = false) => {
    if (!force && Date.now() - lastFetchRef.current < 5000) {
      return;
    }
    lastFetchRef.current = Date.now();
    setLoadingEvents(true);
    try {
      const { data: dbEventsData, error: dbEventsError } = await insforge.database
        .from('events')
        .select('*');

      if (dbEventsError) throw dbEventsError;

      const nowStr = new Date().toISOString();
      const { data: promotionsData } = await insforge.database
        .from('event_promotions')
        .select('*')
        .eq('status', 'active')
        .lte('start_date', nowStr)
        .gte('end_date', nowStr);

      const { data: ticketsData } = await insforge.database
        .from('tickets')
        .select('event_id, status');

      if (dbEventsData) {
        const mapped = dbEventsData.map(mapDbEventToFrontend);

        const bookingsCountMap: Record<string, number> = {};
        if (ticketsData) {
          ticketsData.forEach((t: any) => {
            if (t.status === 'active') {
              bookingsCountMap[t.event_id] = (bookingsCountMap[t.event_id] || 0) + 1;
            }
          });
        }

        const promotionPlanMap: Record<string, string> = {};
        if (promotionsData) {
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
        }

        const enriched = mapped.map(evt => {
          const promoPlan = promotionPlanMap[evt.id];
          const bookings = bookingsCountMap[evt.id] || 0;
          return {
            ...evt,
            isPromoted: !!promoPlan,
            promoPlan: promoPlan || null,
            bookingsCount: bookings,
            attendees: bookings,
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

          if (a.bookingsCount !== b.bookingsCount) {
            return b.bookingsCount - a.bookingsCount;
          }

          const rawA = dbEventsData.find((x: any) => x.id === a.id)?.created_at || '';
          const rawB = dbEventsData.find((x: any) => x.id === b.id)?.created_at || '';
          return new Date(rawB).getTime() - new Date(rawA).getTime();
        });

        setDbEvents(enriched);
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
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);

  const [isDark, setIsDark] = useState<boolean>(() => {
    const saved = localStorage.getItem('theme_preference');
    return saved !== null ? saved === 'dark' : true;
  });
  const [selectedState, setSelectedState] = useState<string>(() => {
    return localStorage.getItem('selected_state_preference') || NIGERIA_STATES[0].name;
  });

  useEffect(() => {
    localStorage.setItem('theme_preference', isDark ? 'dark' : 'light');
  }, [isDark]);

  useEffect(() => {
    localStorage.setItem('selected_state_preference', selectedState);
  }, [selectedState]);
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
    setScreen(tab as Screen);
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

  const handleTicketContinue = useCallback((ticketType: TicketType, qty: number) => {
    setSelectedTicketType(ticketType);
    setSelectedTicketQty(qty);
    navigateTo('checkout');
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
          const { error: insertError } = await insforge.database
            .from('tickets')
            .insert([{
              event_id: ticket.event.id,
              user_id: currentUser.id,
              quantity: ticket.quantity,
              status: 'active'
            }]);
          
          if (insertError) throw insertError;
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

  const handleToggleSave = useCallback((eventId: string) => {
    setSavedEvents((prev) =>
      prev.includes(eventId) ? prev.filter((id) => id !== eventId) : [...prev, eventId]
    );
  }, []);

  const handleToggleFollow = useCallback(async (userId: string) => {
    if (!currentUser) {
      console.warn("User must be logged in to follow");
      navigateTo('auth');
      return;
    }

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
      handleTabChange('saved');
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

  const handleAuthSuccess = useCallback((userProfile: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string }) => {
    setCurrentUser(userProfile);
    setScreenStack([]);
    if (userProfile.role === 'organizer') {
      setUserRole('organizer');
      setOrgTab('org-dashboard');
      setScreen('org-dashboard');
    } else {
      setUserRole('attendee');
      setScreen('home');
      setActiveTab('home');
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    setAuthLoading(true);
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

  // Attendee screens where bottom nav shows
  const attendeeNavScreens = ['home', 'explore', 'saved', 'profile'];
  // Organizer screens where org bottom nav shows
  const orgNavScreens = ['org-dashboard', 'manage-events', 'sales-analytics', 'profile'];

  const showAttendeeNav = userRole === 'attendee' && attendeeNavScreens.includes(screen);
  const showOrgNav = userRole === 'organizer' && orgNavScreens.includes(screen);

  return (
    <div 
      className="min-h-screen flex items-center justify-center"
      style={{
        background: isDark
          ? 'linear-gradient(135deg, #0A0520 0%, #060A14 50%, #100520 100%)'
          : 'linear-gradient(135deg, #E8E0F0 0%, #F0EDF8 50%, #EAE0F4 100%)',
        fontFamily: 'Inter, sans-serif',
        transition: 'background 0.3s ease',
      }}
    >
      <style>{`
        .light-theme { color-scheme: light; }
      `}</style>
      {/* Phone frame */}
      <div
        className={`relative overflow-hidden${isDark ? '' : ' light-theme'}`}
        style={{
          width: '390px',
          height: '844px',
          maxWidth: '100vw',
          maxHeight: '100vh',
          borderRadius: 'clamp(0px, 4vw, 44px)',
          boxShadow: isDark
            ? '0 40px 120px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.08)'
            : '0 40px 120px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.1)',
          background: isDark ? '#060A12' : '#F5F3FA',
          transition: 'background 0.3s ease',
        }}
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
                navigateTo('state-select');
              }}
              onSignIn={() => {
                setPendingSignup(false);
                setAuthMode('login');
                navigateTo('state-select');
              }}
              onPickState={() => {
                setPendingSignup(true);
                navigateTo('state-select');
              }}
            />
          )}
          {screen === 'state-select' && (
            <StateSelectScreen
              selectedStateName={selectedState}
              onContinue={(state) => {
                setSelectedState(state.name);
                // Both signup and login paths go through role selection
                navigateTo('role-select');
              }}
            />
          )}
          {screen === 'role-select' && (
            <RoleSelectScreen
              onBack={goBack}
              onSelect={(role) => {
                setUserRole(role);
                navigateTo('auth');
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
            />
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
            />
          )}
          {screen === 'explore' && (
            <ExploreScreen
              dbEvents={dbEvents}
              onEventPress={handleEventPress}
              savedEvents={savedEvents}
              onToggleSave={handleToggleSave}
              following={following}
              onToggleFollow={handleToggleFollow}
              onUserPress={(user) => {
                setSelectedUser(user);
                navigateTo('user-profile');
              }}
            />
          )}
          {screen === 'saved' && (
            <SavedScreen
              savedEventIds={savedEvents}
              onEventPress={handleEventPress}
              onToggleSave={handleToggleSave}
            />
          )}
          {screen === 'profile' && (
            <ProfileScreen
              currentUser={currentUser}
              onSignOut={handleSignOut}
              tickets={allTickets}
              savedCount={savedEvents.length}
              followingCount={following.length}
              onViewTicket={(ticket) => {
                setPurchasedTicket(ticket);
                navigateTo('payment-success');
              }}
              onNavigate={handleProfileNavigate}
            />
          )}

          {/* ── UTILITY SCREENS ── */}
          {screen === 'notifications' && (
            <NotificationsScreen onBack={goBack} />
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
              isDark={isDark}
              onToggleDark={() => setIsDark((v) => !v)}
            />
          )}

          {/* ── EVENT FLOW ── */}
          {screen === 'event-details' && selectedEvent && (
            <EventDetailsScreen
              event={selectedEvent}
              onBack={goBack}
              onGetTickets={handleGetTickets}
              isSaved={savedEvents.includes(selectedEvent.id)}
              onToggleSave={() => handleToggleSave(selectedEvent.id)}
              isBooked={currentUser ? allTickets.some((t) => t.event.id === selectedEvent.id) : false}
              onBook={() => handleBookEvent(selectedEvent)}
              bookingLoading={bookingLoading}
              onEventPress={handleEventPress}
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
                if (userRole === 'organizer') {
                  setScreen('org-dashboard');
                } else {
                  setScreen('home');
                  setActiveTab('home');
                }
                setScreenStack([]);
              }}
            />
          )}

          {/* ── ORGANIZER FLOW ── */}
          {screen === 'org-dashboard' && (
            <OrganizerDashboard
              currentUser={currentUser}
              onBack={screenStack.length > 0 ? goBack : () => {}}
              onNavigate={handleOrgNavigate}
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
            <AttendeeListScreen onBack={goBack} />
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
            />
          )}
              </>
            )}
          </div>

        {/* Attendee bottom navigation */}
        {showAttendeeNav && (
          <BottomNav
            activeTab={activeTab}
            onTabChange={handleTabChange}
            onTicketsPress={handleTicketsPress}
          />
        )}

        {/* Organizer bottom navigation */}
        {showOrgNav && (
          <OrganizerBottomNav
            activeTab={orgTab}
            onTabChange={handleOrgTabChange}
            onCreatePress={() => navigateTo('create-event')}
          />
        )}
        </ErrorBoundary>
      </div>
    </div>
  );
}
