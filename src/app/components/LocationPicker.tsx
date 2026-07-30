import { useEffect, useRef, useState } from 'react';
import { MapPin, Loader } from 'lucide-react';
import { loadGoogleMaps } from '../../lib/googleMaps';

export interface LocationValue {
  address: string;
  lat: number | null;
  lng: number | null;
}

const FALLBACK_INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  background: '#090514',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '12px',
  padding: '12px 14px',
  color: '#F0F0FF',
  fontSize: '14px',
  fontFamily: 'Inter, sans-serif',
  outline: 'none',
  boxSizing: 'border-box',
};

// Searchable address/venue picker for Nigerian locations, backed by Google's
// PlaceAutocompleteElement (google.maps.places.Autocomplete is blocked for
// API keys created after March 2025 — this project only has "Places API
// (New)" enabled, which the legacy widget does not work against). Falls back
// to a plain text input (still saved as address text, just without
// coordinates) if the Maps script fails to load — organizers must always be
// able to enter SOME address even if the API key is misconfigured or the
// network blocks Google.
export function LocationPicker({
  value,
  onChange,
  placeholder = 'Search for an address, venue, or landmark',
}: {
  value: LocationValue;
  onChange: (v: LocationValue) => void;
  placeholder?: string;
}) {
  const autocompleteContainerRef = useRef<HTMLDivElement>(null);
  const autocompleteElRef = useRef<any>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const geocoderRef = useRef<any>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [text, setText] = useState(value.address);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    setText(value.address);
  }, [value.address]);

  // Step 1: load the SDK. Only flips `status` — no DOM work here, since the
  // container this effect would need to mount into doesn't exist until AFTER
  // status is 'ready' triggers its render (chicken-and-egg otherwise).
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (!cancelled) setStatus('ready');
      })
      .catch((e) => {
        console.error('Location search unavailable:', e);
        if (!cancelled) setStatus('unavailable');
      });
    return () => { cancelled = true; };
  }, []);

  // Step 2: once `status === 'ready'`, the container div has rendered —
  // mount the autocomplete element into it exactly once.
  useEffect(() => {
    if (status !== 'ready' || !autocompleteContainerRef.current || autocompleteElRef.current) return;
    const google = (window as any).google;
    geocoderRef.current = new google.maps.Geocoder();

    const el = new google.maps.places.PlaceAutocompleteElement({
      includedRegionCodes: ['ng'],
    });
    el.placeholder = placeholder;
    if (valueRef.current.address) el.value = valueRef.current.address;
    autocompleteContainerRef.current.appendChild(el);
    autocompleteElRef.current = el;

    el.addEventListener('gmp-select', async (event: any) => {
      try {
        const prediction = event.placePrediction;
        const place = prediction.toPlace();
        await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
        const loc = place.location;
        const lat = loc ? loc.lat() : null;
        const lng = loc ? loc.lng() : null;
        const address = place.formattedAddress || place.displayName || '';
        setText(address);
        onChange({ address, lat, lng });
        if (lat != null && lng != null) placeMarker(lat, lng);
      } catch (err) {
        console.error('Failed to resolve selected place:', err);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    if (status !== 'ready' || !mapDivRef.current || mapRef.current) return;
    const google = (window as any).google;
    const start = value.lat != null && value.lng != null
      ? { lat: value.lat, lng: value.lng }
      : { lat: 6.5244, lng: 3.3792 }; // Lagos, sensible default center for Nigeria
    mapRef.current = new google.maps.Map(mapDivRef.current, {
      center: start,
      zoom: value.lat != null ? 15 : 6,
      disableDefaultUI: true,
      zoomControl: true,
    });
    if (value.lat != null && value.lng != null) placeMarker(value.lat, value.lng);
    mapRef.current.addListener('click', (e: any) => {
      const lat = e.latLng.lat();
      const lng = e.latLng.lng();
      placeMarker(lat, lng);
      reverseGeocode(lat, lng);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  function placeMarker(lat: number, lng: number) {
    const google = (window as any).google;
    if (!mapRef.current) return;
    const pos = { lat, lng };
    mapRef.current.panTo(pos);
    mapRef.current.setZoom(Math.max(mapRef.current.getZoom(), 15));
    if (markerRef.current) {
      markerRef.current.setPosition(pos);
    } else {
      // AdvancedMarkerElement requires a Map ID configured in Cloud Console
      // (extra setup this project doesn't have) — the classic Marker needs
      // no such config and isn't part of the March-2025 Places deprecation.
      markerRef.current = new google.maps.Marker({ position: pos, map: mapRef.current, draggable: true });
      markerRef.current.addListener('dragend', () => {
        const p = markerRef.current.getPosition();
        reverseGeocode(p.lat(), p.lng());
      });
    }
  }

  function reverseGeocode(lat: number, lng: number) {
    if (!geocoderRef.current) {
      onChange({ address: valueRef.current.address, lat, lng });
      return;
    }
    geocoderRef.current.geocode({ location: { lat, lng } }, (results: any[], geoStatus: string) => {
      const address = geoStatus === 'OK' && results?.[0] ? results[0].formatted_address : valueRef.current.address;
      setText(address);
      if (autocompleteElRef.current) autocompleteElRef.current.value = address;
      onChange({ address, lat, lng });
    });
  }

  return (
    <div>
      <style>{`
        gmp-place-autocomplete {
          --gmpx-color-surface: #090514;
          --gmpx-color-on-surface: #F0F0FF;
          --gmpx-color-on-surface-variant: #8B8FA8;
          --gmpx-color-primary: #A78BFA;
          --gmpx-font-family-base: Inter, sans-serif;
          width: 100%;
        }
      `}</style>
      <div style={{ position: 'relative' }}>
        <div ref={autocompleteContainerRef} style={{ width: '100%', display: status === 'ready' ? 'block' : 'none' }} />
        {status !== 'ready' && (
          <input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // Free-typed text with no place selected yet: keep any prior pin
              // but update the address string so the form still saves something.
              onChange({ address: e.target.value, lat: value.lat, lng: value.lng });
            }}
            placeholder={placeholder}
            style={{ ...FALLBACK_INPUT_STYLE, paddingRight: '38px' }}
          />
        )}
        {status !== 'ready' && (
          <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)' }}>
            {status === 'loading'
              ? <Loader size={15} color="#555C7A" className="animate-spin" />
              : <MapPin size={15} color={value.lat != null ? '#22D3EE' : '#555C7A'} />}
          </div>
        )}
      </div>

      {status === 'unavailable' && (
        <p style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '6px' }}>
          Location search is unavailable right now — you can still type the address manually.
        </p>
      )}

      {status === 'ready' && (
        <div
          ref={mapDivRef}
          style={{
            width: '100%',
            height: '160px',
            borderRadius: '12px',
            overflow: 'hidden',
            marginTop: '10px',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        />
      )}
      {status === 'ready' && (
        <p style={{ color: '#555C7A', fontSize: '11px', marginTop: '6px' }}>
          Tap the map or drag the pin to fine-tune the exact spot.
        </p>
      )}
    </div>
  );
}
