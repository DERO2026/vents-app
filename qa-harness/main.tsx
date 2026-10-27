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
import { ConversationScreen } from '../src/app/components/ConversationScreen';
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
import { CustomerWalletScreen } from '../src/app/components/CustomerWalletScreen';
import { ExploreScreen } from '../src/app/components/ExploreScreen';
import { ReferralScreen } from '../src/app/components/ReferralScreen';
import { PromotionsScreen } from '../src/app/components/PromotionsScreen';
import { AdminConsoleShell } from '../src/app/components/admin/AdminConsoleShell';
import { AdminDashboard } from '../src/app/components/admin/AdminDashboard';
import { AdminUsersList } from '../src/app/components/admin/AdminUsersList';
import { AdminUserDetail } from '../src/app/components/admin/AdminUserDetail';
import { AdminEventsList } from '../src/app/components/admin/AdminEventsList';
import { AdminEventDetail } from '../src/app/components/admin/AdminEventDetail';
import { AdminOrganizersList } from '../src/app/components/admin/AdminOrganizersList';
import { AdminOrganizerDetail } from '../src/app/components/admin/AdminOrganizerDetail';
import { AdminProvidersList } from '../src/app/components/admin/AdminProvidersList';
import { AdminProviderDetail } from '../src/app/components/admin/AdminProviderDetail';
import { AdminReportsScreen } from '../src/app/components/admin/AdminReportsScreen';
import { AdminAuditLogScreen } from '../src/app/components/admin/AdminAuditLogScreen';
import { AdminVCScreen } from '../src/app/components/admin/AdminVCScreen';
import { AdminVerificationScreen } from '../src/app/components/admin/AdminVerificationScreen';
import { AdminPayoutsScreen } from '../src/app/components/admin/AdminPayoutsScreen';
import { AdminSystemScreen } from '../src/app/components/admin/AdminSystemScreen';
import { AdminAnalyticsScreen } from '../src/app/components/admin/AdminAnalyticsScreen';
import { AdminServiceBookingsScreen } from '../src/app/components/admin/AdminServiceBookingsScreen';
import { AdminOrganizerRequestsScreen } from '../src/app/components/admin/AdminOrganizerRequestsScreen';
import { AdminProviderRequestsScreen } from '../src/app/components/admin/AdminProviderRequestsScreen';
import App from '../src/app/App';
import { ImageCropperModal } from '../src/app/components/ImageCropperModal';

// Shared fixture admin identity for every Admin Console harness route below
// -- a full Admin (Root+Admin tier), matching the "Full admin view" the
// design export's dashboard header shows.
const ADMIN_FIXTURE_USER = { id: 'admin-1', email: 'admin@example.com', full_name: 'Admin Operator', role: 'admin' };

// The direct-mount List/Detail harness routes below (bypassing
// AdminConsoleShell's own responsive state) need to reflect whatever real
// viewport the screenshot tool actually launched at, not a hardcoded
// desktop assumption -- otherwise every "mobile" screenshot of these routes
// would silently render the desktop table layout squeezed into a phone
// width instead of the real mobile card layout.
const ADMIN_IS_MOBILE = typeof window !== 'undefined' && window.innerWidth < 768;

// Organizer is the independent is_organizer capability, not role
// (0121_organizer_capability_independent_of_role.sql) -- role is 'user'
// here, matching every real organizer account in production.
const FIXTURE_USER = { id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'user', isOrganizer: true };

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
      currentUser={{ id: 'org-1', role: 'user', isOrganizer: true }}
      selectedEvent={{ id: 'evt-1', title: 'Lagos Music Festival' } as any}
    />
  ),
  'door-manager': () => (
    <DoorManagerScreen
      event={{ id: 'evt-1', title: 'Lagos Music Festival', organizer_id: 'org-1' } as any}
      currentUser={{ id: 'org-1', role: 'user', isOrganizer: true }}
      onBack={() => {}}
      onOpenScanner={() => {}}
    />
  ),
  'checkin-scanner': () => (
    <CheckinScannerScreen
      onBack={() => {}}
      currentUser={{ id: 'org-1', role: 'user', isOrganizer: true }}
      selectedEvent={{ id: 'evt-1', title: 'Lagos Music Festival' } as any}
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
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'user', isOrganizer: true, is_verified: true }}
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
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'user', isOrganizer: true, username: 'test.organizer' }}
      onBack={() => {}}
      onSignOut={() => {}}
      isDark
      onToggleDark={() => {}}
    />
  ),
  settings: () => (
    <SettingsScreen
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'user', isOrganizer: true, username: 'test.organizer' }}
      onBack={() => {}}
      onSignOut={() => {}}
      isDark
      onToggleDark={() => {}}
    />
  ),
  'settings-profile-details': () => (
    <SettingsScreen
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'user', isOrganizer: true, username: 'test.organizer' }}
      onBack={() => {}}
      onSignOut={() => {}}
      isDark
      onToggleDark={() => {}}
      initialSubScreen="profile"
    />
  ),
  'connected-accounts': () => (
    <SettingsScreen
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'user', isOrganizer: true, username: 'test.organizer' }}
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
      onMessage={() => {}}
    />
  ),
  'user-wallet': () => (
    <CustomerWalletScreen currentUser={{ id: 'org-1', email: 'organizer@example.com' }} onBack={() => {}} />
  ),
  home: () => (
    <HomeScreen
      onEventPress={() => {}}
      savedEvents={[]}
      onToggleSave={() => {}}
      dbEvents={FIXTURE_EVENTS.map(mapDbEventToFrontend)}
      loading={false}
      fetchEvents={() => {}}
      currentUser={FIXTURE_USER}
      countryFilter="NG"
      onCountryFilterChange={() => {}}
      onServicesPress={() => {}}
    />
  ),
  profile: () => (
    <ProfileScreen
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'user', isOrganizer: true }}
      onSignOut={() => {}}
      tickets={[]}
      savedCount={3}
      onViewTicket={() => {}}
      onNavigate={() => {}}
      setActiveView={() => {}}
      userRole="attendee"
    />
  ),
  'public-user-profile': () => (
    <UserProfileScreen
      user={{
        id: 'user-3', name: 'Chidera Nwosu', username: 'chidera.n', avatarColor: '#F472B6', avatarInitials: 'CN',
        city: 'Lagos', bio: 'Always at the next big thing.', eventsAttended: 8, interests: ['Music', 'Comedy'],
        role: 'attendee', isOrganizer: false, isVerified: false,
      }}
      onBack={() => {}}
      currentUserId="org-1"
      onMessage={() => {}}
    />
  ),
  referral: () => (
    <ReferralScreen
      onBack={() => {}}
      currentUser={{ id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', role: 'user', isOrganizer: true }}
    />
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

  // ── Claude-Design Admin Console (reconciled against the current
  // multi-role architecture and current production RPCs/RLS) ──────────────
  // Shell renders the full nav + default Dashboard view; the individual
  // List/Detail keys below mount each screen directly (bypassing the
  // Shell's internal view state) so every one of the 10 required screens
  // has its own stable, directly-linkable screenshot target.
  'admin-console': () => <AdminConsoleShell onBack={() => {}} currentUser={ADMIN_FIXTURE_USER} />,
  'admin-console-dashboard': () => (
    <AdminDashboard currentUser={ADMIN_FIXTURE_USER} isRoot={false} isSuperAdmin isMobile={ADMIN_IS_MOBILE} isTablet={false} onNavigate={() => {}} />
  ),
  'admin-console-users': () => <AdminUsersList isMobile={ADMIN_IS_MOBILE} onSelectUser={() => {}} />,
  'admin-console-user-detail': () => (
    <AdminUserDetail userId="user-both-caps-1" currentUser={ADMIN_FIXTURE_USER} isMobile={ADMIN_IS_MOBILE} onBack={() => {}} />
  ),
  'admin-console-events': () => <AdminEventsList isMobile={ADMIN_IS_MOBILE} currentUser={ADMIN_FIXTURE_USER} onSelectEvent={() => {}} />,
  'admin-console-event-detail': () => (
    <AdminEventDetail eventId="evt-1" currentUser={ADMIN_FIXTURE_USER} isMobile={ADMIN_IS_MOBILE} onBack={() => {}} />
  ),
  'admin-console-organizers': () => <AdminOrganizersList isMobile={ADMIN_IS_MOBILE} isSuperAdmin onSelectOrganizer={() => {}} />,
  'admin-console-organizer-detail': () => (
    <AdminOrganizerDetail organizerId="org-1" isSuperAdmin isMobile={ADMIN_IS_MOBILE} onBack={() => {}} />
  ),
  'admin-console-providers': () => <AdminProvidersList isMobile={ADMIN_IS_MOBILE} isSuperAdmin onSelectProvider={() => {}} />,
  'admin-console-provider-detail': () => (
    <AdminProviderDetail providerId="prov-1" isSuperAdmin isMobile={ADMIN_IS_MOBILE} onBack={() => {}} />
  ),

  // ── Full admin-console rebuild: the screens added to fully retire
  // AdminDashboardScreen.tsx (no legacy console left) ──────────────────────
  'admin-console-reports': () => <AdminReportsScreen />,
  'admin-console-audit-log': () => <AdminAuditLogScreen />,
  'admin-console-vcents': () => <AdminVCScreen />,
  'admin-console-verification': () => <AdminVerificationScreen />,
  'admin-console-payouts': () => <AdminPayoutsScreen />,
  'admin-console-system': () => <AdminSystemScreen currentUser={ADMIN_FIXTURE_USER} />,
  'admin-console-analytics': () => <AdminAnalyticsScreen />,
  'admin-console-service-bookings': () => <AdminServiceBookingsScreen />,
  'admin-console-organizer-requests': () => <AdminOrganizerRequestsScreen isSuperAdmin />,
  'admin-console-provider-requests': () => <AdminProviderRequestsScreen isSuperAdmin />,

  // Stage 8: PromotionsScreen.tsx. Populated state uses the fixture's
  // event_promotions rows as-is (Active/Scheduled/Expired all present);
  // ?promotionsEmpty=1 forces the empty state via fakeSupabase.ts.
  promotions: () => (
    <PromotionsScreen onBack={() => {}} currentUser={FIXTURE_USER} onPromoteEvent={() => {}} />
  ),

  // Stage 9: ImageCropperModal.tsx. ?variant=flyer|avatar selects the
  // mode; ?cropperError=1 feeds a corrupt image so the decode fails on
  // Done, exercising the error-state styling.
  imagecropper: () => (
    <ImageCropperModal
      imageSrc={cropperError ? 'data:image/png;base64,not-a-real-image' : CROPPER_SAMPLE_IMAGE}
      onCropComplete={() => {}}
      onClose={() => {}}
      variant={cropperVariant}
      title={cropperVariant === 'avatar' ? 'Crop Photo' : 'Crop Flyer'}
    />
  ),

  // Stage 10: ConversationScreen.tsx -- a one-to-one thread against the
  // same user-2 fixture InboxScreen's "inbox" route lists as unread.
  // ?inboxEmpty=1 is handled upstream in fakeSupabase.ts for the inbox
  // route; this route always shows the populated thread (dm-1's sender).
  //
  // ?conversationPending=1 switches the thread partner to user-4, who has
  // no direct_messages fixture rows but DOES have a genuine pending
  // conversation_requests row addressed to org-1 (the FIXTURE_USER) --
  // proves the harness's .or() fix actually filters (shows the banner here)
  // rather than just suppressing it everywhere (as it incorrectly did
  // before, surfacing user-4's unrelated pending row on the user-2 thread).
  conversation: () => (
    <ConversationScreen
      currentUser={FIXTURE_USER}
      otherUser={
        new URLSearchParams(window.location.search).get('conversationPending') === '1'
          ? { id: 'user-4', name: 'Ada Chukwu' }
          : { id: 'user-2', name: 'Priya Nair' }
      }
      onBack={() => {}}
    />
  ),
};

// Stage 9: ImageCropperModal.tsx. A synthetic landscape "flyer" SVG (gradient
// + title block) stands in for an organizer's uploaded poster -- large enough
// to exercise the flyer variant's smart-crop/safe-area/zoom-to-fit UI.
const CROPPER_SAMPLE_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#7B2FBE"/>
          <stop offset="1" stop-color="#1A1724"/>
        </linearGradient>
      </defs>
      <rect width="1600" height="1000" fill="url(#g)"/>
      <circle cx="1250" cy="260" r="220" fill="rgba(255,255,255,0.12)"/>
      <text x="800" y="480" font-size="110" font-family="sans-serif" fill="#fff" text-anchor="middle" font-weight="700">LAGOS MUSIC FEST</text>
      <text x="800" y="580" font-size="48" font-family="sans-serif" fill="#EDEAF5" text-anchor="middle">Dec 12 · Eko Atlantic</text>
    </svg>`
  );

const params = new URLSearchParams(window.location.search);
const screenKey = params.get('screen') || 'welcome';
const cropperVariant = params.get('variant') === 'flyer' ? 'flyer' : 'avatar';
const cropperError = params.get('cropperError') === '1';
const Screen = SCREENS[screenKey];

createRoot(document.getElementById('root')!).render(
  <div style={{ width: '100%', height: '100vh' }}>
    {Screen ? <Screen /> : <div style={{ color: '#fff', padding: 20 }}>Unknown screen: {screenKey}</div>}
  </div>
);
