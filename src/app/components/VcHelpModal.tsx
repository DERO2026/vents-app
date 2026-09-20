import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { ventsColors } from '../../lib/ventsDesignTokens';
import { Sentry } from '../../lib/sentry';

// The VC "?" help experience -- a modal/sheet opened from ReferralScreen's
// header. Every number shown here comes from get_vc_config() (Batch F1/F2's
// authoritative RPC, supabase/migrations/0085 + 0086) -- there is
// deliberately NOT a single hardcoded VC economy literal in this file.
// Content and tone follow this batch's brief exactly: distinguishes VC from
// NGN, states the REAL cash-out rate (never the display-only ticket-credit
// estimate), explains earn/spend sources that actually exist in this
// codebase (no attendance/check-in reward, no organizer/campaign reward),
// states plainly that VC cannot be used toward ticket purchases, explains
// referral qualification and cash-out rules in plain language with no
// database-internal terms (no "advisory lock", "xact lock", etc).

export interface VcConfig {
  profile_completion_reward: number;
  ticket_purchase_reward: number;
  referral_referred_reward: number;
  referral_referrer_reward: number;
  referral_referrer_hold_days: number;
  badge_bronze_price: number;
  badge_silver_price: number;
  badge_gold_price: number;
  badge_platinum_price: number;
  badge_elite_price: number;
  badge_legend_price: number;
  feature_me_cost: number;
  feature_me_duration_days: number;
  event_boost_cost: number;
  event_boost_duration_days: number;
  cashout_rate_naira_per_1000: number;
  cashout_min_vc: number;
  cashout_max_vc: number;
  cashout_daily_max_vc: number;
  cashout_daily_max_requests: number;
  cashout_cooldown_minutes: number;
  cashout_maturation_hold_hours: number;
  ticket_credit_display_estimate_rate: number;
}

// Fetches the authoritative config from get_vc_config() (Batch F1/F2). No
// caller of this hook should ever hardcode a VC number instead.
export function useVcConfig() {
  const [config, setConfig] = useState<VcConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether a load is currently in-flight, checked synchronously so
  // a retry pressed while a request is still pending is a guaranteed no-op
  // (state updates from setLoading are not synchronous, so this ref is the
  // actual guard against firing a second, concurrent request).
  const inFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (inFlightRef.current) return; // guard against duplicate/concurrent requests
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_vc_config' as any);
      if (rpcError) throw rpcError;
      setConfig((data as any) ?? null);
    } catch (err) {
      console.error('Failed to load VC config:', err);
      Sentry.captureException(err);
      setConfig(null);
      setError('Couldn\'t load VENTS Cents info right now.');
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { config, loading, error, retry: load };
}

function fmtNaira(n: number): string {
  return '₦' + n.toLocaleString('en-NG');
}

type Tab = 'overview' | 'earn' | 'spend' | 'cashout';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'earn', label: 'Earn' },
  { id: 'spend', label: 'Spend' },
  { id: 'cashout', label: 'Cash Out' },
];

interface VcHelpModalProps {
  onClose: () => void;
}

export function VcHelpModal({ onClose }: VcHelpModalProps) {
  const { config, loading, error, retry } = useVcConfig();
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: '480px', maxHeight: '86vh', background: ventsColors.bg, borderTopLeftRadius: '24px', borderTopRightRadius: '24px', border: `1px solid ${ventsColors.border}`, borderBottom: 'none', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 18px 10px' }}>
          <span style={{ color: ventsColors.ink1, fontSize: '15px', fontWeight: 800, letterSpacing: '0.02em' }}>About VENTS Cents</span>
          <button onClick={onClose} style={{ width: '32px', height: '32px', borderRadius: '50%', background: ventsColors.glassBg, border: `1px solid ${ventsColors.glassBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <X size={15} color={ventsColors.ink1} />
          </button>
        </div>

        {/* Tabs -- one coherent EARN -> USE -> CASH OUT experience */}
        <div style={{ display: 'flex', gap: '6px', padding: '0 18px 12px', flexShrink: 0 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: 1,
                padding: '9px 0',
                borderRadius: '10px',
                border: tab === t.id ? `1px solid ${ventsColors.accentSoft}` : `1px solid ${ventsColors.border}`,
                background: tab === t.id ? 'rgba(142,92,247,0.18)' : 'transparent',
                color: tab === t.id ? ventsColors.accentSoft : ventsColors.ink2,
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="vc-help-scroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 18px 28px' }}>
          {error ? (
            <div style={{ textAlign: 'center', padding: '30px 0' }}>
              <p style={{ color: ventsColors.ink2, fontSize: '13px', marginBottom: '4px', fontWeight: 700 }}>
                Couldn&apos;t load VENTS Cents info right now
              </p>
              <p style={{ color: ventsColors.ink3, fontSize: '12px', marginBottom: '16px' }}>
                Please check your connection and try again.
              </p>
              <button
                onClick={retry}
                disabled={loading}
                style={{
                  padding: '10px 22px',
                  borderRadius: '10px',
                  border: `1px solid ${ventsColors.accentSoft}`,
                  background: 'rgba(142,92,247,0.18)',
                  color: ventsColors.accentSoft,
                  fontSize: '12.5px',
                  fontWeight: 700,
                  cursor: loading ? 'default' : 'pointer',
                  opacity: loading ? 0.6 : 1,
                }}
              >
                {loading ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          ) : loading || !config ? (
            <p style={{ color: ventsColors.ink3, fontSize: '13px', textAlign: 'center', padding: '30px 0' }}>Loading VENTS Cents info…</p>
          ) : (
            <>
              {tab === 'overview' && <OverviewTab config={config} />}
              {tab === 'earn' && <EarnTab config={config} />}
              {tab === 'spend' && <SpendTab config={config} />}
              {tab === 'cashout' && <CashoutTab config={config} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: '18px' }}>
      <p style={{ color: ventsColors.ink3, fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', marginBottom: '8px', textTransform: 'uppercase' }}>{title}</p>
      <div style={{ color: ventsColors.ink2, fontSize: '13px', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '8px 0', borderBottom: `1px solid ${ventsColors.divider}` }}>
      <span style={{ color: ventsColors.ink2, fontSize: '12.5px' }}>{label}</span>
      <span style={{ color: ventsColors.ink1, fontSize: '12.5px', fontWeight: 700, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function OverviewTab({ config }: { config: VcConfig }) {
  return (
    <>
      <Section title="What VENTS Cents are">
        <p>
          VENTS Cents (VC) are an in-app loyalty currency. They are <strong>not the same as Naira (NGN)</strong> and are not
          a wallet balance you can spend anywhere -- they are earned through specific activities in the app and spent on
          specific in-app perks, described in the Earn and Spend tabs.
        </p>
      </Section>
      <Section title="Cash-out rate (the real rate)">
        <p>
          The only rate that determines what you actually receive if you cash out VC to your bank account is:
        </p>
        <p style={{ marginTop: '6px', color: ventsColors.accentSoft, fontWeight: 800, fontSize: '14px' }}>
          1,000 VC = {fmtNaira(config.cashout_rate_naira_per_1000)}
        </p>
        <p style={{ marginTop: '6px' }}>
          Any other "≈ ₦ in ticket credit" figure you may see elsewhere in the app is a separate, display-only estimate
          and is <strong>not</strong> a cash-out rate or a way to pay for anything.
        </p>
      </Section>
      <Section title="Using VC toward tickets">
        <p style={{ color: '#FCA5A5', fontWeight: 700 }}>
          Using VENTS Cents toward ticket purchases is not currently available.
        </p>
      </Section>
    </>
  );
}

function EarnTab({ config }: { config: VcConfig }) {
  return (
    <>
      <Section title="How you earn VC">
        <Row label="Complete your profile (one-time)" value={`+${config.profile_completion_reward} VC`} />
        <Row label="Buy a ticket" value={`+${config.ticket_purchase_reward} VC`} />
        <Row label="Refer a friend who joins (you)" value={`+${config.referral_referrer_reward} VC`} />
        <Row label="Sign up via a friend's referral (them)" value={`+${config.referral_referred_reward} VC`} />
      </Section>
      <Section title="Referral qualification">
        <p>
          When someone signs up with your referral code, their reward starts as <strong>pending</strong>. It only becomes
          active once they complete their first real, paid ticket purchase -- a free ticket does not qualify a referral.
        </p>
        <p style={{ marginTop: '8px' }}>
          Your own referrer reward also starts pending and unlocks after your referred friend's qualifying purchase, then
          waits out a short hold period ({config.referral_referrer_hold_days} days) before becoming spendable. If a
          qualifying ticket is later refunded, the linked reward is reversed.
        </p>
      </Section>
      <Section title="Admin-awarded VC">
        <p>
          In rare cases VENTS staff may award VC directly (for example, to make up for a support issue). This is an
          exception, not a standard way to earn VC.
        </p>
      </Section>
    </>
  );
}

function SpendTab({ config }: { config: VcConfig }) {
  return (
    <>
      <Section title="Profile badges">
        <Row label="Bronze" value={`${config.badge_bronze_price.toLocaleString()} VC`} />
        <Row label="Silver" value={`${config.badge_silver_price.toLocaleString()} VC`} />
        <Row label="Gold" value={`${config.badge_gold_price.toLocaleString()} VC`} />
        <Row label="Platinum" value={`${config.badge_platinum_price.toLocaleString()} VC`} />
        <Row label="Elite" value={`${config.badge_elite_price.toLocaleString()} VC`} />
        <Row label="Legend" value={`${config.badge_legend_price.toLocaleString()} VC`} />
      </Section>
      <Section title="Featured in People">
        <Row label={`Feature your profile (${config.feature_me_duration_days} days)`} value={`${config.feature_me_cost.toLocaleString()} VC`} />
      </Section>
      <Section title="Event boosts (organizers)">
        <Row label={`Boost an event (${config.event_boost_duration_days} days)`} value={`${config.event_boost_cost.toLocaleString()} VC`} />
      </Section>
      <Section title="Using VC toward tickets">
        <p style={{ color: '#FCA5A5', fontWeight: 700 }}>
          Using VENTS Cents toward ticket purchases is not currently available.
        </p>
      </Section>
    </>
  );
}

function CashoutTab({ config }: { config: VcConfig }) {
  return (
    <>
      <Section title="Rate">
        <p style={{ color: ventsColors.accentSoft, fontWeight: 800, fontSize: '14px' }}>
          1,000 VC = {fmtNaira(config.cashout_rate_naira_per_1000)}
        </p>
      </Section>
      <Section title="Limits">
        <Row label="Minimum per request" value={`${config.cashout_min_vc.toLocaleString()} VC`} />
        <Row label="Maximum per request" value={`${config.cashout_max_vc.toLocaleString()} VC`} />
        <Row label="Daily maximum amount" value={`${config.cashout_daily_max_vc.toLocaleString()} VC`} />
        <Row label="Daily maximum requests" value={`${config.cashout_daily_max_requests}`} />
        <Row label="Cooldown between requests" value={`${config.cashout_cooldown_minutes} minutes`} />
        <Row label="Hold before you can cash out newly-earned VC" value={`${config.cashout_maturation_hold_hours} hours`} />
      </Section>
      <Section title="What happens after you request a cash-out">
        <p>
          Your request is <strong>submitted for review</strong> first -- nothing is paid out yet at that point. Once
          approved, we send the payment to your bank; while that is happening the request shows as
          <strong> processing</strong>. Only when the transfer is confirmed does it show as <strong>paid</strong>.
        </p>
        <p style={{ marginTop: '8px' }}>
          If a request fails, is rejected, or is cancelled, the VC you requested is returned to your balance -- you are
          never left without the VC and without the payout.
        </p>
      </Section>
      <Section title="Where cash-outs are available">
        <p>
          Cash-out is currently only available for Nigerian bank accounts, paid in Naira (NGN) through our payment
          partner, Paystack.
        </p>
      </Section>
    </>
  );
}
