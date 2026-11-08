import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

// VENTS Representative profile badge (migration 0209). Shown only when the
// SERVER says the user is a registered representative whose status is active
// and whose account is not deleted (get_representative_badges, readable by
// anyone). Never derived from anything a user can edit; on any error, or
// before 0209 is deployed, no badge is shown.

const cache = new Map<string, boolean>();

export async function fetchRepresentativeBadges(userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))].slice(0, 200);
  if (ids.length === 0) return new Set();
  const { data, error } = await Promise.resolve(supabase.rpc('get_representative_badges' as any, { p_user_ids: ids }))
    .then((v: any) => v, () => ({ data: null, error: true }));
  if (error || !Array.isArray(data)) return new Set();
  return new Set((data as { user_id: string }[]).map((r) => r.user_id));
}

export function useIsActiveRepresentative(userId: string | null | undefined): boolean {
  const [active, setActive] = useState<boolean>(() => (userId ? cache.get(userId) === true : false));
  useEffect(() => {
    if (!userId) { setActive(false); return; }
    let alive = true;
    fetchRepresentativeBadges([userId]).then((set) => {
      const on = set.has(userId);
      cache.set(userId, on);
      if (alive) setActive(on);
    });
    return () => { alive = false; };
  }, [userId]);
  return active;
}

export function RepresentativeBadgePill() {
  return (
    <span
      data-testid="representative-badge"
      title="VENTS Representative"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        padding: '3px 9px', borderRadius: '999px',
        background: 'rgba(123,47,190,0.32)',
        border: '1px solid rgba(183,155,255,0.55)',
        color: '#E9DDFF', fontSize: '11px', fontWeight: 800, letterSpacing: '0.04em', whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#B79BFF', boxShadow: '0 0 6px rgba(183,155,255,0.9)' }} />
      VENTS Representative
    </span>
  );
}

/** Renders the badge for `userId` when, and only when, the server confirms an active representative. */
export function RepresentativeBadge({ userId }: { userId: string | null | undefined }) {
  const active = useIsActiveRepresentative(userId);
  return active ? <RepresentativeBadgePill /> : null;
}
