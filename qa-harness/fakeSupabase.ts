// QA-ONLY fake Supabase client for visual-regression screenshotting.
// Never touches network, never reads real credentials, never mutates
// anything -- every query resolves synchronously from a static fixture
// table keyed by table name. Aliased in ONLY by qa-harness/vite.config.ts,
// never by the real app build (vite.config.ts is untouched).

type Row = Record<string, any>;

const FIXTURES: Record<string, Row[]> = {
  events: [
    {
      id: 'evt-1', organizer_id: 'org-1', title: 'Lagos Music Festival',
      location: 'Eko Atlantic, Lagos', price: 15000, status: 'live',
      event_date: new Date(Date.now() + 7 * 86400000).toISOString(),
      hidden_by_admin: false, deleted_at: null, archived_at: null, image_url: null,
      created_at: new Date().toISOString(), category: 'Music', country: 'NG', is_featured: true,
      is_18_plus: false, capacity: 2000, ticket_types: [{ id: 't1', name: 'Regular', price: 15000, description: 'General Admission', available: 500 }],
      users: { username: 'lagosfest', full_name: 'Lagos Fest Org', vc_badge: null },
    },
    {
      id: 'evt-2', organizer_id: 'org-1', title: 'Comedy Night Abuja',
      location: 'Transcorp Hilton, Abuja', price: 5000, status: 'live',
      event_date: new Date(Date.now() + 14 * 86400000).toISOString(),
      hidden_by_admin: false, deleted_at: null, archived_at: null, image_url: null,
      created_at: new Date().toISOString(), category: 'Comedy', country: 'NG',
      is_18_plus: false, capacity: 500, ticket_types: [{ id: 't1', name: 'Regular', price: 5000, description: 'General Admission', available: 200 }],
      users: { username: 'comedyabj', full_name: 'Comedy Abuja', vc_badge: null },
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
  ],
  service_bookings: [],
  service_providers: [
    {
      id: 'prov-1', user_id: 'org-1', business_name: 'Ada Photography', category: 'Photography',
      state: 'Lagos', country: 'NG', status: 'approved', starting_price: 85000, cover_image_url: null,
      rating: 0, review_count: 0,
    },
    {
      id: 'sp-2', user_id: 'org-1', business_name: 'Glow Beauty Studio', category: 'Beauty',
      state: 'Abuja', country: 'NG', status: 'approved', starting_price: 25000, cover_image_url: null,
      rating: 0, review_count: 0,
    },
  ],
};

function chainable(table: string): any {
  const state: { filters: Array<[string, any]>; inFilters: Array<[string, any[]]>; limit: number | null; head: boolean } = {
    filters: [], inFilters: [], limit: null, head: false,
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
    // Real .or() takes a Postgrest filter string like "a.eq.1,b.eq.2" -- the
    // fixture table is tiny, so this just passes every row through rather
    // than parsing that mini-language; good enough for a QA render check,
    // never used to assert on filtered results.
    or: () => api,
    ilike: () => api,
    in: (k: string, values: any[]) => { state.inFilters.push([k, values]); return api; },
    order: () => api,
    limit: (n: number) => { state.limit = n; return api; },
    range: () => api,
    single: () => resolveSingle(),
    maybeSingle: () => resolveSingle(),
    upsert: () => Promise.resolve({ data: null, error: null }),
    then: (resolveFn: any, rejectFn?: any) => resolve().then(resolveFn, rejectFn),
  };
  function applyFilters(rows: Row[]) {
    return rows
      .filter((r) => state.filters.every(([k, v]) => r[k] === v))
      .filter((r) => state.inFilters.every(([k, values]) => values.includes(r[k])));
  }
  function resolve() {
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
    getSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signUp: async () => ({ data: { user: { id: 'qa-fake-user', email: 'ada@example.com' }, session: null }, error: null }),
    signInWithPassword: async () => ({ data: { user: null, session: null }, error: { message: 'Invalid login credentials' } }),
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
    verifyOtp: async () => ({ data: { user: { id: 'qa-fake-user' }, session: { access_token: 'qa-fake' } }, error: null }),
    updateUser: async () => ({ data: {}, error: null }),
    resend: async () => ({ data: {}, error: null }),
    signOut: async () => ({ error: null }),
  },
  rpc: async (fn: string) => ({ data: RPC_FIXTURES[fn] ?? null, error: null }),
  channel: () => ({ on: () => ({ subscribe: () => {} }), subscribe: () => {} }),
  removeChannel: () => {},
} as any;
