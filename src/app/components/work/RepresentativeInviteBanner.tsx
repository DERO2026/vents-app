import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import { pendingRepReferral } from '../../../lib/representativeReferral';
import { ORGANIZER_REFERRAL_COST_NOTE } from '../../../lib/workRoles';

// Shown on the sign-up screen when the visitor opened a representative's
// referral link (?rep=CODE): who invited them, from the server
// (get_representative_referral_preview, 0210) -- never from the URL itself.
// An invalid, unknown or suspended code shows nothing.
export function RepresentativeInviteBanner() {
  const [rep, setRep] = useState<{ display_name: string | null; username: string | null } | null>(null);
  useEffect(() => {
    const code = pendingRepReferral();
    if (!code) return;
    let cancelled = false;
    Promise.resolve(supabase.rpc('get_representative_referral_preview' as any, { p_code: code }))
      .then((v: any) => { if (!cancelled && v?.data?.valid) setRep(v.data.representative ?? null); }, () => {});
    return () => { cancelled = true; };
  }, []);
  if (!rep) return null;
  const name = rep.display_name || rep.username || 'A VENTS Representative';
  return (
    <div data-testid="rep-invite-banner" role="note" style={{
      background: 'rgba(142,92,247,0.10)', border: '1px solid rgba(142,92,247,0.32)', borderRadius: 14,
      padding: '10px 12px', display: 'grid', gap: 4, marginBottom: 12,
    }}>
      <span style={{ color: ventsColors.ink1, fontSize: 13, fontWeight: 700 }}>
        <span data-testid="rep-invite-name">{name}</span>
        {rep.username && <span style={{ color: ventsColors.ink2, fontWeight: 600 }}> · @{rep.username}</span>}
        {' '}invited you to VENTS
      </span>
      <span style={{ color: ventsColors.ink2, fontSize: 12, lineHeight: 1.45 }}>
        Create your account to connect it to this VENTS Representative. {ORGANIZER_REFERRAL_COST_NOTE}
      </span>
    </div>
  );
}
