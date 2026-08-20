import type { CSSProperties } from 'react';

// Safe-area-aware fixed-top toast/banner position. A plain `top: '20px'`
// (the pattern this replaces, previously duplicated across QRTicket.tsx and
// PaymentSuccessScreen.tsx) sits a fixed distance from the viewport edge --
// fine on a device with no notch, but on an iPhone with a notch or Dynamic
// Island that fixed offset lands the toast under/behind it, since the
// status bar itself already occupies that space. `env(safe-area-inset-top)`
// is the actual height of that reserved area (0 on devices without one),
// so adding it keeps a consistent 20px gap below the status bar/Dynamic
// Island on every device instead of a hardcoded pixel value tuned to one.
export const TOAST_TOP_POSITION: CSSProperties = {
  position: 'absolute',
  top: 'calc(20px + env(safe-area-inset-top))',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 99,
  whiteSpace: 'nowrap',
};
