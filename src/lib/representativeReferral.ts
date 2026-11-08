// VENTS Representative organizer referral links (migration 0209).
//
//   link     https://getvents.com/?rep=CODE   (CODE: 8 chars, no 0/O/1/I)
//   capture  App.tsx stores CODE when the app opens with ?rep= (localStorage,
//            7 days, so it survives the email-code step and a reload)
//   claim    right after registration (AuthScreen) and on the next signed-in
//            load, claim_representative_referral(CODE) -- the SERVER decides:
//            only a new account (72 h), never self, never a representative,
//            never a second or different representative, only an active code.
// Separate from the VENTS Cents ?ref= referral, which is unchanged.

export const REP_REFERRAL_PARAM = 'rep';
export const REP_REFERRAL_STORAGE_KEY = 'vents_rep_ref';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;

export const REP_REFERRAL_BASE_URL = 'https://getvents.com';

export function normalizeRepCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase();
  return CODE.test(code) ? code : null;
}

export function repReferralLink(code: string): string {
  return `${REP_REFERRAL_BASE_URL}/?${REP_REFERRAL_PARAM}=${code}`;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStore = (): Store | null => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};

/** Remember ?rep=CODE. Returns true if a valid code was captured. */
export function captureRepReferral(params: URLSearchParams, store: Store | null = defaultStore(), now = Date.now()): boolean {
  const code = normalizeRepCode(params.get(REP_REFERRAL_PARAM));
  if (!code || !store) return false;
  try { store.setItem(REP_REFERRAL_STORAGE_KEY, JSON.stringify({ code, at: now })); } catch { return false; }
  return true;
}

export function pendingRepReferral(store: Store | null = defaultStore(), now = Date.now()): string | null {
  if (!store) return null;
  try {
    const raw = store.getItem(REP_REFERRAL_STORAGE_KEY);
    if (!raw) return null;
    const { code, at } = JSON.parse(raw) as { code?: string; at?: number };
    const valid = normalizeRepCode(code);
    if (!valid || typeof at !== 'number' || now - at > MAX_AGE_MS) {
      store.removeItem(REP_REFERRAL_STORAGE_KEY);
      return null;
    }
    return valid;
  } catch {
    return null;
  }
}

export type RepReferralOutcome =
  | 'attributed' | 'already_attributed' | 'self_referral' | 'representative_cannot_be_referred'
  | 'not_a_new_account' | 'invalid_code' | 'retry_later' | 'none';

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }>;

/** Claim a stored code once. Any definitive answer clears it; a transient failure keeps it for the next load. */
export async function claimPendingRepReferral(rpc: Rpc, store: Store | null = defaultStore()): Promise<RepReferralOutcome> {
  const code = pendingRepReferral(store);
  if (!code) return 'none';
  try {
    const { data, error } = await rpc('claim_representative_referral', { p_code: code });
    if (error) return 'retry_later';
    const status = (data?.status ?? 'invalid_code') as RepReferralOutcome;
    try { store?.removeItem(REP_REFERRAL_STORAGE_KEY); } catch { /* ignore */ }
    return status;
  } catch {
    return 'retry_later';
  }
}
