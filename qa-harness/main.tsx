// QA-ONLY harness entry. Mounts the REAL app components (not copies) with
// deterministic fixture props/data via fakeSupabase.ts -- never touches
// Production, never mutates anything, read-only fixture data only.
import { createRoot } from 'react-dom/client';
import '../src/styles/index.css';
import { OrganizerDashboard } from '../src/app/components/OrganizerDashboard';
import { ManageEventsScreen } from '../src/app/components/ManageEventsScreen';
import { SalesAnalyticsScreen } from '../src/app/components/SalesAnalyticsScreen';
import { HomeScreen } from '../src/app/components/HomeScreen';
import { WelcomeScreen } from '../src/app/components/WelcomeScreen';

const FIXTURE_USER = { id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'organizer' };

const FIXTURE_EVENTS = [
  {
    id: 'evt-1', title: 'Lagos Music Festival', location: 'Eko Atlantic, Lagos',
    price: 15000, status: 'live', event_date: new Date(Date.now() + 7 * 86400000).toISOString(),
    category: 'Music', organizer_id: 'org-1', image_url: null,
  },
  {
    id: 'evt-2', title: 'Comedy Night Abuja', location: 'Transcorp Hilton, Abuja',
    price: 5000, status: 'live', event_date: new Date(Date.now() + 14 * 86400000).toISOString(),
    category: 'Comedy', organizer_id: 'org-1', image_url: null,
  },
  {
    id: 'evt-3', title: 'Free Tech Meetup', location: 'Landmark Centre, Lagos',
    price: 0, status: 'live', event_date: new Date(Date.now() + 30 * 86400000).toISOString(),
    category: 'Technology', organizer_id: 'org-1', image_url: null,
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
    />
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
