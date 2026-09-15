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
import { InboxScreen } from '../src/app/components/InboxScreen';
import { NotificationsScreen } from '../src/app/components/NotificationsScreen';
import { ManageProviderServicesScreen } from '../src/app/components/ManageProviderServicesScreen';
import { CheckinScannerScreen } from '../src/app/components/CheckinScannerScreen';

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
      dbEvents={FIXTURE_EVENTS}
      loading={false}
      fetchEvents={() => {}}
      currentUser={FIXTURE_USER}
      countryFilter="NG"
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
  'my-tickets': () => {
    const dbEvent = { ...FIXTURE_EVENTS[0] };
    const event = mapDbEventToFrontend(dbEvent);
    const ticket = {
      event, ticketType: { id: 't1', name: 'Regular', price: 15000, description: 'General Admission', available: 500 },
      quantity: 1, ticketId: 'tkt-1', purchasedAt: new Date().toISOString(), totalAmount: 15000,
      holderName: 'Test Organizer', holderEmail: 'organizer@example.com',
    };
    return (
      <MyTicketsScreen
        tickets={[ticket as any]}
        loading={false}
        onBack={() => {}}
        onViewTicket={() => {}}
        currentUserId="org-1"
        currentUserEmail="organizer@example.com"
      />
    );
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
};

const params = new URLSearchParams(window.location.search);
const screenKey = params.get('screen') || 'welcome';
const Screen = SCREENS[screenKey];

createRoot(document.getElementById('root')!).render(
  <div style={{ width: '100%', height: '100vh' }}>
    {Screen ? <Screen /> : <div style={{ color: '#fff', padding: 20 }}>Unknown screen: {screenKey}</div>}
  </div>
);
