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
    country: row.country || '',
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
  'id, user_id, business_name, category, description, location, country, photo_urls, starting_price, starting_price_currency, services_offered, offers_home_service, offers_delivery, offers_same_day, status, created_at, updated_at';

// "Providers near you" / category browsing: public discovery, RLS already
// restricts this to status='approved' rows for anon/authenticated (see
// service_providers_public_select_approved, 0034). Ordered by created_at
// DESC -- v1 has no real ranking signal, per the approved decision to not
// imply paid/algorithmic featuring.
//
// `country` filters on the structured ISO 3166-1 alpha-2 column
// (0036_service_providers_country.sql), not the free-text `location`
// field. A listing saved with country = '' (predates the column, or
// onboarding hasn't set it yet) never matches a real ISO code, so it's
// naturally excluded from a country-scoped query -- not shown with a
// guessed country.
export async function fetchApprovedServiceProviders(opts: {
  category?: string;
  country?: string;
  limit?: number;
} = {}): Promise<ServiceProvider[]> {
  let query = supabase
    .from('service_providers')
    .select(SERVICE_PROVIDER_COLUMNS)
    .eq('status', 'approved')
    .order('created_at', { ascending: false });

  if (opts.category) {
    // A provider can offer multiple categories (service_provider_categories,
    // 0054) -- matching only service_providers.category (the primary one)
    // would hide a provider under every category EXCEPT the first one they
    // picked. Resolve the full set of matching provider ids first, then
    // filter on that, so a provider appears under every category they
    // actually selected.
    const { data: catRows, error: catError } = await supabase
      .from('service_provider_categories')
      .select('provider_id')
      .eq('category', opts.category);
    if (catError) throw catError;
    const providerIds = (catRows || []).map((r: any) => r.provider_id);
    if (providerIds.length === 0) return [];
    query = query.in('id', providerIds);
  }
  if (opts.country) query = query.eq('country', opts.country);
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

// The signed-in user's own listing, regardless of status -- used by
// ProfileScreen (to decide "Set Up" vs "Edit") and the setup screen (to
// prefill an edit). Relies on service_providers_select_own (0034); RLS
// already restricts this to the caller's own row.
export async function fetchOwnServiceProvider(userId: string): Promise<ServiceProvider | null> {
  const { data, error } = await supabase
    .from('service_providers')
    .select(SERVICE_PROVIDER_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapDbServiceProviderToFrontend(data) : null;
}

export interface ServiceProviderInput {
  businessName: string;
  category: string;
  description: string;
  location: string;
  country: string;
  photoUrls: string[];
  startingPrice: number | null;
  startingPriceCurrency: string | null;
  servicesOffered: string[];
  offersHomeService: boolean;
  offersDelivery: boolean;
  offersSameDay: boolean;
}

// Create-or-update the caller's own listing and publish it directly
// (status='approved') -- per the approved v1 decision, there is no
// separate admin listing-review queue; the capability gate
// (users.is_service_provider, enforced by RLS on this table) is the only
// approval step. Relies on the UNIQUE(user_id) constraint (0034) for the
// upsert's conflict target -- one listing per account.
export async function saveAndPublishServiceProvider(userId: string, input: ServiceProviderInput): Promise<ServiceProvider> {
  const { data, error } = await supabase
    .from('service_providers')
    .upsert(
      {
        user_id: userId,
        business_name: input.businessName,
        category: input.category,
        description: input.description || null,
        location: input.location || null,
        country: input.country,
        photo_urls: input.photoUrls,
        starting_price: input.startingPrice,
        starting_price_currency: input.startingPriceCurrency,
        services_offered: input.servicesOffered,
        offers_home_service: input.offersHomeService,
        offers_delivery: input.offersDelivery,
        offers_same_day: input.offersSameDay,
        status: 'approved',
      },
      { onConflict: 'user_id' }
    )
    .select(SERVICE_PROVIDER_COLUMNS)
    .single();
  if (error) throw error;
  return mapDbServiceProviderToFrontend(data);
}
