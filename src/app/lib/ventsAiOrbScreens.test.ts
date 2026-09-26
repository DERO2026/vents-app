import { describe, it, expect } from 'vitest';
import { shouldShowVentsAiOrb, VENTS_AI_ORB_SCREENS } from './ventsAiOrbScreens';
import type { Screen } from '../components/types';

describe('shouldShowVentsAiOrb', () => {
  it('shows the orb only on the main tabs (Home, Discover/explore, Bookings/my-tickets) while logged in', () => {
    for (const s of VENTS_AI_ORB_SCREENS) {
      expect(shouldShowVentsAiOrb(s, true)).toBe(true);
    }
  });

  it('never shows the orb for a signed-out user, even on an allowed screen', () => {
    expect(shouldShowVentsAiOrb('home', false)).toBe(false);
  });

  // The orb must never overlay payment/checkout/wallet/refund/transfer
  // screens or the VENTS AI screen itself -- this is the direct regression
  // test for that placement rule (see App.tsx's render call site, which
  // gates purely on this function rather than re-deriving the screen list).
  const disallowed: Screen[] = [
    'checkout',
    'payment-success',
    'payment-failed',
    'payment-request',
    'payment-request-sent',
    'payment-requests',
    'wallet',
    'customer-wallet',
    'ticket-refund',
    'ticket-select',
    'vents-ai',
  ];

  it.each(disallowed)('never shows the orb on %s', (s) => {
    expect(shouldShowVentsAiOrb(s, true)).toBe(false);
  });
});
