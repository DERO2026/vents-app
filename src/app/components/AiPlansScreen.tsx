import { useEffect, useState } from 'react';
import { fetchAiPlansPublic, initiateAiSubscriptionPayment, verifyAiSubscriptionPayment, type AiPlanPublic } from '../../lib/aiSubscription';
import { openPaystackPopup } from '../../lib/paystack';
import { supabase } from '../../lib/supabase';

// Real VENTS AI paywall/plans screen. Every price, plan name, and unit
// count shown here comes from get_ai_plans_public() (0175_ai_subscription_
// payments.sql) -- never hardcoded copy. A plan with no approved price
// (VENTS AI Pro, at the time this was written) simply never appears:
// get_ai_plans_public() excludes it server-side, so there is no client
// code path that could display or sell an unresolved price.
//
// Purchase flow: initiate (server records real intent + locks in the real
// price) -> Paystack popup -> verify (server re-checks with Paystack
// directly, then grants the entitlement) -- the exact same architecture
// every other VENTS payment uses (see src/lib/aiSubscription.ts). This
// screen never grants anything itself; "success" here only ever reflects
// what the server's verify call actually returned.

const BG = '#0a0810';
const SURFACE = '#120e1a';
const BORDER = '#2c2438';
const INK1 = '#f2eff6';
const INK2 = '#c9c0d4';
const INK3 = '#8a7f97';
const GRADIENT = 'linear-gradient(135deg,#c084fc,#7c3aed)';

function formatNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG')}`;
}

export function AiPlansScreen({
  onClose,
  onSubscribed,
}: {
  onClose: () => void;
  onSubscribed: () => void;
}) {
  const [plans, setPlans] = useState<AiPlanPublic[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [purchasingPlanId, setPurchasingPlanId] = useState<string | null>(null);
  const [verifyingPlanId, setVerifyingPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Paystack's popup requires a real email to attach the charge to --
  // read directly from the authenticated session (never a prop the parent
  // could skip threading through), same source CustomerWalletScreen's own
  // deposit flow uses.
  const [userEmail, setUserEmail] = useState<string>('');
  const [userName, setUserName] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    fetchAiPlansPublic()
      .then((rows) => { if (!cancelled) setPlans(rows); })
      .catch((e) => { if (!cancelled) setLoadError(e?.message || 'Could not load plans.'); });
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setUserEmail(data.user?.email || '');
      setUserName((data.user?.user_metadata as any)?.full_name || '');
    });
    return () => { cancelled = true; };
  }, []);

  async function handleSubscribe(plan: AiPlanPublic) {
    setError(null);
    if (!userEmail) {
      setError('Could not read your account email. Please try again in a moment.');
      return;
    }
    setPurchasingPlanId(plan.plan_id);
    try {
      const intent = await initiateAiSubscriptionPayment(plan.plan_id);
      openPaystackPopup({
        email: userEmail,
        amountKobo: intent.amount_kobo,
        ref: intent.reference,
        label: userName || 'VENTS AI subscription',
        metadata: { purpose: 'ai_subscription', plan_id: intent.plan_id },
        onSuccess: async () => {
          setPurchasingPlanId(null);
          setVerifyingPlanId(plan.plan_id);
          const result = await verifyAiSubscriptionPayment(intent.reference);
          setVerifyingPlanId(null);
          if (result.status === 'success') {
            setSuccess(`${plan.label} is now active.`);
            onSubscribed();
          } else if (result.status === 'abandoned') {
            setError('Payment was not completed. You have not been charged.');
          } else if (result.status === 'failed') {
            setError('Payment failed. You have not been charged.');
          } else {
            setError(result.error || 'Could not verify this payment. If you were charged, contact support with your reference: ' + intent.reference);
          }
        },
        onClose: () => setPurchasingPlanId(null),
        onError: (message) => { setPurchasingPlanId(null); setError(message); },
      });
    } catch (e: any) {
      setPurchasingPlanId(null);
      setError(e?.message === 'plan_not_purchasable' ? 'This plan is not available for purchase yet.' : (e?.message || 'Could not start checkout.'));
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: BG, display: 'flex', flexDirection: 'column', zIndex: 960 }}>
      <div style={{ height: 50, flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 12px', borderBottom: `1px solid ${BORDER}` }}>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{ width: 34, height: 34, borderRadius: 10, background: SURFACE, border: `1px solid ${BORDER}`, color: '#e4d4ff', fontSize: 16, cursor: 'pointer' }}
        >
          ✕
        </button>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 15, fontWeight: 800, color: INK1, marginRight: 34 }}>VENTS AI Plans</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px calc(32px + env(safe-area-inset-bottom, 0px))' }}>
        <div style={{ maxWidth: 440, margin: '0 auto' }}>
          <p style={{ fontSize: 13, color: INK2, lineHeight: 1.5, marginBottom: 20 }}>
            VENTS itself stays free. VENTS AI is a monthly subscription that unlocks the AI assistant for planning events, finding services, and checking your account — real answers backed by real VENTS data.
          </p>

          {success && (
            <div style={{ marginBottom: 16, fontSize: 13, color: '#34d399', background: 'rgba(52,211,153,.08)', border: '1px solid rgba(52,211,153,.3)', borderRadius: 10, padding: 12 }}>
              {success}
            </div>
          )}
          {error && (
            <div style={{ marginBottom: 16, fontSize: 13, color: '#fbbf24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 10, padding: 12 }}>
              {error}
            </div>
          )}

          {plans === null && !loadError && (
            <div style={{ fontSize: 13, color: INK3 }}>Loading plans…</div>
          )}
          {loadError && (
            <div style={{ fontSize: 13, color: '#f87171' }}>{loadError}</div>
          )}
          {plans && plans.length === 0 && (
            <div style={{ fontSize: 13, color: INK3 }}>No plans are available for purchase right now. Check back soon.</div>
          )}

          {plans && plans.map((plan) => {
            const isPurchasing = purchasingPlanId === plan.plan_id;
            const isVerifying = verifyingPlanId === plan.plan_id;
            const busy = isPurchasing || isVerifying;
            return (
              <div key={plan.plan_id} style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 16, padding: 18, marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <span style={{ fontSize: 17, fontWeight: 800, color: INK1 }}>{plan.label}</span>
                  <span style={{ fontSize: 17, fontWeight: 800, color: INK1 }}>{formatNaira(plan.price_kobo)}<span style={{ fontSize: 12, fontWeight: 600, color: INK3 }}>/{plan.billing_period_days === 30 ? 'month' : `${plan.billing_period_days}d`}</span></span>
                </div>
                <div style={{ fontSize: 12.5, color: INK2, marginBottom: 14 }}>
                  {plan.included_units} AI requests included each billing period (up to {plan.hard_ceiling} total).
                </div>
                <button
                  onClick={() => handleSubscribe(plan)}
                  disabled={busy}
                  data-testid={`ai-plan-subscribe-${plan.plan_id}`}
                  style={{
                    width: '100%', height: 44, borderRadius: 12, border: 'none', cursor: busy ? 'default' : 'pointer',
                    background: busy ? 'rgba(255,255,255,.08)' : GRADIENT, color: busy ? INK3 : '#fff', fontSize: 14, fontWeight: 700,
                  }}
                >
                  {isPurchasing ? 'Opening checkout…' : isVerifying ? 'Verifying payment…' : `Subscribe for ${formatNaira(plan.price_kobo)}/mo`}
                </button>
              </div>
            );
          })}

          <p style={{ fontSize: 11, color: INK3, marginTop: 10, lineHeight: 1.6 }}>
            Billed in Nigerian Naira via Paystack. Payment is verified directly with Paystack before any access is granted. Cancel anytime from VENTS AI access settings.
          </p>
        </div>
      </div>
    </div>
  );
}
