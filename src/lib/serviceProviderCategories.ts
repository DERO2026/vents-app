// Data-layer helpers for a provider's full category set (Stage 3 of
// Services -- supabase/migrations/0054_service_bookings_marketplace.sql).
// service_providers.category (0034) remains the PRIMARY category and is
// untouched by anything here except through the RPC below, which keeps it
// in sync as categories[0] -- every existing single-category reader keeps
// working off that one column.

import { supabase } from './supabase';

export async function fetchServiceProviderCategories(providerId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('service_provider_categories')
    .select('category')
    .eq('provider_id', providerId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((r: any) => r.category);
}

// Atomically sets a provider's full category set (1-5 categories),
// re-deriving service_providers.category = categories[0] server-side --
// see set_service_provider_categories (0054) for the ownership/capability
// checks.
export async function setServiceProviderCategories(providerId: string, categories: string[]): Promise<void> {
  const { error } = await supabase.rpc('set_service_provider_categories', {
    p_provider_id: providerId,
    p_categories: categories,
  });
  if (error) throw error;
}
