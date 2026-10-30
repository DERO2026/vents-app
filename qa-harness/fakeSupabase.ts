// QA-ONLY fake Supabase client for visual-regression screenshotting.
// Never touches network, never reads real credentials, never mutates
// anything -- every query resolves synchronously from a static fixture
// table keyed by table name. Aliased in ONLY by qa-harness/vite.config.ts,
// never by the real app build (vite.config.ts is untouched).

type Row = Record<string, any>;

const FIXTURES: Record<string, Row[]> = {
  app_config: [
    { id: true, vc_naira_per_1000: 500 },
  ],
  events: [
    {
      id: 'evt-1', organizer_id: 'org-1', title: 'Lagos Music Festival',
      location: 'Eko Atlantic, Lagos', price: 15000, status: 'live',
      event_date: new Date(Date.now() + 7 * 86400000).toISOString(),
      hidden_by_admin: false, deleted_at: null, archived_at: null, image_url: null,
      created_at: new Date().toISOString(), category: 'Music', country: 'NG', is_featured: true,
      is_18_plus: false, capacity: 2000, ticket_types: [{ id: 't1', name: 'Regular', price: 15000, description: 'General Admission', available: 500 }],
      users: { username: 'lagosfest', full_name: 'Lagos Fest Org', vc_badge: null },
      'users!events_organizer_id_fkey': { username: 'test.organizer', full_name: 'Test Organizer', is_verified: true },
    },
    {
      id: 'evt-2', organizer_id: 'org-1', title: 'Comedy Night Abuja',
      location: 'Transcorp Hilton, Abuja', price: 5000, status: 'live',
      event_date: new Date(Date.now() + 14 * 86400000).toISOString(),
      hidden_by_admin: false, deleted_at: null, archived_at: null, image_url: null,
      created_at: new Date().toISOString(), category: 'Comedy', country: 'NG',
      is_18_plus: false, capacity: 500, ticket_types: [{ id: 't1', name: 'Regular', price: 5000, description: 'General Admission', available: 200 }],
      users: { username: 'comedyabj', full_name: 'Comedy Abuja', vc_badge: null },
      'users!events_organizer_id_fkey': { username: 'test.organizer', full_name: 'Test Organizer', is_verified: true },
    },
    {
      id: 'evt-adaeze-1', organizer_id: 'user-2', title: 'Golden Hour Portraits Pop-Up',
      location: 'Freedom Park, Lagos', venue: 'Freedom Park', price: 5000, status: 'live',
      event_date: new Date(Date.now() + 5 * 86400000).toISOString(),
      hidden_by_admin: false, deleted_at: null, archived_at: null, image_url: null,
      created_at: new Date().toISOString(), category: 'Arts', country: 'NG',
      is_18_plus: false, capacity: 100, ticket_types: [{ id: 't1', name: 'Regular', price: 5000, description: 'General Admission', available: 50 }],
      users: { username: 'adaeze.o', full_name: 'Adaeze Okonkwo', vc_badge: null },
    },
    {
      id: 'evt-3', organizer_id: 'org-1', title: 'Tech Summit 2026',
      location: 'Landmark Centre, Lagos', price: 25000, status: 'draft',
      event_date: new Date(Date.now() + 30 * 86400000).toISOString(),
      hidden_by_admin: false, deleted_at: null, archived_at: null, image_url: null,
      created_at: new Date().toISOString(), category: 'Technology', country: 'NG',
      is_18_plus: false, capacity: 1000, ticket_types: [{ id: 't1', name: 'Regular', price: 25000, description: 'General Admission', available: 800 }],
      users: { username: 'techsummit', full_name: 'Tech Summit', vc_badge: null },
    },
  ],
  tickets: [
    {
      id: 'tkt-refund-1', ticket_type: 'Regular', quantity: 1, amount: 15000,
      discount_percentage: 0, payment_status: 'refunded', payment_method: 'wallet',
      refund_reason: 'Event cancelled by organizer', checked_in: false,
      events: { title: 'Lagos Music Festival', event_date: new Date(Date.now() + 7 * 86400000).toISOString(), location: 'Eko Atlantic, Lagos' },
    },
    // Drives SalesAnalyticsScreen (DT2 desktop) -- it queries tickets
    // directly (status='active' AND payment_status='paid'), not an RPC, so
    // the aggregate RPC fixture above isn't enough on its own for this screen.
    { id: 'tkt-sa-1', event_id: 'evt-1', ticket_type: 'Regular', quantity: 1, amount: 15000, status: 'active', payment_status: 'paid', created_at: new Date().toISOString() },
    { id: 'tkt-sa-2', event_id: 'evt-1', ticket_type: 'VIP', quantity: 1, amount: 30000, status: 'active', payment_status: 'paid', created_at: new Date().toISOString() },
    { id: 'tkt-sa-3', event_id: 'evt-2', ticket_type: 'Regular', quantity: 1, amount: 5000, status: 'active', payment_status: 'paid', created_at: new Date().toISOString() },
  ],
  service_bookings: [
    {
      id: 'bk-1', provider_id: 'prov-1', customer_id: 'org-1', status: 'cancelled', payment_status: 'refunded',
      scheduled_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), scheduled_time: '14:00',
      location: 'Victoria Island, Lagos', customer_notes: null, currency: 'NGN',
      subtotal_kobo: 8500000, fee_kobo: 425000, total_kobo: 8925000, created_at: new Date().toISOString(),
      service_providers: { business_name: 'Ada Photography' },
      service_booking_items: [{ id: 'bki-1', service_name: 'Full studio session', unit_price_kobo: 8500000, quantity: 1, line_total_kobo: 8500000 }],
    },
  ],
  service_providers: [
    {
      id: 'prov-1', user_id: 'org-1', business_name: 'Ada Photography', category: 'Photography',
      location: 'Victoria Island, Lagos', latitude: null, longitude: null, country: 'NG',
      description: 'Full studio and event photography with same-day previews. Over 200 shoots across Lagos.',
      photo_urls: [], starting_price: 85000, starting_price_currency: 'NGN',
      services_offered: ['Portraits', 'Events', 'Weddings'],
      offers_home_service: true, offers_delivery: false, offers_same_day: true,
      status: 'approved', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
    {
      id: 'sp-2', user_id: 'org-1', business_name: 'Glow Beauty Studio', category: 'Beauty',
      location: 'Wuse, Abuja', latitude: null, longitude: null, country: 'NG',
      description: null, photo_urls: [], starting_price: 25000, starting_price_currency: 'NGN',
      services_offered: [], offers_home_service: false, offers_delivery: true, offers_same_day: false,
      status: 'approved', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
  ],
  provider_services: [
    {
      id: 'psv-1', provider_id: 'prov-1', name: 'Full studio session', description: '2 hours · outdoor or studio',
      price: 85000, currency: 'NGN', duration_minutes: 120, category: 'Photography', is_active: true,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
    {
      id: 'psv-2', provider_id: 'prov-1', name: 'Event coverage', description: 'Full day · edited gallery',
      price: 220000, currency: 'NGN', duration_minutes: 480, category: 'Photography', is_active: true,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
  ],
  service_provider_categories: [
    { provider_id: 'prov-1', category: 'Photography' },
    { provider_id: 'sp-2', category: 'Beauty' },
  ],
  service_provider_ratings: [],
  // VENTS Work / Representative dashboard: rep-1 is an active
  // Representative with 3 accepted partners and 2 open invitations.
  recruiters: [
    { id: 'rep-1', display_name: 'Adaeze Okonkwo', bio: null, status: 'active', created_at: '2026-10-03T09:00:00Z' },
  ],
  // RepresentativesScreen Invitations tab (recipient side): org-1 has one
  // pending invitation from user-3 and one it already accepted from user-4.
  recruiter_partnerships: [
    ...['user-2', 'user-3', 'user-4'].map((org, i) => ({
      id: `rp-rep-${i}`, recruiter_id: 'rep-1', organizer_id: `rep-org-${i}`, provider_id: null, status: 'accepted',
      commission_split_bps: 10000, invited_at: new Date(Date.now() - (20 - i) * 86400000).toISOString(),
      responded_at: new Date(Date.now() - (18 - i) * 86400000).toISOString(),
    })),
    ...[0, 1].map((i) => ({
      id: `rp-rep-pending-${i}`, recruiter_id: 'rep-1', organizer_id: `rep-invitee-${i}`, provider_id: null, status: 'pending',
      commission_split_bps: 10000, invited_at: new Date(Date.now() - i * 3600000).toISOString(), responded_at: null,
    })),
    {
      id: 'rp-pending', recruiter_id: 'user-3', organizer_id: 'org-1', provider_id: null, status: 'pending',
      commission_split_bps: 10000, invited_at: new Date(Date.now() - 2 * 3600000).toISOString(), responded_at: null,
    },
    {
      id: 'rp-accepted', recruiter_id: 'user-4', organizer_id: 'org-1', provider_id: null, status: 'accepted',
      commission_split_bps: 10000, invited_at: new Date(Date.now() - 9 * 86400000).toISOString(),
      responded_at: new Date(Date.now() - 6 * 86400000).toISOString(),
    },
  ],
  public_profiles: [
    {
      id: 'user-2', full_name: 'Priya Nair', username: 'priya.n', avatar_url: null, vc_badge: null,
      role: 'attendee', last_active_at: new Date().toISOString(), bio: 'Lagos-based, loves live music.',
      state: 'Lagos', is_verified: false, interests: [],
    },
    {
      id: 'user-3', full_name: 'Tobi Oyelaran', username: 'tobi.o', avatar_url: null, vc_badge: null,
      role: 'organizer', last_active_at: new Date(Date.now() - 3 * 3600000).toISOString(), bio: '',
      state: 'Abuja', is_verified: true, interests: [],
    },
    {
      id: 'user-4', full_name: 'Ada Chukwu', username: 'ada.chukwu', avatar_url: null, vc_badge: null,
      role: 'attendee', last_active_at: new Date(Date.now() - 2 * 86400000).toISOString(), bio: '',
      state: 'Lagos', is_verified: false, interests: [],
    },
  ],
  direct_messages: [
    {
      id: 'dm-1', sender_id: 'user-2', recipient_id: 'org-1', body: 'Hey! Are you still doing the meet & greet after the show?',
      created_at: new Date(Date.now() - 5 * 60000).toISOString(), read_at: null,
    },
    {
      id: 'dm-2', sender_id: 'org-1', recipient_id: 'user-3', body: 'Thanks for confirming the booth setup time.',
      created_at: new Date(Date.now() - 3 * 3600000).toISOString(), read_at: new Date().toISOString(),
    },
  ],
  conversation_requests: [
    { requester_id: 'user-4', recipient_id: 'org-1', status: 'pending', created_at: new Date(Date.now() - 86400000).toISOString() },
  ],
  // ── Admin Console fixtures ──────────────────────────────────────────────
  reports: [
    {
      id: 'rep-1', reporter_id: 'user-4', target_type: 'user', target_id: 'user-3',
      reason: 'Harassment', details: 'Sent repeated unsolicited messages after being asked to stop.',
      status: 'pending', created_at: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: 'rep-2', reporter_id: 'user-2', target_type: 'event', target_id: 'evt-1',
      reason: 'Misleading listing', details: 'Event page shows a different venue than what was advertised.',
      status: 'pending', created_at: new Date(Date.now() - 7200000).toISOString(),
    },
  ],
  organizer_verification_requests: [],
  organizer_requests: [
    {
      id: 'orgreq-1', user_id: 'user-plain-1', reason: 'I run monthly food festivals in Lagos and want to list them on VENTS.',
      status: 'pending', admin_note: null, created_at: new Date(Date.now() - 86400000).toISOString(),
    },
  ],
  organizer_withdrawal_requests: [
    { id: 'wd-1', organizer_id: 'org-1', amount_kobo: 5000000, status: 'pending', created_at: new Date(Date.now() - 2 * 86400000).toISOString() },
  ],
  organizer_wallets: [
    { organizer_id: 'org-1', balance_kobo: 32500000, pending_kobo: 5000000, total_earned_kobo: 172000000, total_withdrawn_kobo: 134500000 },
  ],
  service_provider_requests: [
    {
      id: 'spr-1', user_id: 'org-1', status: 'pending', reason: 'I offer event photography and want to list my services.',
      business_name: 'Ada Photography', cac_number: null, owner_name: 'Test Organizer',
      provider_type: 'individual', country: 'NG', identity_id_type: 'NIN', identity_id_number: '12345678901',
      document_url: null, admin_note: null,
      created_at: new Date(Date.now() - 3 * 86400000).toISOString(), reviewed_at: null,
    },
  ],
  admin_logs: [
    { id: 'log-1', action: 'toggle_user_verified', details: { verified: true }, created_at: new Date(Date.now() - 5 * 86400000).toISOString(), admin_id: 'admin-1', actor_role: 'admin', target_user_id: 'org-1' },
    { id: 'log-2', action: 'suspend_user', details: { banned_until: null, ban_days: 7 }, created_at: new Date(Date.now() - 2 * 86400000).toISOString(), admin_id: 'admin-1', actor_role: 'admin', target_user_id: 'user-suspended-1' },
  ],
  // Drives App.tsx's own session-hydration `.from('users').select('*')`
  // when mounting the real, unmodified App (the 'full-app' harness route)
  // to verify real in-app navigation end-to-end, not just source reading.
  users: [
    {
      id: 'org-1', email: 'organizer@example.com', full_name: 'Test Organizer', username: 'test.organizer',
      // Organizer is the independent is_organizer capability, not role
      // (0121_organizer_capability_independent_of_role.sql) -- role stays
      // 'user' here, matching every real organizer account in production.
      role: 'user', is_organizer: true, is_service_provider: false,
      avatar_url: null, cover_url: null, is_verified: true, state: 'Lagos',
      phone_number: '+2348010000001', status: 'active', banned_until: null, deleted_at: null,
      interests: [], bio: '', vc_badge: null, instagram_handle: null, x_handle: null, tiktok_handle: null,
      country: 'NG', created_at: new Date().toISOString(),
    },
    // ── Admin Console fixture rows ──────────────────────────────────────────
    // Deliberately cover every independent combination the multi-role
    // architecture allows, plus edge cases the visual checklist asks for
    // (long name/email overflow, multiple capability badges at once,
    // suspended status, unverified).
    {
      id: 'admin-1', email: 'admin@example.com', full_name: 'Admin Operator', username: 'admin.operator',
      role: 'admin', is_organizer: false, is_service_provider: false,
      state: 'Lagos', status: 'active', is_verified: true, created_at: new Date(Date.now() - 200 * 86400000).toISOString(),
      banned_until: null, deleted_at: null, phone_number: '+2348010000002',
    },
    {
      id: 'subadmin-1', email: 'subadmin@example.com', full_name: 'Sub Admin Reviewer', username: 'sub.reviewer',
      // Proves independence: a Sub-Admin who is ALSO an Organizer -- the
      // exact case the old conflated-role model could never represent.
      role: 'sub-admin', is_organizer: true, is_service_provider: false,
      state: 'Abuja', status: 'active', is_verified: true, created_at: new Date(Date.now() - 150 * 86400000).toISOString(),
      banned_until: null, deleted_at: null, phone_number: '+2348010000003',
    },
    {
      id: 'user-plain-1', email: 'chidinma.eze@example.com', full_name: 'Chidinma Eze', username: 'chidinma.eze',
      role: 'user', is_organizer: false, is_service_provider: false,
      state: 'Rivers', status: 'active', is_verified: false, created_at: new Date(Date.now() - 40 * 86400000).toISOString(),
      banned_until: null, deleted_at: null, phone_number: '+2348010000004',
    },
    {
      id: 'user-both-caps-1',
      email: 'oluwaseun.adebayo-photography-and-events@example.com',
      full_name: 'Oluwaseun Adebayo-Photography-And-Events-Extremely-Long-Display-Name',
      username: 'oluwaseun.the.everything.organizer.and.provider',
      // Both capabilities at once -- User + Organizer + Service Provider --
      // the primary scenario the multi-role fix exists to represent, plus
      // the long-name/email overflow check the visual checklist asks for.
      role: 'user', is_organizer: true, is_service_provider: true,
      state: 'Lagos', status: 'active', is_verified: true, created_at: new Date(Date.now() - 90 * 86400000).toISOString(),
      banned_until: null, deleted_at: null, phone_number: '+2348010000005',
    },
    {
      id: 'user-suspended-1', email: 'suspended.user@example.com', full_name: 'Suspended Example', username: 'suspended.example',
      role: 'user', is_organizer: false, is_service_provider: true,
      state: 'Kano', status: 'suspended', is_verified: false, created_at: new Date(Date.now() - 20 * 86400000).toISOString(),
      banned_until: new Date(Date.now() + 5 * 86400000).toISOString(), deleted_at: null, phone_number: '+2348010000006',
    },
  ],
  // Stage 8 screenshot verification (PromotionsScreen.tsx) -- one Active
  // (Trending), one Scheduled (Featured), and one Expired row so all three
  // date-derived statuses are visible in the populated state at once.
  // ?promotionsEmpty=1 forces this to [] for the empty-state screenshot,
  // same pattern as ?eventsEmpty=1 for ManageEventsScreen below.
  event_promotions: [
    {
      id: 'promo-1', event_id: 'evt-1', organizer_id: 'org-1', plan_type: 'trending', status: 'active',
      start_date: new Date(Date.now() - 2 * 86400000).toISOString(),
      end_date: new Date(Date.now() + 5 * 86400000).toISOString(),
      created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      events: { id: 'evt-1', title: 'Lagos Music Festival', image_url: null, event_date: new Date(Date.now() + 7 * 86400000).toISOString() },
    },
    {
      id: 'promo-2', event_id: 'evt-2', organizer_id: 'org-1', plan_type: 'featured', status: 'active',
      start_date: new Date(Date.now() + 3 * 86400000).toISOString(),
      end_date: new Date(Date.now() + 10 * 86400000).toISOString(),
      created_at: new Date(Date.now() - 1 * 86400000).toISOString(),
      // A data: URI, not an external host -- this sandbox's outbound
      // network is blocked for everything but Supabase/Vercel, so a real
      // remote image URL would just render as a broken image in a
      // screenshot. This still exercises the real <img src=...> thumbnail
      // code path exactly as a live events.image_url would.
      events: { id: 'evt-2', title: 'Comedy Night Abuja', image_url: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzdCMkZCRSIvPjwvc3ZnPg==', event_date: new Date(Date.now() + 14 * 86400000).toISOString() },
    },
    {
      id: 'promo-3', event_id: 'evt-3', organizer_id: 'org-1', plan_type: 'trending', status: 'active',
      start_date: new Date(Date.now() - 20 * 86400000).toISOString(),
      end_date: new Date(Date.now() - 13 * 86400000).toISOString(),
      created_at: new Date(Date.now() - 20 * 86400000).toISOString(),
      events: { id: 'evt-3', title: 'Tech Summit 2026', image_url: null, event_date: new Date(Date.now() + 30 * 86400000).toISOString() },
    },
  ],
};

// Parses the subset of the real PostgREST .or() filter-string mini-language
// this codebase actually sends: a top-level comma-separated list of OR
// branches, each either a bare `col.eq.val` term or an `and(col.eq.val,...)`
// group of AND'd eq terms (exactly the shape every call site in this repo
// uses, e.g. ConversationScreen.tsx's
// `and(sender_id.eq.X,recipient_id.eq.Y),and(sender_id.eq.Y,recipient_id.eq.X)`).
// Splits on top-level commas only (commas inside and(...) don't split
// branches), not a general PostgREST parser -- sufficient for this fixture
// harness, not meant to be reused outside it.
function splitTopLevel(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

function evalEqTerm(term: string, row: Row): boolean {
  const m = term.match(/^([^.]+)\.eq\.(.*)$/);
  if (!m) return false; // unsupported operator in this subset -- fail closed, never match
  const [, key, value] = m;
  return String(row[key]) === value;
}

function evalOrBranch(branch: string, row: Row): boolean {
  const andMatch = branch.match(/^and\((.*)\)$/);
  if (andMatch) return splitTopLevel(andMatch[1]).every((term) => evalEqTerm(term, row));
  return evalEqTerm(branch, row);
}

function chainable(table: string): any {
  const state: { filters: Array<[string, any]>; inFilters: Array<[string, any[]]>; orExpr: string | null; limit: number | null; head: boolean } = {
    filters: [], inFilters: [], orExpr: null, limit: null, head: false,
  };
  const api: any = {
    select: (_cols?: string, opts?: { head?: boolean }) => { if (opts?.head) state.head = true; return api; },
    eq: (k: string, v: any) => { state.filters.push([k, v]); return api; },
    neq: () => api,
    gt: () => api,
    gte: () => api,
    lte: () => api,
    not: () => api,
    is: () => api,
    // Real .or() takes a Postgrest filter string like
    // "and(a.eq.1,b.eq.2),and(a.eq.2,b.eq.1)" -- parsed above (splitTopLevel
    // + evalOrBranch) so fixture rows are genuinely filtered, not just
    // passed through.
    or: (expr: string) => { state.orExpr = expr; return api; },
    ilike: () => api,
    in: (k: string, values: any[]) => { state.inFilters.push([k, values]); return api; },
    order: () => api,
    limit: (n: number) => { state.limit = n; return api; },
    range: () => api,
    single: () => resolveSingle(),
    maybeSingle: () => resolveSingle(),
    upsert: () => Promise.resolve({ data: null, error: null }),
    update: () => api,
    then: (resolveFn: any, rejectFn?: any) => resolve().then(resolveFn, rejectFn),
  };
  function applyFilters(rows: Row[]) {
    return rows
      .filter((r) => state.filters.every(([k, v]) => r[k] === v))
      .filter((r) => state.inFilters.every(([k, values]) => values.includes(r[k])))
      .filter((r) => state.orExpr === null || splitTopLevel(state.orExpr!).some((branch) => evalOrBranch(branch, r)));
  }
  function resolve() {
    if (table === 'event_promotions' && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('promotionsEmpty') === '1') {
      return Promise.resolve({ data: [], error: null });
    }
    // Stage 10: ?inboxEmpty=1 forces InboxScreen/ConversationScreen's
    // message/request-backed tables to [] for the empty-state screenshot.
    if (
      (table === 'direct_messages' || table === 'conversation_requests' || table === 'conversation_clears') &&
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('inboxEmpty') === '1'
    ) {
      return Promise.resolve({ data: [], error: null });
    }
    let rows = applyFilters(FIXTURES[table] || []);
    if (state.limit) rows = rows.slice(0, state.limit);
    if (state.head) return Promise.resolve({ data: null, error: null, count: rows.length });
    return Promise.resolve({ data: rows, error: null });
  }
  function resolveSingle() {
    const rows = applyFilters(FIXTURES[table] || []);
    return Promise.resolve({ data: rows[0] || null, error: null });
  }
  return api;
}

export async function getAuthToken(): Promise<string> {
  return 'qa-harness-fake-token';
}

const RPC_FIXTURES: Record<string, any> = {
  // Drives the real ManageEventsScreen / useOrganizerEvents.ts data layer
  // (DT1 desktop table) -- rows in the same raw shape the real RPC returns,
  // mapped by mapRow() in useOrganizerEvents.ts, not a hand-shaped UI object.
  get_organizer_events_overview: [
    {
      id: 'evt-1', title: 'Lagos Music Festival', description: null, location: 'Eko Atlantic, Lagos',
      event_date: '2026-09-23T20:00:00Z', price: 15000, ticket_goal: 120, ticket_types: [],
      status: 'live', is_18_plus: false, created_at: new Date().toISOString(),
      sold_count: 86, sold_quantity: 86, pending_count: 0, cancelled_count: 0, refunded_count: 0,
      revenue_kobo: 172000000, checked_in_count: 61, is_ended: false, is_sold_out: false,
    },
    {
      id: 'evt-2', title: 'Comedy Night Lagos', description: null, location: 'Lekki, Lagos',
      event_date: '2026-10-05T19:00:00Z', price: 8000, ticket_goal: 150, ticket_types: [],
      status: 'live', is_18_plus: false, created_at: new Date().toISOString(),
      sold_count: 142, sold_quantity: 142, pending_count: 0, cancelled_count: 0, refunded_count: 0,
      revenue_kobo: 213000000, checked_in_count: 0, is_ended: false, is_sold_out: false,
    },
    {
      id: 'evt-3', title: 'Tech Summit Lagos', description: null, location: 'Victoria Island, Lagos',
      event_date: '2026-08-01T09:00:00Z', price: 15000, ticket_goal: 64, ticket_types: [],
      status: 'live', is_18_plus: false, created_at: new Date().toISOString(),
      sold_count: 64, sold_quantity: 64, pending_count: 0, cancelled_count: 0, refunded_count: 0,
      revenue_kobo: 96000000, checked_in_count: 0, is_ended: false, is_sold_out: true,
    },
    // Stage 6: rounding out status-badge coverage (ManageEventsScreen's
    // STATUS_META has 4 states -- the rows above only ever exercised live
    // and sold_out) with a draft and an ended row, same raw shape.
    {
      id: 'evt-4', title: 'Afrobeats Rooftop Session', description: null, location: 'Ikoyi, Lagos',
      event_date: '2026-12-12T20:00:00Z', price: 10000, ticket_goal: 80, ticket_types: [],
      status: 'draft', is_18_plus: false, created_at: new Date().toISOString(),
      sold_count: 0, sold_quantity: 0, pending_count: 0, cancelled_count: 0, refunded_count: 0,
      revenue_kobo: 0, checked_in_count: 0, is_ended: false, is_sold_out: false,
    },
    {
      id: 'evt-5', title: 'Lagos Jazz Brunch', description: null, location: 'Victoria Island, Lagos',
      event_date: '2026-01-10T12:00:00Z', price: 6000, ticket_goal: 50, ticket_types: [],
      status: 'live', is_18_plus: false, created_at: new Date().toISOString(),
      sold_count: 41, sold_quantity: 41, pending_count: 0, cancelled_count: 1, refunded_count: 0,
      revenue_kobo: 24600000, checked_in_count: 41, is_ended: true, is_sold_out: false,
    },
  ],
  // Drives SalesAnalyticsScreen (DT2 desktop) -- get_event_ticket_stats is
  // the same aggregate RPC OrganizerDashboard/ManageEventsScreen call.
  get_event_ticket_stats: [
    { event_id: 'evt-1', sold_count: 86, sold_quantity: 86, revenue_kobo: 172000000, checked_in_count: 61 },
    { event_id: 'evt-2', sold_count: 142, sold_quantity: 142, revenue_kobo: 213000000, checked_in_count: 0 },
    { event_id: 'evt-3', sold_count: 64, sold_quantity: 64, revenue_kobo: 96000000, checked_in_count: 0 },
  ],
  // ── Admin Console dashboard/event-detail RPCs ───────────────────────────
  admin_get_vc_aggregates: [{ circulation: 128400 }],
  // VENTS Work / VENTS Earn (QA fixture values, mockup-sized).
  get_my_vc_balance: { spendable: 1250, expired_this_call: 0 },
  vc_tier_and_multiplier_for_user: [{ tier: 'Silver', lifetime_earned: 4900, multiplier: 1.1 }],
  get_my_wallet: [{ balance_kobo: 320000 }],
  get_my_referral_confirmations: [
    { id: 'claim-confirm-1', status: 'pending_organizer', created_at: new Date().toISOString(), representative_name: 'Adaeze Okonkwo', event_title: 'Lagos Music Festival' },
  ],
  get_my_representative_rewards: {
    representative: { id: 'rep-1', status: 'active', created_at: '2026-10-03T09:00:00Z', display_name: 'Adaeze Okonkwo' },
    payouts_enabled: false, programme_open: false, current_month: '2026-10-01', current_rate_kobo: 5000000,
    base_reward_kobo: 5000000, rate_review_threshold: 9, qualifying_this_month: 2, qualifying_last_month: 0,
    funding_available: false,
    attributions: [
      { organizer_id: 'user-3', organizer_name: 'Tobi Oyelaran', organizer_username: 'tobi.o', attributed_at: '2026-10-05T09:00:00Z',
        events: [{ event_id: 'evt-x1', title: 'Abuja Comedy Night', eligibility: { eligible: true, reasons: [], is_free_event: false } }] },
      { organizer_id: 'user-2', organizer_name: 'Priya Nair', organizer_username: 'priya.n', attributed_at: '2026-10-08T09:00:00Z',
        events: [{ event_id: 'evt-x2', title: 'Lekki Art Walk', eligibility: { eligible: false, reasons: ['settlement_hold'] } }] },
      { organizer_id: 'user-4', organizer_name: 'Ada Chukwu', organizer_username: 'ada.chukwu', attributed_at: '2026-10-09T09:00:00Z', events: [] },
    ],
    claims: [
      { id: 'cl-1', organizer_id: 'user-9', organizer_name: 'Kemi Adeyemi', event_id: 'evt-y1', event_title: 'Ikoyi Jazz Brunch', status: 'approved', amount_kobo: 5000000, reward_month: '2026-10-01', created_at: '2026-10-20T09:00:00Z', decision_reason: null, credited_at: null },
      { id: 'cl-2', organizer_id: 'user-8', organizer_name: 'Femi Bello', event_id: 'evt-y2', event_title: 'Yaba Tech Fair', status: 'pending_review', amount_kobo: 5000000, reward_month: '2026-10-01', created_at: '2026-10-24T09:00:00Z', decision_reason: null, credited_at: null },
    ],
    expenses: [
      { id: 'ex-1', category: 'transport', amount_kobo: 250000, description: 'Bus to Ikeja meeting', incurred_on: '2026-10-21', status: 'submitted', decision_reason: null, created_at: '2026-10-21T09:00:00Z' },
    ],
  },
  admin_get_vents_earn_overview: {
    settings: { payouts_enabled: false, legacy_commission_reconciled: false, settlement_hold_days: 7, base_reward_kobo: 5000000 },
    pool: { available_kobo: 0, reserved_kobo: 0, credited_kobo: 0 },
    claims: [
      { id: 'cl-2', status: 'pending_review', amount_kobo: 5000000, reward_month: '2026-10-01', is_free_event: false, free_event_verified: false, representative_id: 'rep-1', representative_name: 'Adaeze Okonkwo', organizer_id: 'user-8', organizer_name: 'Femi Bello', event_id: 'evt-y2', event_title: 'Yaba Tech Fair', created_at: '2026-10-24T09:00:00Z', decision_reason: null },
    ],
    attributions: [
      { id: 'at-1', representative_id: 'rep-1', representative_name: 'Adaeze Okonkwo', organizer_id: 'user-3', organizer_name: 'Tobi Oyelaran', attributed_at: '2026-10-05T09:00:00Z', organizer_had_events_before: false },
    ],
    expenses: [
      { id: 'ex-1', representative_id: 'rep-1', representative_name: 'Adaeze Okonkwo', category: 'transport', amount_kobo: 250000, description: 'Bus to Ikeja meeting', incurred_on: '2026-10-21', status: 'submitted', created_at: '2026-10-21T09:00:00Z' },
    ],
    monthly_counts: [{ representative_id: 'rep-1', month: '2026-10-01', count: 2 }],
    recognitions: [],
    audit: [
      { id: 'au-1', entity_type: 'settings', entity_id: null, action: 'legacy_commission_snapshot', actor_id: null, subject_user_id: null, details: {}, created_at: '2026-10-30T09:00:00Z' },
    ],
  },
  // Real shape: a bare scalar (Number(data)), not an array/object.
  admin_pending_request_count: 3,
  admin_get_verification_stats: [{ pending_count: 2 }],
  admin_list_organizer_verifications: [],
  get_event_analytics: {
    overview: { soldCount: 86, soldQuantity: 86, grossKobo: 172000000, pendingCount: 0, cancelledCount: 2, refundedCount: 1 },
    attendance: { checkedInCount: 61, soldQuantity: 86, attendancePct: 70.9 },
  },
  get_payment_request_details: {
    event_title: 'Lagos Music Festival', event_image_url: null, ticket_type: 'Regular',
    attendee_count: 2, amount_kobo: 4200000, recipient_name: 'Ada Okonkwo',
    status: 'pending', is_expired: false, viewer_is_requester: true,
    payer_name: 'Tobi O.', payer_masked_phone: '+234 803••••21',
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 23 * 3600000).toISOString(),
  },
};

// QA-ONLY auth mocks so AuthScreen's real OTP/verification UI is reachable
// without live Supabase credentials -- each mirrors the shape the real
// client returns on the SUCCESS path only (email-confirmation-required
// signup, code-sent password reset, correct-code verify), just enough to
// drive the screen's own state machine into each visual state for
// comparison against the export. Never used by the real app build.
export const supabase = {
  from: (table: string) => chainable(table),
  auth: {
    // Real, authenticated session ONLY for the 'full-app' harness route
    // (?screen=full-app), which mounts the actual, unmodified App.tsx to
    // verify real in-app navigation end-to-end. Every other harness route
    // mounts one screen directly with fixture props and still needs
    // getSession() to read "logged out" (e.g. AuthScreen's own states).
    getSession: async () => {
      const isFullApp = typeof window !== 'undefined' && window.location.search.includes('screen=full-app');
      if (!isFullApp) return { data: { session: null }, error: null };
      return {
        data: {
          session: {
            user: { id: 'org-1', email: 'organizer@example.com' },
            access_token: 'qa-harness-fake-token',
          },
        },
        error: null,
      };
    },
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signUp: async () => ({ data: { user: { id: 'qa-fake-user', email: 'ada@example.com' }, session: null }, error: null }),
    signInWithPassword: async () => ({ data: { user: null, session: null }, error: { message: 'Invalid login credentials' } }),
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
    verifyOtp: async () => ({ data: { user: { id: 'qa-fake-user' }, session: { access_token: 'qa-fake' } }, error: null }),
    updateUser: async () => ({ data: {}, error: null }),
    resend: async () => ({ data: {}, error: null }),
    signOut: async () => ({ error: null }),
  },
  rpc: async (fn: string, args?: any) => {
    // QA-only: verify_entry_pass keyed off a magic p_ticket_id prefix so
    // the real scanner UI's own dev simulator input can drive every real
    // ScanOutcome branch (ticketValidation.ts) without a live backend.
    // Typed exactly as the RPC's real response shape -- this is exercising
    // the actual client-side result-mapping code, not inventing new UI.
    if (fn === 'verify_entry_pass') {
      const id = String(args?.p_ticket_id || '').toUpperCase();
      if (id.startsWith('VALID')) {
        return { data: { ok: true, holder_name: 'Ada Chukwu', ticket_type: 'Regular', event_name: 'Lagos Music Festival', checked_in_at: new Date().toISOString() }, error: null };
      }
      if (id.startsWith('USED')) {
        return { data: { ok: false, reason: 'already_scanned', holder_name: 'Tobi Oyelaran', ticket_type: 'VIP', event_name: 'Lagos Music Festival', checked_in_at: new Date(Date.now() - 3600000).toISOString(), scanner_id: 'Gate A' }, error: null };
      }
      if (id.startsWith('EXPIRED')) {
        return { data: { ok: false, reason: 'expired', message: 'This pass has expired.' }, error: null };
      }
      if (id.startsWith('WRONG')) {
        return { data: { ok: false, reason: 'wrong_organizer', message: 'This ticket is for a different event.' }, error: null };
      }
      if (id.startsWith('REFUNDED')) {
        return { data: { ok: false, reason: 'not_active', message: 'This ticket was refunded.' }, error: null };
      }
      if (id.startsWith('CANCELLED')) {
        return { data: { ok: false, reason: 'not_active', message: 'This ticket was cancelled.' }, error: null };
      }
      return { data: { ok: false, reason: 'not_found', message: 'This ticket could not be validated.' }, error: null };
    }
    // Stage 6 screenshot verification needs both a populated and a
    // genuinely empty "My Events" state from the same harness screen key --
    // ?eventsEmpty=1 forces the one RPC that screen depends on to return no
    // rows, without touching the fixture data every other screen relies on.
    if (fn === 'get_organizer_events_overview' && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('eventsEmpty') === '1') {
      return { data: [], error: null };
    }
    return { data: RPC_FIXTURES[fn] ?? null, error: null };
  },
  channel: () => ({ on: () => ({ subscribe: () => {} }), subscribe: () => {} }),
  removeChannel: () => {},
} as any;
