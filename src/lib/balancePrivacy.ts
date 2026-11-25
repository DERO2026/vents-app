// Global "hide balances" preference.
//
// One device-level switch masks every private financial figure in the app
// (wallet balance, earnings, pending/withdrawable/on-hold amounts,
// representative earnings, VENTS Cents). It is NOT stored on the account:
//   * it lives in this device's localStorage under one fixed key, so it
//     survives app restarts, logout/login and switching accounts on the
//     same device (logout never clears localStorage in this app);
//   * it is read synchronously on the very first render, so a balance can
//     never flash visible before the saved preference loads.
// If storage is unavailable (private mode, quota), the preference falls
// back to the default (shown) for this session; nothing breaks.
//
// Public prices, ticket totals, transaction amounts and other figures a
// user needs to identify a purchase are deliberately NOT masked.
import { useSyncExternalStore } from 'react';

export const BALANCE_PRIVACY_STORAGE_KEY = 'vents:balance-privacy:hidden';
export const MASK_NAIRA = '₦••••••';
export const MASK_VC = '•••••• VC';
export const MASK_PLAIN = '••••••';

const listeners = new Set<() => void>();
let memory: boolean | null = null; // fallback when storage throws

function read(): boolean {
  try {
    const v = window.localStorage.getItem(BALANCE_PRIVACY_STORAGE_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* storage unavailable */ }
  return memory ?? false;
}

export function isBalanceHidden(): boolean {
  return read();
}

export function setBalanceHidden(hidden: boolean): void {
  memory = hidden;
  try { window.localStorage.setItem(BALANCE_PRIVACY_STORAGE_KEY, hidden ? '1' : '0'); } catch { /* keep in memory */ }
  listeners.forEach((l) => l());
}

export function toggleBalanceHidden(): void {
  setBalanceHidden(!read());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Keep other open tabs/windows of the web app in sync.
  const onStorage = (e: StorageEvent) => { if (e.key === BALANCE_PRIVACY_STORAGE_KEY) listener(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

/** Current preference; re-renders every subscriber when it changes. */
export function useBalanceHidden(): boolean {
  // Server snapshot reads the same device value (read() is guarded when
  // window/storage are unavailable), so no render path ever starts 'shown'.
  return useSyncExternalStore(subscribe, read, read);
}

/** Returns the masked text when hidden, otherwise the formatted amount. */
export function privateAmount(formatted: string, hidden: boolean, mask: string = MASK_NAIRA): string {
  return hidden ? mask : formatted;
}
