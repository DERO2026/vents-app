import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { MapPin, Navigation } from 'lucide-react';
import { loadGoogleMaps } from '../../lib/googleMaps';
import { SecondaryButton } from './shared/Button';
import { Sentry } from '../../lib/sentry';
import { buildMapEmbedUrl, listenToMapEmbed, shouldUseMapEmbed } from '../../lib/mapEmbed';

interface EventMapProps {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  venue: string;
  address: string;
  onGetDirections: () => void;
}

// A valid Nigerian event coordinate is never exactly (0, 0) — that's
// "null island", off the coast of West Africa, and only ever shows up from
// a failed/placeholder geocode that got stored as zeros instead of null.
// Treating it as "no location" avoids ever centering a live map on the
// open ocean.
function isValidCoordinate(lat: number | null | undefined, lng: number | null | undefined): lat is number {
  return typeof lat === 'number' && typeof lng === 'number'
    && Number.isFinite(lat) && Number.isFinite(lng)
    && !(lat === 0 && lng === 0);
}

// Production embedded map for the event details page (Prompt 4). Reuses
// the same loadGoogleMaps() singleton LocationPicker already uses, so an
// organizer who just picked a location and a browsing user viewing an
// event never load the Maps script twice in the same session. Renders a
// live, pannable/zoomable google.maps.Map with a marker + info window —
// never a blank screen: a loading skeleton while the script loads, and a
// clear non-map fallback (never an empty box) when the event has no valid
// coordinates at all.
export function EventMap({ latitude, longitude, venue, address, onGetDirections }: EventMapProps) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const hasCoords = isValidCoordinate(latitude, longitude);
  // iOS-only: render the real-origin HTTPS iframe embed instead of calling
  // loadGoogleMaps() directly — see src/lib/mapEmbed.ts. Android and web are
  // completely unaffected; both branches below only ever run on iOS native.
  const useEmbed = shouldUseMapEmbed();

  useEffect(() => {
    if (useEmbed) return; // handled by the postMessage listener effect below
    if (!hasCoords) return; // nothing to load a map for — fallback UI handles this
    let cancelled = false;
    loadGoogleMaps()
      .then(() => { if (!cancelled) setStatus('ready'); })
      .catch((e) => {
        console.error('Event map unavailable:', e);
        Sentry.captureException(e);
        if (!cancelled) setStatus('unavailable');
      });
    return () => { cancelled = true; };
  }, [hasCoords, useEmbed]);

  // iOS embed path: the map itself is rendered by embed/map.html inside the
  // iframe below (see the return block) — this effect only listens for its
  // ready/error signal to drive the exact same `status` state machine the
  // direct-Maps-JS path above uses, so the loading/ready/unavailable UI
  // stays identical regardless of platform.
  useEffect(() => {
    if (!useEmbed || !hasCoords) return;
    return listenToMapEmbed((msg) => {
      if (msg.type === 'vents:ready') {
        setStatus('ready');
      } else if (msg.type === 'vents:authFailure' || msg.type === 'vents:error') {
        const err = new Error(msg.type === 'vents:authFailure'
          ? 'Google Maps authentication failed inside the iOS map embed.'
          : msg.message);
        console.error('Event map unavailable (iOS embed):', err);
        Sentry.captureException(err);
        setStatus('unavailable');
      }
    });
  }, [useEmbed, hasCoords]);

  useEffect(() => {
    if (useEmbed) return; // iframe renders its own map — see embed/map.html
    if (status !== 'ready' || !mapDivRef.current || !hasCoords || mapRef.current) return;
    const google = (window as any).google;
    const pos = { lat: latitude as number, lng: longitude as number };
    const map = new google.maps.Map(mapDivRef.current, {
      center: pos,
      zoom: 15,
      // Deliberately NOT disableDefaultUI — Prompt 4 requires real pan/zoom,
      // so the standard touch/scroll/pinch controls stay enabled.
      zoomControl: true,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
      gestureHandling: 'cooperative', // avoids hijacking page scroll on mobile
    });
    mapRef.current = map;

    const marker = new google.maps.Marker({ position: pos, map, title: venue || address });

    if (venue || address) {
      const info = new google.maps.InfoWindow({
        content: `<div style="font-family:Inter,sans-serif;font-size:13px;max-width:200px;">
          ${venue ? `<strong>${escapeHtml(venue)}</strong><br/>` : ''}
          ${address ? `<span style="color:#555">${escapeHtml(address)}</span>` : ''}
        </div>`,
      });
      marker.addListener('click', () => info.open({ map, anchor: marker }));
      // Open once by default so the venue name is visible without an extra tap.
      info.open({ map, anchor: marker });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, hasCoords]);

  if (!hasCoords) {
    // Graceful fallback for a missing/invalid location — never a blank map
    // box. Still gives the user the address text and a working directions
    // action (openMap's provider-choice modal, same as before).
    return (
      <div
        style={{
          height: '140px',
          borderRadius: '14px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px dashed rgba(255,255,255,0.1)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          textAlign: 'center',
          padding: '12px',
        }}
      >
        <MapPin size={20} color="#555C7A" />
        <span style={{ color: '#8B8FA8', fontSize: '12px' }}>
          Map preview unavailable for this event's location.
        </span>
        {(venue || address) && (
          <button
            onClick={onGetDirections}
            style={{ background: 'rgba(168,85,247,0.12)', border: '1px solid rgba(168,85,247,0.25)', borderRadius: '8px', padding: '5px 12px', color: '#A78BFA', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
          >
            Search this address instead
          </button>
        )}
      </div>
    );
  }

  const mapBoxStyle: CSSProperties = {
    height: '160px',
    borderRadius: '14px',
    overflow: 'hidden',
    border: '1px solid rgba(255,255,255,0.08)',
    background: '#0B0B14',
  };

  return (
    <div>
      <div style={{ position: 'relative' }}>
        {useEmbed ? (
          <iframe
            title="Event location map"
            src={buildMapEmbedUrl({ mode: 'display', lat: latitude, lng: longitude, venue, address })}
            style={{ ...mapBoxStyle, width: '100%', border: 'none' }}
            // Least privilege: this frame never needs script-triggered
            // downloads, popups, top-level navigation, or forms — only the
            // ability to run its own scripts (to load Maps JS) and make
            // same-origin requests.
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <div ref={mapDivRef} style={mapBoxStyle} />
        )}
        {status !== 'ready' && (
          <div
            style={{
              position: 'absolute', inset: 0, borderRadius: '14px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#0B0B14', border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            {status === 'loading' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#555C7A', fontSize: '12px' }}>
                <span
                  style={{
                    width: '14px', height: '14px', borderRadius: '50%',
                    border: '2px solid rgba(85,92,122,0.3)', borderTopColor: '#A78BFA',
                    animation: 'eventMapSpin 0.8s linear infinite',
                  }}
                />
                Loading map…
              </div>
            ) : (
              <span style={{ color: '#8B8FA8', fontSize: '12px' }}>Map unavailable — tap Get Directions below.</span>
            )}
          </div>
        )}
        <style>{`@keyframes eventMapSpin { to { transform: rotate(360deg); } }`}</style>
      </div>
      <SecondaryButton onClick={onGetDirections} icon={<Navigation size={15} />} style={{ marginTop: '10px' }}>
        Get Directions
      </SecondaryButton>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
