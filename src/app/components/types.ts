export interface TicketType {
  id: string;
  name: string;
  price: number;
  description: string;
  available: number;
}

export interface Event {
  id: string;
  title: string;
  category: string;
  categoryIcon: string;
  date: string;
  time: string;
  endTime: string;
  venue: string;
  area: string;
  city: string;
  state: string;
  price: number;
  image: string;
  // Flyer gallery for the multi-image carousel: image_url followed by
  // gallery_urls, mapped in mapDbEventToFrontend (HomeScreen.tsx).
  images?: string[];
  description: string;
  organizer: string;
  organizerVerified?: boolean;
  organizerVcBadge?: string | null;
  isFeatured: boolean;
  isTrending: boolean;
  attendees: number;
  capacity: number;
  rating: number;
  reviewCount: number;
  ticketTypes: TicketType[];
  tags?: string[];
  lineup?: string[];
  contactPhone?: string;
  isPromoted?: boolean;
  promoPlan?: string | null;
  bookingsCount?: number;
  organizer_id?: string;
  created_at?: string;
  event_date?: string;
  is_18_plus?: boolean;
}

export interface TicketAttendee {
  name: string;
  email: string;
  phone?: string;
}

export interface PurchasedTicket {
  event: Event;
  ticketType: TicketType;
  quantity: number;
  ticketId: string;
  purchasedAt: string;
  totalAmount: number;
  holderName: string;
  holderEmail?: string;
  // One entry per ticket in the group, in the same order the backend should
  // insert them — index 0 is always the purchaser. Only read at checkout
  // submission time; a ticket fetched back from the DB doesn't carry this,
  // it's already resolved into holderName/holderEmail for that one row.
  attendees?: TicketAttendee[];
  // Server-validated promo code applied at checkout, if any — forwarded to
  // purchase_ticket so it can be re-verified and the redemption recorded.
  promoCode?: string;
  useVentsCents?: boolean;
  // Signed v2 pass token, generated server-side WITH the purchase
  // (purchase_ticket_with_tokens) so the QR renders instantly with no mint delay.
  token?: string;
  vcDiscountNgn?: number;
}

export interface UserProfile {
  id: string;
  name: string;
  username: string;
  avatarColor: string;
  avatarInitials: string;
  city: string;
  bio: string;
  eventsAttended: number;
  interests: string[];
  avatar_url?: string;
  cover_url?: string;
  role?: string;
  isOrganizer?: boolean;
  isVerified?: boolean;
  vc_badge?: string;
}

export interface Notification {
  id: string;
  type: 'reminder' | 'booking' | 'promo' | 'social';
  title: string;
  body: string;
  time: string;
  read: boolean;
  icon: string;
}

export type Screen =
  | 'referral'
  | 'splash'
  | 'welcome'
  | 'role-select'
  | 'auth'
  | 'home'
  | 'explore'
  | 'search'
  | 'saved'
  | 'notifications'
  | 'profile'
  | 'settings'
  | 'privacy-policy'
  | 'help-support'
  | 'privacy-security'
  | 'my-tickets'
  | 'ticket-detail'
  | 'event-details'
  | 'ticket-select'
  | 'checkout'
  | 'payment-success'
  | 'org-dashboard'
  | 'create-event'
  | 'manage-events'
  | 'sales-analytics'
  | 'attendee-list'
  | 'user-profile'
  | 'promote-event'
  | 'nigeria-live'
  | 'admin-dashboard'
  | 'checkin-scanner'
  | 'door-manager'
  | 'inbox'
  | 'conversation'
  | 'wallet';

export type TabId = 'home' | 'explore' | 'my-tickets' | 'profile';
export type AuthMode = 'login' | 'signup' | 'forgot' | 'reset';
export type UserRole = 'attendee' | 'organizer';

export type OrgEventStatus = 'under_review' | 'approved' | 'live' | 'draft';

export interface OrganizerEvent {
  id: string;
  title: string;
  category: string;
  description: string;
  date: string;
  startTime: string;
  venue: string;
  city: string;
  capacity: string;
  ticketName: string;
  ticketPrice: string;
  ticketQty: string;
  contactPhone: string;
  showPhone: boolean;
  status: OrgEventStatus;
  createdAt: number;
}

// Real, live-computed status for the Organizer Hub dashboard — derived
// entirely from actual DB state (event.status + event_date + sold-out math),
// never from a client-side timer. 'live'/'draft' mirror the DB's own CHECK
// constraint values; 'ended'/'sold_out' are computed overlays on top of a
// 'live' event, not separate DB status values.
export type OrganizerEventDisplayStatus = 'live' | 'draft' | 'ended' | 'sold_out';

// One row from get_organizer_events_overview() — the single-call source of
// truth for "My Created Events" (real status + live ticket/revenue/check-in
// aggregates), replacing the old OrganizerEvent's static, pre-sale-only fields.
export interface OrganizerEventOverview {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  eventDate: string | null;
  price: number;
  ticketGoal: number;
  ticketTypes: Array<{ id: string; name: string; price: number; quantity: number; description?: string }>;
  status: 'live' | 'draft';
  is18Plus: boolean;
  createdAt: string;
  soldCount: number;
  soldQuantity: number;
  pendingCount: number;
  cancelledCount: number;
  refundedCount: number;
  revenueKobo: number;
  checkedInCount: number;
  isEnded: boolean;
  isSoldOut: boolean;
  displayStatus: OrganizerEventDisplayStatus;
}
