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
      hidden_by_admin: false, deleted_at: null, image_url: null,
      created_at: new Date().toISOString(), category: 'Music',
    },
    {
      id: 'evt-2', organizer_id: 'org-1', title: 'Comedy Night Abuja',
      location: 'Transcorp Hilton, Abuja', price: 5000, status: 'live',
      event_date: new Date(Date.now() + 14 * 86400000).toISOString(),
      hidden_by_admin: false, deleted_at: null, image_url: null,
      created_at: new Date().toISOString(), category: 'Comedy',
    },
    {
      id: 'evt-3', organizer_id: 'org-1', title: 'Tech Summit 2026',
      location: 'Landmark Centre, Lagos', price: 25000, status: 'draft',
      event_date: new Date(Date.now() + 30 * 86400000).toISOString(),
      hidden_by_admin: false, deleted_at: null, image_url: null,
      created_at: new Date().toISOString(), category: 'Technology',
    },
  ],
  tickets: [],
  service_bookings: [],
};

function chainable(table: string): any {
  const state: { filters: Array<[string, any]> } = { filters: [] };
  const api: any = {
    select: () => api,
    eq: (k: string, v: any) => { state.filters.push([k, v]); return api; },
    is: () => api,
    order: () => api,
    limit: (n: number) => resolve(n),
    single: () => resolveSingle(),
    maybeSingle: () => resolveSingle(),
    then: (resolveFn: any) => resolve().then(resolveFn),
  };
  function applyFilters(rows: Row[]) {
    return rows.filter((r) => state.filters.every(([k, v]) => r[k] === v));
  }
  function resolve(limit?: number) {
    let rows = applyFilters(FIXTURES[table] || []);
    if (limit) rows = rows.slice(0, limit);
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

export const supabase = {
  from: (table: string) => chainable(table),
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  rpc: async () => ({ data: null, error: null }),
  channel: () => ({ on: () => ({ subscribe: () => {} }), subscribe: () => {} }),
  removeChannel: () => {},
} as any;
