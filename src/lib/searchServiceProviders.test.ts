import { describe, it, expect, vi, afterEach } from 'vitest';

// Real server-side search for Services -- the previous "search" was a
// client-side .filter() over whatever ~20 rows the near-you discovery
// effect happened to have already fetched (country/GPS-capped), so a real
// provider outside that small batch could never be found no matter what
// was typed. This tests the actual Supabase query this function builds:
// it must run a case-insensitive substring match against the real columns
// (business_name, category, description, location) plus an exact-element
// match against services_offered, scoped to status='approved', and must
// escape ILIKE/`.or()` special characters so a provider name or search
// term containing `%`, `_`, or `,` can't corrupt the query.

const calls: Record<string, any[]> = {};
function makeQueryBuilder(resolved: { data: any[] | null; error: any }) {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn((...args: any[]) => { (calls.eq ??= []).push(args); return builder; }),
    or: vi.fn((...args: any[]) => { (calls.or ??= []).push(args); return builder; }),
    order: vi.fn((...args: any[]) => { (calls.order ??= []).push(args); return builder; }),
    limit: vi.fn((...args: any[]) => { (calls.limit ??= []).push(args); return builder; }),
    then: (resolve: any) => Promise.resolve(resolved).then(resolve),
  };
  return builder;
}

let fromImpl = (_table: string) => makeQueryBuilder({ data: [], error: null });
vi.mock('./supabase', () => ({
  supabase: { from: (table: string) => fromImpl(table) },
}));

afterEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  vi.resetModules();
});

describe('searchServiceProviders', () => {
  it('returns [] immediately for an empty/whitespace query, without ever calling Supabase', async () => {
    const { searchServiceProviders } = await import('./serviceProviders');
    let called = false;
    fromImpl = () => { called = true; return makeQueryBuilder({ data: [], error: null }); };
    const result = await searchServiceProviders({ query: '   ' });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('searches business_name, category, description, location (ILIKE) and services_offered (contains), scoped to status=approved', async () => {
    fromImpl = () => makeQueryBuilder({ data: [], error: null });
    const { searchServiceProviders } = await import('./serviceProviders');
    await searchServiceProviders({ query: 'mc', country: 'NG' });

    expect(calls.eq[0]).toEqual(['status', 'approved']);
    expect(calls.eq[1]).toEqual(['country', 'NG']);
    const orExpr = calls.or[0][0] as string;
    expect(orExpr).toContain('business_name.ilike.%mc%');
    expect(orExpr).toContain('category.ilike.%mc%');
    expect(orExpr).toContain('description.ilike.%mc%');
    expect(orExpr).toContain('location.ilike.%mc%');
    expect(orExpr).toContain('services_offered.cs.{mc}');
    expect(calls.limit[0]).toEqual([30]);
  });

  it('is case-insensitive and whitespace-tolerant by construction (passes the raw ILIKE pattern through, trims the query)', async () => {
    fromImpl = () => makeQueryBuilder({ data: [], error: null });
    const { searchServiceProviders } = await import('./serviceProviders');
    await searchServiceProviders({ query: '  Wedding MC  ' });
    const orExpr = calls.or[0][0] as string;
    expect(orExpr).toContain('business_name.ilike.%Wedding MC%');
  });

  it('escapes %, _ and , so a search term or provider name containing them cannot corrupt the query', async () => {
    fromImpl = () => makeQueryBuilder({ data: [], error: null });
    const { searchServiceProviders } = await import('./serviceProviders');
    await searchServiceProviders({ query: '50%_off,deals' });
    const orExpr = calls.or[0][0] as string;
    expect(orExpr).toContain('business_name.ilike.%50\\%\\_off\\,deals%');
    // No unescaped comma that would terminate the .or() clause early.
    expect(orExpr.split('business_name.ilike.')[1].startsWith('%50\\%\\_off\\,deals%')).toBe(true);
  });

  it('maps real rows back to the frontend ServiceProvider shape, including partial-match results', async () => {
    const row = {
      id: 'p1', user_id: 'u1', business_name: 'DJ Mc Real', category: 'Entertainment & Talent',
      description: null, location: null, latitude: null, longitude: null, country: 'NG',
      photo_urls: [], starting_price: null, starting_price_currency: null, services_offered: [],
      offers_home_service: false, offers_delivery: false, offers_same_day: false,
      status: 'approved', created_at: '2026-01-01', updated_at: '2026-01-01',
    };
    fromImpl = () => makeQueryBuilder({ data: [row], error: null });
    const { searchServiceProviders } = await import('./serviceProviders');
    const result = await searchServiceProviders({ query: 'mc' });
    expect(result).toHaveLength(1);
    expect(result[0].businessName).toBe('DJ Mc Real');
    expect(result[0].id).toBe('p1');
  });

  it('propagates a real Supabase error instead of silently returning an empty list', async () => {
    fromImpl = () => makeQueryBuilder({ data: null, error: new Error('network down') });
    const { searchServiceProviders } = await import('./serviceProviders');
    await expect(searchServiceProviders({ query: 'mc' })).rejects.toThrow('network down');
  });
});
