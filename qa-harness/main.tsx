// QA-ONLY harness entry. Mounts the REAL app components (not copies) with
// deterministic fixture props/data via fakeSupabase.ts -- never touches
// Production, never mutates anything, read-only fixture data only.
import { createRoot } from 'react-dom/client';
import '../src/styles/index.css';
import { OrganizerDashboard } from '../src/app/components/OrganizerDashboard';
import { ManageEventsScreen } from '../src/app/components/ManageEventsScreen';
import { SalesAnalyticsScreen } from '../src/app/components/SalesAnalyticsScreen';
import { HomeScreen, mapDbEventToFrontend } from '../src/app/components/HomeScreen';
import { WelcomeScreen } from '../src/app/components/WelcomeScreen';
import { EventDetailsScreen } from '../src/app/components/EventDetailsScreen';
import { CheckoutScreen } from '../src/app/components/CheckoutScreen';
import { ServicesHomeScreen } from '../src/app/components/ServicesHomeScreen';
import { ServiceBookingsScreen } from '../src/app/components/ServiceBookingsScreen';
import { MyTicketsScreen } from '../src/app/components/MyTicketsScreen';
import { QRTicket } from '../src/app/components/QRTicket';
import { InboxScreen } from '../src/app/components/InboxScreen';
import { NotificationsScreen } from '../src/app/components/NotificationsScreen';
import { ManageProviderServicesScreen } from '../src/app/components/ManageProviderServicesScreen';
import { CheckinScannerScreen } from '../src/app/components/CheckinScannerScreen';
import { DoorManagerScreen } from '../src/app/components/DoorManagerScreen';
import { BottomNav } from '../src/app/components/BottomNav';
import { TicketRefundScreen } from '../src/app/components/TicketRefundScreen';
import { PaymentRequestScreen } from '../src/app/components/PaymentRequestScreen';
import { CountrySelectScreen } from '../src/app/components/CountrySelectScreen';
import { WalletScreen } from '../src/app/components/WalletScreen';
import { AuthScreen } from '../src/app/components/AuthScreen';
import { CreateEventScreen } from '../src/app/components/CreateEventScreen';
import { PaymentFailedScreen } from '../src/app/components/PaymentFailedScreen';
import { ProfileScreen } from '../src/app/components/ProfileScreen';
import { PromoteEventScreen } from '../src/app/components/PromoteEventScreen';
import { ServiceCategoryScreen } from '../src/app/components/ServiceCategoryScreen';
import { ServiceProviderProfileScreen } from '../src/app/components/ServiceProviderProfileScreen';
import { ServiceProviderSetupScreen } from '../src/app/components/ServiceProviderSetupScreen';
import { ServiceProviderVerificationScreen } from '../src/app/components/ServiceProviderVerificationScreen';
import { SettingsScreen } from '../src/app/components/SettingsScreen';
import { UserProfileScreen } from '../src/app/components/UserProfileScreen';
import { UserWalletScreen } from '../src/app/components/UserWalletScreen';
import { ExploreScreen } from '../src/app/components/ExploreScreen';
import { ReferralScreen } from '../src/app/components/ReferralScreen';
import App from '../src/app/App';

const FIXTURE_USER = { id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'organizer' };

const FIXTURE_EVENTS = [
  {
    id: 'evt-1', title: 'Lagos Music Festival', location: 'Eko Atlantic, Lagos',
    price: 15000, status: 'live', event_date: new Date(Date.now() + 7 * 86400000).toISOString(),
    category: 'Music', organizer_id: 'org-1', image_url: null, country: 'NG',
  },
  {
    id: 'evt-2', title: 'Comedy Night Abuja', location: 'Transcorp Hilton, Abuja',
    price: 5000, status: 'live', event_date: new Date(Date.now() + 14 * 86400000).toISOString(),
    category: 'Comedy', organizer_id: 'org-1', image_url: null, country: 'NG',
  },
  {
    id: 'evt-3', title: 'Free Tech Meetup', location: 'Landmark Centre, Lagos',
    price: 0, status: 'live', event_date: new Date(Date.now() + 30 * 86400000).toISOString(),
    category: 'Technology', organizer_id: 'org-1', image_url: null, country: 'NG',
  },
  {
    id: 'evt-4', title: 'Abuja Food Carnival', location: 'Millennium Park, Abuja',
    price: 3000, status: 'live', event_date: new Date(Date.now() + 10 * 86400000).toISOString(),
    category: 'Food', organizer_id: 'org-1', image_url: null, country: 'NG',
  },
] as any[];

const SCREENS: Record<string, () => JSX.Element> = {
  welcome: () => <WelcomeScreen onGetStarted={() => {}} onSignIn={() => {}} />,
  'organizer-dashboard': () => (
    <OrganizerDashboard currentUser={FIXTURE_USER} setActiveView={() => {}} />
  ),
  'manage-events': () => (
    <ManageEventsScreen
      currentUser={FIXTURE_USER}
      onBack={() => {}}
      onOpenEdit={() => {}}
      onCreateEvent={() => {}}
      onViewAttendees={() => {}}
      onViewAnalytics={() => {}}
      onOpenDoorManager={() => {}}
      onOpenScanner={() => {}}
    />
  ),
  'sales-analytics': () => (
    <SalesAnalyticsScreen currentUser={FIXTURE_USER} onBack={() => {}} />
  ),
  home: () => (
    <HomeScreen
      onEventPress={() => {}}
      savedEvents={[]}
      onToggleSave={() => {}}
      dbEvents={FIXTURE_EVENTS.map((e) => mapDbEventToFrontend({ ...e, ticket_types: [{ id: 't1', name: 'Regular', price: e.price, description: 'General Admission', available: 500 }] }))}
      loading={false}
      fetchEvents={() => {}}
      currentUser={FIXTURE_USER}
      countryFilter="NG"
      onCountryFilterChange={() => {}}
    />
  ),
  'event-details': () => {
    const dbEvent = { ...FIXTURE_EVENTS[0], ticket_types: [{ id: 't1', name: 'Regular', price: 15000, description: 'General Admission', available: 500 }] };
    const event = mapDbEventToFrontend(dbEvent);
    return (
      <EventDetailsScreen
        event={event}
        onBack={() => {}}
        onGetTickets={() => {}}
        isSaved={false}
        onToggleSave={() => {}}
        currentUserId="user-1"
      />
    );
  },
  'services-home': () => (
    <ServicesHomeScreen
      onBack={() => {}}
      onCategoryPress={() => {}}
      onProviderPress={() => {}}
      discoveryCountryIso="NG"
      onDiscoveryCountryChange={() => {}}
    />
  ),
  'service-bookings': () => (
    <ServiceBookingsScreen mode="customer" onBack={() => {}} />
  ),
  'provider-bookings': () => (
    <ServiceBookingsScreen mode="provider" providerId="prov-1" onBack={() => {}} />
  ),
  'my-tickets': () => {
    const dbEvent = { ...FIXTURE_EVENTS[0] };
    const event = mapDbEventToFrontend(dbEvent);
    const activeTicket = {
      event, ticketType: { id: 't1', name: 'Regular', price: 15000, description: 'General Admission', available: 500 },
      quantity: 1, ticketId: 'tkt-1', purchasedAt: new Date().toISOString(), totalAmount: 15000,
      holderName: 'Test Organizer', holderEmail: 'organizer@example.com',
      status: 'active', paymentStatus: 'paid',
    };
    // Verifies the refunded/cancelled navigation fix: a real cancelled
    // ticket for a future event must land in Past (never Upcoming) and
    // route to TicketRefundScreen on tap, not the QR view.
    const refundedTicket = {
      event, ticketType: { id: 't1', name: 'Regular', price: 15000, description: 'General Admission', available: 500 },
      quantity: 1, ticketId: 'tkt-refund-1', purchasedAt: new Date().toISOString(), totalAmount: 15000,
      holderName: 'Test Organizer', holderEmail: 'organizer@example.com',
      status: 'cancelled', paymentStatus: 'refunded',
    };
    return (
      <MyTicketsScreen
        tickets={[activeTicket as any, refundedTicket as any]}
        loading={false}
        onBack={() => {}}
        onViewTicket={(t: any) => { (window as any).__lastViewedTicket = t; }}
        currentUserId="org-1"
        currentUserEmail="organizer@example.com"
      />
    );
  },
  'qr-ticket': () => {
    const dbEvent = { ...FIXTURE_EVENTS[0] };
    const event = mapDbEventToFrontend(dbEvent);
    const ticket = {
      event, ticketType: { id: 't1', name: 'Regular', price: 15000, description: 'General Admission', available: 500 },
      quantity: 1, ticketId: 'tkt-1', purchasedAt: new Date().toISOString(), totalAmount: 15000,
      holderName: 'Ada Chukwu', holderEmail: 'ada@example.com',
      paidByName: 'Tobi Oyelaran', transferredFromName: null, checkedIn: false,
    };
    return <QRTicket ticket={ticket as any} onBack={() => {}} onGoHome={() => {}} />;
  },
  inbox: () => (
    <InboxScreen currentUser={{ id: 'org-1' }} onBack={() => {}} onOpenConversation={() => {}} />
  ),
  notifications: () => (
    <NotificationsScreen currentUser={{ id: 'org-1' }} onBack={() => {}} />
  ),
  'manage-provider-services': () => (
    <ManageProviderServicesScreen providerId="prov-1" accountCountry="NG" onBack={() => {}} />
  ),
  scanner: () => (
    <CheckinScannerScreen
      onBack={() => {}}
      currentUser={{ id: 'org-1', role: 'organizer' }}
      selectedEvent={{ id: 'evt-1', title: 'Lagos Music Festival' } as any}
    />
  ),
  'door-manager': () => (
    <DoorManagerScreen
      event={{ id: 'evt-1', title: 'Lagos Music Festival', organizer_id: 'org-1' } as any}
      currentUser={{ id: 'org-1', role: 'organizer' }}
      onBack={() => {}}
      onOpenScanner={() => {}}
    />
  ),
  'bottom-nav': () => (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#08070C' }}>
      <BottomNav activeTab="home" onTabChange={() => {}} hasUnreadChats />
    </div>
  ),
  checkout: () => {
    const dbEvent = { ...FIXTURE_EVENTS[0] };
    const event = mapDbEventToFrontend(dbEvent);
    const ticketType = { id: 't1', name: 'Regular', price: 15000, description: 'General Admission', available: 500 };
    return (
      <CheckoutScreen
        event={event}
        ticketType={ticketType}
        quantity={1}
        currentUser={FIXTURE_USER}
        onBack={() => {}}
        onSuccess={() => {}}
      />
    );
  },
  'ticket-refund': () => (
    <TicketRefundScreen ticketId="tkt-refund-1" onBack={() => {}} onViewWallet={() => {}} />
  ),
  'payment-request': () => (
    <PaymentRequestScreen paymentRef="pr-1" currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer' }} onBack={() => {}} onPaid={() => {}} />
  ),
  'country-select': () => (
    <CountrySelectScreen onContinue={() => {}} onBack={() => {}} />
  ),
  wallet: () => (
    <WalletScreen currentUser={FIXTURE_USER} onBack={() => {}} />
  ),
  'auth-signup': () => (
    <AuthScreen initialMode="signup" onBack={() => {}} onSuccess={() => {}} />
  ),
  'auth-login': () => (
    <AuthScreen initialMode="login" onBack={() => {}} onSuccess={() => {}} />
  ),
  'auth-verify-otp': () => (
    <AuthScreen initialMode="signup" onBack={() => {}} onSuccess={() => {}} pendingVerificationEmail="ada@example.com" />
  ),
  'auth-forgot': () => (
    <AuthScreen initialMode="forgot" onBack={() => {}} onSuccess={() => {}} />
  ),
  'auth-forgot-otp': () => (
    <AuthScreen initialMode="forgot" onBack={() => {}} onSuccess={() => {}} pendingResetEmail="ada@example.com" />
  ),
  'create-event': () => (
    <CreateEventScreen currentUser={FIXTURE_USER} onBack={() => {}} onCreated={() => {}} />
  ),
  'payment-failed': () => (
    <PaymentFailedScreen eventTitle="Lagos Music Festival" reference="VN-8F42-K19C" message="Your card was declined by your bank. No charge was made." onGoHome={() => {}} />
  ),
  profile: () => (
    <ProfileScreen
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'organizer', is_verified: true }}
      onSignOut={() => {}}
      tickets={[]}
      savedCount={2}
      onViewTicket={() => {}}
      onNavigate={() => {}}
      setActiveView={() => {}}
      userRole="organizer"
    />
  ),
  'promote-event': () => (
    <PromoteEventScreen onBack={() => {}} currentUser={FIXTURE_USER} />
  ),
  'service-category': () => (
    <ServiceCategoryScreen category="Photography" onBack={() => {}} onProviderPress={() => {}} />
  ),
  'service-provider-profile': () => (
    <ServiceProviderProfileScreen providerId="prov-1" onBack={() => {}} currentUserId="user-1" currentUserEmail="user1@example.com" />
  ),
  'service-provider-setup': () => (
    <ServiceProviderSetupScreen currentUser={FIXTURE_USER} onBack={() => {}} onSaved={() => {}} />
  ),
  'service-provider-verification': () => (
    <ServiceProviderVerificationScreen currentUser={{ id: 'org-1', country: 'NG' }} onBack={() => {}} />
  ),
  settings: () => (
    <SettingsScreen
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'organizer', username: 'test.organizer' }}
      onBack={() => {}}
      onSignOut={() => {}}
      isDark
      onToggleDark={() => {}}
    />
  ),
  'settings-profile-details': () => (
    <SettingsScreen
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'organizer', username: 'test.organizer' }}
      onBack={() => {}}
      onSignOut={() => {}}
      isDark
      onToggleDark={() => {}}
      initialSubScreen="profile"
    />
  ),
  'connected-accounts': () => (
    <SettingsScreen
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'organizer', username: 'test.organizer' }}
      onBack={() => {}}
      onSignOut={() => {}}
      isDark
      onToggleDark={() => {}}
      initialSubScreen="connected-accounts"
    />
  ),
  'user-profile': () => (
    <UserProfileScreen
      user={{
        id: 'user-2', name: 'Adaeze Okonkwo', username: 'adaeze.o', avatarColor: '#A855F7', avatarInitials: 'AO',
        city: 'Lagos', bio: 'Event photographer & hype woman. Lagos based.', eventsAttended: 12, interests: ['Music', 'Technology'],
        role: 'organizer', isOrganizer: true, isVerified: true,
        instagram_handle: 'adaeze.creates', x_handle: null, tiktok_handle: null,
      }}
      onBack={() => {}}
      currentUserId="org-1"
    />
  ),
  'user-wallet': () => (
    <UserWalletScreen currentUser={{ id: 'org-1', email: 'organizer@example.com' }} onBack={() => {}} />
  ),
  explore: () => (
    <ExploreScreen currentUserId="org-1" onUserPress={() => {}} initialTab="people" />
  ),
  'explore-chats': () => (
    <ExploreScreen currentUserId="org-1" onUserPress={() => {}} initialTab="chats" />
  ),
  // Mounts the REAL, unmodified App.tsx (not one screen in isolation) to
  // verify actual in-app navigation end-to-end -- e.g. the Batch 5 Creator
  // Studio sidebar wiring (org-dashboard -> manage-events -> sales-analytics
  // -> back). Only reachable with the fake auth session fakeSupabase.ts
  // grants specifically to ?screen=full-app.
  'full-app': () => <App />,
  referrals: () => (
    <ReferralScreen onBack={() => {}} currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer' }} />
  ),
};

const params = new URLSearchParams(window.location.search);
const screenKey = params.get('screen') || 'welcome';
const Screen = SCREENS[screenKey];

createRoot(document.getElementById('root')!).render(
  <div style={{ width: '100%', height: '100vh' }}>
    {Screen ? <Screen /> : <div style={{ color: '#fff', padding: 20 }}>Unknown screen: {screenKey}</div>}
  </div>
);
