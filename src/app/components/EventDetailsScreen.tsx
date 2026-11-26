import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { flyerScrim } from '../../lib/flyerScrim';
import { ventsColors } from '../../lib/ventsDesignTokens';
import BadgeChip from './BadgeChip';
import {
  ArrowLeft,
  Share2,
  Link as LinkIcon,
  MapPin,
  Calendar,
  Users,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  Send,
  MessageSquarePlus,
  Phone,
  MessageCircle,
  Minus,
  Plus,
  Flag,
  CalendarPlus,
  Shield,
  ScanLine,
  LayoutDashboard,
  AlertCircle,
  Sparkles,
  Bell,
  Check,
} from 'lucide-react';
import { Sentry } from '../../lib/sentry';
import { Event, TicketType } from './types';
import { COUNTRY_CODES } from '../../lib/countries';
import { formatPrice, formatPriceRange } from './data';
import { hasEventEnded, isEventDiscoverable } from '../../lib/eventLifecycle';
import { formatSalesOpen, isComingSoon, isSalesDue, openEventSalesIfDue, useSaleAlerts } from '../../lib/comingSoon';
import { mapDbEventToFrontend, HorizontalEventCard } from './HomeScreen';
import { supabase } from '../../lib/supabase';
import { canViewAttendanceCount, rowShowsAttendanceCount } from '../../lib/attendanceVisibility';
import { haptics } from '../../lib/haptics';
import { downloadBlob } from '../../lib/ticketImage';
import { shareLink } from '../../lib/shareLink';
import { openExternalUrl } from '../../lib/externalLink';
import { analytics } from '../../lib/analyticsEvents';
import { EVENT_CARD_ASPECT_CSS } from '../../lib/eventCardAspect';
import { ReportModal } from './ReportModal';
import { ImageCarousel } from './ImageCarousel';
import { FlyerLightbox } from './FlyerLightbox';
import { EventMap } from './EventMap';
import { contactPhoneLinks } from '../../lib/contactPhone';
import { formatKobo } from '../../lib/ticketFees';
import { useTicketQuote, serviceFeeLabel } from '../../lib/ticketQuote';
import {
  firstAvailableTicketId, initialTicketQuantities, nextQuantity, isTicketAvailable, selectionProblem,
  selectionLabel, isFreeSelection, ONE_CATEGORY_PER_ORDER_NOTE,
} from '../../lib/ticketSelection';

interface EventDetailsScreenExtraProps {
  currentUserId?: string;
  onOrganizerPress?: (organizerId: string) => void;
  onMessageOrganizer?: (organizerId: string, eventId: string, eventTitle: string) => void;
}

interface EventDetailsScreenProps {
  event: Event;
  onBack: () => void;
  onGetTickets: (ticketType: TicketType, qty: number) => void;
  isSaved: boolean;
  onToggleSave: () => void;
  isBooked?: boolean;
  onBook?: () => void;
  bookingLoading?: boolean;
  onEventPress?: (event: Event) => void;
  currentUserId?: string;
  currentUserRole?: string;
  onOrganizerPress?: (organizerId: string) => void;
  onMessageOrganizer?: (organizerId: string, eventId: string, eventTitle: string) => void;
  onOpenDoorScanner?: () => void;
  onOpenDoorManager?: () => void;
  // Kill switch (app_config.disable_purchases) — server-side purchase_ticket
  // also rejects with 'purchases_disabled' if this is bypassed, so this
  // prop is purely a graceful-degradation UI state, not the real gate.
  purchasesDisabled?: boolean;
  // Contextual VENTS AI entry point -- the approved prototype's "Ask
  // VENTS AI to plan this night" row on event details. Receives the event
  // itself (not just an id) so the caller can seed the AI composer with
  // real event context -- see App.tsx's openVentsAiForEvent.
  onAskVentsAi?: (event: Event) => void;
}

// Root admin account — same convention used in App.tsx / the Admin Console.
const ROOT_UID = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832';

function parseEventDate(eventDate?: string, dateStr?: string, timeStr?: string): number {
  if (eventDate) {
    const t = new Date(eventDate).getTime();
    if (!isNaN(t)) return t;
  }

  if (dateStr && timeStr) {
    try {
      const cleanDate = dateStr.replace(/^[A-Za-z]+,\s*/, '').trim();
      const parts = cleanDate.replace(/,/g, '').split(/\s+/);
      if (parts.length === 3) {
        const monthStr = parts[0];
        const day = parseInt(parts[1], 10);
        const year = parseInt(parts[2], 10);

        const months: Record<string, number> = {
          jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
          jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
        };
        const monthIndex = months[monthStr.toLowerCase().slice(0, 3)];

        const timeParts = timeStr.trim().split(/\s+/);
        if (timeParts.length >= 1) {
          const hm = timeParts[0].split(':');
          let hours = parseInt(hm[0], 10);
          const minutes = hm.length > 1 ? parseInt(hm[1], 10) : 0;
          const ampm = timeParts.length > 1 ? timeParts[1].toLowerCase() : '';

          if (ampm === 'pm' && hours < 12) {
            hours += 12;
          } else if (ampm === 'am' && hours === 12) {
            hours = 0;
          }

          if (monthIndex !== undefined && !isNaN(day) && !isNaN(year) && !isNaN(hours) && !isNaN(minutes)) {
            const dateObj = new Date(year, monthIndex, day, hours, minutes, 0, 0);
            return dateObj.getTime();
          }
        }
      }
    } catch (e) {
      console.error("Failed to parse fallback date:", e);
      Sentry.captureException(e);
    }
  }

  return NaN;
}

function useCountdown(eventDate?: string, dateStr?: string, timeStr?: string) {
  const target = useMemo(() => {
    return parseEventDate(eventDate, dateStr, timeStr);
  }, [eventDate, dateStr, timeStr]);

  const [remaining, setRemaining] = useState(() => {
    if (isNaN(target)) return 0;
    const rem = target - Date.now();
    return rem > 0 ? rem : 0;
  });

  useEffect(() => {
    if (isNaN(target) || target <= 0) {
      setRemaining(0);
      return;
    }

    const initialRem = target - Date.now();
    if (initialRem <= 0) {
      setRemaining(0);
      return;
    }

    setRemaining(initialRem);

    const intervalId = setInterval(() => {
      const currentRem = target - Date.now();
      if (currentRem <= 0) {
        setRemaining(0);
        clearInterval(intervalId);
      } else {
        setRemaining(currentRem);
      }
    }, 1000);

    return () => {
      clearInterval(intervalId);
    };
  }, [target]);

  if (remaining <= 0) return null;

  const d = Math.floor(remaining / 86400000);
  const h = Math.floor((remaining % 86400000) / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const s = Math.floor((remaining % 60000) / 1000);

  return { d, h, m, s };
}

// ── Event Detail presentation: text sits on the page; containers only where
// something is interactive (ticket rows, map, controls over the flyer). ──
const hairline = 'rgba(255,255,255,0.08)';
const infoPrimary: React.CSSProperties = { color: ventsColors.ink1, fontSize: '15px', fontWeight: 600, lineHeight: 1.35 };
const infoSecondary: React.CSSProperties = { color: ventsColors.ink2, fontSize: '13.5px', lineHeight: 1.45, marginTop: '2px' };
const sectionStyle: React.CSSProperties = { marginTop: '32px', paddingTop: '28px', borderTop: `1px solid ${hairline}` };
const sectionHeading: React.CSSProperties = { color: ventsColors.white, fontSize: '18px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.2px', margin: '0 0 12px' };
const textAction: React.CSSProperties = {
  display: 'flex', width: 'fit-content', alignItems: 'center', gap: '6px', alignSelf: 'flex-start', marginTop: '8px',
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: ventsColors.accentSoft, fontSize: '13.5px', fontWeight: 600,
};
const iconAction: React.CSSProperties = {
  width: '36px', height: '36px', borderRadius: '50%', flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', cursor: 'pointer', textDecoration: 'none',
};
const coverControl: React.CSSProperties = {
  width: '38px', height: '38px', borderRadius: '50%', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(0,0,0,0.42)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
};

function InfoRow({ icon: Icon, children, trailing }: { icon: React.ComponentType<{ size?: number; color?: string }>; children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
      <span style={{ width: '32px', display: 'flex', justifyContent: 'center', paddingTop: '1px', flexShrink: 0 }}>
        <Icon size={18} color={ventsColors.ink2} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>{children}</div>
      {trailing && <div style={{ display: 'flex', gap: '8px', flexShrink: 0, alignSelf: 'center' }}>{trailing}</div>}
    </div>
  );
}

// Isolates the 1-second countdown tick into its own memoized subtree.
// useCountdown used to be called directly inside the (1000+ line,
// non-memoized) EventDetailsScreen component, so every tick re-rendered the
// entire screen — organizer info, ticket cards, related-events carousel,
// everything — once a second for as long as the page stayed open. Wrapping
// it here means a tick only re-renders this small block.
const EventCountdown = memo(function EventCountdown({ event_date, date, time }: { event_date?: string; date?: string; time?: string }) {
  const countdown = useCountdown(event_date, date, time);
  if (!countdown) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span data-testid="event-countdown" style={{ ...infoSecondary, fontVariantNumeric: 'tabular-nums' }}>
      Starts in {countdown.d > 0 ? `${countdown.d}d ` : ''}{pad(countdown.h)}h {pad(countdown.m)}m {pad(countdown.s)}s
    </span>
  );
});

interface Review {
  id: string;
  name: string;
  avatar: string;
  initials: string;
  rating: number;
  text: string;
  date: string;
}

export function EventDetailsScreen({
  event,
  onBack,
  onGetTickets,
  isSaved,
  onToggleSave,
  isBooked = false,
  onBook,
  bookingLoading = false,
  onEventPress,
  currentUserId,
  currentUserRole,
  onOrganizerPress,
  onMessageOrganizer,
  onOpenDoorScanner,
  onOpenDoorManager,
  purchasesDisabled = false,
  onAskVentsAi,
}: EventDetailsScreenProps) {
  const isEventOwner = !!currentUserId && !!event.organizer_id && currentUserId === event.organizer_id;
  const contactPhone = contactPhoneLinks(event.contactPhone);
  const isSubAdmin = currentUserRole === 'sub-admin';
  const isRootAdmin = currentUserId === ROOT_UID;
  const isPlatformAdmin = currentUserRole === 'admin';
  const canManageDoor = isEventOwner || isSubAdmin || isRootAdmin || isPlatformAdmin;

  const [expanded, setExpanded] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [showMapDialog, setShowMapDialog] = useState(false);
  const [flyerFullScreen, setFlyerFullScreen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  // events only stores a single image_url today -- falls back to the
  // already-resolved event.image the moment a real gallery isn't present.
  const flyerImages = event.images && event.images.length > 0 ? event.images : (event.image ? [event.image] : []);
  const [userReviews, setUserReviews] = useState<Review[]>([]);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewHover, setReviewHover] = useState(0);

  // Inline ticket quantity selection
  const ticketTypes = event.ticketTypes || [];
  // The first AVAILABLE category is pre-selected with quantity 1; sold-out
  // categories start (and stay) at 0 and cannot be selected. One category
  // per order (ticketSelection.ts).
  const [selectedTicketId, setSelectedTicketId] = useState<string>(() => firstAvailableTicketId(ticketTypes));
  const [ticketQtys, setTicketQtys] = useState<Record<string, number>>(() => initialTicketQuantities(ticketTypes));
  const changeTicketQty = useCallback((id: string, delta: number) => {
    setTicketQtys((prev) => ({ ...prev, [id]: nextQuantity(ticketTypes.find((t) => t.id === id), prev[id] ?? 0, delta) }));
  }, [ticketTypes]);
  const selectTicket = useCallback((id: string) => {
    const t = ticketTypes.find((x) => x.id === id);
    if (!isTicketAvailable(t)) return;
    setSelectedTicketId(id);
    // Selecting an available category with nothing chosen yet starts at 1.
    setTicketQtys((prev) => ((prev[id] ?? 0) > 0 ? prev : { ...prev, [id]: 1 }));
  }, [ticketTypes]);
  const selectedTicket = ticketTypes.find((t) => t.id === selectedTicketId);
  const selectedQty = ticketQtys[selectedTicketId] ?? 0;
  // A prior purchase no longer locks the whole booking flow — an attendee
  // who already has a ticket can still open the event, see every tier, and
  // buy more (extra tickets for friends, a different tier, etc). isBooked
  // now only drives the small "you already have a ticket" notice below,
  // never whether buying is possible.
  // Single source of truth for "has this event ended" (requirement #3 of
  // the event-lifecycle fix) -- see src/lib/eventLifecycle.ts. Direct links
  // to an ended event must show "Event Ended" with no purchase CTA, even
  // though the row is still readable (organizer/admin/ticket-holders keep
  // access per RLS -- ended-ness is a UI/purchase-eligibility concern, not
  // a visibility one).
  const hasEnded = hasEventEnded({ event_date: (event as any).event_date, end_date: (event as any).endDate });
  // Coming Soon (0224): public but not on sale. Every purchase function
  // refuses it server-side; this only renders that state. Once the planned
  // time passes, ask the server to open it (it never opens early) and switch
  // to the normal purchase UI only when the server confirms.
  const [salesOpenedHere, setSalesOpenedHere] = useState(false);
  const comingSoon = isComingSoon(event) && !salesOpenedHere;
  const salesOpenLabel = formatSalesOpen(event.salesOpenAt);
  const saleAlerts = useSaleAlerts(currentUserId ?? null);
  const [notifyNotice, setNotifyNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!isComingSoon(event) || !event.salesOpenAt) return;
    let cancelled = false;
    const tryOpen = async () => {
      if (await openEventSalesIfDue(event.id) && !cancelled) setSalesOpenedHere(true);
    };
    if (isSalesDue(event.salesOpenAt)) { void tryOpen(); return () => { cancelled = true; }; }
    // Opening within the next day: check again at the planned time.
    const wait = new Date(event.salesOpenAt).getTime() - Date.now();
    if (wait > 24 * 60 * 60 * 1000) return () => { cancelled = true; };
    const timer = setTimeout(() => { void tryOpen(); }, wait + 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [event.id, event.status, event.salesOpenAt]);
  const toggleNotify = async () => {
    haptics.light();
    const res = await saleAlerts.toggle(event.id);
    setNotifyNotice(res.ok ? null : (res.error || null));
  };
  const selectionIssue = selectionProblem(selectedTicket, selectedQty);
  // Coming Soon renders its own bottom bar and no order panel, so canBook is
  // never reachable for it; the server refuses the purchase regardless.
  const canBook = !hasEnded && selectionIssue === null;
  const freeSelection = isFreeSelection(selectedTicket, selectedQty);
  const allSoldOut = ticketTypes.length > 0 && !ticketTypes.some(isTicketAvailable);
  // What the buyer will actually pay, fee included, with the same per-ticket
  // arithmetic as checkout and the database (ticketFees.ts / 0208), so the
  // event page never shows a lower amount than checkout charges.
  const eventQuote = useTicketQuote(selectedTicket && Number(selectedTicket.price) > 0 ? selectedTicket.price : null, selectedQty).quote;
  const eventCheckout = { totalKobo: eventQuote?.total_kobo ?? 0, serviceFeeKobo: eventQuote?.service_fee_kobo ?? 0 };
  const eventPayText = eventQuote ? formatKobo(eventCheckout.totalKobo) : '…';
  // Bottom bar / order panel: the SELECTED category and quantity, never the cheapest price.
  const orderLabel = allSoldOut ? 'Sold out' : selectionLabel(selectedTicket, selectedQty);
  const payButtonText = (paused: boolean): string => paused
    ? 'Purchases Temporarily Paused'
    : allSoldOut ? 'Sold out'
    : canBook ? (freeSelection ? 'Book Free Ticket' : `Pay ${eventPayText}`)
    : selectionIssue === 'zero_quantity' ? 'Choose a quantity' : 'Select a ticket';
  const [reviewText, setReviewText] = useState('');
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewSubmitted, setReviewSubmitted] = useState(false);

  const aboutRef = useRef<HTMLDivElement>(null);
  const ticketsRef = useRef<HTMLDivElement>(null);
  const organizerRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  // "Read more" only when the description is actually clamped.
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [descriptionClamped, setDescriptionClamped] = useState(false);
  useEffect(() => {
    const el = descriptionRef.current;
    if (!el) return;
    const check = () => { if (!expanded) setDescriptionClamped(el.scrollHeight > el.clientHeight + 1); };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [event.description, expanded]);
  const [realAttendeeCount, setRealAttendeeCount] = useState(event.attendees);
  // The organizer's attendance-visibility choice (events.show_attendance_count,
  // 0221). The database already withholds a hidden count from everyone but the
  // organizer and admins; this only decides whether to render one.
  const [showAttendanceCount, setShowAttendanceCount] = useState(event.showAttendanceCount !== false);
  const [organizerProfile, setOrganizerProfile] = useState<any>(null);
  const [relatedEvents, setRelatedEvents] = useState<any[]>([]);
  const [loadingRelated, setLoadingRelated] = useState(true);
  const [shared, setShared] = useState(false);
  const [calendarError, setCalendarError] = useState(false);
  const [showReport, setShowReport] = useState(false);

  // 1. Static metadata (organizer profile and related events) - fetch once per event
  useEffect(() => {
    let cancelled = false;

    const fetchOrganizerProfile = async () => {
      if (!event.organizer_id) return;
      try {
        const { data, error } = await supabase
          .from('public_profiles')
          .select('id, full_name, username, avatar_url, is_verified, state, vc_badge')
          .eq('id', event.organizer_id)
          .maybeSingle();

        if (error) throw error;
        if (data && !cancelled) {
          setOrganizerProfile(data);
        }
      } catch (err) {
        console.error('Failed to fetch organizer profile:', err);
        Sentry.captureException(err);
      }
    };

    const fetchRelatedEvents = async () => {
      setLoadingRelated(true);
      try {
        // Requirement #4: Related Events must never show ended events. No
        // date/expiry filter existed here at all before -- conservative
        // server prefilter + exact client-side isEventDiscoverable() below,
        // same pattern as the Home/Explore feed (see src/lib/eventLifecycle.ts).
        const nowIso = new Date().toISOString();
        const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        let relatedQuery = supabase
          .from('events')
          .select('*')
          .eq('category', event.category)
          .in('status', ['live', 'published'])
          .is('deleted_at', null)
          .is('archived_at', null)
          .eq('hidden_by_admin', false)
          .or(`end_date.gte.${nowIso},and(end_date.is.null,event_date.gte.${cutoffIso})`)
          .neq('id', event.id);

        // Every other event surface (home feed, search) hides 18+ events
        // from users below the age threshold — this carousel had no such
        // gate at all. The viewer's own date_of_birth isn't threaded down
        // to this screen, but the event they're currently viewing is a
        // reliable proxy: if it's not 18+, never surface an 18+ related
        // event alongside it (the common case — an all-ages event's related
        // carousel should never suddenly include an 18+ one).
        if (!(event as any).is_18_plus) {
          relatedQuery = relatedQuery.eq('is_18_plus', false);
        }

        const { data, error } = await relatedQuery.limit(8);

        if (error) throw error;
        if (data && !cancelled) {
          const mapped = data.filter((e: any) => isEventDiscoverable(e)).slice(0, 4).map(mapDbEventToFrontend);
          setRelatedEvents(mapped);
        }
      } catch (err) {
        console.error('Failed to fetch related events:', err);
        Sentry.captureException(err);
      } finally {
        if (!cancelled) setLoadingRelated(false);
      }
    };

    fetchOrganizerProfile();
    fetchRelatedEvents();
    return () => { cancelled = true; };
  }, [event.id, event.category, event.organizer_id]);

  // 2. Dynamic attendee count - re-fetch when event changes or booking state updates.
  // Single source of truth (get_event_ticket_stats, see Data Consistency
  // migration) — previously counted any status='active' ticket regardless
  // of payment_status, which could show a different number here than on
  // SalesAnalyticsScreen/OrganizerDashboard for the same event.
  useEffect(() => {
    let cancelled = false;
    const fetchAttendeeCount = async () => {
      try {
        const [{ data, error }, setting] = await Promise.all([
          supabase.rpc('get_event_ticket_stats', { p_event_ids: [event.id] }),
          // Read the setting itself rather than trust whichever feed/search
          // row this event came from (some do not carry the column). Before
          // 0221 the column does not exist: that error leaves the count shown.
          Promise.resolve(supabase.from('events').select('show_attendance_count').eq('id', event.id).maybeSingle())
            .catch(() => ({ data: null, error: true })),
        ]);
        if (error) throw error;
        if (!cancelled) {
          setRealAttendeeCount(data?.[0]?.sold_count ?? 0);
          if (!(setting as any)?.error && (setting as any)?.data) setShowAttendanceCount(rowShowsAttendanceCount((setting as any).data));
        }
      } catch (err) {
        console.error('Failed to fetch attendee count:', err);
        Sentry.captureException(err);
      }
    };

    fetchAttendeeCount();
    return () => { cancelled = true; };
  }, [event.id, isBooked]);

  const handleShare = async () => {
    analytics.eventShared(event.id, event.title);
    // Always the real public domain, never window.location.origin -- inside
    // the native app that resolves to the WebView's own internal origin
    // (capacitor://localhost on iOS, https://localhost on Android per
    // capacitor.config.ts's androidScheme/hostname), which is meaningless
    // to anyone the link is shared with. Same pattern PaymentSuccessScreen's
    // ticket-share link already uses.
    const deepLink = `https://getvents.com/?event=${event.id}`;
    // The deep link is embedded in `text` only -- `url` is intentionally
    // omitted from the shareLink() call below. Capacitor's Android Share
    // plugin (and iOS's UIActivityViewController) fold a separate `text` +
    // `url` into one combined payload for share targets that only accept a
    // single string (e.g. the OS "Copy to clipboard" resolver), which
    // duplicated the URL when both were passed. Keeping it in `text` once
    // is enough for every real share target (WhatsApp, Messages, etc.) to
    // see the link exactly once.
    const text =
      `🎟️ ${event.title}\n` +
      `📅 ${event.date} · ${event.time}\n` +
      `📍 ${event.venue}, ${event.city}\n` +
      `\nGet tickets on Vents 👇\n${deepLink}`;

    await shareLink({ title: event.title, text });
  };

  // Dedicated, OS-share-sheet-independent "Copy Link" action. Writes ONLY
  // the canonical URL to the clipboard directly, never routed through
  // shareLink()/Share.share()/navigator.share() -- those hand control to
  // OS/plugin chrome (the native share sheet's own "Copy" resolver, or an
  // async clipboard overwrite racing against it) that this app cannot
  // reliably control cross-platform, which is what produced the
  // promo-text + duplicated-URL clipboard bug this replaces.
  const handleCopyLink = async () => {
    const deepLink = `https://getvents.com/?event=${event.id}`;
    try {
      await navigator.clipboard.writeText(deepLink);
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch {
      // ignore -- no toast on failure
    }
  };

  const allReviews = [...userReviews];

  function submitReview() {
    if (!reviewRating || !reviewText.trim()) return;
    setUserReviews((prev) => [
      {
        id: `user-${Date.now()}`,
        name: 'You',
        avatar: '#8E5CF7',
        initials: 'ME',
        rating: reviewRating,
        text: reviewText.trim(),
        date: 'Just now',
      },
      ...prev,
    ]);
    setReviewRating(0);
    setReviewText('');
    setShowReviewForm(false);
    setReviewSubmitted(true);
  }

  const openMap = (provider: 'google' | 'apple') => {
    // event.country is a real ISO code (events_country.sql) -- resolve it to
    // a name for the map search label instead of hardcoding Nigeria, which
    // sent every non-Nigerian event's map search to the wrong country.
    const countryName = COUNTRY_CODES.find((c) => c.iso === event.country)?.name || event.country;
    const label = `${event.venue}, ${event.area}, ${event.city}, ${countryName}`;
    const query = encodeURIComponent(label);
    const hasCoords = event.latitude != null && event.longitude != null;
    const coords = hasCoords ? `${event.latitude},${event.longitude}` : '';
    const webUrl = provider === 'google'
      ? `https://www.google.com/maps/search/?api=1&query=${hasCoords ? coords : query}`
      : `https://maps.apple.com/?q=${query}${hasCoords ? `&ll=${coords}` : ''}`;

    // Previously attempted a raw geo:/comgooglemaps:// URI scheme first (to
    // open the actual installed Maps app instead of an in-app browser tab),
    // with a visibilitychange-based fallback to this same web URL. Reverted:
    // an unhandled or malformed custom-scheme URI just silently does nothing
    // in an Android WebView — no error, no navigation, nothing to catch —
    // and that's exactly what got reported ("nothing happens when I tap
    // Google Maps"). openExternalUrl + Browser.open() is the same mechanism
    // already used everywhere else in this app (WhatsApp, Terms, Privacy
    // links) and has never been reported broken — reliability over the
    // marginal benefit of skipping the in-app browser tab.
    openExternalUrl(webUrl);
    setShowMapDialog(false);
  };
  // Status, where it applies: plain text, never a badge.
  const addressLine = [event.area, event.city, event.state].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  const statusText = hasEnded ? 'Event ended'
    : comingSoon ? (salesOpenLabel ? `Coming soon · Tickets on sale ${salesOpenLabel}` : 'Coming soon')
    : allSoldOut ? 'Sold out'
    : null;
  const statusTone: 'accent' | 'muted' = comingSoon && !hasEnded ? 'accent' : 'muted';
  const capacityPct = Math.round((realAttendeeCount / (event.capacity || 1000)) * 100);
  // Public viewers never see a hidden count; the organizer and admins do, labelled.
  const attendanceVisible = canViewAttendanceCount(showAttendanceCount, {
    isEventOwner,
    isAdmin: isPlatformAdmin || isSubAdmin || isRootAdmin,
  });
  const attendanceHiddenNote = !showAttendanceCount ? ' · hidden from the public' : '';

  // "Add to Calendar" ICS content — memoized so it's computed once per
  // event, not on every render (this screen re-renders often).
  const icsContent = useMemo(() => {
    const eventDateRaw = (event as any).event_date || event.date;
    if (!eventDateRaw) return null;
    const dtStart = new Date(eventDateRaw);
    if (isNaN(dtStart.getTime())) return null;
    const dtEnd = (event as any).end_time
      ? (() => {
          const [h, m] = ((event as any).end_time as string).split(':').map(Number);
          const d = new Date(dtStart);
          d.setHours(h, m || 0, 0, 0);
          // An overnight event (e.g. 22:00 -> 02:00) has an end_time clock
          // value earlier than the start, which without adjustment lands
          // dtEnd BEFORE dtStart on the same calendar day -- a negative-
          // duration VEVENT that calendar apps render incorrectly (or reject).
          if (d.getTime() <= dtStart.getTime()) d.setDate(d.getDate() + 1);
          return d;
        })()
      : new Date(dtStart.getTime() + 2 * 60 * 60 * 1000);
    const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    return [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//VENTS//EN',
      'BEGIN:VEVENT',
      `DTSTART:${fmt(dtStart)}`,
      `DTEND:${fmt(dtEnd)}`,
      `SUMMARY:${(event.title || '').replace(/,/g, '\\,')}`,
      `LOCATION:${[event.venue, event.area, event.city, event.state].filter(Boolean).join(', ').replace(/,/g, '\\,')}`,
      `DESCRIPTION:${(event.description || '').replace(/\n/g, '\\n').replace(/,/g, '\\,')}`,
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
  }, [(event as any).event_date, event.date, (event as any).end_time, event.title, event.venue, event.area, event.city, event.state, event.description]);

  const [addingToCalendar, setAddingToCalendar] = useState(false);
  const handleAddToCalendar = async () => {
    if (!icsContent || addingToCalendar) return;
    setAddingToCalendar(true);
    try {
      const blob = new Blob([icsContent], { type: 'text/calendar' });
      const result = await downloadBlob(blob, `${event.title || 'event'}.ics`);
      // 'cancelled' means the organizer deliberately dismissed the OS share
      // sheet without picking anything -- not a failure, so no error toast.
      if (result === 'failed') {
        setCalendarError(true);
        setTimeout(() => setCalendarError(false), 2500);
      }
    } finally {
      setAddingToCalendar(false);
    }
  };

  return (
    <div
      style={{
        background: '#020005',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        scrollbarWidth: 'none',
      }}
    >
      {/* Desktop containment (interim, real fix pending the full TB2/DT
          media-left/sticky-purchase-panel-right split the handoff spec
          calls for): without this, widening the shared #root shell to
          1200px (this session's viewport fix) would stretch this screen's
          full-bleed hero/content edge-to-edge again -- the exact "desktop
          is mobile stretched" bug from earlier in this effort. Caps
          content at a readable width instead of reintroducing that
          regression while the real two-column rework is still pending. */}
      <style>{`
        .event-details-content { display: flex; flex-direction: column; }
        .edt-purchase-panel { display: none; }
        /* Tablet split (TB2 export, 834px worked example): media-left /
           content-right instead of the mobile full-bleed hero + sticky
           footer stack. Reuses the exact same hero, main-content and
           purchase-panel blocks the mobile and >=1200px desktop layouts
           already render -- only their grid placement/sizing changes here,
           no new components and no functional change (ticket selection,
           promo codes, purchase flow all still the same real code). */
        /* !important throughout this tier: the hero/main/panel elements
           carry their own inline styles (mobile padding/margins, the hero's
           aspect-ratio card sizing) which otherwise always win over an
           external stylesheet rule for the same property at any width. */
        @media (min-width: 768px) and (max-width: 1199px) {
          .event-details-content {
            display: grid !important;
            grid-template-columns: 52% 1fr;
            column-gap: 0;
            align-items: stretch;
            height: 100%;
            max-width: none !important;
            margin: 0 !important;
          }
          .event-details-hero {
            grid-column: 1;
            grid-row: 1 / span 2;
            padding: 0 !important;
            margin: 0 !important;
            height: 100%;
            position: sticky;
            top: 0;
          }
          .event-details-hero > div {
            border-radius: 0 !important;
            height: 100% !important;
            aspect-ratio: auto !important;
          }
          .event-details-main {
            grid-column: 2;
            padding: calc(24px + env(safe-area-inset-top)) 24px 24px !important;
            overflow-y: auto;
          }
          .edt-bottom-bar { display: none !important; }
          .edt-purchase-panel {
            display: block;
            grid-column: 2;
            margin: 0 24px 24px;
            background: #0E0C14;
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 18px;
            padding: 20px;
          }
        }
        @media (min-width: 1200px) {
          .event-details-content {
            display: grid;
            grid-template-columns: 1fr 380px;
            column-gap: 32px;
            max-width: 1100px;
            margin: 0 auto;
            width: 100%;
            align-items: start;
          }
          .event-details-hero { grid-column: 1; }
          .event-details-main { grid-column: 1; padding-bottom: 40px; }
          .edt-bottom-bar { display: none !important; }
          .edt-purchase-panel {
            display: block;
            grid-column: 2;
            grid-row: 1 / span 2;
            position: sticky;
            top: 24px;
            align-self: start;
            background: #0E0C14;
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 18px;
            padding: 20px;
            margin-top: calc(12px + env(safe-area-inset-top));
          }
        }
      `}</style>
      <div className="event-details-content" style={{ flex: 1 }}>
      {/* Full-screen flyer lightbox */}
      {flyerFullScreen && (
        <FlyerLightbox
          images={flyerImages}
          initialIndex={lightboxIndex}
          alt={event.title}
          onClose={() => setFlyerFullScreen(false)}
        />
      )}

      {/* 1. COVER -- the flyer, clean: no frame, border, shadow, pills or
          hint badges over it. Only the back / share / save controls. */}
      <div
        className="event-details-hero"
        style={{
          padding: '0 16px',
          marginTop: 'calc(12px + env(safe-area-inset-top))',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: 'relative',
            aspectRatio: EVENT_CARD_ASPECT_CSS,
            borderRadius: '20px',
            overflow: 'hidden',
            background: ventsColors.surface,
          }}
        >
          <ImageCarousel
            images={flyerImages}
            alt={event.title}
            imageFit="cover"
            showArrows={flyerImages.length > 1}
            onImageTap={(i) => { setLightboxIndex(i); setFlyerFullScreen(true); }}
            style={{ width: '100%', height: '100%', cursor: 'zoom-in' }}
          />
          {/* A light bottom fade so the flyer meets the black page softly. */}
          <div data-testid="event-hero-scrim" aria-hidden style={flyerScrim(18)} />

          <button aria-label="Back" onClick={(e) => { e.stopPropagation(); onBack(); }} style={{ ...coverControl, position: 'absolute', top: '12px', left: '12px' }}>
            <ArrowLeft size={18} color={ventsColors.white} />
          </button>
          <div style={{ position: 'absolute', top: '12px', right: '12px', display: 'flex', gap: '8px' }}>
            <button aria-label="Share event" onClick={(e) => { e.stopPropagation(); handleShare(); }} style={coverControl}>
              <Share2 size={17} color={ventsColors.white} />
            </button>
            <button aria-label={isSaved ? 'Remove from saved' : 'Save event'} aria-pressed={isSaved} onClick={(e) => { e.stopPropagation(); onToggleSave(); }} style={coverControl}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill={isSaved ? ventsColors.accentSoft : 'none'} stroke={isSaved ? ventsColors.accentSoft : ventsColors.white} strokeWidth="2.2">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className="event-details-main" style={{ flex: 1, padding: '20px 20px 120px' }}>
        {/* 2. EVENT INFORMATION -- typography and small icons on the page
            itself; no card per item. */}
        <section data-testid="event-info">
          {event.category && (
            <p style={{ color: ventsColors.ink3, fontSize: '12px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 6px' }}>
              {event.category}{(event as any).is_18_plus ? ' · 18+' : ''}
            </p>
          )}
          <h1 style={{ color: ventsColors.white, fontSize: '26px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', letterSpacing: '-0.5px', lineHeight: 1.2, margin: 0 }}>
            {event.title}
          </h1>
          {statusText && (
            <p data-testid="event-status" style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '10px 0 0', color: statusTone === 'accent' ? ventsColors.accentSoft : ventsColors.ink2, fontSize: '14px', fontWeight: 600 }}>
              <span aria-hidden style={{ width: '6px', height: '6px', borderRadius: '50%', background: statusTone === 'accent' ? ventsColors.accent : ventsColors.ink3, flexShrink: 0 }} />
              {statusText}
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '22px' }}>
            <InfoRow icon={Calendar}>
              <span style={infoPrimary}>{event.date}</span>
              <span style={infoSecondary}>
                {event.endTime ? `${event.time} – ${event.endTime}` : (event.time || 'Time to be confirmed')}
              </span>
              <EventCountdown event_date={event.event_date} date={event.date} time={event.time} />
              {icsContent && (
                <button type="button" onClick={handleAddToCalendar} disabled={addingToCalendar} style={textAction}>
                  <CalendarPlus size={14} /> {addingToCalendar ? 'Opening…' : 'Add to calendar'}
                </button>
              )}
            </InfoRow>

            <InfoRow icon={MapPin}>
              {event.locationType === 'online' ? (
                <span style={infoPrimary}>Online event</span>
              ) : (
                <>
                  <span style={infoPrimary}>{event.venue}</span>
                  <span style={infoSecondary}>{addressLine}</span>
                </>
              )}
            </InfoRow>

            {attendanceVisible ? (
              <InfoRow icon={Users}>
                <span data-testid="event-attendance-header" style={infoPrimary}>
                  {realAttendeeCount.toLocaleString()} attending{attendanceHiddenNote}
                </span>
                <span data-testid="event-attendance-capacity" style={infoSecondary}>
                  {capacityPct}% filled · {(event.capacity ?? 0).toLocaleString()} capacity
                </span>
              </InfoRow>
            ) : (
              <InfoRow icon={Users}>
                <span data-testid="event-capacity-only" style={infoPrimary}>
                  {(event.capacity ?? 0).toLocaleString()} total capacity
                </span>
              </InfoRow>
            )}

            {/* Organizer -- tapping opens their profile. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button
                type="button"
                onClick={() => event.organizer_id && onOrganizerPress?.(event.organizer_id)}
                style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0, background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: event.organizer_id && onOrganizerPress ? 'pointer' : 'default' }}
              >
                <span style={{ width: '32px', height: '32px', borderRadius: '50%', background: ventsColors.elevated, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, position: 'relative', overflow: 'hidden' }}>
                  <span style={{ color: ventsColors.ink1, fontSize: '13px', fontWeight: 700 }}>
                    {(organizerProfile?.full_name || event.organizer || 'O')[0].toUpperCase()}
                  </span>
                  {organizerProfile?.avatar_url && (
                    <img src={organizerProfile.avatar_url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  )}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ ...infoSecondary, marginTop: 0 }}>Hosted by</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                    <span style={{ ...infoPrimary, overflow: 'hidden', textOverflow: 'ellipsis' }}>{organizerProfile?.full_name || event.organizer}</span>
                    {(event.organizerVerified || organizerProfile?.is_verified) && (
                      <CheckCircle size={14} fill={ventsColors.accent} color={ventsColors.white} />
                    )}
                    <BadgeChip tier={organizerProfile?.vc_badge} />
                  </span>
                </span>
              </button>
              {event.organizer_id && onMessageOrganizer && currentUserId && currentUserId !== event.organizer_id && (
                <button type="button" onClick={() => onMessageOrganizer(event.organizer_id!, event.id, event.title)} style={{ ...textAction, marginTop: 0 }}>
                  <MessageCircle size={14} /> Message
                </button>
              )}
            </div>

            {/* Contact number (if the organizer chose to show it). Nigerian
                numbers show locally (0XXXXXXXXXX); call and WhatsApp always
                use +234 (src/lib/contactPhone.ts). */}
            {contactPhone && (
              <InfoRow
                icon={Phone}
                trailing={
                  <>
                    {contactPhone.telHref && (
                      <a href={contactPhone.telHref} data-testid="organizer-contact-call" aria-label={`Call organiser on ${contactPhone.display}`} style={iconAction}>
                        <Phone size={16} color={ventsColors.accentSoft} />
                      </a>
                    )}
                    {contactPhone.whatsappNumber && (
                      <button type="button" data-testid="organizer-contact-whatsapp" aria-label="Message organiser on WhatsApp" onClick={() => openExternalUrl(`https://wa.me/${contactPhone.whatsappNumber}`)} style={iconAction}>
                        <MessageCircle size={16} color={ventsColors.accentSoft} />
                      </button>
                    )}
                  </>
                }
              >
                <span data-testid="organizer-contact-phone" style={{ ...infoPrimary, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
                  {contactPhone.display}
                </span>
                <span style={infoSecondary}>Organizer contact, for event enquiries only</span>
              </InfoRow>
            )}

            {/* Door tools -- only the event's organizer, a Sub-Admin or an admin. */}
            {canManageDoor && onOpenDoorScanner && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                <Shield size={18} color={ventsColors.ink2} style={{ flexShrink: 0, width: '32px' }} />
                <button type="button" onClick={onOpenDoorScanner} style={{ ...textAction, marginTop: 0 }}>
                  <ScanLine size={14} /> Open door scanner
                </button>
                {onOpenDoorManager && (
                  <button type="button" onClick={onOpenDoorManager} style={{ ...textAction, marginTop: 0 }}>
                    <LayoutDashboard size={14} /> Door manager
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        {/* 3. ABOUT THIS EVENT -- directly on the page. */}
        {(event.description || '').trim() && (
          <section style={sectionStyle}>
            <h2 style={sectionHeading}>About this event</h2>
            <p
              ref={descriptionRef}
              data-testid="event-description"
              style={{
                color: ventsColors.ink2,
                fontSize: '15px',
                lineHeight: 1.65,
                margin: 0,
                whiteSpace: 'pre-line',
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: expanded ? 'unset' : 4,
                WebkitBoxOrient: 'vertical',
              }}
            >
              {event.description}
            </p>
            {(descriptionClamped || expanded) && (
              <button type="button" onClick={() => setExpanded(!expanded)} style={textAction}>
                {expanded ? 'Show less' : 'Read more'}
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
            {event.lineup && event.lineup.length > 0 && (
              <p style={{ color: ventsColors.ink2, fontSize: '14px', lineHeight: 1.6, margin: '14px 0 0' }}>
                <span style={{ color: ventsColors.ink1, fontWeight: 600 }}>Lineup: </span>{event.lineup.join(', ')}
              </p>
            )}
            {event.tags && event.tags.length > 0 && (
              <p style={{ color: ventsColors.ink3, fontSize: '13px', margin: '10px 0 0' }}>
                {event.tags.map((tag) => `#${tag.replace(' ', '')}`).join('  ')}
              </p>
            )}
            {onAskVentsAi && (
              <button type="button" onClick={() => onAskVentsAi(event)} style={textAction}>
                <Sparkles size={14} /> Ask VENTS AI to plan this night
              </button>
            )}
          </section>
        )}

        {/* 4. LOCATION -- a pure online event has no venue, so no map (the
            private access link only ever comes from get_event_online_access,
            gated on ticket ownership). */}
        <section style={sectionStyle}>
          <h2 style={sectionHeading}>Location</h2>
          {event.locationType === 'online' ? (
            <>
              <p style={{ ...infoPrimary, margin: 0 }}>Online event</p>
              <p style={{ ...infoSecondary, margin: '4px 0 0' }}>Join online. Access details are sent after you register or purchase a ticket.</p>
            </>
          ) : (
            <>
              <p style={{ ...infoPrimary, margin: 0 }}>{event.venue}</p>
              <p style={{ ...infoSecondary, margin: '4px 0 0' }}>{addressLine}</p>
              {event.locationType === 'hybrid' && (
                <p style={{ ...infoSecondary, margin: '4px 0 0' }}>Also available online. Access details are sent after you register or purchase a ticket.</p>
              )}
              <div style={{ marginTop: '14px' }}>
                <EventMap
                  latitude={event.latitude}
                  longitude={event.longitude}
                  venue={event.venue}
                  address={`${event.area}, ${event.city}, ${event.state}`}
                  onGetDirections={() => setShowMapDialog(true)}
                />
              </div>
            </>
          )}
        </section>

        {/* 5. TICKETS -- the only interactive containers on the page. Stays
            available after a prior purchase (more tickets, another tier). */}
        {ticketTypes.length > 0 && comingSoon && (
          <section ref={ticketsRef} data-testid="coming-soon-tickets" style={sectionStyle}>
            <h2 style={sectionHeading}>Tickets</h2>
            <p style={{ color: ventsColors.ink2, fontSize: '14px', lineHeight: 1.6, margin: '0 0 8px' }}>
              {salesOpenLabel ? `Tickets go on sale ${salesOpenLabel} (Nigeria time).` : 'Tickets are not on sale yet.'} Tap Notify me and we'll let you know the moment they are.
            </p>
            {ticketTypes.map((t) => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '12px 0', borderTop: `1px solid ${hairline}` }}>
                <span style={{ color: ventsColors.ink1, fontSize: '15px', fontWeight: 600 }}>{t.name}</span>
                <span style={{ color: ventsColors.ink2, fontSize: '15px', fontVariantNumeric: 'tabular-nums lining-nums' }}>{Number(t.price) > 0 ? formatKobo(Math.round(Number(t.price) * 100)) : 'Free'}</span>
              </div>
            ))}
          </section>
        )}
        {ticketTypes.length > 0 && !comingSoon && (
          <section ref={ticketsRef} className="edt-tickets-inline" style={sectionStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
              <h2 style={sectionHeading}>Tickets</h2>
              {isBooked && (
                <span style={{ display: 'flex', alignItems: 'center', gap: '5px', color: ventsColors.ink2, fontSize: '13px', fontWeight: 600 }}>
                  <CheckCircle size={13} color={ventsColors.accentSoft} /> You have a ticket
                </span>
              )}
            </div>
            {ticketTypes.length > 1 && (
              <p data-testid="one-category-note" style={{ color: ventsColors.ink3, fontSize: '12.5px', margin: '-6px 0 12px' }}>{ONE_CATEGORY_PER_ORDER_NOTE}</p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {ticketTypes.map((t) => {
                const isSelected = selectedTicketId === t.id;
                const qty = ticketQtys[t.id] ?? 0;
                const soldOut = !isTicketAvailable(t);
                return (
                  <div
                    key={t.id}
                    role="radio"
                    aria-checked={isSelected}
                    aria-disabled={soldOut}
                    onClick={() => { if (!soldOut) { haptics.light(); selectTicket(t.id); } }}
                    style={{
                      background: isSelected ? 'rgba(142,92,247,0.08)' : 'transparent',
                      border: `1px solid ${isSelected ? ventsColors.accent : 'rgba(255,255,255,0.1)'}`,
                      borderRadius: '14px',
                      padding: '14px 16px',
                      cursor: soldOut ? 'not-allowed' : 'pointer',
                      opacity: soldOut ? 0.5 : 1,
                      transition: 'border-color 0.15s, background 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ color: ventsColors.ink1, fontSize: '15px', fontWeight: 600, margin: 0 }}>{t.name}</p>
                        <p style={{ color: ventsColors.ink2, fontSize: '13px', margin: '3px 0 0' }}>
                          {t.description || 'General Admission'}{soldOut ? ' · Sold out' : ` · ${t.available} left`}
                        </p>
                      </div>
                      <span style={{ color: ventsColors.white, fontSize: '16px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', fontVariantNumeric: 'tabular-nums lining-nums' }}>
                        {formatPrice(t.price)}
                      </span>
                    </div>
                    {isSelected && !soldOut && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '12px' }}>
                        <span style={{ color: ventsColors.ink2, fontSize: '13px' }}>Quantity</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                          <button aria-label="Decrease quantity" onClick={(e) => { e.stopPropagation(); if (qty > 0) haptics.light(); changeTicketQty(t.id, -1); }} style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'transparent', border: '1px solid rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: qty === 0 ? 'not-allowed' : 'pointer', opacity: qty === 0 ? 0.4 : 1 }}>
                            <Minus size={14} color={ventsColors.ink1} />
                          </button>
                          <span key={qty} style={{ color: ventsColors.ink1, fontSize: '17px', fontWeight: 700, minWidth: '24px', textAlign: 'center', display: 'inline-block', fontVariantNumeric: 'tabular-nums' }}>{qty}</span>
                          <button aria-label="Increase quantity" onClick={(e) => { e.stopPropagation(); haptics.light(); changeTicketQty(t.id, 1); }} style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#7B2FBE', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                            <Plus size={14} color={ventsColors.white} />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Related events (existing) -- plain list, no boxed empty state. */}
        <section style={sectionStyle}>
          <h2 style={sectionHeading}>Related events</h2>
          {loadingRelated ? (
            <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', scrollbarWidth: 'none' }}>
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} style={{ width: '140px', height: '120px', background: ventsColors.surface, borderRadius: '14px', opacity: 0.6, flexShrink: 0 }} />
              ))}
            </div>
          ) : relatedEvents.length === 0 ? (
            <p style={{ ...infoSecondary, margin: 0 }}>No related events in this category.</p>
          ) : (
            <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '8px', scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
              {relatedEvents.map((evt) => (
                <HorizontalEventCard key={evt.id} event={evt} onPress={() => onEventPress && onEventPress(evt)} isSaved={false} onToggleSave={() => {}} />
              ))}
            </div>
          )}
        </section>

        {/* Quiet page-end actions (existing): copy the link, report. */}
        <div style={{ display: 'flex', gap: '20px', marginTop: '28px', paddingTop: '18px', borderTop: `1px solid ${hairline}` }}>
          <button type="button" onClick={handleCopyLink} style={{ ...textAction, marginTop: 0, color: ventsColors.ink2 }}>
            <LinkIcon size={14} /> Copy link
          </button>
          {currentUserId && (
            <button type="button" onClick={() => setShowReport(true)} style={{ ...textAction, marginTop: 0, color: ventsColors.ink2 }}>
              <Flag size={14} /> Report event
            </button>
          )}
        </div>
      </div>

      {/* Desktop sticky purchase panel (handoff DT2/TB2: Event Detail splits
          media-left / sticky-purchase-panel-right at >=1200px). Hidden below
          that breakpoint -- .edt-tickets-inline above stays the only ticket
          UI on mobile/tablet. Mirrors the bottom CTA bar's summary + buy
          action rather than duplicating the full ticket-tier list, since
          that list already lives in the left column and stays reachable via
          the "Tickets" tab / normal scroll on desktop too. */}
      {ticketTypes.length > 0 && !hasEnded && !comingSoon && (
        <div className="edt-purchase-panel">
          <div style={{ color: ventsColors.ink2, fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: '10px' }}>
            Your Order
          </div>
          <div data-testid="event-order-breakdown" style={{ display: 'grid', gap: '6px', fontSize: '13px', fontVariantNumeric: 'tabular-nums lining-nums' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: ventsColors.ink2 }}>Selected ticket</span>
              <span data-testid="event-order-ticket" style={{ color: ventsColors.ink1, fontWeight: 600 }}>{selectedTicket ? selectedTicket.name : (allSoldOut ? 'Sold out' : 'None')}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: ventsColors.ink2 }}>Quantity</span>
              <span data-testid="event-order-qty" style={{ color: ventsColors.ink1, fontWeight: 600 }}>{selectedTicket ? selectedQty : 0}</span>
            </div>
            {canBook && !freeSelection && eventQuote && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: ventsColors.ink2 }}>Ticket subtotal</span>
                  <span data-testid="event-order-subtotal" style={{ color: ventsColors.ink1, fontWeight: 600 }}>{formatKobo(eventQuote.face_kobo)}</span>
                </div>
                <div data-testid="event-total-fee-note" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: ventsColors.ink2 }}>{serviceFeeLabel(eventQuote)}</span>
                  <span data-testid="event-order-fee" style={{ color: ventsColors.ink1, fontWeight: 600 }}>{formatKobo(eventCheckout.serviceFeeKobo)}</span>
                </div>
              </>
            )}
          </div>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '12px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <span style={{ color: ventsColors.ink2, fontSize: '13px', fontWeight: 600 }}>Total payable</span>
            <span data-testid="event-order-total" style={{ color: ventsColors.white, fontSize: '18px', fontWeight: 800, fontFamily: 'Manrope, sans-serif', fontVariantNumeric: 'tabular-nums lining-nums' }}>
              {canBook ? (freeSelection ? formatPrice(0) : eventPayText) : formatPrice(0)}
            </span>
          </div>
          <button
            onClick={() => {
              try {
                if (canBook && !purchasesDisabled && selectedTicket) {
                  haptics.medium();
                  onGetTickets(selectedTicket, selectedQty);
                }
              } catch (err: any) {
                console.error('BOOK BUTTON CRASH:', err);
                Sentry.captureException(err);
                setBookingError(err?.message || String(err));
                setTimeout(() => setBookingError(null), 3500);
              }
            }}
            disabled={!canBook || purchasesDisabled}
            style={{
              width: '100%',
              background: purchasesDisabled
                ? ventsColors.elevated
                : canBook
                ? '#7B2FBE'
                : ventsColors.elevated,
              border: 'none',
              borderRadius: '14px',
              padding: '14px',
              color: purchasesDisabled ? ventsColors.ink3 : canBook ? ventsColors.white : ventsColors.ink2,
              fontSize: '15px',
              fontWeight: 700,
              fontFamily: 'Manrope, sans-serif',
              cursor: !canBook || purchasesDisabled ? 'not-allowed' : 'pointer',
            }}
          >
            {payButtonText(purchasesDisabled)}
          </button>
        </div>
      )}

      {/* Map dialog */}
      {showMapDialog && (
        <div
          onClick={() => setShowMapDialog(false)}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            display: 'flex',
            alignItems: 'flex-end',
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              background: ventsColors.surface,
              borderRadius: '24px 24px 0 0',
              padding: '24px 20px 36px',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
              <div
                style={{
                  width: '40px',
                  height: '4px',
                  background: 'rgba(255,255,255,0.15)',
                  borderRadius: '2px',
                  margin: '0 auto 16px',
                }}
              />
              <p style={{ color: ventsColors.ink1, fontSize: '16px', fontWeight: 700 }}>Open Location In</p>
              <p style={{ color: ventsColors.ink2, fontSize: '12px', marginTop: '4px' }}>
                {event.venue}, {event.city}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button
                onClick={() => openMap('google')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '14px',
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '14px',
                  padding: '14px 16px',
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: ventsColors.white, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="22" height="22" viewBox="0 0 24 24">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                  </svg>
                </div>
                <div style={{ textAlign: 'left' }}>
                  <p style={{ color: ventsColors.ink1, fontSize: '15px', fontWeight: 700 }}>Google Maps</p>
                  <p style={{ color: ventsColors.ink2, fontSize: '12px' }}>Opens in browser</p>
                </div>
              </button>
              <button
                onClick={() => openMap('apple')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '14px',
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '14px',
                  padding: '14px 16px',
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                <div style={{ width: '40px', height: '40px', borderRadius: '12px', background: ventsColors.elevated, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <MapPin size={20} color={ventsColors.white} />
                </div>
                <div style={{ textAlign: 'left' }}>
                  <p style={{ color: ventsColors.ink1, fontSize: '15px', fontWeight: 700 }}>Apple Maps</p>
                  <p style={{ color: ventsColors.ink2, fontSize: '12px' }}>Opens on iOS/macOS</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {bookingError && (
        <div style={{ position: 'absolute', left: '16px', right: '16px', bottom: '88px', zIndex: 20 }}>
          <div style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '12px', padding: '10px 14px', color: ventsColors.error, fontSize: '13px', fontWeight: 600 }}>
            {bookingError}
          </div>
        </div>
      )}

      {/* Sticky bottom bar -- mobile/tablet only; desktop's sticky
          .edt-purchase-panel in the right column replaces it. */}
      <div
        className="edt-bottom-bar"
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          background: '#020005',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: '12px 20px calc(16px + env(safe-area-inset-bottom))',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        {hasEnded ? (
          <div style={{ flex: 1, textAlign: 'center', color: ventsColors.ink2, fontSize: '15px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', padding: '14px 28px' }}>
            Event Ended
          </div>
        ) : comingSoon ? (
          <>
            <div data-testid="event-coming-soon-bar" style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: ventsColors.white, fontSize: '14px', fontWeight: 700, fontFamily: 'Manrope, sans-serif' }}>Coming Soon</div>
              <div style={{ color: ventsColors.ink2, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {salesOpenLabel ? `Tickets on sale ${salesOpenLabel}` : 'Tickets not on sale yet'}
              </div>
              {notifyNotice && <div role="status" style={{ color: ventsColors.ink1, fontSize: '12px', fontWeight: 600 }}>{notifyNotice}</div>}
            </div>
            <button
              type="button"
              data-testid="event-notify-me"
              aria-pressed={saleAlerts.isSubscribed(event.id)}
              disabled={saleAlerts.isPending(event.id)}
              onClick={toggleNotify}
              style={{
                flex: 1, borderRadius: '14px', padding: '14px 18px', fontSize: '15px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                color: saleAlerts.isSubscribed(event.id) ? ventsColors.accentSoft : ventsColors.white,
                background: saleAlerts.isSubscribed(event.id) ? 'transparent' : '#7B2FBE',
                border: saleAlerts.isSubscribed(event.id) ? `1px solid ${ventsColors.accent}` : 'none',
              }}
            >
              {saleAlerts.isSubscribed(event.id) ? <Check size={16} /> : <Bell size={16} />}
              {saleAlerts.isSubscribed(event.id) ? 'Notifying you' : 'Notify me'}
            </button>
          </>
        ) : (
          <>
            {/* The SELECTED category and quantity ("Guys × 1"). Never the
                cheapest category's "Buy from ₦X": that read as the price of
                what the attendee had chosen. The amount is on the button. */}
            <div data-testid="event-bottom-selection" style={{ color: ventsColors.white, fontSize: '15px', fontWeight: 700, fontFamily: 'Manrope, sans-serif', flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {orderLabel}
            </div>
            <button
              onClick={() => {
                try {
                  if (canBook && !purchasesDisabled && selectedTicket) {
                    haptics.medium();
                    onGetTickets(selectedTicket, selectedQty);
                  }
                } catch (err: any) {
                  console.error('BOOK BUTTON CRASH:', err);
                  Sentry.captureException(err);
                  setBookingError(err?.message || String(err));
                  setTimeout(() => setBookingError(null), 3500);
                }
              }}
              disabled={!canBook || purchasesDisabled}
              style={{
                flex: 1,
                background: purchasesDisabled
                  ? ventsColors.elevated
                  : canBook
                  ? '#7B2FBE'
                  : ventsColors.elevated,
                border: 'none',
                borderRadius: '14px',
                padding: '14px 24px',
                color: purchasesDisabled ? ventsColors.ink3 : canBook ? ventsColors.white : ventsColors.ink2,
                fontSize: '16px',
                fontWeight: 700,
                fontFamily: 'Manrope, sans-serif',
                cursor: !canBook || purchasesDisabled ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              {payButtonText(purchasesDisabled)}
            </button>
          </>
        )}
      </div>

      {shared && (
        <div style={{
          position: 'absolute',
          top: '30px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: ventsColors.elevated,
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '10px',
          padding: '8px 16px',
          zIndex: 100,
          color: ventsColors.white,
          fontSize: '13px',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          <Check size={14} color={ventsColors.accentSoft} />
          Link copied
        </div>
      )}

      {calendarError && (
        <div style={{
          position: 'absolute', top: '30px', left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(239,68,68,0.95)', backdropFilter: 'blur(10px)',
          border: '1px solid rgba(239,68,68,0.3)', borderRadius: '10px', padding: '8px 16px',
          zIndex: 100, color: ventsColors.white, fontSize: '13px', fontWeight: 600,
          boxShadow: '0 4px 12px rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', gap: '6px',
        }}>
          <AlertCircle size={14} color={ventsColors.white} />
          Couldn't open calendar. Please try again.
        </div>
      )}
      {showReport && currentUserId && (
        <ReportModal
          reporterId={currentUserId}
          targetType="event"
          targetId={event.id}
          targetName={event.title}
          onClose={() => setShowReport(false)}
        />
      )}
      </div>
    </div>
  );
}
