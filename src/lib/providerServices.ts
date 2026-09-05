// Data-layer helpers for the provider service catalog (Stage 2 of Services,
// supabase/migrations/0048_provider_services.sql). Mirrors serviceProviders.ts's
// own plain-mapper convention -- no React here, reusable from the provider's
// own management screen and the public provider profile alike.

import { supabase } from './supabase';
import { ProviderService } from '../app/components/types';

export function mapDbProviderServiceToFrontend(row: any): ProviderService {
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    description: row.description ?? null,
    price: row.price,
    currency: row.currency,
    durationMinutes: row.duration_minutes ?? null,
    category: row.category ?? null,
    isActive: row.is_active === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROVIDER_SERVICE_COLUMNS =
  'id, provider_id, name, description, price, currency, duration_minutes, category, is_active, created_at, updated_at';

// Public provider profile: RLS already restricts this to is_active=true
// rows under an approved listing (provider_services_public_select, 0048) --
// no separate "is this provider approved" check needed here, same as
// fetchApprovedServiceProviders relying on service_providers' own policy.
export async function fetchActiveServicesForProvider(providerId: string): Promise<ProviderService[]> {
  const { data, error } = await supabase
    .from('provider_services')
    .select(PROVIDER_SERVICE_COLUMNS)
    .eq('provider_id', providerId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapDbProviderServiceToFrontend);
}

// Provider's own management screen: every service under their listing
// regardless of active status. RLS (provider_services_select_own) already
// restricts this to the caller's own provider_id.
export async function fetchOwnServicesForProvider(providerId: string): Promise<ProviderService[]> {
  const { data, error } = await supabase
    .from('provider_services')
    .select(PROVIDER_SERVICE_COLUMNS)
    .eq('provider_id', providerId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapDbProviderServiceToFrontend);
}

export interface ProviderServiceInput {
  name: string;
  description: string;
  price: number;
  currency: string;
  durationMinutes: number | null;
  category: string;
  isActive: boolean;
}

export async function createProviderService(providerId: string, input: ProviderServiceInput): Promise<ProviderService> {
  const { data, error } = await supabase
    .from('provider_services')
    .insert({
      provider_id: providerId,
      name: input.name,
      description: input.description || null,
      price: input.price,
      currency: input.currency,
      duration_minutes: input.durationMinutes,
      category: input.category || null,
      is_active: input.isActive,
    })
    .select(PROVIDER_SERVICE_COLUMNS)
    .single();
  if (error) throw error;
  return mapDbProviderServiceToFrontend(data);
}

export async function updateProviderService(serviceId: string, input: ProviderServiceInput): Promise<ProviderService> {
  const { data, error } = await supabase
    .from('provider_services')
    .update({
      name: input.name,
      description: input.description || null,
      price: input.price,
      currency: input.currency,
      duration_minutes: input.durationMinutes,
      category: input.category || null,
      is_active: input.isActive,
    })
    .eq('id', serviceId)
    .select(PROVIDER_SERVICE_COLUMNS)
    .single();
  if (error) throw error;
  return mapDbProviderServiceToFrontend(data);
}

export async function setProviderServiceActive(serviceId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase
    .from('provider_services')
    .update({ is_active: isActive })
    .eq('id', serviceId);
  if (error) throw error;
}

export async function deleteProviderService(serviceId: string): Promise<void> {
  const { error } = await supabase
    .from('provider_services')
    .delete()
    .eq('id', serviceId);
  if (error) throw error;
}
