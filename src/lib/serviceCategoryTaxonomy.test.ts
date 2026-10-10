import { describe, it, expect, vi } from 'vitest';
import {
  SERVICE_CATEGORIES, categoryAccents, CATEGORY_ICONS, LEGACY_CATEGORY_ALIASES,
  CATEGORY_SPECIALTY_SUGGESTIONS,
} from './servicesDesignTokens';

// Batch 2 (Services marketplace redesign): the approved prototype's
// 12-category taxonomy replaces the earlier 10-category starting list.
// These are static-shape tests (no network) covering the taxonomy data
// itself and the alias map that keeps the one real, already-approved
// provider (registered under the OLD taxonomy) visible under the new one
// -- see LEGACY_CATEGORY_ALIASES's own comment for why this exists.

const APPROVED_12 = [
  'Entertainment & Talent',
  'Photography & Videography',
  'Beauty & Styling',
  'Event Planning & Decoration',
  'Food, Drinks & Catering',
  'Event Equipment & Production',
  'Venues & Spaces',
  'Transport & Logistics',
  'Fashion & Custom Design',
  'Event Support & Professional Services',
  'Marketing & Creative Services',
  'Celebrations & Special Occasions',
];

describe('Services taxonomy: the approved 12 categories', () => {
  it('SERVICE_CATEGORIES is exactly the 12 approved categories, in the prototype order', () => {
    expect(SERVICE_CATEGORIES.length).toBe(12);
    expect([...SERVICE_CATEGORIES]).toEqual(APPROVED_12);
  });

  it('every category has an accent color and an icon', () => {
    for (const cat of SERVICE_CATEGORIES) {
      expect(categoryAccents[cat]).toBeTruthy();
      expect(CATEGORY_ICONS[cat]).toBeTruthy();
    }
  });

  it('every category has at least one specialty suggestion', () => {
    for (const cat of SERVICE_CATEGORIES) {
      expect(CATEGORY_SPECIALTY_SUGGESTIONS[cat]?.length).toBeGreaterThan(0);
    }
  });

  it('none of the OLD 10-category names are themselves in the new list (a real swap, not an addition)', () => {
    const old = ['Beauty & Grooming', 'Weddings', 'Events', 'Photography', 'Fashion', 'Home Services', 'Catering & Food', 'Entertainment', 'Decor & Design', 'Transportation'];
    for (const o of old) expect(SERVICE_CATEGORIES as readonly string[]).not.toContain(o);
  });
});

describe('LEGACY_CATEGORY_ALIASES: keeps real old-taxonomy providers visible', () => {
  it('maps every old category name to exactly one new category', () => {
    const allAliases = Object.values(LEGACY_CATEGORY_ALIASES).flat();
    const old = ['Beauty & Grooming', 'Weddings', 'Events', 'Decor & Design', 'Photography', 'Fashion', 'Catering & Food', 'Entertainment', 'Transportation', 'Home Services'];
    for (const o of old) expect(allAliases).toContain(o);
  });

  it('every alias key is itself one of the 12 approved categories', () => {
    for (const key of Object.keys(LEGACY_CATEGORY_ALIASES)) {
      expect(SERVICE_CATEGORIES as readonly string[]).toContain(key);
    }
  });
});

// A thenable chain stub that supports every builder method
// fetchApprovedServiceProviders' main `service_providers` query chains
// (.select/.eq/.order/.in/.limit), always resolving to an empty result --
// only the service_provider_categories lookup's own `.in` call is actually
// asserted on in these tests.
function makeProvidersChain() {
  const chain: any = { data: [], error: null };
  for (const m of ['select', 'eq', 'order', 'in', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve);
  return chain;
}

describe('fetchApprovedServiceProviders: category filter expands through aliases (real data, not cosmetic)', () => {
  it('queries service_provider_categories with the alias-expanded list, not just the literal category passed in', async () => {
    const inSpy = vi.fn(() => Promise.resolve({ data: [{ provider_id: 'p1' }], error: null }));
    vi.doMock('./supabase', () => ({
      supabase: {
        from: (table: string) => {
          if (table === 'service_provider_categories') return { select: () => ({ in: inSpy }) };
          return makeProvidersChain();
        },
      },
    }));
    vi.resetModules();
    const { fetchApprovedServiceProviders } = await import('./serviceProviders');

    await fetchApprovedServiceProviders({ category: 'Beauty & Styling' });

    expect(inSpy).toHaveBeenCalledWith('category', ['Beauty & Styling', 'Beauty & Grooming']);
  });

  it('a category with no legacy alias queries only itself', async () => {
    const inSpy = vi.fn(() => Promise.resolve({ data: [], error: null }));
    vi.doMock('./supabase', () => ({
      supabase: {
        from: (table: string) => {
          if (table === 'service_provider_categories') return { select: () => ({ in: inSpy }) };
          return makeProvidersChain();
        },
      },
    }));
    vi.resetModules();
    const { fetchApprovedServiceProviders } = await import('./serviceProviders');

    await fetchApprovedServiceProviders({ category: 'Venues & Spaces' });

    expect(inSpy).toHaveBeenCalledWith('category', ['Venues & Spaces']);
  });
});
