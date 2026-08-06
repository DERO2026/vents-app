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
}

export interface DeniedCopy {
  icon: 'camera' | 'bell';
  title: string;
  message: string;
}

type PrimerRequest = PrimerCopy & { onContinue: () => void; onNotNow: () => void };
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
 * this device, then gets out of the way on every later call. Resolves 'skip'
 * if the user taps "Not now" (caller should not fire the OS prompt that turn)
 * or 'proceed' otherwise (first-time "Continue", or every call after the first).
 */
export function askPermission(permission: 'camera' | 'notifications', copy: PrimerCopy): Promise<'proceed' | 'skip'> {
  let alreadyShown = true;
  try {
    alreadyShown = !!localStorage.getItem(primerShownKey(permission));
  } catch { /* localStorage unavailable — fail open, skip the primer */ }
  if (alreadyShown || !showPrimer) return Promise.resolve('proceed');

  try { localStorage.setItem(primerShownKey(permission), '1'); } catch { /* best-effort */ }
  return new Promise((resolve) => {
    showPrimer!({
      ...copy,
      onContinue: () => resolve('proceed'),
      onNotNow: () => resolve('skip'),
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
