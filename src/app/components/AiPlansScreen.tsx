import { useEffect, useState } from 'react';
import { fetchAiPlansPublic, initiateAiSubscriptionPayment, verifyAiSubscriptionPayment, type AiPlanPublic } from '../../lib/aiSubscription';
import { openPaystackPopup } from '../../lib/paystack';
import { supabase } from '../../lib/supabase';
import { resolveHasRealAiAccess, cancelMyAiSubscription, type AiEntitlementRow } from '../../lib/aiEntitlementClient';

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

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-NG', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

// Short, accurate per-plan positioning. These describe what a plan's own
// real included_units/hard_ceiling already provide (fetched from
// get_ai_plans_public(), never hardcoded elsewhere) -- no feature is
// named here that the backend doesn't actually have today (there is no
// multi-region search, no priority support queue, no separate "advanced
// model" -- VENTS AI's tools and model are identical across tiers; the
// only real, server-enforced differences are price and monthly usage
// allowance). ai_plus's exact wording is generated below from the real
// numbers rather than a separate hardcoded string, so it can't silently
// drift from what the plan actually grants.
const PLAN_BLURB: Record<string, string> = {
  ai: 'Explore and plan. Chat with VENTS AI to discover events, get service recommendations, and put together a basic plan.',
};

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
  // Real current-subscription state for "which tier you currently have"
  // and real renewal/expiry copy -- same get_my_ai_entitlement() RPC
  // VentsAiUnlockedScreen and the Home status pill already read (STABLE,
  // SECURITY DEFINER, auth.uid()-scoped). null means "not loaded yet /
  // no row", never a default of "active" -- no renewal date or status is
  // ever shown here unless this call actually returned one.
  const [entitlement, setEntitlement] = useState<AiEntitlementRow | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

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
    supabase.rpc('get_my_ai_entitlement').then(({ data, error: entErr }) => {
      if (!cancelled && !entErr) setEntitlement(data as AiEntitlementRow | null);
    });
    return () => { cancelled = true; };
  }, []);

  const hasRealAccess = resolveHasRealAiAccess(entitlement);
  const currentPlanId = hasRealAccess ? entitlement?.plan_id : null;

  // Cancellation is immediate, not "stop auto-renewing" -- see the
  // migration's own comment (0177_ai_subscription_self_cancellation.sql)
  // for why: this product has no recurring Paystack subscription object,
  // so there's no future charge to defer against. The confirm step exists
  // because this gives up real, already-paid-for access right now.
  async function handleCancel() {
    setError(null);
    setCancelling(true);
    try {
      const result = await cancelMyAiSubscription();
      if (result.status === 'canceled' || result.status === 'already_canceled') {
        setEntitlement((prev) => (prev ? { ...prev, status: 'canceled' } : prev));
        setConfirmingCancel(false);
      } else {
        setError('Could not cancel your subscription. Please try again.');
      }
    } catch (e: any) {
      setError(e?.message || 'Could not cancel your subscription. Please try again.');
    } finally {
      setCancelling(false);
    }
  }

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
          <p style={{ fontSize: 13, color: INK2, lineHeight: 1.5, marginBottom: 16 }}>
            VENTS itself stays free. VENTS AI is a monthly subscription that unlocks the AI assistant for planning events, finding services, and checking your account — real answers backed by real VENTS data.
          </p>

          {/* Real current-tier status -- resolveHasRealAiAccess() mirrors
              the server's own active/trialing/grace + period/grace logic,
              never a hardcoded "unlocked" claim. period_end is only ever
              shown when the entitlement row actually has one -- no
              renewal date is invented for a trial or any row without
              one. */}
          {entitlement !== null && (
            <div
              data-testid="ai-plans-current-status"
              style={{
                marginBottom: 16, fontSize: 12.5, borderRadius: 10, padding: '10px 12px',
                color: hasRealAccess ? '#c4b5fd' : INK3,
                background: hasRealAccess ? 'rgba(139,92,246,.12)' : 'rgba(255,255,255,.04)',
                border: `1px solid ${hasRealAccess ? 'rgba(139,92,246,.35)' : BORDER}`,
              }}
            >
              {hasRealAccess ? (
                <>
                  You're on <strong>{plans?.find((p) => p.plan_id === currentPlanId)?.label || currentPlanId}</strong>.
                  {entitlement?.period_end && (
                    <> {entitlement.status === 'grace' ? 'Renewal is overdue —' : 'Renews'} {formatDate(entitlement.period_end)}.</>
                  )}
                  {' '}
                  {confirmingCancel ? (
                    <>
                      Cancelling ends your access immediately (this plan has no recurring charge to stop, so there's nothing to keep paying for).{' '}
                      <button
                        onClick={handleCancel}
                        disabled={cancelling}
                        data-testid="ai-plans-cancel-confirm"
                        style={{ background: 'none', border: 'none', padding: 0, color: '#f87171', fontSize: 12.5, fontWeight: 700, cursor: cancelling ? 'default' : 'pointer', textDecoration: 'underline' }}
                      >
                        {cancelling ? 'Cancelling…' : 'Yes, cancel now'}
                      </button>
                      {' · '}
                      <button
                        onClick={() => setConfirmingCancel(false)}
                        disabled={cancelling}
                        style={{ background: 'none', border: 'none', padding: 0, color: INK3, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        Keep my subscription
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmingCancel(true)}
                      data-testid="ai-plans-cancel-start"
                      style={{ background: 'none', border: 'none', padding: 0, color: INK3, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
                    >
                      Cancel subscription
                    </button>
                  )}
                </>
              ) : (
                <>You don't have an active VENTS AI subscription{entitlement?.status === 'expired' || entitlement?.status === 'canceled' ? ' — your previous subscription has ended' : ''}. Subscribe below to chat with VENTS AI.</>
              )}
            </div>
          )}

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

          {plans && plans.map((plan, i) => {
            const isPurchasing = purchasingPlanId === plan.plan_id;
            const isVerifying = verifyingPlanId === plan.plan_id;
            const busy = isPurchasing || isVerifying;
            const isCurrent = currentPlanId === plan.plan_id;
            // ai_plus's blurb is generated from its real numbers against
            // the next plan down (ai) rather than a separate hardcoded
            // string -- if either plan's real included_units ever
            // changes, this sentence changes with it instead of silently
            // going stale.
            const lowerPlan = i > 0 ? plans[i - 1] : null;
            const blurb = PLAN_BLURB[plan.plan_id] || (lowerPlan
              ? `A more extensive planning experience, with ${Math.round(plan.included_units / lowerPlan.included_units * 10) / 10}x the monthly VENTS AI usage of ${lowerPlan.label}.`
              : 'A more extensive VENTS AI planning experience with a higher monthly usage allowance.');
            return (
              <div
                key={plan.plan_id}
                style={{ background: SURFACE, border: `1px solid ${isCurrent ? 'rgba(139,92,246,.5)' : BORDER}`, borderRadius: 16, padding: 18, marginBottom: 14 }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <span style={{ fontSize: 17, fontWeight: 800, color: INK1 }}>
                    {plan.label}
                    {isCurrent && <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 700, color: '#d3b8ff', background: 'rgba(139,92,246,.18)', borderRadius: 8, padding: '2px 7px' }}>CURRENT</span>}
                  </span>
                  <span style={{ fontSize: 17, fontWeight: 800, color: INK1 }}>{formatNaira(plan.price_kobo)}<span style={{ fontSize: 12, fontWeight: 600, color: INK3 }}>/{plan.billing_period_days === 30 ? 'month' : `${plan.billing_period_days}d`}</span></span>
                </div>
                <div style={{ fontSize: 12.5, color: INK2, marginBottom: 8, lineHeight: 1.5 }}>{blurb}</div>
                <div style={{ fontSize: 12, color: INK3, marginBottom: 14 }}>
                  {plan.included_units} AI requests included each billing period (up to {plan.hard_ceiling} total).
                </div>
                {isCurrent ? (
                  <div style={{ width: '100%', height: 44, borderRadius: 12, border: `1px solid ${BORDER}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: INK3 }}>
                    Your current plan
                  </div>
                ) : (
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
                )}
              </div>
            );
          })}

          {/* AI Pro -- deliberately shown as unavailable, never a buyable
              card. get_ai_plans_public() already excludes it server-side
              (purchasable=false, price_kobo NULL), so there is no price
              or exact usage number to show here even if this copy tried
              to -- showing one would mean inventing a number this screen
              has no authority to promise. No price, no Subscribe button,
              no exact unit counts. */}
          <div
            data-testid="ai-plan-pro-coming-soon"
            style={{ background: 'rgba(255,255,255,.02)', border: `1px dashed ${BORDER}`, borderRadius: 16, padding: 18, marginBottom: 14, opacity: 0.85 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={{ fontSize: 17, fontWeight: 800, color: INK2 }}>VENTS AI Pro</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: INK3, background: 'rgba(255,255,255,.06)', borderRadius: 8, padding: '3px 9px' }}>COMING SOON</span>
            </div>
            <div style={{ fontSize: 12.5, color: INK3, lineHeight: 1.5 }}>
              The advanced VENTS AI experience: the highest usage allowance, and — once the necessary markets and event data are in place — broader geographic discovery. Pricing and availability have not been approved yet.
            </div>
          </div>

          <p style={{ fontSize: 11, color: INK3, marginTop: 10, lineHeight: 1.6 }}>
            Billed in Nigerian Naira via Paystack. Payment is verified directly with Paystack before any access is granted. Cancel anytime from VENTS AI access settings.
          </p>
        </div>
      </div>
    </div>
  );
}
