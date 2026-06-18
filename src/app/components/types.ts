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
  description: string;
  organizer: string;
  organizerVerified?: boolean;
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
}

export interface PurchasedTicket {
  event: Event;
  ticketType: TicketType;
  quantity: number;
  ticketId: string;
  purchasedAt: string;
  totalAmount: number;
  holderName: string;
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
  followers: number;
  following: number;
  interests: string[];
  avatar_url?: string;
  isOrganizer?: boolean;
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
  | 'following-list'
  | 'admin-dashboard'
  | 'checkin-scanner'
  | 'transactions';

export type TabId = 'home' | 'explore' | 'saved' | 'profile';
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
