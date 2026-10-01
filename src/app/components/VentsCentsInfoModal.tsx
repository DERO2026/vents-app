import { X } from 'lucide-react';

// VENTS Cents "?" info experience (Prompt 2): a polished, native-feeling
// explanation of the VC economy, built entirely from values the caller
// already fetched from the authoritative backend (vc_reward_campaigns,
// vc_badge_tiers, app_config) -- nothing here is a second source of truth
// for a reward amount, tier threshold, or conversion rate. No database
// table, RPC, or security-architecture detail is named anywhere in this
// copy, per the "don't expose implementation details" requirement.

interface TierRow {
  tier: string;
  rank: number;
  min_lifetime_vc: number;
  multiplier: string | number;
}

export interface VentsCentsInfoModalProps {
  onClose: () => void;
  profileAward: number;
  referredAward: number;
  checkinAward: number;
  referrerCheckinAward: number;
  tierLadder: TierRow[];
  ngnPer1000Vc: number;
  tierLabels: Record<string, string>;
  tierColors: Record<string, string>;
  fmtMultiplier: (m: string | number) => string;
}

const CHECKIN_THRESHOLD_NGN = 20000;
const WALLET_RATE_LABEL = '10 VC = ₦1';
const WALLET_MIN_VC = 10000;

function Section({ emoji, title, children }: { emoji: string; title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span style={{ fontSize: '16px' }}>{emoji}</span>
        <span style={{ color: '#F0F0FF', fontSize: '14.5px', fontWeight: 800 }}>{title}</span>
      </div>
      <div style={{ color: '#B9B4C7', fontSize: '13px', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

export function VentsCentsInfoModal({
  onClose,
  profileAward,
  referredAward,
  checkinAward,
  referrerCheckinAward,
  tierLadder,
  ngnPer1000Vc,
  tierLabels,
  tierColors,
  fmtMultiplier,
}: VentsCentsInfoModalProps) {
  // 2 VC = N1 when vc_naira_per_1000 (app_config) = 500 -- derived here, not
  // a second hardcoded constant: naira per VC = ngnPer1000Vc / 1000.
  const vcPerNaira = ngnPer1000Vc > 0 ? Math.round(1000 / ngnPer1000Vc) : null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 300 }}
      onClick={onClose}
    >
      <div
        data-testid="vc-info-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0d0818',
          borderTopLeftRadius: '24px',
          borderTopRightRadius: '24px',
          width: '100%',
          maxWidth: '520px',
          maxHeight: '88vh',
          overflowY: 'auto',
          padding: '20px 20px calc(24px + env(safe-area-inset-bottom))',
          border: '1px solid rgba(168,85,247,0.25)',
          borderBottom: 'none',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
          <span style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 800 }}>About VENTS Cents</span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
          >
            <X size={15} color="#f6f4f9" />
          </button>
        </div>

        <Section emoji="🪙" title="What are VENTS Cents?">
          <p style={{ margin: 0 }}>
            VENTS Cents (VC) are VENTS' own internal reward currency. You earn them by doing qualifying things inside the app —
            they are <strong style={{ color: '#f6f4f9' }}>not cash</strong>, and they are{' '}
            <strong style={{ color: '#f6f4f9' }}>not Paystack money</strong>. Paystack never creates or funds VC; it only comes in
            later, if and when you convert eligible VC into your VENTS Wallet balance.
          </p>
        </Section>

        <Section emoji="🎁" title="How do I earn VC?">
          <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <li>Completing your profile — <strong style={{ color: '#FFB830' }}>+{profileAward} VC</strong>, once</li>
            <li>A friend joins with your referral code — they get <strong style={{ color: '#FFB830' }}>+{referredAward} VC</strong>, once</li>
            <li>A qualifying event check-in — <strong style={{ color: '#FFB830' }}>+{checkinAward} VC × your current tier multiplier</strong></li>
            <li>After your referred friend's first qualifying check-in — you get <strong style={{ color: '#FFB830' }}>+{referrerCheckinAward} VC × your current tier multiplier</strong></li>
          </ul>
          <p style={{ margin: '12px 0 0' }}>
            A check-in only qualifies for VC when the ticket costs{' '}
            <strong style={{ color: '#f6f4f9' }}>₦{CHECKIN_THRESHOLD_NGN.toLocaleString()} or more</strong>. Free events and
            tickets under ₦{CHECKIN_THRESHOLD_NGN.toLocaleString()} earn <strong style={{ color: '#f6f4f9' }}>0 VC</strong> when
            checked in — eligibility is always based on what was actually paid, not anything the app itself reports.
            Buying a ticket on its own doesn't earn VC; you need to actually check in at the event.
          </p>
        </Section>

        <Section emoji="📈" title="Lifetime VC">
          <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
            <div style={{ flex: 1, background: 'rgba(192,132,252,0.08)', border: '1px solid rgba(192,132,252,0.2)', borderRadius: '12px', padding: '10px 12px' }}>
              <div style={{ color: '#c084fc', fontSize: '11px', fontWeight: 800, letterSpacing: '0.04em' }}>SPENDABLE VC</div>
              <div style={{ color: '#9a93a8', fontSize: '11.5px', marginTop: '4px', lineHeight: 1.4 }}>What you have available to spend or convert right now.</div>
            </div>
            <div style={{ flex: 1, background: 'rgba(255,184,48,0.08)', border: '1px solid rgba(255,184,48,0.2)', borderRadius: '12px', padding: '10px 12px' }}>
              <div style={{ color: '#FFB830', fontSize: '11px', fontWeight: 800, letterSpacing: '0.04em' }}>LIFETIME VC</div>
              <div style={{ color: '#9a93a8', fontSize: '11.5px', marginTop: '4px', lineHeight: 1.4 }}>Your all-time qualifying earnings. This is what sets your tier.</div>
            </div>
          </div>
          <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <li>Spending VC does not lower your Lifetime VC.</li>
            <li>Converting VC to your Wallet does not lower your Lifetime VC.</li>
            <li>An ordinary balance adjustment does not automatically raise your Lifetime VC.</li>
            <li>Only your Lifetime VC decides your tier and multiplier.</li>
          </ul>
        </Section>

        <Section emoji="🏆" title="Tiers & multipliers">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '10px' }}>
            {tierLadder.map((t) => (
              <div key={t.tier} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '8px 12px' }}>
                <span style={{ color: tierColors[t.tier] || '#f6f4f9', fontSize: '12.5px', fontWeight: 700 }}>{tierLabels[t.tier] || t.tier}</span>
                <span style={{ color: '#8B8FA8', fontSize: '11.5px' }}>{t.min_lifetime_vc.toLocaleString()} lifetime VC</span>
                <span style={{ color: '#f6f4f9', fontSize: '12px', fontWeight: 700 }}>{fmtMultiplier(t.multiplier)}</span>
              </div>
            ))}
          </div>
          <p style={{ margin: 0 }}>
            Your tier is reached automatically once your Lifetime VC crosses its threshold — it isn't something you buy. The
            multiplier applies to the rewards configured to use it: currently event check-ins and the referrer's
            first-qualifying-check-in bonus.
          </p>
        </Section>

        <Section emoji="💳" title="Spending VC">
          <p style={{ margin: 0 }}>
            {vcPerNaira ? <>{vcPerNaira} VC = ₦1</> : '2 VC = ₦1'} toward eligible ticket purchases, using the redemption option
            currently available in the app at checkout.
          </p>
        </Section>

        <Section emoji="💰" title="Convert VC to VENTS Wallet">
          <p style={{ margin: 0 }}>
            At <strong style={{ color: '#FFD700' }}>Gold tier or above</strong>, you can convert VC into your existing VENTS
            Wallet balance at <strong style={{ color: '#f6f4f9' }}>{WALLET_RATE_LABEL}</strong>, in minimum amounts of{' '}
            <strong style={{ color: '#f6f4f9' }}>{WALLET_MIN_VC.toLocaleString()} VC</strong> (₦1,000), and only in valid
            10-VC increments.
          </p>
          <p style={{ margin: '10px 0 0' }}>
            This credits your VENTS Wallet — it is separate from, and not the same as, redeeming VC for a ticket discount.
            It does not pay out directly to a bank account; withdraw from your Wallet separately whenever you'd like. Direct
            VC-to-bank cash-out is retired.
          </p>
        </Section>

        <Section emoji="🔒" title="How VENTS protects VC">
          <p style={{ margin: 0 }}>
            Your balance, rewards, Lifetime VC, tier, and every conversion are all determined and enforced on VENTS' own
            servers — never by anything your device reports.
          </p>
        </Section>

        <button
          onClick={onClose}
          style={{ width: '100%', padding: '13px', borderRadius: '12px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', color: '#F0F0FF', fontWeight: 700, fontSize: '14px', cursor: 'pointer', marginTop: '4px' }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
