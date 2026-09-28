import { useEffect, useState } from 'react';
import { Bookmark, MapPin, Calendar, ArrowLeft } from 'lucide-react';
import { Event, ServiceProvider } from './types';
import { formatPriceRange } from './data';
import { mapDbEventToFrontend } from './HomeScreen';
import { supabase } from '../../lib/supabase';
import { Sentry } from '../../lib/sentry';
import { fetchServiceProvidersByIds } from '../../lib/serviceProviders';
import { ServiceProviderCompactCard } from './ServiceProviderCard';

interface SavedScreenProps {
  savedEventIds: string[];
  onEventPress: (event: Event) => void;
  onToggleSave: (id: string) => void;
  dbEvents: Event[];
  onBack?: () => void;
  // Saved service providers -- optional so any caller that hasn't been
  // updated yet still renders (just without the Services tab) rather than
  // crashing on a missing required prop.
  // Unsaving a provider happens from its own profile screen's bookmark
  // toggle (the same affordance used to save it) rather than a second,
  // duplicate control here.
  savedProviderIds?: string[];
  onProviderPress?: (provider: ServiceProvider) => void;
}

// Deliberately queries by the full savedEventIds list rather than filtering
// dbEvents — dbEvents is only the currently-loaded, paginated home feed
// (20 events at a time), so an event saved beyond that first page used to
// vanish from this screen entirely (a primary nav tab showing "0 events
// saved" for a user who had, in fact, saved events). Falls back to
// whatever's already in dbEvents for instant paint, then replaces it with
// the authoritative fetch.
export function SavedScreen({ savedEventIds, onEventPress, onToggleSave, dbEvents, onBack, savedProviderIds = [], onProviderPress }: SavedScreenProps) {
  const [savedEvents, setSavedEvents] = useState<Event[]>(() => dbEvents.filter((e) => savedEventIds.includes(e.id)));
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'events' | 'services'>('events');
  const [savedProviders, setSavedProviders] = useState<ServiceProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchSavedProviders() {
      if (savedProviderIds.length === 0) {
        if (!cancelled) { setSavedProviders([]); setProvidersLoading(false); }
        return;
      }
      setProvidersLoading(true);
      try {
        const fetched = await fetchServiceProvidersByIds(savedProviderIds);
        if (cancelled) return;
        const byId = new Map(fetched.map((p) => [p.id, p]));
        setSavedProviders(savedProviderIds.map((id) => byId.get(id)).filter((p): p is ServiceProvider => !!p));
      } catch (err) {
        console.error('Failed to fetch saved service providers:', err);
        Sentry.captureException(err);
      } finally {
        if (!cancelled) setProvidersLoading(false);
      }
    }
    fetchSavedProviders();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedProviderIds.join(',')]);

  useEffect(() => {
    let cancelled = false;

    async function fetchSavedEvents() {
      if (savedEventIds.length === 0) {
        if (!cancelled) { setSavedEvents([]); setLoading(false); }
        return;
      }
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('events')
          .select('*, users!events_organizer_id_fkey(username, full_name, vc_badge)')
          .in('id', savedEventIds)
          .eq('hidden_by_admin', false)
          .is('deleted_at', null);

        if (error) throw error;
        if (cancelled) return;

        const mapped = (data || []).map((e: any) => {
          const orgUser = e.users;
          return mapDbEventToFrontend({
            ...e,
            organizer_name: orgUser?.username || orgUser?.full_name || null,
            organizer_vc_badge: orgUser?.vc_badge || null,
          });
        });
        // Preserve save order (most-recently-saved first isn't tracked here,
        // so keep savedEventIds' order, which the caller controls).
        const byId = new Map(mapped.map((e) => [e.id, e]));
        setSavedEvents(savedEventIds.map((id) => byId.get(id)).filter((e): e is Event => !!e));
      } catch (err) {
        console.error('Failed to fetch saved events:', err);
        Sentry.captureException(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchSavedEvents();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedEventIds.join(',')]);

  return (
    <div className="flex flex-col h-full" style={{ background: '#020005' }}>
      {/* Header */}
      <div className="px-4 pb-4" style={{ paddingTop: 'calc(20px + env(safe-area-inset-top))' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '2px' }}>
          {onBack && (
            <button
              onClick={onBack}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
              aria-label="Go back"
            >
              <ArrowLeft size={22} color="#A78BFA" />
            </button>
          )}
          <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 800, fontFamily: 'Manrope, sans-serif', margin: 0 }}>
            Saved
          </h1>
        </div>
        <p style={{ color: '#8B8FA8', fontSize: '13px', marginBottom: '12px' }}>
          {tab === 'events'
            ? `${savedEvents.length} event${savedEvents.length !== 1 ? 's' : ''} saved`
            : `${savedProviders.length} provider${savedProviders.length !== 1 ? 's' : ''} saved`}
        </p>
        {onProviderPress && (
          <div style={{ display: 'flex', gap: '8px' }}>
            {(['events', 'services'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  padding: '6px 14px', borderRadius: '999px', border: 'none', cursor: 'pointer',
                  fontWeight: 700, fontSize: '12px',
                  background: tab === t ? 'rgba(167,139,250,0.18)' : 'rgba(255,255,255,0.05)',
                  color: tab === t ? '#A78BFA' : '#8B8FA8',
                }}
              >
                {t === 'events' ? 'Events' : 'Services'}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4" style={{ scrollbarWidth: 'none', paddingBottom: 'calc(96px + env(safe-area-inset-bottom))' }}>
        {tab === 'services' ? (
          providersLoading && savedProviders.length === 0 && savedProviderIds.length > 0 ? (
            <div className="flex flex-col items-center justify-center h-full pb-20">
              <p style={{ color: '#8B8FA8', fontSize: '14px' }}>Loading saved services…</p>
            </div>
          ) : savedProviders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full pb-20">
              <div className="w-20 h-20 rounded-full flex items-center justify-center mb-4" style={{ background: '#090514' }}>
                <Bookmark size={36} color="#2A2D3E" strokeWidth={1.5} />
              </div>
              <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700 }}>No saved services</p>
              <p style={{ color: '#8B8FA8', fontSize: '14px', marginTop: '4px', textAlign: 'center' }}>
                Tap the bookmark icon on any provider's profile to save it here
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              {savedProviders.map((provider) => (
                <ServiceProviderCompactCard key={provider.id} provider={provider} onPress={onProviderPress!} />
              ))}
            </div>
          )
        ) : loading && savedEvents.length === 0 && savedEventIds.length > 0 ? (
          <div className="flex flex-col items-center justify-center h-full pb-20">
            <p style={{ color: '#8B8FA8', fontSize: '14px' }}>Loading saved events…</p>
          </div>
        ) : savedEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full pb-20">
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center mb-4"
              style={{ background: '#090514' }}
            >
              <Bookmark size={36} color="#2A2D3E" strokeWidth={1.5} />
            </div>
            <p style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 700 }}>No saved events</p>
            <p style={{ color: '#8B8FA8', fontSize: '14px', marginTop: '4px', textAlign: 'center' }}>
              Tap the bookmark icon on any event to save it here
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {savedEvents.map((event) => (
              <div
                key={event.id}
                onClick={() => onEventPress(event)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEventPress(event); } }}
                role="button" tabIndex={0}
                className="flex gap-3 cursor-pointer active:opacity-90 p-3"
                style={{
                  background: '#090514',
                  borderRadius: '16px',
                  border: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <div className="relative flex-shrink-0">
                  <img
                    src={event.image}
                    alt={event.title}
                    className="object-cover"
                    style={{ width: '90px', height: '90px', borderRadius: '12px' }}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between">
                    <span
                      style={{
                        fontSize: '10px',
                        color: '#A78BFA',
                        background: 'rgba(167,139,250,0.1)',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontWeight: 600,
                      }}
                    >
                      {event.category}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleSave(event.id);
                      }}
                      className="ml-2"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      aria-label="Remove from saved"
                    >
                      <Bookmark size={16} color="#A78BFA" fill="#A78BFA" />
                    </button>
                  </div>
                  <h3
                    style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, lineHeight: 1.3 }}
                    className="mt-1 mb-1 truncate"
                  >
                    {event.title}
                  </h3>
                  <div className="flex items-center gap-1 mb-0.5">
                    <Calendar size={10} color="#8B8FA8" />
                    <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{event.date}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <MapPin size={10} color="#8B8FA8" />
                      <span style={{ color: '#8B8FA8', fontSize: '11px' }}>{event.city}</span>
                    </div>
                    <span style={{ color: event.price === 0 ? '#06D6A0' : '#FFB830', fontSize: '13px', fontWeight: 700, width: 'fit-content' }}>
                      {formatPriceRange(event.ticketTypes)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
