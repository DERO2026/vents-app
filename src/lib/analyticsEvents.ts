import { trackEvent } from './analytics';

// ─── Canonical PostHog events ─────────────────────────────────────────────────
// Single source of truth for event names and property shapes so instrumentation
// never drifts. Convention:
//   • names: snake_case, `object_action`, past tense for completed actions
//   • property keys: snake_case, stable (event_id, ticket_type, amount, …)
//   • amounts are in the smallest currency unit (kobo), matching the rest of the app
//
// Call sites use the `analytics.*` helpers below rather than trackEvent directly,
// which keeps property keys identical everywhere.

export const AnalyticsEvent = {
  // Auth
  SignedUp: 'user_signed_up',
  LoggedIn: 'user_logged_in',
  LoggedOut: 'user_logged_out',
  PasswordResetRequested: 'password_reset_requested',
  // Discovery
  SearchPerformed: 'search_performed',
  EventViewed: 'event_viewed',
  // Attendee funnel
  EventSaved: 'event_saved',
  EventUnsaved: 'event_unsaved',
  EventShared: 'event_shared',
  CheckoutStarted: 'checkout_started',
  TicketPurchased: 'ticket_purchased',
  TicketQrViewed: 'ticket_qr_viewed',
  // Organizer
  EventCreated: 'event_created',
  EventEdited: 'event_edited',
  EventPromoted: 'event_promoted',
  TicketScanned: 'ticket_scanned',
  WithdrawalRequested: 'withdrawal_requested',
  OrganizerVerificationSubmitted: 'organizer_verification_submitted',
  // Profile & engagement
  ProfileUpdated: 'profile_updated',
  NotificationOpened: 'notification_opened',
  // Push (mirrored from pushNotifications listeners)
  PushReceived: 'push_received',
  PushOpened: 'push_opened',
} as const;

const clean = (o: Record<string, unknown>) => {
  // Drop undefined so PostHog properties stay tidy.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
};

export const analytics = {
  // Auth
  signedUp: (role: string) => trackEvent(AnalyticsEvent.SignedUp, { role }),
  loggedIn: (method: 'password' | '2fa' = 'password') => trackEvent(AnalyticsEvent.LoggedIn, { method }),
  loggedOut: () => trackEvent(AnalyticsEvent.LoggedOut),
  passwordResetRequested: () => trackEvent(AnalyticsEvent.PasswordResetRequested),

  // Discovery
  searchPerformed: (queryLength: number, resultsCount: number) =>
    trackEvent(AnalyticsEvent.SearchPerformed, { query_length: queryLength, results_count: resultsCount }),
  eventViewed: (p: { eventId: string; eventTitle?: string; category?: string }) =>
    trackEvent(AnalyticsEvent.EventViewed, clean({ event_id: p.eventId, event_title: p.eventTitle, category: p.category })),

  // Attendee funnel
  eventSaveToggled: (eventId: string, saved: boolean) =>
    trackEvent(saved ? AnalyticsEvent.EventSaved : AnalyticsEvent.EventUnsaved, { event_id: eventId }),
  eventShared: (eventId: string, eventTitle?: string) =>
    trackEvent(AnalyticsEvent.EventShared, clean({ event_id: eventId, event_title: eventTitle })),
  checkoutStarted: (p: { eventId?: string; ticketType?: string; quantity: number; amount: number; free: boolean }) =>
    trackEvent(AnalyticsEvent.CheckoutStarted, clean({ event_id: p.eventId, ticket_type: p.ticketType, quantity: p.quantity, amount: p.amount, free: p.free })),
  ticketPurchased: (p: { eventId: string; eventTitle?: string; ticketType?: string; quantity: number; amount: number; free: boolean; reference?: string }) =>
    trackEvent(AnalyticsEvent.TicketPurchased, clean({ event_id: p.eventId, event_title: p.eventTitle, ticket_type: p.ticketType, quantity: p.quantity, amount: p.amount, free: p.free, reference: p.reference })),
  ticketQrViewed: (eventId: string) => trackEvent(AnalyticsEvent.TicketQrViewed, { event_id: eventId }),

  // Organizer
  eventCreated: (p: { eventId: string; isFree?: boolean; price?: number }) =>
    trackEvent(AnalyticsEvent.EventCreated, clean({ event_id: p.eventId, is_free: p.isFree, price: p.price })),
  eventEdited: (eventId: string) => trackEvent(AnalyticsEvent.EventEdited, { event_id: eventId }),
  eventPromoted: (eventId: string, plan?: string) =>
    trackEvent(AnalyticsEvent.EventPromoted, clean({ event_id: eventId, plan })),
  ticketScanned: (result: string, eventId?: string) =>
    trackEvent(AnalyticsEvent.TicketScanned, clean({ result, event_id: eventId })),
  withdrawalRequested: (amount: number) => trackEvent(AnalyticsEvent.WithdrawalRequested, { amount }),
  organizerVerificationSubmitted: () => trackEvent(AnalyticsEvent.OrganizerVerificationSubmitted),

  // Profile & engagement
  profileUpdated: () => trackEvent(AnalyticsEvent.ProfileUpdated),
  notificationOpened: (type?: string) => trackEvent(AnalyticsEvent.NotificationOpened, clean({ type })),
};
