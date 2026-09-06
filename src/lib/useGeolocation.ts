import { useEffect, useState } from 'react';

// Customer-side "Providers Near You" location. Deliberately NOT persisted
// anywhere (no localStorage, no DB write) -- it's a live, one-shot read
// used only to compute distance for this session's discovery query
// (get_nearby_service_providers, 0056_service_provider_geolocation.sql).
// Uses the plain Web Geolocation API rather than a separate Capacitor
// plugin: Capacitor's WebView proxies navigator.geolocation through the
// native permission prompt on both platforms once the native usage
// strings are declared (ios/App/App/Info.plist's
// NSLocationWhenInUseUsageDescription, android's ACCESS_COARSE_LOCATION/
// ACCESS_FINE_LOCATION), so no new native dependency is needed for this.

export type GeolocationStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'unavailable';

export interface GeolocationState {
  status: GeolocationStatus;
  lat: number | null;
  lng: number | null;
}

export function useGeolocation(enabled: boolean): GeolocationState {
  const [state, setState] = useState<GeolocationState>({ status: 'idle', lat: null, lng: null });

  useEffect(() => {
    if (!enabled) return;
    if (!('geolocation' in navigator)) {
      setState({ status: 'unavailable', lat: null, lng: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, status: 'requesting' }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        setState({ status: 'granted', lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        if (cancelled) return;
        // Covers both an explicit permission denial and any other failure
        // (timeout, position unavailable) -- either way the caller falls
        // back to country/city proximity, never blocking discovery.
        setState({ status: 'denied', lat: null, lng: null });
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );
    return () => { cancelled = true; };
  }, [enabled]);

  return state;
}
