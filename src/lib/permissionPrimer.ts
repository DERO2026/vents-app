// Imperative bridge between plain-JS callers (pickImage.ts, pushNotifications.ts
// — neither renders React) and the single <PermissionSheetHost/> mounted once at
// the app root (App.tsx), the same registration pattern already used for
// pushActionHandler in pushNotifications.ts. Two sheet types:
//   - "primer": a soft pre-ask shown once per permission per device, before the
//     OS prompt fires, explaining why we're about to ask. Skipped on every call
//     after the first — nagging on every camera tap would be worse than the
//     bare OS prompt it's meant to soften.
//   - "denied": shown after the OS prompt comes back denied, offering a direct
//     path to Settings instead of a dead end.
export interface PrimerCopy {
  icon: 'camera' | 'bell';
  title: string;
  message: string;
  // Apple Guideline 5.1.1(iv): a custom pre-permission screen must never
  // let the user close/delay it without the real OS prompt firing --
  // this is the exact behavior Apple's Oct 2026 rejection of VENTS 1.0.2
  // cited for the camera primer. dismissible:false (used for 'camera')
  // removes the "Not now" button and the backdrop-tap-to-close affordance
  // entirely, so "Continue" -> the real OS permission dialog is the ONLY
  // path out of the sheet. Defaults to true, so the notifications primer
  // (not cited, not a hardware-permission gate the same way, and where a
  // soft pre-ask the user can decline without ever seeing the system
  // prompt is normal, encouraged practice) is completely unchanged.
  dismissible?: boolean;
}

export interface DeniedCopy {
  icon: 'camera' | 'bell';
  title: string;
  message: string;
}

type PrimerRequest = PrimerCopy & { onContinue: () => void; onNotNow: (() => void) | null };
type DeniedRequest = DeniedCopy & { onOpenSettings: () => void; onDismiss: () => void };

let showPrimer: ((req: PrimerRequest) => void) | null = null;
let showDenied: ((req: DeniedRequest) => void) | null = null;

export function registerPrimerHost(handlers: {
  showPrimer: (req: PrimerRequest) => void;
  showDenied: (req: DeniedRequest) => void;
}) {
  showPrimer = handlers.showPrimer;
  showDenied = handlers.showDenied;
  return () => {
    showPrimer = null;
    showDenied = null;
  };
}

const primerShownKey = (permission: string) => `vents_permission_primer_shown_${permission}`;

/**
 * Shows the soft pre-ask sheet the first time this permission is requested on
 * this device, then gets out of the way on every later call.
 *
 * copy.dismissible === false (camera): there is no "skip" outcome at all --
 * the returned promise only ever resolves 'proceed', and the host renders no
 * "Not now" button and ignores a backdrop tap, so the real OS prompt is the
 * only way the sheet ever closes. This is the fix for Apple's Oct 2026
 * rejection (Guideline 5.1.1(iv)): a custom pre-permission screen must not
 * offer a close/delay action that avoids the system dialog.
 *
 * Otherwise (notifications, or dismissible left true): resolves 'skip' if
 * the user taps "Not now" (caller should not fire the OS prompt that turn)
 * or 'proceed' otherwise (first-time "Continue", or every call after the
 * first) -- unchanged from before.
 */
export function askPermission(permission: 'camera' | 'notifications', copy: PrimerCopy): Promise<'proceed' | 'skip'> {
  let alreadyShown = true;
  try {
    alreadyShown = !!localStorage.getItem(primerShownKey(permission));
  } catch { /* localStorage unavailable — fail open, skip the primer */ }
  if (alreadyShown || !showPrimer) return Promise.resolve('proceed');

  try { localStorage.setItem(primerShownKey(permission), '1'); } catch { /* best-effort */ }
  const dismissible = copy.dismissible !== false;
  return new Promise((resolve) => {
    showPrimer!({
      ...copy,
      onContinue: () => resolve('proceed'),
      onNotNow: dismissible ? () => resolve('skip') : null,
    });
  });
}

/** Fire-and-forget "permission denied — open Settings?" toast-style sheet. */
export function notifyPermissionDenied(copy: DeniedCopy) {
  if (!showDenied) return;
  showDenied({
    ...copy,
    onOpenSettings: async () => {
      const { openAppSettings } = await import('./openAppSettings');
      openAppSettings();
    },
    onDismiss: () => {},
  });
}
