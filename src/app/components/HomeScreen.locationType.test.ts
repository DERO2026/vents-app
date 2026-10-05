import { describe, it, expect, vi } from 'vitest';

// HomeScreen.tsx imports the real supabase client at module scope, which
// throws outside a browser env with VITE_SUPABASE_URL set -- mapDbEventToFrontend
// itself is a pure function and never touches supabase, so stub the module
// just to let the import succeed.
vi.mock('../../lib/supabase', () => ({ supabase: {} }));

import { mapDbEventToFrontend } from './HomeScreen';

// Online is a first-class location_type (migration 0155), not inferred from
// a magic address string -- these are the regression cases the product
// spec calls out explicitly: an online event must map through with null
// lat/lng intact (never a fabricated coordinate) and location_type carried
// over so the UI can decide what to render, while an in-person event keeps
// behaving exactly as it did before this column existed.
function baseDbEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    title: 'Test Event',
    category: 'music',
    event_date: '2026-01-01T18:00:00Z',
    start_time: '18:00',
    end_time: null,
    location: 'Eko Hotel, Lagos, Lagos',
    country: 'NG',
    price: 0,
    image_url: '',
    gallery_urls: [],
    description: '',
    ticket_types: [],
    ticket_goal: 100,
    bookings_count: 0,
    saves_count: 0,
    ...overrides,
  };
}

describe('mapDbEventToFrontend location_type regression', () => {
  it('defaults an in-person event (no location_type column value) to in_person', () => {
    const evt = mapDbEventToFrontend(baseDbEvent({ latitude: 6.43, longitude: 3.42 }));
    expect(evt.locationType).toBe('in_person');
    expect(evt.latitude).toBe(6.43);
    expect(evt.longitude).toBe(3.42);
  });

  it('maps a pure online event with null lat/lng without fabricating coordinates', () => {
    const evt = mapDbEventToFrontend(baseDbEvent({
      location_type: 'online',
      location: 'Online',
      latitude: null,
      longitude: null,
    }));
    expect(evt.locationType).toBe('online');
    expect(evt.latitude).toBeNull();
    expect(evt.longitude).toBeNull();
  });

  it('maps a hybrid event, preserving the physical venue/coordinates', () => {
    const evt = mapDbEventToFrontend(baseDbEvent({
      location_type: 'hybrid',
      latitude: 6.43,
      longitude: 3.42,
    }));
    expect(evt.locationType).toBe('hybrid');
    expect(evt.venue).toBe('Eko Hotel');
    expect(evt.latitude).toBe(6.43);
    expect(evt.longitude).toBe(3.42);
  });
});
