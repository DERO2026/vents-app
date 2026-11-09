import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { ventsColors } from '../../../lib/ventsDesignTokens';
import { formatNaira, isBackendUnavailable, claimStateView } from '../../../lib/workRoles';
import { repReferralLink } from '../../../lib/representativeReferral';
import { shareLink } from '../../../lib/shareLink';
import { useRepHistory, MoreButton, ListError, type Attribution } from './representativePanels';
import { MLabel, MCard, Row, Ico, Pill, WorkButton, ErrorNote, NoteBand, Loading } from './workUi';
import { ReferralSteps } from './representativeConnection';

// Organizer referral link and the organizers it brought (migration 0209).
// The code comes from the server (get_my_representative_referral), which
// issues one only to an ACTIVE representative; attribution and every reward
// rule are enforced there too. Nothing here is computed on the client.

type Referral = { code: string; link: string; displayName: string | null; username: string | null };

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function registrationText(a: Attribution): { label: string; tone: 'on' | 'wait' | 'off' } {
  if (a.organizer_verified) return { label: 'Verified organizer', tone: 'on' };
  if (a.verification_status === 'pending') return { label: 'Verification pending', tone: 'wait' };
  if (a.verification_status === 'rejected') return { label: 'Verification rejected', tone: 'off' };
  if (a.is_organizer) return { label: 'Organizer, not verified', tone: 'wait' };
  return { label: 'Registered', tone: 'wait' };
}

function qualifyingText(a: Attribution): string {
  const events = a.events ?? [];
  if (events.length === 0) return 'No event since joining';
  const ok = events.find((e) => e.eligibility?.eligible);
  if (ok) return `Qualifying event: ${ok.title}`;
  if (events.every((e) => e.eligibility?.reasons?.includes('free_event'))) return 'Only free events so far (free events do not qualify)';
  return `${events.length} event${events.length === 1 ? '' : 's'}, none qualifying yet`;
}

function rewardText(a: Attribution): string {
  if (!a.reward_status) return a.claimed ? 'Reward already claimed for this organizer' : 'No reward yet';
  const v = claimStateView(a.reward_status, { payoutsEnabled: true, fundingAvailable: true });
  const amount = a.reward_amount_kobo ? `${formatNaira(a.reward_amount_kobo)} · ` : '';
  return a.reward_status === 'credited' ? `${amount}credited to your earnings wallet` : `${amount}${v.label}`;
}

export function ReferralsPanel({ active }: { active: boolean }) {
  const [referral, setReferral] = useState<Referral | null>(null);
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const referred = useRepHistory<Attribution>('attributions', null, active);

  const load = useCallback(async () => {
    if (!active) return;
    setLoading(true); setError(null);
    const { data, error: e } = await Promise.resolve(supabase.rpc('get_my_representative_referral' as any))
      .then((v: any) => v, (err) => ({ data: null, error: err }));
    if (e) {
      if (isBackendUnavailable(e)) setUnavailable(true);
      else setError(e.message || 'Could not load your referral link.');
    } else if (data?.code) {
      setReferral({ code: data.code, link: repReferralLink(data.code), displayName: data.display_name ?? null, username: data.username ?? null });
    }
    setLoading(false);
  }, [active]);
  useEffect(() => { void load(); }, [load]);

  if (!active) {
    return (
      <MCard testId="referrals-inactive">
        <Row title="Referral links are for active VENTS Representatives"
          sub="Your representative status must be active to invite organizers with a link." />
      </MCard>
    );
  }
  if (unavailable) {
    return <NoteBand><span data-testid="referrals-not-live">Organizer referral links go live with the next VENTS Earn release.</span></NoteBand>;
  }

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(null), 2500); };

  return (
    <>
      {error && <ErrorNote>{error}</ErrorNote>}
      {notice && <NoteBand><span role="status">{notice}</span></NoteBand>}
      <MLabel>Your organizer referral link</MLabel>
      <MCard testId="referral-link-card">
        {loading && <Loading />}
        {!loading && referral && (
          <>
            <p style={{ margin: 0, color: ventsColors.ink2, fontSize: 12, lineHeight: 1.5 }}>
              A new organizer who registers through this link is connected to you permanently and sees your name
              when they open it. A click or a registration earns nothing by itself: the reward is paid only after
              every step below, including their paid event taking place.
            </p>
            {(referral.displayName || referral.username) && (
              <div data-testid="referral-identity" style={{ color: ventsColors.ink1, fontSize: 12.5 }}>
                Organizers will see: <strong>{referral.displayName || referral.username}</strong>
                {referral.username && <span style={{ color: ventsColors.ink2 }}> · @{referral.username}</span>}
              </div>
            )}
            <div style={{ display: 'grid', gap: 4 }}>
              <span style={{ color: ventsColors.ink3, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em' }}>CODE</span>
              <span data-testid="referral-code" style={{ color: ventsColors.white, fontSize: 20, fontWeight: 800, letterSpacing: '0.12em', fontVariantNumeric: 'tabular-nums' }}>{referral.code}</span>
            </div>
            <div data-testid="referral-link" style={{ color: ventsColors.accentSoft, fontSize: 12.5, overflowWrap: 'anywhere', background: 'rgba(142,92,247,0.08)', border: '1px solid rgba(142,92,247,0.25)', borderRadius: 10, padding: '8px 10px' }}>
              {referral.link}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <WorkButton testId="referral-copy-link" onClick={async () => flash((await copy(referral.link)) ? 'Link copied' : 'Could not copy; long-press the link to copy it')}>Copy link</WorkButton>
              <WorkButton ghost testId="referral-share" onClick={async () => {
                const r = await shareLink({ title: 'Join VENTS as an organizer', text: 'Create and sell tickets for your events on VENTS.', url: referral.link });
                if (r === 'copied') flash('Link copied');
              }}>Share</WorkButton>
            </div>
            <WorkButton ghost testId="referral-copy-code" onClick={async () => flash((await copy(referral.code)) ? 'Code copied' : 'Could not copy the code')}>Copy code</WorkButton>
          </>
        )}
      </MCard>

      <MLabel>How the reward is earned</MLabel>
      <MCard testId="referral-policy">
        <ReferralSteps rewardKobo={null} audience="representative" />
      </MCard>

      <MLabel>Organizers you referred</MLabel>
      <MCard testId="referred-organizers">
        {referred.loading && <Loading />}
        <ListError h={referred} testId="referred-error" />
        {!referred.loading && !referred.error && referred.items.length === 0 && (
          <Row testId="referred-empty" title="No organizers yet" sub="Share your link: new organizers who register through it appear here." />
        )}
        {!referred.loading && referred.items.map((a) => {
          const reg = registrationText(a);
          return (
            <Row key={a.id} testId={`referred-${a.organizer_id}`} icon={<Ico tone="p">{(a.organizer_name || 'O').slice(0, 1).toUpperCase()}</Ico>}
              title={<span>{a.organizer_name || 'Organizer'}{a.organizer_username && <span style={{ color: ventsColors.ink2, fontWeight: 600 }}> · @{a.organizer_username}</span>}</span>}
              sub={
                <span style={{ display: 'grid', gap: 2 }}>
                  <span>{a.source === 'referral_link' ? 'Joined through your link' : 'Accepted your invitation'} · {new Date(a.attributed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                  <span data-testid={`referred-qualifying-${a.organizer_id}`}>{qualifyingText(a)}</span>
                  <span data-testid={`referred-reward-${a.organizer_id}`}>{rewardText(a)}</span>
                </span>
              }
              right={<Pill tone={reg.tone}>{reg.label}</Pill>} />
          );
        })}
        <MoreButton h={referred} testId="referred-more" label="Show more" />
      </MCard>
    </>
  );
}
