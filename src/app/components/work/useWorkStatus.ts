import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { getVcBalance } from '../../../lib/vcBalanceCache';
import { toRequestStatus, type RequestStatus } from '../../../lib/workRoles';

export interface WorkUser {
  id: string;
  role?: string;
  isOrganizer?: boolean;
  is_service_provider?: boolean;
  is_verified?: boolean;
}

export interface WorkStatus {
  loading: boolean;
  organizerRequest: RequestStatus;
  organizerAdminNote: string | null;
  organizerReason: string | null;
  providerRequest: RequestStatus;
  providerProfileStatus: string | null;
  representative: 'none' | 'active' | 'suspended';
  representativeSince: string | null;
  vcSpendable: number | null;
  refresh: () => void;
}

// Role statuses for VENTS Work, read from the same tables Profile has
// always read (organizer_requests, service_provider_requests,
// service_providers, recruiters) -- each one RLS-scoped to the caller.
// A failed read leaves that role at its neutral state rather than
// guessing: the row still opens the real flow, which shows the truth.
export function useWorkStatus(user: WorkUser | null | undefined): WorkStatus {
  const [state, setState] = useState<Omit<WorkStatus, 'refresh'>>({
    loading: true,
    organizerRequest: 'none',
    organizerAdminNote: null,
    organizerReason: null,
    providerRequest: 'none',
    providerProfileStatus: null,
    representative: 'none',
    representativeSince: null,
    vcSpendable: null,
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const settle = <T,>(p: PromiseLike<T>) => Promise.resolve(p).then((v) => v, () => null);
      const [org, sp, prof, rep, vc] = await Promise.all([
        settle(supabase.from('organizer_requests').select('status, admin_note, reason').eq('user_id', user.id)
          .order('created_at', { ascending: false }).limit(1).maybeSingle()),
        settle(supabase.from('service_provider_requests').select('status').eq('user_id', user.id)
          .order('created_at', { ascending: false }).limit(1).maybeSingle()),
        settle(supabase.from('service_providers').select('status').eq('user_id', user.id).maybeSingle()),
        settle(supabase.from('recruiters').select('status, created_at').eq('id', user.id).maybeSingle()),
        settle(getVcBalance(user.id)),
      ]);
      if (cancelled) return;
      const orgRow = (org as any)?.data ?? null;
      const repRow = (rep as any)?.data ?? null;
      setState({
        loading: false,
        organizerRequest: toRequestStatus(orgRow?.status),
        organizerAdminNote: orgRow?.admin_note ?? null,
        organizerReason: orgRow?.reason ?? null,
        providerRequest: toRequestStatus((sp as any)?.data?.status),
        providerProfileStatus: (prof as any)?.data?.status ?? null,
        representative: repRow ? (repRow.status === 'suspended' ? 'suspended' : 'active') : 'none',
        representativeSince: repRow?.created_at ?? null,
        vcSpendable: (vc as any)?.spendable ?? null,
      });
    })();
    return () => { cancelled = true; };
  }, [user?.id, tick]);

  return { ...state, refresh };
}
