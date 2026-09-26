import type { Screen } from '../components/types';

// The VENTS AI floating orb (see VentsAiOrb.tsx) overlays only the app's
// main navigation tabs -- Home, Discover (ExploreScreen) and Bookings
// (MyTicketsScreen, the 'my-tickets' screen/tab) -- per the design export's
// "lives as a persistent floating orb over Home, Discover and Bookings"
// spec. It must never render on top of payment/checkout/wallet/refund/
// transfer screens or any other screen, and never for a signed-out user.
// Kept as a standalone, pure, exported list/function (rather than inlined
// in App.tsx) specifically so this placement rule has its own direct unit
// test (VentsAiOrb.render.test.tsx) instead of only being exercised
// incidentally through a full App render.
export const VENTS_AI_ORB_SCREENS: Screen[] = ['home', 'explore', 'my-tickets'];

export function shouldShowVentsAiOrb(screen: Screen, loggedIn: boolean): boolean {
  return loggedIn && VENTS_AI_ORB_SCREENS.includes(screen);
}
