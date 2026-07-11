import { insforge } from './insforge';

interface VcBalanceResult {
  spendable: number;
  expired_this_call: number;
}

// get_my_vc_balance() performs synchronous UPDATEs (expiring stale VC rows,
// and conditionally adjusting the wallet balance) on every call — it's not
// a cheap read. ProfileScreen (balance chip) and ReferralScreen (Vents
// Cents page) each call it independently, and are typically visited
// back-to-back in one navigation, so the second screen was paying for the
// same round-trip again for a number that had just been fetched moments
// earlier. This short-lived cache (plus in-flight de-duplication for
// near-simultaneous calls) avoids that.
const CACHE_TTL_MS = 15_000;
let cache: { userId: string; data: VcBalanceResult; fetchedAt: number } | null = null;
let inFlight: { userId: string; promise: Promise<VcBalanceResult | null> } | null = null;

export async function getVcBalance(userId: string, opts?: { force?: boolean }): Promise<VcBalanceResult | null> {
  const now = Date.now();
  if (!opts?.force && cache && cache.userId === userId && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  if (!opts?.force && inFlight && inFlight.userId === userId) {
    return inFlight.promise;
  }

  const promise: Promise<VcBalanceResult | null> = Promise.resolve(insforge.database.rpc('get_my_vc_balance' as any)).then(
    ({ data }: any) => {
      const result: VcBalanceResult = { spendable: data?.spendable ?? 0, expired_this_call: data?.expired_this_call ?? 0 };
      cache = { userId, data: result, fetchedAt: Date.now() };
      inFlight = null;
      return result;
    },
    () => {
      inFlight = null;
      return null;
    }
  );

  inFlight = { userId, promise };
  return promise;
}

// Call after any action that spends/earns VC (badge purchase, feature
// boost, profile bonus, etc.) so the next read isn't served a stale cached
// value.
export function invalidateVcBalanceCache() {
  cache = null;
}
