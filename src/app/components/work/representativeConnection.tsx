import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import {
  REFERRAL_REWARD_STEPS, ORGANIZER_REFERRAL_COST_NOTE, eligibilityReasonText, isBackendUnavailable, formatNaira,
} from '../../../lib/workRoles';
import { pendingRepReferral } from '../../../lib/representativeReferral';
import { MLabel, MCard, Row, Ico, Pill, ErrorNote, Loading, NoteBand, WorkButton } from './workUi';

// The ORGANIZER's side of a VENTS Representative referral (0210:
// get_my_representative_connection). Everything shown here is the caller's
// own authenticated database record -- never a locally simulated connection.

interface RepIdentity { display_name: string | null; username: string | null; avatar_url?: string | null; active?: boolean }
export interface RepresentativeConnection {
  status: 'established' | 'pending' | 'none';
  is_representative: boolean;
  attribution: null | { attributed_at: string; source: 'referral_link' | 'invite'; representative: RepIdentity | null };
  pending_invitations: { partnership_id: string; invited_at: string; representative: RepIdentity }[];
  reward_confirmations: { claim_id: string; status: string; event_title: string; submitted_at: string; needs_your_confirmation: boolean }[];
  events: { event_id: string; title: string; event_date: string | null; created_at: string; eligible: boolean; reasons: string[]; is_free_event: boolean }[];
  reward_amount_kobo: number | null;
  organizer_pays_for_referral: boolean;
}

export function repName(r: RepIdentity | null | undefined): string {
  return (r?.display_name || r?.username || 'A VENTS Representative').trim();
}
export function repHandle(r: RepIdentity | null | undefined): string | null {
  return r?.username ? `@${r.username}` : null;
}

const fmtDate = (iso: string | null | undefined) => (iso
  ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  : '');

const CLAIM_TEXT: Record<string, string> = {
  pending_organizer: 'Waiting for you to confirm the referral',
  pending_review: 'You confirmed · two VENTS admins are reviewing the event',
  approved: 'Approved by VENTS',
  funded: 'Approved by VENTS',
  credited: 'Reward paid to your representative by VENTS',
  rejected: 'Not approved by VENTS',
  reversed: 'Reversed by VENTS',
};

/** The reward steps, numbered; shown to both sides. */
export function ReferralSteps({ rewardKobo, audience }: { rewardKobo: number | null; audience: 'organizer' | 'representative' }) {
  const amount = rewardKobo ? formatNaira(rewardKobo) : 'the fixed reward';
  return (
    <div data-testid={`referral-steps-${audience}`} style={{ display: 'grid', gap: 8 }}>
      <p style={{ margin: 0, color: ventsColors.ink2, fontSize: 12, lineHeight: 1.5 }}>
        {audience === 'representative'
          ? `You earn ${amount} per qualifying organizer, once, only after every step below. It is a fixed reward from VENTS, not a commission or a share of ticket sales.`
          : `Your representative earns ${amount} from VENTS only after every step below. It is a fixed reward paid by VENTS, not a commission.`}
      </p>
      <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
        {REFERRAL_REWARD_STEPS.map((s) => (
          <li key={s.key} style={{ color: ventsColors.ink1, fontSize: 12, lineHeight: 1.45 }}>
            <strong>{s.title}.</strong> <span style={{ color: ventsColors.ink2 }}>{s.detail}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Defensive read of the server answer: unknown shapes never crash the screen or invent a connection. */
export function normalizeConnection(d: any): RepresentativeConnection | null {
  if (!d || typeof d !== 'object') return null;
  const status = d.status === 'established' || d.status === 'pending' ? d.status : 'none';
  const arr = (v: any) => (Array.isArray(v) ? v : []);
  return {
    status: status === 'established' && !d.attribution ? 'none' : status,
    is_representative: d.is_representative === true,
    attribution: d.attribution && typeof d.attribution === 'object' ? d.attribution : null,
    pending_invitations: arr(d.pending_invitations),
    reward_confirmations: arr(d.reward_confirmations),
    events: arr(d.events),
    reward_amount_kobo: typeof d.reward_amount_kobo === 'number' ? d.reward_amount_kobo : null,
    organizer_pays_for_referral: d.organizer_pays_for_referral === true,
  };
}

export function useRepresentativeConnection(enabled: boolean) {
  const [data, setData] = useState<RepresentativeConnection | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true); setError(null);
    const { data: d, error: e } = await Promise.resolve(supabase.rpc('get_my_representative_connection' as any))
      .then((v: any) => v, (err) => ({ data: null, error: err }));
    if (e) {
      if (isBackendUnavailable(e)) setUnavailable(true);
      else setError(e.message || 'Could not load your representative connection.');
    } else {
      setData(normalizeConnection(d));
    }
    setLoading(false);
  }, [enabled]);
  useEffect(() => { void load(); }, [load]);
  return { data, loading, error, unavailable, reload: load };
}

/** "Your VENTS Representative" -- the organizer's own referral connection. */
export function RepresentativeConnectionCard({ enabled, onOpenInvitations }: { enabled: boolean; onOpenInvitations?: () => void }) {
  const c = useRepresentativeConnection(enabled);
  const [showSteps, setShowSteps] = useState(false);
  // A link opened before registering that has not been claimed yet (it is
  // claimed automatically once signed in; the server decides).
  const pendingCode = pendingRepReferral();

  if (!enabled || c.unavailable) return null;
  if (c.loading) return (<><MLabel>Your VENTS Representative</MLabel><MCard testId="rep-connection"><Loading /></MCard></>);
  if (c.error) return (<><MLabel>Your VENTS Representative</MLabel><ErrorNote>{c.error}</ErrorNote></>);
  const d = c.data;
  if (!d || d.is_representative) return null;
  if (d.status === 'none' && !pendingCode) return null;

  const rep = d.attribution?.representative ?? null;
  return (
    <>
      <MLabel>Your VENTS Representative</MLabel>
      <MCard testId="rep-connection">
        {d.status === 'established' && d.attribution && (
          <Row testId="rep-connection-established"
            icon={<Ico tone="p" round>{repName(rep).slice(0, 1).toUpperCase()}</Ico>}
            title={<span data-testid="rep-connection-name">{repName(rep)}{repHandle(rep) && <span style={{ color: ventsColors.ink2, fontWeight: 600 }}> · {repHandle(rep)}</span>}</span>}
            sub={`${d.attribution.source === 'referral_link' ? 'You joined VENTS through their referral link' : 'You accepted their invitation'} · ${fmtDate(d.attribution.attributed_at)}. This connection is permanent.`}
            right={<Pill tone="on">Connected</Pill>} />
        )}
        {d.status === 'pending' && d.pending_invitations.map((inv) => (
          <Row key={inv.partnership_id} testId={`rep-connection-pending-${inv.partnership_id}`}
            icon={<Ico tone="y" round>{repName(inv.representative).slice(0, 1).toUpperCase()}</Ico>}
            title={<span>{repName(inv.representative)}{repHandle(inv.representative) && <span style={{ color: ventsColors.ink2, fontWeight: 600 }}> · {repHandle(inv.representative)}</span>}</span>}
            sub={`Invited you on ${fmtDate(inv.invited_at)}. Accept the invitation to connect your organizer account.`}
            right={<Pill tone="wait">Pending</Pill>}
            onClick={onOpenInvitations} />
        ))}
        {d.status === 'none' && pendingCode && (
          <Row testId="rep-connection-connecting" title="Connecting you to your representative…"
            sub="Your referral link is being confirmed. Only a newly registered account can be connected." right={<Pill tone="wait">Pending</Pill>} />
        )}

        <NoteBand><span data-testid="rep-connection-cost-note">{ORGANIZER_REFERRAL_COST_NOTE}</span></NoteBand>

        {d.reward_confirmations.length > 0 && (
          <div style={{ display: 'grid', gap: 4 }}>
            {d.reward_confirmations.map((r) => (
              <div key={r.claim_id} data-testid={`rep-connection-claim-${r.claim_id}`} style={{ fontSize: 12, color: ventsColors.ink2 }}>
                <strong style={{ color: ventsColors.ink1 }}>{r.event_title}</strong> · {CLAIM_TEXT[r.status] ?? r.status}
              </div>
            ))}
          </div>
        )}

        {d.status === 'established' && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ color: ventsColors.ink3, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em' }}>YOUR EVENTS SINCE THE REFERRAL</span>
            {d.events.length === 0 && <span data-testid="rep-connection-no-events" style={{ fontSize: 12, color: ventsColors.ink2 }}>No events yet.</span>}
            {d.events.map((e) => (
              <div key={e.event_id} data-testid={`rep-connection-event-${e.event_id}`} style={{ fontSize: 12, color: ventsColors.ink2 }}>
                <strong style={{ color: ventsColors.ink1 }}>{e.title}</strong>{' · '}
                {e.eligible ? 'Meets the event requirements; VENTS admins still confirm it took place' : (e.reasons ?? []).map(eligibilityReasonText).join(' · ')}
              </div>
            ))}
          </div>
        )}

        <WorkButton ghost testId="rep-connection-how" onClick={() => setShowSteps((v) => !v)}>
          {showSteps ? 'Hide how the representative reward works' : 'How the representative reward works'}
        </WorkButton>
        {showSteps && <ReferralSteps rewardKobo={d.reward_amount_kobo} audience="organizer" />}
      </MCard>
    </>
  );
}
