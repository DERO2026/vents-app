import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

// VENTS AI subscription/entitlement foundation -- the customer-facing
// gate in front of VentsAiScreen. Mirrors VentsAiScreen's own hardcoded
// export-derived palette (not src/lib/ventsDesignTokens.ts, which exists
// but isn't adopted by this screen family yet) so it reads as part of
// the same screen, not a bolted-on SaaS paywall template.
//
// FINANCIAL SAFETY, by construction:
// - This component is a pure READ of get_my_ai_entitlement() (a STABLE,
//   SECURITY DEFINER RPC that reads auth.uid()'s own row -- there is no
//   argument through which a client could ask for someone else's
//   entitlement, and no write path here at all).
// - It never computes remaining units, expiry, or ceiling status from
//   anything the client controls (local storage, props, query params) --
//   every number rendered here is exactly what the server just returned.
// - "Start trial" / "Choose a plan" do NOT grant anything. start_ai_trial()
//   and check_and_reserve_ai_usage() are project_admin-only (no
//   anon/authenticated grant at all -- confirmed in
//   0165_ai_subscription_foundation.sql) -- there is no client-callable
//   RPC that could grant an entitlement, and this component does not
//   invent one. The two CTAs call onStartTrial/onUpgrade, which the
//   parent wires to a simple "not yet available" notice -- a real
//   integration point for Phase 9 (store billing), deliberately left
//   unimplemented rather than faked.
// - Gating itself only ever engages when app_config.ai_entitlement_enforced
//   is true. While it's false (production's current state), this
//   component fetches nothing and calls onContinue() immediately -- zero
//   behavior change for any current user. This is a deliberate choice:
//   shipping a client-side paywall that blocks real users while the
//   server-side enforcement flag is still off would be a silent product
//   change nobody asked for yet, not "foundation."
// - On an entitlement-check failure WHILE enforcement is genuinely on,
//   this fails CLOSED (shows the error state, does not call onContinue)
//   -- the same fail-closed posture aiAssistantHandler.ts itself uses for
//   an unexpected check_and_reserve_ai_usage error. Nothing here ever
//   fails open past a real, on, enforcement flag.

const GRADIENT = 'linear-gradient(135deg,#c084fc,#7c3aed)';
const BG = '#0a0810';
const SURFACE = '#120e1a';
const ELEVATED = '#1c1726';
const BORDER = '#2c2438';
const INK1 = '#f2eff6';
const INK2 = '#c9c0d4';
const INK3 = '#8a7f97';
const ACCENT = '#d3b8ff';

type Entitlement = {
  plan_id: string | null;
  status: 'inactive' | 'trialing' | 'active' | 'grace' | 'expired' | 'canceled';
  period_start?: string | null;
  period_end?: string | null;
  grace_until?: string | null;
  trial_used: boolean;
  used_units?: number;
  included_units?: number;
  hard_ceiling?: number;
};

type GateState =
  | { kind: 'checking' }
  | { kind: 'allow' }
  | { kind: 'no_entitlement'; trialUsed: boolean }
  | { kind: 'trial_active'; used: number; ceiling: number }
  | { kind: 'paid_active'; used: number; included: number; ceiling: number; nearCeiling: boolean }
  | { kind: 'ceiling_reached'; isTrial: boolean }
  | { kind: 'expired' }
  | { kind: 'error' };

// Planning-stage placeholder plan copy -- matches the backend's current
// ai_plans configuration (0165_ai_subscription_foundation.sql) exactly.
// NOT fetched from the server: ai_plans has no RLS policy allowing any
// direct client read, so these numbers would need a future read-only RPC
// if they're ever meant to be server-driven. Flagged, not silently
// worked around.
const PLAN_COPY = [
  { id: 'ai', label: 'VENTS AI', included: 50, ceiling: 75 },
  { id: 'ai_plus', label: 'VENTS AI+', included: 100, ceiling: 150 },
  { id: 'ai_pro', label: 'VENTS AI Pro', included: 220, ceiling: 320 },
] as const;
const TRIAL_UNITS = 15;

function resolveState(ent: Entitlement): GateState {
  const now = Date.now();
  const periodEndPassed = !!ent.period_end && new Date(ent.period_end).getTime() < now;

  if (!ent.plan_id || ent.status === 'inactive') {
    return { kind: 'no_entitlement', trialUsed: !!ent.trial_used };
  }
  if (ent.status === 'expired' || ent.status === 'canceled' || (periodEndPassed && !ent.grace_until)) {
    return { kind: 'expired' };
  }

  const used = ent.used_units ?? 0;
  const included = ent.included_units ?? 0;
  const ceiling = ent.hard_ceiling ?? 0;

  if (ceiling > 0 && used >= ceiling) {
    return { kind: 'ceiling_reached', isTrial: ent.status === 'trialing' };
  }
  if (ent.status === 'trialing') {
    return { kind: 'trial_active', used, ceiling };
  }
  // 'active' or 'grace'
  return { kind: 'paid_active', used, included, ceiling, nearCeiling: included > 0 && used >= included };
}

export function AiAccessScreen({
  onClose,
  onContinue,
  onStartTrial,
  onUpgrade,
}: {
  onClose: () => void;
  /** Called once access is confirmed (or enforcement is off) -- parent then renders the real VentsAiScreen. */
  onContinue: () => void;
  onStartTrial?: () => void;
  onUpgrade?: (planId: string) => void;
}) {
  const [state, setState] = useState<GateState>({ kind: 'checking' });
  const [notice, setNotice] = useState<string | null>(null);

  const check = async () => {
    setState({ kind: 'checking' });
    try {
      const { data: enforced, error: enforcedErr } = await supabase.rpc('ai_entitlement_enforced');
      if (enforcedErr || enforced !== true) {
        // Enforcement off (the current production default) -- or the
        // flag itself couldn't be read, which fails the same way: never
        // gate on an unreadable enforcement flag, only on a confirmed
        // `true`. Zero behavior change for any current user. onContinue()
        // fires from the state-driven effect below, exactly once.
        setState({ kind: 'allow' });
        return;
      }

      const { data, error } = await supabase.rpc('get_my_ai_entitlement');
      if (error || !data) {
        setState({ kind: 'error' });
        return;
      }
      setState(resolveState(data as Entitlement));
    } catch {
      setState({ kind: 'error' });
    }
  };

  useEffect(() => {
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Access-granted states hand off to the real screen via onContinue().
  // This is a single, unconditionally-called effect (never a
  // conditionally-invoked hook) that reacts to state.kind -- required by
  // React's rules of hooks, since hooks can't be called from inside an
  // `if` block.
  useEffect(() => {
    if (state.kind === 'allow' || state.kind === 'trial_active' || state.kind === 'paid_active') {
      onContinue();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  // Allowed states render nothing of their own -- the parent switches to
  // the real VentsAiScreen once onContinue() fires above. 'checking' and
  // every gated/blocked state render the screen below.
  if (state.kind === 'allow' || state.kind === 'trial_active' || state.kind === 'paid_active') return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: BG,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 50,
      }}
    >
      <Header onClose={onClose} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px calc(32px + env(safe-area-inset-bottom, 0px))' }}>
        {state.kind === 'checking' && <CheckingBody />}
        {state.kind === 'error' && <ErrorBody onRetry={check} />}
        {state.kind === 'no_entitlement' && (
          <PaywallBody
            trialUsed={state.trialUsed}
            onStartTrial={() => (onStartTrial ? onStartTrial() : setNotice('Trials open soon -- check back shortly.'))}
            onUpgrade={(id) => (onUpgrade ? onUpgrade(id) : setNotice('VENTS AI plans aren’t purchasable yet -- check back shortly.'))}
          />
        )}
        {state.kind === 'ceiling_reached' && (
          <CeilingReachedBody
            isTrial={state.isTrial}
            onUpgrade={(id) => (onUpgrade ? onUpgrade(id) : setNotice('VENTS AI plans aren’t purchasable yet -- check back shortly.'))}
          />
        )}
        {state.kind === 'expired' && (
          <ExpiredBody onUpgrade={(id) => (onUpgrade ? onUpgrade(id) : setNotice('VENTS AI plans aren’t purchasable yet -- check back shortly.'))} />
        )}
      </div>
      {notice && <NoticeToast text={notice} onDismiss={() => setNotice(null)} />}
    </div>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        height: 50,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        borderBottom: `1px solid ${BORDER}`,
      }}
    >
      <button
        onClick={onClose}
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: ELEVATED,
          border: `1px solid ${BORDER}`,
          color: '#e4d4ff',
          fontSize: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        ←
      </button>
      <div style={{ marginLeft: 12, fontSize: 15, fontWeight: 800, color: INK1 }}>VENTS AI</div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: 10,
        letterSpacing: '.16em',
        color: ACCENT,
        marginBottom: 10,
        textTransform: 'uppercase',
      }}
    >
      {children}
    </div>
  );
}

function PromoCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'linear-gradient(160deg, rgba(163,92,255,.16), rgba(18,14,26,1) 70%)',
        border: '1px solid rgba(163,92,255,.35)',
        borderRadius: 16,
        padding: 18,
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

function PrimaryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        padding: '13px 16px',
        borderRadius: 12,
        background: GRADIENT,
        color: '#fff',
        fontWeight: 700,
        fontSize: 14,
        border: 'none',
      }}
    >
      {label}
    </button>
  );
}

function SecondaryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        padding: '13px 16px',
        borderRadius: 12,
        background: ELEVATED,
        border: `1px solid ${BORDER}`,
        color: INK2,
        fontWeight: 600,
        fontSize: 14,
        marginTop: 8,
      }}
    >
      {label}
    </button>
  );
}

function PlanRow({ plan }: { plan: (typeof PLAN_COPY)[number] }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 14px',
        borderRadius: 12,
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        marginBottom: 8,
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: INK1 }}>{plan.label}</div>
        <div style={{ fontSize: 12, color: INK3, marginTop: 2 }}>
          {plan.included} included &middot; {plan.ceiling} max
        </div>
      </div>
    </div>
  );
}

function CheckingBody() {
  return <div style={{ color: INK3, fontSize: 13, textAlign: 'center', marginTop: 60 }}>Checking your VENTS AI access…</div>;
}

function ErrorBody({ onRetry }: { onRetry: () => void }) {
  return (
    <div>
      <PromoCard>
        <SectionLabel>VENTS AI</SectionLabel>
        <div style={{ fontSize: 17, fontWeight: 800, color: INK1, marginBottom: 8 }}>
          We couldn&apos;t check your access
        </div>
        <div style={{ fontSize: 13, color: INK2, lineHeight: 1.5 }}>
          Something went wrong reaching VENTS AI. Nothing was changed or charged.
        </div>
      </PromoCard>
      <PrimaryButton label="Try again" onClick={onRetry} />
    </div>
  );
}

function PaywallBody({
  trialUsed,
  onStartTrial,
  onUpgrade,
}: {
  trialUsed: boolean;
  onStartTrial: () => void;
  onUpgrade: (planId: string) => void;
}) {
  return (
    <div>
      <PromoCard>
        <SectionLabel>VENTS AI</SectionLabel>
        <div style={{ fontSize: 17, fontWeight: 800, color: INK1, marginBottom: 8 }}>
          VENTS AI is a premium feature
        </div>
        <div style={{ fontSize: 13, color: INK2, lineHeight: 1.5 }}>
          {trialUsed
            ? 'Your free trial has already been used on this account. Choose a plan below to continue.'
            : `Try VENTS AI free for ${TRIAL_UNITS} messages, then continue with a plan that fits you.`}
        </div>
      </PromoCard>
      {!trialUsed && <PrimaryButton label={`Start your free ${TRIAL_UNITS}-message trial`} onClick={onStartTrial} />}
      <div style={{ marginTop: 20 }}>
        <SectionLabel>PLANS</SectionLabel>
        {PLAN_COPY.map((plan) => (
          <PlanRow key={plan.id} plan={plan} />
        ))}
      </div>
      {trialUsed && <PrimaryButton label="Choose a plan" onClick={() => onUpgrade(PLAN_COPY[0].id)} />}
    </div>
  );
}

function CeilingReachedBody({ isTrial, onUpgrade }: { isTrial: boolean; onUpgrade: (planId: string) => void }) {
  return (
    <div>
      <PromoCard>
        <SectionLabel>USAGE LIMIT REACHED</SectionLabel>
        <div style={{ fontSize: 17, fontWeight: 800, color: INK1, marginBottom: 8 }}>
          {isTrial ? 'Your trial is complete' : "You've reached this period's AI limit"}
        </div>
        <div style={{ fontSize: 13, color: INK2, lineHeight: 1.5 }}>
          {isTrial
            ? 'You’ve used all your free trial messages. Choose a plan to keep using VENTS AI.'
            : 'Upgrade to a higher plan, or wait for your next billing period to continue.'}
        </div>
      </PromoCard>
      <div style={{ marginBottom: 20 }}>
        {PLAN_COPY.map((plan) => (
          <PlanRow key={plan.id} plan={plan} />
        ))}
      </div>
      <PrimaryButton label="Choose a plan" onClick={() => onUpgrade(PLAN_COPY[0].id)} />
    </div>
  );
}

function ExpiredBody({ onUpgrade }: { onUpgrade: (planId: string) => void }) {
  return (
    <div>
      <PromoCard>
        <SectionLabel>SUBSCRIPTION ENDED</SectionLabel>
        <div style={{ fontSize: 17, fontWeight: 800, color: INK1, marginBottom: 8 }}>Your VENTS AI plan has ended</div>
        <div style={{ fontSize: 13, color: INK2, lineHeight: 1.5 }}>
          Renew to keep chatting with VENTS AI.
        </div>
      </PromoCard>
      <div style={{ marginBottom: 20 }}>
        {PLAN_COPY.map((plan) => (
          <PlanRow key={plan.id} plan={plan} />
        ))}
      </div>
      <PrimaryButton label="Renew" onClick={() => onUpgrade(PLAN_COPY[0].id)} />
    </div>
  );
}

function NoticeToast({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <div
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 'calc(24px + env(safe-area-inset-bottom, 0px))',
        background: ELEVATED,
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        padding: '12px 14px',
        color: INK2,
        fontSize: 13,
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  );
}
