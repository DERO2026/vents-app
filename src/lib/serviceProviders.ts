// Data-layer helpers for the Services discovery UI (Stage 2). Mirrors the
// mapDbEventToFrontend convention (HomeScreen.tsx) -- a plain mapper from
// the raw Supabase row shape to the camelCase ServiceProvider type in
// types.ts, kept separate from any React component so it can be reused by
// the home/category/profile screens without duplication.

import { supabase } from './supabase';
import { ServiceProvider } from '../app/components/types';

export function mapDbServiceProviderToFrontend(row: any): ServiceProvider {
  return {
    id: row.id,
    userId: row.user_id,
    businessName: row.business_name,
    category: row.category,
    description: row.description ?? null,
    location: row.location ?? null,
    photoUrls: row.photo_urls || [],
    startingPrice: row.starting_price ?? null,
    startingPriceCurrency: row.starting_price_currency ?? null,
    servicesOffered: row.services_offered || [],
    offersHomeService: row.offers_home_service === true,
    offersDelivery: row.offers_delivery === true,
    offersSameDay: row.offers_same_day === true,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SERVICE_PROVIDER_COLUMNS =
  'id, user_id, business_name, category, description, location, photo_urls, starting_price, starting_price_currency, services_offered, offers_home_service, offers_delivery, offers_same_day, status, created_at, updated_at';

// "Providers near you" / category browsing: public discovery, RLS already
// restricts this to status='approved' rows for anon/authenticated (see
// service_providers_public_select_approved, 0034). Ordered by created_at
// DESC -- v1 has no real ranking signal, per the approved decision to not
// imply paid/algorithmic featuring.
export async function fetchApprovedServiceProviders(opts: {
  category?: string;
  limit?: number;
} = {}): Promise<ServiceProvider[]> {
  let query = supabase
    .from('service_providers')
    .select(SERVICE_PROVIDER_COLUMNS)
    .eq('status', 'approved')
    .order('created_at', { ascending: false });

  if (opts.category) query = query.eq('category', opts.category);
  if (opts.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(mapDbServiceProviderToFrontend);
}

export async function fetchServiceProviderById(id: string): Promise<ServiceProvider | null> {
  const { data, error } = await supabase
    .from('service_providers')
    .select(SERVICE_PROVIDER_COLUMNS)
    .eq('id', id)
    .eq('status', 'approved')
    .maybeSingle();
  if (error) throw error;
  return data ? mapDbServiceProviderToFrontend(data) : null;
}

// Best-effort discovery-country filter. service_providers has no
// structured country column in the v1 schema (0034_service_providers.sql
// only has a free-text `location`) -- adding one is schema work, out of
// scope for the discovery-UI-only stage this function belongs to. Until a
// structured field exists, this does a simple case-insensitive substring
// match against `location`, which will legitimately return zero results
// for most (provider, country) pairs -- that's expected and handled by
// the "no providers in this country yet" empty state, not a bug to hide.
export function filterProvidersByCountryName(providers: ServiceProvider[], countryName: string): ServiceProvider[] {
  const q = countryName.trim().toLowerCase();
  if (!q) return providers;
  return providers.filter((p) => (p.location || '').toLowerCase().includes(q));
}
