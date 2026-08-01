import { useEffect, useRef, useState } from 'react';
import { MapPin, Loader, WifiOff } from 'lucide-react';
import { loadGoogleMaps } from '../../lib/googleMaps';
import { matchNigeriaState } from '../../lib/nigeriaLocations';

export interface LocationValue {
  address: string;
  lat: number | null;
  lng: number | null;
  // Populated only on an actual place SELECTION or a marker drag/map-click
  // reverse-geocode — never on free-typed text, so a consumer can safely
  // auto-fill its own venue/city/state fields only when these are present,
  // without clobbering manual edits on every keystroke.
  venue?: string;
  city?: string;
  state?: string;
  country?: string;
  placeId?: string;
}

// Pulls city/state/country out of a Places addressComponents array. Google
// nests these under `types` on each component rather than fixed keys, so
// this has to search by type rather than index.
function parseAddressComponents(components: any[] | undefined): { city: string; state: string; country: string } {
  const byType = (type: string) => components?.find((c) => c.types?.includes(type))?.longText
    ?? components?.find((c) => c.types?.includes(type))?.long_name ?? '';
  const city = byType('locality') || byType('administrative_area_level_2') || '';
  const rawState = byType('administrative_area_level_1');
  const country = byType('country');
  return { city, state: matchNigeriaState(rawState) || rawState, country };
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  background: '#090514',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '12px',
  padding: '12px 38px 12px 14px',
  color: '#F0F0FF',
  fontSize: '14px',
  fontFamily: 'Inter, sans-serif',
  outline: 'none',
  boxSizing: 'border-box',
};

interface Suggestion {
  key: string;
  mainText: string;
  secondaryText: string;
  prediction: any;
}

// Searchable address/venue picker for Nigerian locations.
//
// Previously delegated entirely to Google's <gmp-place-autocomplete> web
// component, which renders its OWN dropdown internally via shadow DOM. That
// dropdown relies on the CSS anchor-positioning/Popover APIs to escape
// ancestor clipping — unsupported in some WebViews, and this form's
// scrollable body (CreateEventScreen.tsx's `overflowY: 'auto'` wrapper)
// creates exactly the kind of overflow clipping context that silently
// hides an absolutely-positioned fallback dropdown with zero console
// errors (the API call succeeds; only the *visual* list vanishes).
//
// Rebuilt on the underlying data API instead — AutocompleteSuggestion.
// fetchAutocompleteSuggestions() — so this component owns the dropdown
// markup directly: a plain `position: absolute` list anchored to this
// input's own wrapper, immune to that failure mode by construction.
export function LocationPicker({
  value,
  onChange,
  placeholder = 'Search for an address, venue, or landmark',
}: {
  value: LocationValue;
  onChange: (v: LocationValue) => void;
  placeholder?: string;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const geocoderRef = useRef<any>(null);
  // Groups requests from the same search into one Google billing session —
  // reset after a selection (or on mount) per Google's session-token
  // guidance, so a whole "type → pick a result" flow bills as one session
  // instead of one per keystroke.
  const sessionTokenRef = useRef<any>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against a slow, stale fetch resolving AFTER a newer one and
  // clobbering fresher suggestions — only the most recent request's result
  // is ever applied.
  const requestSeqRef = useRef(0);

  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'offline'>(
    typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'loading'
  );
  const [retryKey, setRetryKey] = useState(0);
  const [text, setText] = useState(value.address);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    setText(value.address);
  }, [value.address]);

  // A genuinely offline device gets a distinct message from "unavailable"
  // (misconfigured key, blocked request, etc.) — same symptom (no search),
  // different cause, different fix for the user. Retries automatically the
  // moment the device reconnects rather than leaving a stale error up.
  useEffect(() => {
    const goOffline = () => setStatus((s) => (s === 'ready' ? s : 'offline'));
    const goOnline = () => {
      setStatus((s) => (s === 'offline' ? 'loading' : s));
      setRetryKey((k) => k + 1);
    };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  // Load the SDK (places + geocoding + maps + marker libraries — see
  // googleMaps.ts). Only flips `status`; the map effect below waits for
  // 'ready' before touching the DOM.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { setStatus('offline'); return; }
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (cancelled) return;
        const google = (window as any).google;
        geocoderRef.current = new google.maps.Geocoder();
        sessionTokenRef.current = new google.maps.places.AutocompleteSessionToken();
        setStatus('ready');
      })
      .catch((e) => {
        console.error('Location search unavailable:', e);
        if (cancelled) return;
        setStatus(navigator.onLine === false ? 'offline' : 'unavailable');
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryKey]);

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

  // Click-outside-to-close. Suggestion rows use onMouseDown (fires before
  // blur) to actually select — if this used onClick instead, the input's
  // blur would close the dropdown and unmount the row before the click
  // event ever reached it.
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

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
      const result = geoStatus === 'OK' ? results?.[0] : null;
      const address = result ? result.formatted_address : valueRef.current.address;
      const { city, state, country } = parseAddressComponents(result?.address_components);
      setText(address);
      onChange({
        address,
        lat,
        lng,
        // A reverse-geocoded point has no distinct "place name" the way a
        // Places selection does (e.g. dragging the pin to an empty field
        // isn't "a place") — venue/placeId intentionally omitted so the
        // caller doesn't overwrite a manually-typed venue name with a
        // street address.
        city: city || undefined,
        state: state || undefined,
        country: country || undefined,
      });
    });
  }

  // The actual Autocomplete service call. Debounced 300ms from onChange
  // below (step 1 of the requested fix: confirm this is really firing).
  async function fetchSuggestions(query: string) {
    // TEMP DEBUG (requested): confirms onChange -> debounce -> this
    // function is actually being reached, and what Google returns, without
    // digging through devtools network tab. Safe to remove once confirmed.
    console.log('[LocationPicker] fetchSuggestions running for:', JSON.stringify(query));

    if (status !== 'ready') {
      console.log('[LocationPicker] skipped — status is', status, '(SDK not ready yet)');
      return;
    }
    const google = (window as any).google;
    if (!google?.maps?.places?.AutocompleteSuggestion) {
      console.error('[LocationPicker] google.maps.places.AutocompleteSuggestion is undefined — places library did not load correctly');
      return;
    }

    const mySeq = ++requestSeqRef.current;
    setSearching(true);
    try {
      const { suggestions: raw } = await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: query,
        includedRegionCodes: ['ng'],
        sessionToken: sessionTokenRef.current,
      });
      console.log('[LocationPicker] fetchAutocompleteSuggestions returned', raw?.length ?? 0, 'result(s)');

      if (mySeq !== requestSeqRef.current) return; // a newer request already superseded this one

      const mapped: Suggestion[] = (raw || [])
        .filter((s: any) => s.placePrediction)
        .map((s: any, i: number) => {
          const p = s.placePrediction;
          const main = p.mainText?.text ?? p.text?.text ?? '';
          const secondary = p.secondaryText?.text ?? '';
          return { key: p.placeId || String(i), mainText: main, secondaryText: secondary, prediction: p };
        });
      setSuggestions(mapped);
      setDropdownOpen(mapped.length > 0);
    } catch (err) {
      console.error('[LocationPicker] fetchAutocompleteSuggestions failed:', err);
      if (mySeq === requestSeqRef.current) {
        setSuggestions([]);
        setDropdownOpen(false);
      }
    } finally {
      if (mySeq === requestSeqRef.current) setSearching(false);
    }
  }

  function handleTextChange(next: string) {
    setText(next);
    // Free-typed text with no place selected yet: keep any prior pin but
    // update the address string so the form still saves something even if
    // the user never picks a suggestion.
    onChange({ address: next, lat: value.lat, lng: value.lng });

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const query = next.trim();
    if (query.length < 2) {
      setSuggestions([]);
      setDropdownOpen(false);
      requestSeqRef.current++; // invalidate any in-flight request
      return;
    }
    // 300ms debounce — step "optimise API usage": avoids firing a request
    // on every single keystroke while still feeling instant to type into.
    debounceRef.current = setTimeout(() => fetchSuggestions(query), 300);
  }

  async function handleSelect(s: Suggestion) {
    setDropdownOpen(false);
    setSuggestions([]);
    try {
      const place = s.prediction.toPlace();
      await place.fetchFields({
        fields: ['displayName', 'formattedAddress', 'location', 'addressComponents', 'id'],
      });
      const loc = place.location;
      const lat = loc ? loc.lat() : null;
      const lng = loc ? loc.lng() : null;
      const address = place.formattedAddress || place.displayName || '';
      const { city, state, country } = parseAddressComponents(place.addressComponents);
      setText(address);
      onChange({
        address,
        lat,
        lng,
        venue: place.displayName || undefined,
        city: city || undefined,
        state: state || undefined,
        country: country || undefined,
        placeId: place.id || undefined,
      });
      if (lat != null && lng != null) placeMarker(lat, lng);
    } catch (err) {
      console.error('Failed to resolve selected place:', err);
    } finally {
      // New session for the next search, per Google's billing guidance —
      // one token covers "type → select", not the whole component lifetime.
      const google = (window as any).google;
      if (google?.maps?.places?.AutocompleteSessionToken) {
        sessionTokenRef.current = new google.maps.places.AutocompleteSessionToken();
      }
    }
  }

  return (
    <div ref={wrapperRef}>
      <div style={{ position: 'relative' }}>
        <input
          value={text}
          onChange={(e) => handleTextChange(e.target.value)}
          onFocus={() => { if (suggestions.length > 0) setDropdownOpen(true); }}
          placeholder={placeholder}
          disabled={status === 'loading'}
          style={INPUT_STYLE}
        />
        <div style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)' }}>
          {status === 'loading' || searching
            ? <Loader size={15} color="#555C7A" className="animate-spin" />
            : status === 'offline'
            ? <WifiOff size={15} color="#F59E0B" />
            : <MapPin size={15} color={value.lat != null ? '#22D3EE' : '#555C7A'} />}
        </div>

        {/* The dropdown itself — inline, absolutely positioned directly
            under the input, scoped z-index. Never a full-screen overlay or
            fixed-position modal. */}
        {dropdownOpen && suggestions.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: 0,
              right: 0,
              zIndex: 50,
              background: '#0D0A1A',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '12px',
              boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
              maxHeight: '260px',
              overflowY: 'auto',
            }}
          >
            {suggestions.map((s) => (
              <div
                key={s.key}
                onMouseDown={(e) => { e.preventDefault(); handleSelect(s); }}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '8px',
                  padding: '10px 12px',
                  cursor: 'pointer',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(168,85,247,0.08)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <MapPin size={14} color="#A78BFA" style={{ marginTop: '2px', flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.mainText}
                  </div>
                  {s.secondaryText && (
                    <div style={{ color: '#8B8FA8', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.secondaryText}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {status === 'offline' && (
        <p style={{ color: '#F59E0B', fontSize: '11px', marginTop: '6px' }}>
          You're offline — location search will resume automatically once you're back online. You can still type the address manually.
        </p>
      )}
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
