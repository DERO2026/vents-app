import { useEffect, useRef, useState } from 'react';
import { sendVentsAiMessage, type VentsAiMessage } from '../../lib/ventsAi';
import { supabase } from '../../lib/supabase';
import { PickerSheet, PickerField } from './shared/PickerSheet';
import { COUNTRY_CODES } from '../../lib/countries';
import { AiPlansScreen } from './AiPlansScreen';

// VENTS AI full-screen conversational assistant, reproducing
// design-export/"VENTS AI.dc.html"'s Home + Conversation views. Every color,
// spacing, border-radius and copy string below is taken directly from that
// export -- see the per-section comments for the exact export line it
// mirrors. Card *data* is real (from api/ai-assistant.ts's response), never
// the export's scripted SCEN mock data.
//
// "RECENT CONVERSATIONS" persistence: this repo has no global state/Context
// and no backend table for AI conversation history (confirmed against
// api/ai-assistant.ts and api/_lib/aiTools.ts -- neither persists anything,
// every round trip is stateless besides the confirmation token). Building a
// new backend table for this would be new scope beyond wiring the existing
// backend, so conversation history here is in-memory, scoped to this
// component's own state for the session -- it survives switching tabs away
// and back (App.tsx mounts this once and keeps it alive with the same
// display:none pattern used for HomeScreen/MyTicketsScreen), but resets on
// a full reload, sign-out, or app restart.

const GRADIENT = 'linear-gradient(135deg,#c084fc,#7c3aed)';

type BackendCard = { type: string; data: unknown; source?: 'vents' | 'external' | 'general' };

type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  cards?: BackendCard[];
  confirmation?: { action: string; params: Record<string, unknown>; proposal: Record<string, unknown>; token: string; resolved?: 'confirmed' | 'cancelled' };
};

type LocalConversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
  // When set, this conversation is a plan's pinned SI thread (§01 IA: "one
  // pinned SI thread per plan"), not general Chat. Every outgoing message
  // in a plan thread carries this id as plan context (see sendText) so SI
  // can call get_plan/propose_plan_update/etc. against the right plan --
  // this is a hint for the MODEL's tool arguments, never an authorization
  // mechanism: every plan tool still independently re-checks ownership
  // server-side regardless of what context the client sent.
  planId?: string;
};

// Fetched via get_plans_overview() (migration 0160) -- one aggregate RPC
// call for every one of the caller's own plans, rather than an N+1 of
// per-plan fetchPlanWorkspace-style reads just to render the P25 list.
// readiness_pct/committed_or_paid_kobo/overdue_task_count mirror
// computeReadiness()'s own formula and the Tasks tab's own due-date
// derivation exactly, computed server-side in SQL.
type PlanSummary = {
  id: string;
  title: string;
  event_type: string;
  status: string;
  event_date: string | null;
  city: string | null;
  guests: number | null;
  total_kobo: number | null;
  currency: string;
  created_at: string;
  readiness_pct: number;
  committed_or_paid_kobo: number;
  overdue_task_count: number;
};

type WorkspaceAssignment = {
  id: string;
  provider_id: string | null;
  own_vendor_name: string | null;
  agreed_kobo: number | null;
  status: 'shortlisted' | 'assigned' | 'booked' | 'cancelled';
  provider: { business_name: string; category: string | null; location: string | null } | null;
  // Real timestamp -- P14's "just now" receipt and its "relaxes to a
  // normal row on next visit" rule are both read off this, never a
  // frontend-only flag with no backing data.
  updated_at: string;
};

type WorkspaceCategory = {
  id: string;
  key: string;
  label: string;
  // 'custom' when added via "+ Category" (migration 0161's
  // add_plan_category) -- S2-C's own signal for "not a VENTS service
  // category," distinct from a template-seeded category (always NULL
  // today; that column exists but was never populated for the seed path).
  vents_category: string | null;
  allocated_kobo: number;
  is_priority: boolean;
  // A contingency line (e.g. "Contingency ₦800,000") has no team slot at
  // all -- the mockup's own Budget tab lists it as a value-only row, and
  // the Team tab's "N of M assigned" count/list excludes it entirely.
  is_contingency: boolean;
  committed_kobo: number;
  paid_kobo: number;
  booked: boolean;
  // All assignment rows for this category, every status -- P10/P11 need
  // shortlisted/cancelled rows too (shortlist counts, "own vendor" glyph),
  // not just the active assigned/booked one get_plan's own summary needs.
  assignments: WorkspaceAssignment[];
};

type WorkspaceTask = {
  id: string;
  category_id: string | null;
  title: string;
  offset_days: number | null;
  due_override: string | null;
  done_at: string | null;
  source: 'si' | 'user';
  // A task a real booking auto-completes -- P10's own spec text: "can't
  // be unticked manually, the booking is the truth."
  completes_on_booking: boolean;
};

type WorkspaceMilestone = { id: string; phase_key: string; label: string; ends_offset_days: number };

type PlanWorkspaceData = {
  plan: { id: string; title: string; event_type: string; status: string; event_date: string | null; city: string | null; guests: number | null; total_kobo: number | null };
  categories: WorkspaceCategory[];
  tasks: WorkspaceTask[];
  milestones: WorkspaceMilestone[];
};

// Mirrors api/_lib/aiTools.ts's executeGetPlan query shape exactly (same
// tables, same RLS) -- a plain authoritative read for the dedicated Plan
// Workspace (P07/P08), done directly rather than spending a model call
// just to render a screen. Both this and get_plan read the identical
// source of truth; neither is more "real" than the other.
async function fetchPlanWorkspace(planId: string): Promise<PlanWorkspaceData> {
  const { data: plan, error: planError } = await supabase
    .from('plans')
    .select('id, title, event_type, status, event_date, city, guests, total_kobo')
    .eq('id', planId)
    .single();
  if (planError) throw planError;

  const { data: categories } = await supabase
    .from('plan_categories')
    .select('id, key, label, vents_category, allocated_kobo, is_priority, is_contingency, sort')
    .eq('plan_id', planId)
    .order('sort');
  const categoryIds = (categories ?? []).map((c: any) => c.id);

  const { data: assignments } = categoryIds.length
    ? await supabase.from('plan_assignments').select('id, category_id, provider_id, own_vendor_name, agreed_kobo, status, updated_at').in('category_id', categoryIds)
    : { data: [] as any[] };

  // One extra join for the VENTS providers referenced by any assignment --
  // plan_assignments itself only has provider_id; business_name/category/
  // location live on service_providers, same table every other provider
  // card in this file already reads.
  const providerIds = [...new Set((assignments ?? []).map((a: any) => a.provider_id).filter(Boolean))];
  const { data: providers } = providerIds.length
    ? await supabase.from('service_providers').select('id, business_name, category, location').in('id', providerIds)
    : { data: [] as any[] };
  const providerById = new Map<string, any>((providers ?? []).map((p: any) => [p.id, p]));

  const { data: tasks } = await supabase
    .from('plan_tasks')
    .select('id, category_id, title, offset_days, due_override, done_at, source, completes_on_booking')
    .eq('plan_id', planId);

  const { data: milestones } = await supabase
    .from('plan_milestones')
    .select('id, phase_key, label, ends_offset_days')
    .eq('plan_id', planId)
    .order('ends_offset_days');

  const byCategory = new Map<string, any[]>();
  for (const a of assignments ?? []) {
    const list = byCategory.get(a.category_id) ?? [];
    list.push(a);
    byCategory.set(a.category_id, list);
  }

  return {
    plan,
    categories: (categories ?? []).map((c: any) => {
      const all: WorkspaceAssignment[] = (byCategory.get(c.id) ?? []).map((a: any) => ({
        id: a.id,
        provider_id: a.provider_id,
        own_vendor_name: a.own_vendor_name,
        agreed_kobo: a.agreed_kobo,
        status: a.status,
        provider: a.provider_id ? providerById.get(a.provider_id) ?? null : null,
        updated_at: a.updated_at,
      }));
      const active = all.filter((a) => a.status === 'assigned' || a.status === 'booked');
      return {
        id: c.id,
        key: c.key,
        label: c.label,
        vents_category: c.vents_category ?? null,
        allocated_kobo: c.allocated_kobo ?? 0,
        is_priority: !!c.is_priority,
        is_contingency: !!c.is_contingency,
        committed_kobo: active.filter((a) => a.status === 'assigned').reduce((s, a) => s + (a.agreed_kobo ?? 0), 0),
        paid_kobo: active.filter((a) => a.status === 'booked').reduce((s, a) => s + (a.agreed_kobo ?? 0), 0),
        booked: active.some((a) => a.status === 'booked'),
        assignments: all,
      };
    }),
    tasks: (tasks ?? []).map((t: any) => ({
      id: t.id,
      category_id: t.category_id,
      title: t.title,
      offset_days: t.offset_days,
      due_override: t.due_override,
      done_at: t.done_at,
      source: t.source === 'si' ? 'si' : 'user',
      completes_on_booking: !!t.completes_on_booking,
    })),
    milestones: (milestones ?? []).map((m: any) => ({ id: m.id, phase_key: m.phase_key, label: m.label, ends_offset_days: m.ends_offset_days })),
  };
}

// Readiness formula per P07's own spec text: tasks done (50%) + team slots
// assigned (35%) + budget fully committed (15%). Shared by
// ContinuePlanningCard, WorkspaceOverviewTab, and P14's "Plan is now X%
// ready" toast -- one formula, never three slightly-different copies.
function computeReadiness(data: PlanWorkspaceData): number {
  const tasksDone = data.tasks.filter((t) => !!t.done_at).length;
  const tasksTotal = data.tasks.length;
  const tasksPct = tasksTotal > 0 ? tasksDone / tasksTotal : 0;
  const assignedCategories = data.categories.filter((c) => c.committed_kobo > 0 || c.paid_kobo > 0 || c.booked).length;
  const categoriesTotal = data.categories.length;
  const teamPct = categoriesTotal > 0 ? assignedCategories / categoriesTotal : 0;
  const totalAllocated = data.categories.reduce((s, c) => s + c.allocated_kobo, 0);
  const totalCommittedOrPaid = data.categories.reduce((s, c) => s + c.committed_kobo + c.paid_kobo, 0);
  const budgetPct = totalAllocated > 0 ? Math.min(1, totalCommittedOrPaid / totalAllocated) : 0;
  return Math.round((tasksPct * 0.5 + teamPct * 0.35 + budgetPct * 0.15) * 100);
}

// P01's "NEW · VENTS AI PLANNER" promo card -- shown on the Chat tab only when
// the user has no plan yet. Exact copy/colors/radii from P01.html. Type
// chips prefill AND immediately send ("Help me plan a {type}"), per that
// frame's own spec text ("Type chips prefill ... and send").
function NewPlannerPromoCard({ onPickType }: { onPickType: (text: string) => void }) {
  const TYPES = ['Wedding', 'Birthday', 'Conference', 'Something else'];
  return (
    <div style={{ padding: 16, borderRadius: 14, background: 'linear-gradient(160deg, rgba(163,92,255,.16), rgba(18,14,26,1) 70%)', border: '1px solid rgba(163,92,255,.35)', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '.16em', color: '#d3b8ff' }}>NEW · VENTS AI PLANNER</span>
      <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-.01em' }}>Plan an event with VENTS AI</span>
      <span style={{ fontSize: 13, color: '#c9c0d4', lineHeight: 1.5 }}>Tell VENTS AI what you're hosting. Get a budget, a team of VENTS providers, tasks and a timeline.</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {TYPES.map((t) => (
          <span
            key={t}
            onClick={() => onPickType(t === 'Something else' ? "I'm planning an event." : `Help me plan a ${t.toLowerCase()}`)}
            style={{ fontSize: 12, padding: '6px 10px', borderRadius: 99, background: '#1c1726', border: '1px solid #2c2438', color: '#d6cfe0', cursor: 'pointer' }}
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

// When a plan exists, P01's promo card becomes this "CONTINUE PLANNING"
// card (P24's own spec). Readiness/days-to-go/urgent-tasks are computed
// from a real fetchPlanWorkspace read of the most recent plan -- never
// fabricated placeholder numbers.
function ContinuePlanningCard({ plan, onAskSi, onOpenWorkspace }: { plan: PlanSummary; onAskSi: () => void; onOpenWorkspace: () => void }) {
  const [data, setData] = useState<PlanWorkspaceData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPlanWorkspace(plan.id).then((d) => { if (!cancelled) setData(d); }).catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [plan.id]);

  if (!data) return null;

  const readiness = computeReadiness(data);
  const daysToGo = data.plan.event_date ? Math.max(0, Math.round((new Date(data.plan.event_date).getTime() - Date.now()) / 86400000)) : null;

  function dueDate(t: WorkspaceTask): Date | null {
    if (t.due_override) return new Date(t.due_override);
    if (data!.plan.event_date && t.offset_days != null) {
      const d = new Date(data!.plan.event_date);
      d.setDate(d.getDate() - t.offset_days);
      return d;
    }
    return null;
  }
  const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const now = Date.now();
  const incomplete = data.tasks
    .filter((t) => !t.done_at)
    .map((t) => ({ t, due: dueDate(t) }))
    .filter((x) => x.due)
    .sort((a, b) => a.due!.getTime() - b.due!.getTime());
  const overdue = incomplete.filter((x) => x.due!.getTime() < now);
  const upcoming = incomplete.filter((x) => x.due!.getTime() >= now);
  const lines: { text: string; color: string }[] = [];
  if (overdue.length > 0) lines.push({ text: `${overdue.length} overdue · ${overdue[0].t.title}`, color: '#fbbf24' });
  for (const x of upcoming) {
    if (lines.length >= 2) break;
    lines.push({ text: `${x.t.title} due ${fmtDate(x.due!)}`, color: '#c9c0d4' });
  }

  return (
    <div style={{ padding: 16, borderRadius: 14, background: 'linear-gradient(160deg, rgba(163,92,255,.16), #120e1a 70%)', border: '1px solid rgba(163,92,255,.35)', display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '.16em', color: '#d3b8ff' }}>CONTINUE PLANNING</span>
        <span style={{ fontSize: 12, color: '#a89db3' }}>{daysToGo != null ? `${daysToGo} days` : ''}</span>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: `conic-gradient(#a35cff 0 ${readiness}%, #2c2438 ${readiness}% 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <span style={{ width: 42, height: 42, borderRadius: '50%', background: '#16111f', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, fontWeight: 800 }}>{readiness}%</span>
        </div>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800 }}>{plan.title}</div>
          <div style={{ fontSize: 12.5, color: '#a89db3', marginTop: 2 }}>
            {plan.event_date ? plan.event_date : ''}{plan.city ? ` · ${plan.city}` : ''}
          </div>
        </div>
      </div>
      {lines.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.06)' }}>
          {lines.map((l, i) => (
            <span key={i} style={{ fontSize: 13, color: l.color }}>● {l.text}</span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <span onClick={onAskSi} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Ask VENTS AI</span>
        <span onClick={onOpenWorkspace} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>Open plan</span>
      </div>
    </div>
  );
}

// Dedicated Plan Workspace (P07 Overview, P08 Budget) -- a non-chat-log
// screen, distinct from a plan's chat thread (P24's "Open plan" vs. "Ask
// SI"). Reads via fetchPlanWorkspace, the same RLS-scoped tables get_plan's
// own backend executor reads -- never more or less authoritative than the
// chat tool's view of the same plan.
//
// Style values below are copied verbatim from P07.html/P08.html (colors,
// px sizes, border-radius, gradient stops) -- "style-value verified"
// against that source, not visually verified (this sandbox cannot render
// or screenshot). Team/Tasks/Timeline tabs are not implemented; they are
// shown as explicit placeholders rather than silently omitted.
function PlanWorkspaceView({
  planId,
  onBack,
  onAskSi,
  onComposerSend,
  onSwitchPlan,
  onStartNewPlan,
}: {
  planId: string;
  onBack: () => void;
  onAskSi: (title: string) => void;
  onComposerSend: (text: string) => void;
  // P26 plan switcher -- parent just swaps which plan id this same
  // component instance renders; see tabMemory below for why this doesn't
  // lose the new plan's own last-used tab.
  onSwitchPlan: (planId: string) => void;
  // "+ New plan" inside the switcher -- same prefill-only behavior as the
  // Plans list's own "+ New Plan" row, never auto-sent.
  onStartNewPlan: (prompt: string) => void;
}) {
  const [tab, setTab] = useState<'overview' | 'budget' | 'team' | 'tasks' | 'timeline'>('overview');
  const [data, setData] = useState<PlanWorkspaceData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState('');
  // P10's own spec text: "Opened from Budget, Team, or a task chip" --
  // a stacked screen over whichever tab is active, not a tab itself, so
  // its own Back returns to that same tab rather than always Overview.
  const [detailCategoryId, setDetailCategoryId] = useState<string | null>(null);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [showDateSheet, setShowDateSheet] = useState(false);
  const [showPlanSwitcher, setShowPlanSwitcher] = useState(false);
  const [switcherPlans, setSwitcherPlans] = useState<PlanSummary[] | null>(null);
  // P26's own spec text: "Each plan remembers its own scroll/tab" --
  // this component instance is never remounted on switch (same `key`),
  // so a plain `tab` useState would otherwise leak one plan's active tab
  // onto the next. A ref-backed per-plan map is enough to honor that
  // without a new backend/model contract -- purely client-side UI state.
  const tabMemory = useRef<Record<string, typeof tab>>({});

  const load = () => {
    setData(null);
    setLoadError(null);
    fetchPlanWorkspace(planId)
      .then((d) => setData(d))
      .catch((e) => setLoadError(e?.message || 'Could not load this plan.'));
  };

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    setTab(tabMemory.current[planId] ?? 'overview');
    setDetailCategoryId(null);
    fetchPlanWorkspace(planId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setLoadError(e?.message || 'Could not load this plan.'); });
    return () => { cancelled = true; };
  }, [planId]);

  function setTabRemembered(next: typeof tab) {
    tabMemory.current[planId] = next;
    setTab(next);
  }

  function openPlanSwitcher() {
    setShowPlanSwitcher(true);
    if (switcherPlans === null) {
      supabase.rpc('get_plans_overview').then(({ data: rows, error }: any) => {
        if (!error) setSwitcherPlans(Array.isArray(rows) ? (rows as PlanSummary[]) : []);
      });
    }
  }

  const TABS: { id: typeof tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'budget', label: 'Budget' },
    { id: 'team', label: 'Team' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'timeline', label: 'Timeline' },
  ];

  const composerPlaceholder =
    tab === 'budget' ? '"Move ₦300k from décor to photos"' : tab === 'team' ? '"Find a band under ₦350k"' : `Ask VENTS AI about ${data?.plan.title || 'this plan'}…`;

  function sendComposer() {
    const t = composerText.trim();
    if (!t) return;
    setComposerText('');
    onComposerSend(t);
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0a0810' }}>
      <div style={{ flexShrink: 0, padding: '0 18px', borderBottom: '1px solid #1c1726', background: '#0b0812' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 50 }}>
          <span onClick={onBack} role="button" aria-label="Back" style={{ fontSize: 19, color: '#e4d4ff', cursor: 'pointer' }}>←</span>
          <div onClick={openPlanSwitcher} role="button" data-testid="workspace-plan-switcher-trigger" style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>
              {data?.plan.title || 'Plan'} <span style={{ fontSize: 13, color: '#d3b8ff' }}>▾</span>
            </div>
            <div style={{ fontSize: 11.5, color: '#a89db3' }}>
              {data?.plan.event_date ? friendlyDate(data.plan.event_date) : ''}{data?.plan.city ? ` · ${data.plan.city}` : ''}{data?.plan.guests ? ` · ${data.plan.guests} guests` : ''}
            </div>
          </div>
          <span onClick={() => setShowHeaderMenu((v) => !v)} role="button" data-testid="workspace-header-menu" style={{ width: 34, height: 34, borderRadius: 10, background: '#1c1726', border: '1px solid #2c2438', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c9c0d4', cursor: 'pointer', position: 'relative' }}>
            ⋯
            {showHeaderMenu && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ position: 'absolute', top: 40, right: 0, background: '#120e1a', border: '1px solid #2c2438', borderRadius: 10, padding: 6, zIndex: 970, boxShadow: '0 12px 30px rgba(0,0,0,.5)', minWidth: 160 }}
              >
                <div
                  onClick={() => { setShowHeaderMenu(false); setShowDateSheet(true); }}
                  role="button"
                  data-testid="workspace-menu-change-date"
                  style={{ padding: '10px 12px', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#e8e3ee', cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  Change date
                </div>
              </div>
            )}
          </span>
        </div>
        {/* R1 (360px) regression this pass found: the mockup's own tab row
            (fixed gap:20px, no overflow handling) is only ever rendered at
            its native 390px design width, where it just fits -- at 360px
            "Timeline" genuinely ran past both this row's own container and
            the viewport edge (confirmed by measuring the real rendered
            rect). overflowX:auto here is the same established pattern
            Home's own filter-chip row already uses for this exact
            narrow-viewport problem; flexShrink:0 keeps each tab's own
            label from being squeezed instead of the row simply scrolling. */}
        <div style={{ display: 'flex', gap: 20, fontSize: 13, fontWeight: 600, color: '#8a7f97', overflowX: 'auto', scrollbarWidth: 'none' }}>
          {TABS.map((t) => (
            <span
              key={t.id}
              onClick={() => setTabRemembered(t.id)}
              data-testid={`workspace-tab-${t.id}`}
              style={{ padding: '10px 0', cursor: 'pointer', flexShrink: 0, color: tab === t.id ? '#f2eff6' : '#8a7f97', borderBottom: tab === t.id ? '2px solid #a35cff' : 'none' }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {loadError ? (
          <div style={{ fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 10, padding: 12 }}>
            Couldn't load this plan — {loadError}
          </div>
        ) : !data ? (
          <div style={{ fontSize: 12, color: '#5e5470', textAlign: 'center', padding: 20 }}>Loading plan…</div>
        ) : detailCategoryId ? (
          <CategoryDetailView
            planId={planId}
            planTitle={data.plan.title}
            planCity={data.plan.city}
            totalBudgetKobo={data.plan.total_kobo ?? 0}
            allCategories={data.categories}
            category={data.categories.find((c) => c.id === detailCategoryId)!}
            tasks={data.tasks.filter((t) => t.category_id === detailCategoryId)}
            onBack={() => setDetailCategoryId(null)}
            onChanged={load}
          />
        ) : tab === 'overview' ? (
          <WorkspaceOverviewTab data={data} onOpenBudget={() => setTabRemembered('budget')} />
        ) : tab === 'budget' ? (
          <WorkspaceBudgetTab data={data} planId={planId} onOpenCategory={setDetailCategoryId} onAskSi={() => onAskSi(data.plan.title)} onChanged={load} />
        ) : tab === 'team' ? (
          <WorkspaceTeamTab data={data} planId={planId} onOpenCategory={setDetailCategoryId} onAskSi={() => onAskSi(data.plan.title)} onChanged={load} />
        ) : tab === 'tasks' ? (
          <WorkspaceTasksTab data={data} onChanged={load} />
        ) : tab === 'timeline' ? (
          <WorkspaceTimelineTab data={data} planId={planId} onOpenTasks={() => setTabRemembered('tasks')} onChanged={load} />
        ) : (
          <div style={{ fontSize: 12.5, color: '#786d87', textAlign: 'center', padding: 20 }}>
            {TABS.find((t) => t.id === tab)?.label} isn't built yet in this pass — not a mockup frame it skips, just not reached yet.
          </div>
        )}
      </div>

      <div style={{ flexShrink: 0, padding: '10px 16px 22px', background: '#0b0812', borderTop: '1px solid #1c1726' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#161020', border: '1px solid #2a2438', borderRadius: 12, padding: '6px 6px 6px 12px' }}>
          <span style={{ width: 22, height: 22, borderRadius: '50%', background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#fff' }}>✦</span>
          <input
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendComposer()}
            placeholder={composerPlaceholder}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 13, color: '#e8e3ee', fontFamily: 'inherit' }}
          />
          <span onClick={sendComposer} role="button" aria-label="Send" style={{ width: 30, height: 30, borderRadius: 8, background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13, cursor: 'pointer' }}>↑</span>
        </div>
      </div>
      {showDateSheet && data && (
        <DateChangeSheet
          planId={planId}
          data={data}
          onClose={() => setShowDateSheet(false)}
          onChanged={load}
        />
      )}
      {showPlanSwitcher && (
        <PlanSwitcherDropdown
          plans={switcherPlans}
          activePlanId={planId}
          onSelect={(id) => { setShowPlanSwitcher(false); if (id !== planId) onSwitchPlan(id); }}
          onNewPlan={() => { setShowPlanSwitcher(false); onStartNewPlan("I'm planning another event."); }}
          onAllPlans={() => { setShowPlanSwitcher(false); onBack(); }}
          onClose={() => setShowPlanSwitcher(false)}
        />
      )}
    </div>
  );
}

// P26 -- "Title ▾ on every planner view opens this dropdown." Real plans
// only (get_plans_overview(), the same aggregate RPC the Plans list uses),
// current plan marked with a check, "+ New plan" and "All plans" footer
// rows exactly as the mockup shows. On desktop the plan rail replaces this
// (R3, not built here -- see the architectural-investigation note on R3).
function PlanSwitcherDropdown({
  plans,
  activePlanId,
  onSelect,
  onNewPlan,
  onAllPlans,
  onClose,
}: {
  plans: PlanSummary[] | null;
  activePlanId: string;
  onSelect: (planId: string) => void;
  onNewPlan: () => void;
  onAllPlans: () => void;
  onClose: () => void;
}) {
  const rows = (plans ?? []).filter((p) => p.status === 'draft' || p.status === 'active');
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 975 }} onClick={onClose} data-testid="workspace-plan-switcher">
      <div style={{ position: 'absolute', inset: 0, top: 96, background: 'rgba(5,4,8,.72)' }} />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', top: 100, left: 12, right: 12, borderRadius: 18, background: '#120e1a', border: '1px solid #2c2438', padding: 8, display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,.6)' }}
      >
        {plans === null ? (
          <div style={{ padding: 12, fontSize: 12.5, color: '#786d87', textAlign: 'center' }}>Loading your plans…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 12, fontSize: 12.5, color: '#786d87', textAlign: 'center' }}>No other plans yet.</div>
        ) : (
          rows.map((p) => {
            const isActive = p.id === activePlanId;
            return (
              <div
                key={p.id}
                onClick={() => onSelect(p.id)}
                role="button"
                data-testid={`workspace-plan-switcher-row-${p.id}`}
                style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 12, borderRadius: 11, background: isActive ? 'rgba(163,92,255,.1)' : 'transparent', cursor: 'pointer' }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{p.title}</div>
                  <div style={{ fontSize: 12, color: '#a89db3' }}>
                    {p.status === 'draft' ? 'Draft' : (
                      <>
                        {friendlyDate(p.event_date, true) || 'Date not set'} · {p.readiness_pct}%
                        {p.overdue_task_count > 0 && <> · <span style={{ color: '#fbbf24' }}>{p.overdue_task_count} overdue</span></>}
                      </>
                    )}
                  </div>
                </div>
                {isActive && <span style={{ color: '#d3b8ff' }}>✓</span>}
              </div>
            );
          })
        )}
        <div style={{ height: 1, background: '#221d2d', margin: '4px 8px' }} />
        <div onClick={onNewPlan} role="button" data-testid="workspace-plan-switcher-new" style={{ padding: 12, fontSize: 14, fontWeight: 700, color: '#d3b8ff', cursor: 'pointer' }}>+ New plan</div>
        <div onClick={onAllPlans} role="button" data-testid="workspace-plan-switcher-all" style={{ padding: 12, fontSize: 14, color: '#c9c0d4', cursor: 'pointer' }}>All plans</div>
      </div>
    </div>
  );
}

// P22 "Event date changed" -- a bottom sheet previewing real impact before
// confirming. Every line is computed from real data: open tasks that will
// shift (offset_days-based tasks always move with the event date, by
// construction -- just counted here, never recomputed fictionally),
// the real runway in days, and the REAL booked/own-vendor assignments
// that need a human to confirm with the provider. "Move to {date}" calls
// the same direct plans.update() executeReschedulePlan's own backend
// executor uses (same RLS-permitted pattern) and inserts one real
// plan_tasks row per affected assignment ("Confirm new date with X"),
// per the mockup's own spec text -- never auto-reschedules a real
// booking, which this backend has no path to do at all.
// S4-A "Set total" -- a real plans.update() write, scoped by the existing
// plans_update_own RLS (same direct-update precedent as P20/P22's
// AllocationSheet-adjacent writes), never a frontend-only number.
function SetTotalBudgetSheet({
  planId,
  initialNaira,
  onClose,
  onChanged,
}: {
  planId: string;
  initialNaira?: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [value, setValue] = useState(initialNaira ? String(initialNaira) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const naira = Number(value);
    if (!isFinite(naira) || naira <= 0) { setError('Enter a real amount in naira.'); return; }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.from('plans').update({ total_kobo: Math.round(naira * 100) }).eq('id', planId);
    setSaving(false);
    if (err) { setError(err.message); return; }
    onChanged();
    onClose();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,4,8,.72)', display: 'flex', alignItems: 'flex-end', zIndex: 980 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: '#120e1a', borderTop: '1px solid #2c2438', borderRadius: '18px 18px 0 0', padding: '18px 18px calc(18px + env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Set total budget</span>
        <input
          type="text"
          inputMode="numeric"
          value={value ? Number(value).toLocaleString('en-NG') : ''}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="e.g. 8,000,000"
          data-testid="workspace-budget-set-total-input"
          style={{ background: '#1c1726', border: '1px solid #2c2438', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
        />
        {error && <span style={{ fontSize: 12, color: '#fbbf24' }}>{error}</span>}
        <div style={{ display: 'flex', gap: 8 }}>
          <span onClick={onClose} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Cancel</span>
          <span onClick={save} role="button" data-testid="workspace-budget-set-total-save" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Saving…' : 'Save'}</span>
        </div>
      </div>
    </div>
  );
}

// S4-D "Set" -- a plan with no event_date yet has no existing date to
// preview an "impact" against (unlike DateChangeSheet, which previews the
// real effect of CHANGING an already-set date), so this is a plain direct
// plans.update() write, same RLS-scoped pattern as SetTotalBudgetSheet.
function SetEventDateSheet({
  planId,
  onClose,
  onChanged,
}: {
  planId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!value) { setError('Pick a date.'); return; }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.from('plans').update({ event_date: value }).eq('id', planId);
    setSaving(false);
    if (err) { setError(err.message); return; }
    onChanged();
    onClose();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,4,8,.72)', display: 'flex', alignItems: 'flex-end', zIndex: 980 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: '#120e1a', borderTop: '1px solid #2c2438', borderRadius: '18px 18px 0 0', padding: '18px 18px calc(18px + env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Set event date</span>
        <input
          type="date"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid="workspace-timeline-set-date-input"
          style={{ background: '#1c1726', border: '1px solid #2c2438', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
        />
        {error && <span style={{ fontSize: 12, color: '#fbbf24' }}>{error}</span>}
        <div style={{ display: 'flex', gap: 8 }}>
          <span onClick={onClose} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Cancel</span>
          <span onClick={save} role="button" data-testid="workspace-timeline-set-date-save" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Saving…' : 'Save'}</span>
        </div>
      </div>
    </div>
  );
}

function DateChangeSheet({
  planId,
  data,
  onClose,
  onChanged,
}: {
  planId: string;
  data: PlanWorkspaceData;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newDate, setNewDate] = useState(data.plan.event_date || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const todayIso = new Date().toISOString().slice(0, 10);
  const oldDateFmt = data.plan.event_date ? new Date(data.plan.event_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null;
  const newDateFmt = newDate ? new Date(newDate).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : null;
  const runwayDays = newDate ? Math.max(0, Math.round((new Date(newDate).getTime() - Date.now()) / 86400000)) : null;

  const openTasksWithOffset = data.tasks.filter((t) => !t.done_at && t.offset_days != null && !t.due_override);
  const bookedAssignments = data.categories
    .flatMap((c) => c.assignments.filter((a) => a.status === 'booked').map((a) => ({ c, a })));
  const ownVendorAssignments = data.categories
    .flatMap((c) => c.assignments.filter((a) => a.status === 'assigned' && !a.provider_id && a.own_vendor_name).map((a) => ({ c, a })));

  async function confirmMove() {
    if (!newDate) return;
    setSaving(true);
    setError(null);
    try {
      const { error: updateError } = await supabase.from('plans').update({ event_date: newDate }).eq('id', planId);
      if (updateError) throw updateError;

      const affected = [...bookedAssignments, ...ownVendorAssignments];
      if (affected.length > 0) {
        const rows = affected.map(({ c, a }) => ({
          plan_id: planId,
          category_id: c.id,
          title: `Confirm new date with ${a.provider?.business_name || a.own_vendor_name}`,
          source: 'si' as const,
          completes_on_booking: false,
        }));
        await supabase.from('plan_tasks').insert(rows);
      }
      onChanged();
      onClose();
    } catch (e: any) {
      setError(e?.message || "That didn't go through.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(5,4,8,.72)' }} onClick={onClose} data-testid="ai-date-change-sheet-backdrop">
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: '24px 24px 0 0', background: '#120e1a', borderTop: '1px solid #2c2438', padding: '10px 20px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        <span style={{ width: 40, height: 4, borderRadius: 9, background: '#3a3048', alignSelf: 'center' }} />
        <div>
          <div style={{ fontSize: 12, color: '#8a7f97' }}>Change event date</div>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4 }}>
            {oldDateFmt && <span style={{ color: '#786d87', textDecoration: 'line-through', fontWeight: 600 }}>{oldDateFmt}</span>} {newDateFmt ? `→ ${newDateFmt}` : ''}
          </div>
        </div>
        <input
          type="date"
          value={newDate}
          min={todayIso}
          onChange={(e) => setNewDate(e.target.value)}
          data-testid="ai-date-change-input"
          style={{ width: '100%', boxSizing: 'border-box', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '12px 14px', fontSize: 14, color: '#f0f0ff', fontFamily: 'inherit' }}
        />
        {newDate && newDate !== data.plan.event_date && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, borderRadius: 12, background: '#0a0810', border: '1px solid #221d2d', padding: '4px 14px' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '11px 0', borderBottom: '1px solid #1c1726' }}>
              <span style={{ color: '#34d399', fontSize: 13 }}>✓</span>
              <div style={{ flex: 1, fontSize: 13.5 }}>{openTasksWithOffset.length} open task{openTasksWithOffset.length === 1 ? '' : 's'} move with the new date</div>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '11px 0', borderBottom: (bookedAssignments.length > 0 || ownVendorAssignments.length > 0) ? '1px solid #1c1726' : 'none' }}>
              <span style={{ color: '#34d399', fontSize: 13 }}>✓</span>
              <div style={{ flex: 1, fontSize: 13.5 }}>Timeline re-flows · runway {runwayDays} days</div>
            </div>
            {bookedAssignments.length > 0 && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '11px 0', borderBottom: ownVendorAssignments.length > 0 ? '1px solid #1c1726' : 'none' }}>
                <span style={{ color: '#fbbf24', fontSize: 13 }}>!</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5 }}>{bookedAssignments.length} provider{bookedAssignments.length === 1 ? ' was' : 's were'} booked for {oldDateFmt}</div>
                  <div style={{ fontSize: 12, color: '#a89db3', marginTop: 3 }}>{bookedAssignments.map(({ a }) => a.provider?.business_name || a.own_vendor_name).join(' · ')}</div>
                </div>
              </div>
            )}
            {ownVendorAssignments.map(({ c, a }) => (
              <div key={a.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '11px 0' }}>
                <span style={{ color: '#fbbf24', fontSize: 13 }}>!</span>
                <div style={{ flex: 1, fontSize: 13.5 }}>{c.label} (own vendor) — check with them</div>
              </div>
            ))}
          </div>
        )}
        {newDate && newDate !== data.plan.event_date && (bookedAssignments.length > 0 || ownVendorAssignments.length > 0) && (
          <div style={{ padding: '12px 14px', borderRadius: 11, background: 'rgba(251,191,36,.07)', border: '1px solid rgba(251,191,36,.3)', fontSize: 12.5, color: '#e8e3ee', lineHeight: 1.5 }}>
            Bookings won't change automatically. I'll add a "Confirm new date" task for each.
          </div>
        )}
        {error && <div style={{ fontSize: 12, color: '#fbbf24' }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <span onClick={onClose} role="button" style={{ flex: 1, height: 48, borderRadius: 12, background: '#1c1726', border: '1px solid #2c2438', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Cancel</span>
          <span
            onClick={confirmMove}
            role="button"
            data-testid="ai-date-change-confirm"
            style={{ flex: 1.6, height: 48, borderRadius: 12, background: newDate && newDate !== data.plan.event_date ? GRADIENT : '#2c2438', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#fff', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}
          >
            {saving ? 'Moving…' : newDateFmt ? `Move to ${newDateFmt.replace(/^\w+ /, '')}` : 'Choose a date'}
          </span>
        </div>
      </div>
    </div>
  );
}

// Readiness formula per P07's own spec text: tasks done (50%) + team slots
// assigned (35%) + budget fully committed (15%). "Team slots assigned"
// here reads as categories with an active (assigned or booked) provider,
// since this schema has no separate team-member concept yet.
function WorkspaceOverviewTab({ data, onOpenBudget }: { data: PlanWorkspaceData; onOpenBudget: () => void }) {
  const tasksDone = data.tasks.filter((t) => !!t.done_at).length;
  const tasksTotal = data.tasks.length;
  const assignedCategories = data.categories.filter((c) => c.committed_kobo > 0 || c.paid_kobo > 0 || c.booked).length;
  const categoriesTotal = data.categories.length;

  const readiness = computeReadiness(data);

  const daysToGo = data.plan.event_date ? Math.max(0, Math.round((new Date(data.plan.event_date).getTime() - Date.now()) / 86400000)) : null;

  const totalCommitted = data.categories.reduce((s, c) => s + c.committed_kobo, 0) / 100;
  const totalPaid = data.categories.reduce((s, c) => s + c.paid_kobo, 0) / 100;
  const totalEstimated = data.categories.filter((c) => c.committed_kobo === 0 && c.paid_kobo === 0).reduce((s, c) => s + c.allocated_kobo, 0) / 100;
  const totalBudget = (data.plan.total_kobo ?? 0) / 100;
  const leftToCommit = Math.max(0, totalBudget - totalCommitted - totalPaid);
  const overBudgetCategory = data.categories.find((c) => c.committed_kobo + c.paid_kobo > c.allocated_kobo);

  const upNext = data.tasks.filter((t) => !t.done_at).slice(0, 3);

  return (
    <>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', padding: 16, borderRadius: 14, background: '#120e1a', border: '1px solid #221d2d' }}>
        <div style={{ width: 78, height: 78, borderRadius: '50%', background: `conic-gradient(#a35cff 0 ${readiness}%, #221d2d ${readiness}% 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#120e1a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 19, fontWeight: 800 }}>{readiness}%</span>
            <span style={{ fontSize: 9.5, color: '#8a7f97' }}>ready</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em' }}>{daysToGo != null ? `${daysToGo} days to go` : 'No date set'}</span>
          <span style={{ fontSize: 13, color: '#a89db3' }}>{tasksDone} of {tasksTotal} tasks · {assignedCategories} of {categoriesTotal} team assigned</span>
        </div>
      </div>

      <div style={{ padding: 14, borderRadius: 14, background: '#120e1a', border: '1px solid #221d2d', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97' }}>BUDGET</span>
          <span onClick={onOpenBudget} role="button" style={{ fontSize: 12, color: '#d3b8ff', cursor: 'pointer' }}>Open ›</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 22, fontWeight: 800 }}>{naira(leftToCommit)}</span>
          <span style={{ fontSize: 12, color: '#a89db3' }}>left to commit of {compactNaira(totalBudget)}</span>
        </div>
        <BudgetBar estimated={totalEstimated} committed={totalCommitted} paid={totalPaid} total={totalBudget || null} />
        {overBudgetCategory && (
          <div style={{ fontSize: 12, color: '#fbbf24' }}>
            {overBudgetCategory.label} is {naira((overBudgetCategory.committed_kobo + overBudgetCategory.paid_kobo - overBudgetCategory.allocated_kobo) / 100)} over its allocation
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97' }}>UP NEXT</span>
          <span style={{ fontSize: 12, color: '#d3b8ff' }}>All tasks ›</span>
        </div>
        {upNext.length === 0 ? (
          <div style={{ fontSize: 12.5, color: '#5e5470', padding: '11px 0' }}>Nothing due yet.</div>
        ) : (
          upNext.map((t, i) => {
            // Same real due-date resolution Tasks/Timeline already use --
            // never the raw due_override string or a literal "T-10d".
            const due = taskDueDate(t, data.plan.event_date);
            const overdue = !!due && due.getTime() < new Date().setHours(0, 0, 0, 0);
            return (
              <div key={t.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '11px 0', borderBottom: i < upNext.length - 1 ? '1px solid #1c1726' : 'none' }}>
                <span style={{ width: 20, height: 20, borderRadius: 6, border: `1.5px solid ${overdue ? '#fbbf24' : '#4a3f56'}`, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 14 }}>{t.title}</span>
                <span style={{ fontSize: 11.5, color: overdue ? '#fbbf24' : '#a89db3' }}>{due ? (overdue ? `Due ${fmtTaskDate(due)}` : fmtTaskDate(due)) : ''}</span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// P20 "Budget exceeded" -- real numbers throughout: overKobo is the real
// committed+paid shortfall, the contingency/over-category amounts are
// real allocated_kobo values, never estimated. "Use contingency" and
// "Raise total" call the exact same apply_plan_allocation_changes RPC
// AllocationSheet uses and a direct plans.update() (same RLS-permitted
// pattern executeReschedulePlan's own backend executor already uses),
// respectively -- both real writes, never a frontend-only banner dismiss.
// "Trim unbooked categories" is a stated, smaller scope: it opens the
// first eligible category's own detail/allocation sheet rather than the
// mockup's dedicated multi-category trim picker, which isn't built.
function BudgetExceededBanner({
  data,
  planId,
  overKobo,
  onOpenCategory,
  onAskSi,
  onChanged,
}: {
  data: PlanWorkspaceData;
  planId: string;
  overKobo: number;
  onOpenCategory: (categoryId: string) => void;
  onAskSi: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const totalBudgetKobo = data.plan.total_kobo ?? 0;
  const totalSpendKobo = data.categories.reduce((s, c) => s + c.committed_kobo + c.paid_kobo, 0);
  const totalEstimateKobo = data.categories.filter((c) => c.committed_kobo === 0 && c.paid_kobo === 0).reduce((s, c) => s + c.allocated_kobo, 0);
  const paidKobo = data.categories.reduce((s, c) => s + c.paid_kobo, 0);
  const committedKobo = data.categories.reduce((s, c) => s + c.committed_kobo, 0);
  const grandTotalKobo = totalSpendKobo + totalEstimateKobo;

  const contingency = data.categories.find((c) => /conting/i.test(c.key) || /conting/i.test(c.label));
  const trimCandidate = data.categories.find((c) => !c.is_priority && !c.booked && c.committed_kobo === 0 && c.paid_kobo === 0 && c.allocated_kobo > 0);

  async function useContingency() {
    if (!contingency) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc('apply_plan_allocation_changes', {
        p_plan_id: planId,
        p_changes: [{ category_id: contingency.id, new_allocated_kobo: Math.max(0, contingency.allocated_kobo - overKobo) }],
        p_actor: 'user',
      });
      if (!error) onChanged();
      else setNote(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function raiseTotal() {
    setBusy(true);
    try {
      const { error } = await supabase.from('plans').update({ total_kobo: grandTotalKobo }).eq('id', planId);
      if (!error) onChanged();
      else setNote(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 16, borderRadius: 14, background: 'rgba(248,113,113,.07)', border: '1px solid rgba(248,113,113,.4)', display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 }} data-testid="workspace-budget-exceeded-banner">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#f87171' }}>OVER BUDGET</span>
        <span style={{ fontSize: 12, color: '#a89db3' }}>Paid + committed + estimates</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 26, fontWeight: 800 }}>{naira(grandTotalKobo / 100)}</span>
        <span style={{ fontSize: 13, color: '#f87171', fontWeight: 700 }}>+{naira(overKobo / 100)}</span>
      </div>
      <div style={{ position: 'relative', display: 'flex', height: 10, borderRadius: 99, overflow: 'hidden', gap: 2 }}>
        <span style={{ width: `${totalBudgetKobo > 0 ? Math.min(100, (paidKobo / totalBudgetKobo) * 100) : 0}%`, background: '#34d399' }} />
        <span style={{ flex: 1, background: '#a35cff' }} />
        <span style={{ width: `${totalBudgetKobo > 0 ? Math.min(100, (overKobo / totalBudgetKobo) * 100) : 3}%`, background: '#f87171' }} />
      </div>
      <span style={{ fontSize: 12.5, color: '#c9c0d4', lineHeight: 1.5 }}>
        Real committed and paid amounts across all categories now total {naira((committedKobo + paidKobo) / 100)}, {naira(overKobo / 100)} over the plan's {naira(totalBudgetKobo / 100)} budget.
      </span>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97' }}>WAYS TO BALANCE</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {contingency && contingency.allocated_kobo > 0 && (
          <div onClick={useContingency} role="button" style={{ padding: 14, borderRadius: 12, background: '#120e1a', border: '1px solid rgba(163,92,255,.45)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: busy ? 'default' : 'pointer' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Use contingency</div>
              <div style={{ fontSize: 12, color: '#a89db3', marginTop: 2 }}>{naira(contingency.allocated_kobo / 100)} → {naira(Math.max(0, contingency.allocated_kobo - overKobo) / 100)} left</div>
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#d3b8ff' }}>VENTS AI pick</span>
          </div>
        )}
        {trimCandidate && (
          <div onClick={() => onOpenCategory(trimCandidate.id)} role="button" style={{ padding: 14, borderRadius: 12, background: '#120e1a', border: '1px solid #221d2d', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Trim unbooked categories</div>
              <div style={{ fontSize: 12, color: '#a89db3', marginTop: 2 }}>Opens {trimCandidate.label}'s own budget editor</div>
            </div>
            <span style={{ color: '#d3b8ff' }}>›</span>
          </div>
        )}
        <div onClick={raiseTotal} role="button" style={{ padding: 14, borderRadius: 12, background: '#120e1a', border: '1px solid #221d2d', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: busy ? 'default' : 'pointer' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Raise total to {naira(grandTotalKobo / 100)}</div>
            <div style={{ fontSize: 12, color: '#a89db3', marginTop: 2 }}>Keep everything as is</div>
          </div>
          <span style={{ color: '#d3b8ff' }}>›</span>
        </div>
        <div onClick={onAskSi} role="button" style={{ padding: 14, borderRadius: 12, background: '#120e1a', border: '1px solid #221d2d', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Talk it through with VENTS AI</div>
            <div style={{ fontSize: 12, color: '#a89db3', marginTop: 2 }}>Opens the plan thread</div>
          </div>
          <span style={{ color: '#d3b8ff' }}>›</span>
        </div>
      </div>
      {note && <div style={{ fontSize: 11.5, color: '#fbbf24' }}>{note}</div>}
    </div>
  );
}

// Budget tab (P08). Rows sorted per P08's own spec text: over-budget first,
// then committed, then estimates. "+N more" is not implemented here --
// all categories are shown (an honest gap vs. the mockup's truncation,
// not a fabricated count).
function WorkspaceBudgetTab({
  data,
  planId,
  onOpenCategory,
  onAskSi,
  onChanged,
}: {
  data: PlanWorkspaceData;
  planId: string;
  onOpenCategory: (categoryId: string) => void;
  onAskSi: () => void;
  onChanged: () => void;
}) {
  const [showSetTotal, setShowSetTotal] = useState(false);

  // S4-A "Budget · no total yet" -- a real missing-data state, not a
  // ₦0 budget rendered as if it were real. "Not sure yet" hands off to
  // the plan's own Ask SI thread (same real flow as S4-B's "Finish brief
  // with SI"); "Set total" is a real plans.update() write, never a
  // frontend-only number.
  if (!data.plan.total_kobo) {
    return (
      <>
        <div style={{ padding: 16, borderRadius: 14, background: '#120e1a', border: '1px solid #221d2d', display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="workspace-budget-not-yet">
          <span style={{ fontSize: 16, fontWeight: 800 }}>Set a total to see your budget</span>
          <span style={{ fontSize: 13, color: '#a89db3', lineHeight: 1.5 }}>VENTS AI splits it across categories as planning estimates — not quotes.</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <span onClick={onAskSi} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Not sure yet</span>
            <span onClick={() => setShowSetTotal(true)} role="button" data-testid="workspace-budget-set-total" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>Set total</span>
          </div>
        </div>
        {showSetTotal && (
          <SetTotalBudgetSheet planId={planId} onClose={() => setShowSetTotal(false)} onChanged={onChanged} />
        )}
      </>
    );
  }

  const totalBudgetKobo = data.plan.total_kobo ?? 0;
  const totalBudget = totalBudgetKobo / 100;
  const totalCommittedKobo = data.categories.reduce((s, c) => s + c.committed_kobo, 0);
  const totalPaidKobo = data.categories.reduce((s, c) => s + c.paid_kobo, 0);
  const totalCommitted = totalCommittedKobo / 100;
  const totalPaid = totalPaidKobo / 100;
  const totalEstimated = data.categories.filter((c) => c.committed_kobo === 0 && c.paid_kobo === 0).reduce((s, c) => s + c.allocated_kobo, 0) / 100;
  const totalAllocated = data.categories.reduce((s, c) => s + c.allocated_kobo, 0) / 100;
  const unallocated = Math.max(0, totalBudget - totalAllocated);

  function status(c: WorkspaceCategory): 'over' | 'committed' | 'paid' | 'estimate' {
    const spent = c.committed_kobo + c.paid_kobo;
    if (spent > c.allocated_kobo) return 'over';
    if (c.paid_kobo > 0) return 'paid';
    if (c.committed_kobo > 0) return 'committed';
    return 'estimate';
  }
  const sortRank: Record<string, number> = { over: 0, committed: 1, paid: 1, estimate: 2 };
  const sorted = [...data.categories].sort((a, b) => sortRank[status(a)] - sortRank[status(b)]);

  // P20 "Budget exceeded" -- the mockup's own spec text: "Only
  // commitments can trigger it," so this checks real committed+paid
  // against the real total, never estimates alone.
  const overBudgetKobo = Math.max(0, totalCommittedKobo + totalPaidKobo - totalBudgetKobo);
  const isOverBudget = overBudgetKobo > 0;

  return (
    <>
      {isOverBudget && (
        <BudgetExceededBanner
          data={data}
          planId={planId}
          overKobo={overBudgetKobo}
          onOpenCategory={onOpenCategory}
          onAskSi={onAskSi}
          onChanged={onChanged}
        />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 12, color: '#8a7f97' }}>Total budget</span>
          <span onClick={() => setShowSetTotal(true)} role="button" data-testid="workspace-budget-edit-total" style={{ fontSize: 12, color: '#d3b8ff', cursor: 'pointer' }}>Edit</span>
        </div>
        <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em' }}>{naira(totalBudget)}</span>
        {showSetTotal && (
          <SetTotalBudgetSheet planId={planId} initialNaira={totalBudget} onClose={() => setShowSetTotal(false)} onChanged={onChanged} />
        )}
        {/* hideLegend: the 2x2 Paid/Committed/Estimate/Unallocated grid right
            below already shows these same figures (P08's own layout) --
            BudgetBar's inline legend would just duplicate it. */}
        <BudgetBar estimated={totalEstimated} committed={totalCommitted} paid={totalPaid} total={totalBudget || null} hideLegend />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div style={{ padding: '8px 10px', borderRadius: 10, background: '#120e1a', border: '1px solid #221d2d' }}>
            <div style={{ fontSize: 11, color: '#34d399' }}>● Paid</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 3 }}>{naira(totalPaid)}</div>
          </div>
          <div style={{ padding: '8px 10px', borderRadius: 10, background: '#120e1a', border: '1px solid #221d2d' }}>
            <div style={{ fontSize: 11, color: '#c084fc' }}>● Committed</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 3 }}>{naira(totalCommitted)}</div>
          </div>
          <div style={{ padding: '8px 10px', borderRadius: 10, background: '#120e1a', border: '1px solid #221d2d' }}>
            <div style={{ fontSize: 11, color: '#b892ff' }}>◌ Estimate · not a quote</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 3 }}>≈ {naira(totalEstimated)}</div>
          </div>
          <div style={{ padding: '8px 10px', borderRadius: 10, background: '#120e1a', border: '1px solid #221d2d' }}>
            <div style={{ fontSize: 11, color: '#a89db3' }}>○ Unallocated</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 3 }}>{naira(unallocated)}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {sorted.map((c, i) => {
          const s = status(c);
          const spent = (c.committed_kobo + c.paid_kobo) / 100;
          const allocated = c.allocated_kobo / 100;
          const over = spent - allocated;
          const barPct = allocated > 0 ? Math.min(100, (spent / allocated) * 100) : 0;
          const barColor = s === 'over' ? '#fbbf24' : s === 'paid' ? '#34d399' : s === 'committed' ? '#a35cff' : undefined;
          return (
            <div
              key={c.id}
              onClick={() => onOpenCategory(c.id)}
              role="button"
              data-testid={`workspace-budget-row-${c.key}`}
              style={{ padding: '9px 0', borderBottom: i < sorted.length - 1 ? '1px solid #1c1726' : 'none', display: 'flex', flexDirection: 'column', gap: 7, cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{c.label} {c.is_priority && <span style={{ fontSize: 10, color: '#d3b8ff' }}>★</span>}</span>
                <span style={{ fontSize: 13 }}>
                  {s === 'estimate' ? (
                    <span style={{ color: '#c9c0d4' }}>≈ {naira(allocated)}</span>
                  ) : (
                    <><b>{naira(spent)}</b> <span style={{ color: '#8a7f97' }}>/ {compactNaira(allocated)}</span></>
                  )}
                </span>
              </div>
              <div style={{ height: 5, borderRadius: 999, background: s === 'estimate' ? 'repeating-linear-gradient(45deg, rgba(163,92,255,.35) 0 4px, rgba(163,92,255,.1) 4px 8px)' : '#221d2d', overflow: 'hidden', display: 'flex' }}>
                {s !== 'estimate' && <span style={{ width: `${barPct}%`, background: barColor }} />}
              </div>
              <span style={{ fontSize: 11.5, color: s === 'over' ? '#fbbf24' : s === 'paid' ? '#34d399' : '#a89db3' }}>
                {s === 'over' ? `Committed · ${naira(over)} over` : s === 'paid' ? `Paid via VENTS · ${naira(allocated - spent)} left` : s === 'committed' ? `Committed · ${naira(allocated - spent)} left` : 'Estimate · not booked'}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

// P09 Budget allocation sheet -- a bottom sheet over a dimmed backdrop,
// opened from CategoryDetailView's "Edit" link. "Save allocation" calls
// the REAL apply_plan_allocation_changes RPC directly (bypassing the AI
// model), the exact same server-side invariant-enforcing path
// apply_plan_update's own executor uses -- same precedent as Undo calling
// undo_plan_change directly: a direct, unambiguous, structured UI action
// needs no model round trip. The floor-price/count line reuses the real
// search_services_fuzzy_filtered RPC recommend_providers already wraps.
function AllocationSheet({
  planId,
  category,
  categories,
  planCity,
  totalBudgetKobo,
  onClose,
  onSaved,
}: {
  planId: string;
  category: WorkspaceCategory;
  categories: WorkspaceCategory[];
  planCity: string | null;
  totalBudgetKobo: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amountNaira, setAmountNaira] = useState(category.allocated_kobo / 100);
  const [source, setSource] = useState<{ kind: 'unallocated' } | { kind: 'category'; id: string } | { kind: 'raise_total' } | null>({ kind: 'unallocated' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [floorPrice, setFloorPrice] = useState<number | null>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.rpc('search_services_fuzzy_filtered', { p_query: category.label, p_category: category.key, p_limit: 50, p_location: planCity, p_max_starting_price: null });
        if (cancelled) return;
        const rows = Array.isArray(data) ? data : [];
        setMatchCount(rows.length);
        const prices = rows.map((r: any) => Number(r.starting_price)).filter((n: number) => isFinite(n) && n >= 0);
        setFloorPrice(prices.length ? Math.min(...prices) : null);
      } catch {
        // factual floor-price line is best-effort -- never blocks editing the allocation
      }
    })();
    return () => { cancelled = true; };
  }, [category.key, category.label, planCity]);

  const totalAllocatedOther = categories.filter((c) => c.id !== category.id).reduce((s, c) => s + c.allocated_kobo, 0);
  const unallocatedKobo = Math.max(0, totalBudgetKobo - totalAllocatedOther - category.allocated_kobo);
  const deltaKobo = Math.round(amountNaira * 100) - category.allocated_kobo;

  const STEP_NAIRA = 50000;
  function step(dir: 1 | -1) {
    setAmountNaira((n) => Math.max(0, n + dir * STEP_NAIRA));
  }

  const otherCategories = categories.filter((c) => c.id !== category.id && !/conting/i.test(c.key) && !/conting/i.test(c.label));
  const contingency = categories.find((c) => /conting/i.test(c.key) || /conting/i.test(c.label));

  async function handleSave() {
    if (deltaKobo === 0) { onClose(); return; }
    if (deltaKobo > 0 && (!source || source.kind === 'raise_total')) {
      // Raising the category needs a real source category to take from --
      // "Raise total budget" is a distinct, larger action (editing the
      // plan's own total_kobo) not built in this pass; stated, not faked.
      if (source?.kind === 'raise_total') {
        setError("Raising the total budget isn't built yet -- pick a category or Unallocated to take from instead.");
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const changes: { category_id: string; new_allocated_kobo: number }[] = [
        { category_id: category.id, new_allocated_kobo: Math.round(amountNaira * 100) },
      ];
      if (deltaKobo > 0 && source && source.kind === 'category') {
        const sourceCat = categories.find((c) => c.id === source.id);
        if (sourceCat) changes.push({ category_id: sourceCat.id, new_allocated_kobo: Math.max(0, sourceCat.allocated_kobo - deltaKobo) });
      }
      // deltaKobo < 0 (lowering the category) needs no source -- it just
      // frees allocation back to Unallocated, nothing else to change.
      const { error: rpcError } = await supabase.rpc('apply_plan_allocation_changes', { p_plan_id: planId, p_changes: changes, p_actor: 'user' });
      if (rpcError) throw rpcError;
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || "That didn't go through.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(5,4,8,.72)' }} onClick={onClose} data-testid="ai-allocation-sheet-backdrop">
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: '24px 24px 0 0', background: '#120e1a', borderTop: '1px solid #2c2438', padding: '10px 20px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}
      >
        <span style={{ width: 40, height: 4, borderRadius: 9, background: '#3a3048', alignSelf: 'center' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 18, fontWeight: 800 }}>{category.label}</span>
          <span style={{ fontSize: 12, color: '#8a7f97' }}>{category.booked ? 'Paid via VENTS' : category.committed_kobo > 0 ? 'Committed' : 'Estimate · not booked'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* R1 (360px) regression this pass found: with no flexShrink:0,
              these 44px stepper buttons were compressed down to ~19px by
              the flex row (confirmed by measuring the real rendered rect --
              the "+" button ended up entirely off-screen, past x=400 in a
              360px viewport). The buttons must stay full-size; the amount
              input (flex:1) is the one with room to give. */}
          <span onClick={() => step(-1)} role="button" data-testid="ai-allocation-minus" style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, background: '#1c1726', border: '1px solid #2c2438', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, cursor: 'pointer' }}>−</span>
          <input
            type="text"
            inputMode="numeric"
            value={naira(amountNaira)}
            onChange={(e) => setAmountNaira(Math.max(0, Number(e.target.value.replace(/[^0-9]/g, '')) || 0))}
            data-testid="ai-allocation-amount-input"
            style={{ flex: 1, minWidth: 0, height: 56, borderRadius: 12, background: '#0a0810', border: '1px solid rgba(163,92,255,.55)', textAlign: 'center', fontSize: 24, fontWeight: 800, color: '#f2eff6', fontFamily: 'inherit' }}
          />
          <span onClick={() => step(1)} role="button" data-testid="ai-allocation-plus" style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, background: '#1c1726', border: '1px solid #2c2438', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, cursor: 'pointer' }}>+</span>
        </div>
        <div style={{ fontSize: 12.5, color: '#a89db3', textAlign: 'center' }}>
          {matchCount == null ? 'Checking VENTS providers…' : matchCount === 0 ? 'No matching VENTS providers for this category yet' : `VENTS ${category.label.toLowerCase()} providers${planCity ? ` in ${planCity}` : ''} start from ${floorPrice != null ? naira(floorPrice) : '—'} · ${matchCount} found`}
        </div>
        {deltaKobo > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97' }}>TAKE {naira(deltaKobo / 100)} FROM</span>
            <div
              onClick={() => setSource({ kind: 'unallocated' })}
              role="button"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderRadius: 11, cursor: 'pointer', background: source?.kind === 'unallocated' ? 'rgba(163,92,255,.12)' : '#0a0810', border: source?.kind === 'unallocated' ? '1px solid rgba(163,92,255,.55)' : '1px solid #2c2438' }}
            >
              <span style={{ fontSize: 13.5, fontWeight: 700 }}>Unallocated</span>
              <span style={{ fontSize: 13, color: '#c9c0d4' }}>{naira(unallocatedKobo / 100)} → {naira(Math.max(0, unallocatedKobo - deltaKobo) / 100)}</span>
            </div>
            {contingency && (
              <div
                onClick={() => setSource({ kind: 'category', id: contingency.id })}
                role="button"
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderRadius: 11, cursor: 'pointer', background: source?.kind === 'category' && source.id === contingency.id ? 'rgba(163,92,255,.12)' : '#0a0810', border: source?.kind === 'category' && source.id === contingency.id ? '1px solid rgba(163,92,255,.55)' : '1px solid #2c2438' }}
              >
                <span style={{ fontSize: 13.5 }}>{contingency.label}</span>
                <span style={{ fontSize: 13, color: '#8a7f97' }}>{naira(contingency.allocated_kobo / 100)}</span>
              </div>
            )}
            {otherCategories.length > 0 && (
              <PickerField
                value={source?.kind === 'category' && source.id !== contingency?.id ? categories.find((c) => c.id === source.id)?.label || '' : ''}
                placeholder="Another category…"
                onOpen={() => setShowCategoryPicker(true)}
              />
            )}
            <div
              onClick={() => setSource({ kind: 'raise_total' })}
              role="button"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderRadius: 11, cursor: 'pointer', background: source?.kind === 'raise_total' ? 'rgba(163,92,255,.12)' : '#0a0810', border: source?.kind === 'raise_total' ? '1px solid rgba(163,92,255,.55)' : '1px solid #2c2438' }}
            >
              <span style={{ fontSize: 13.5 }}>Raise total budget</span>
              <span style={{ fontSize: 13, color: '#8a7f97' }}>{naira(totalBudgetKobo / 100)}</span>
            </div>
          </div>
        )}
        {error && <div style={{ fontSize: 12, color: '#fbbf24' }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <span onClick={onClose} role="button" style={{ flex: 1, height: 48, borderRadius: 12, background: '#1c1726', border: '1px solid #2c2438', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Cancel</span>
          <span onClick={handleSave} role="button" data-testid="ai-allocation-save" style={{ flex: 1.6, height: 48, borderRadius: 12, background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#fff', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save allocation'}</span>
        </div>
      </div>
      {showCategoryPicker && (
        <PickerSheet
          title="Take from which category?"
          options={otherCategories.map((c) => ({ value: c.id, label: c.label, sublabel: naira(c.allocated_kobo / 100) }))}
          value={source?.kind === 'category' ? source.id : ''}
          searchable={false}
          onSelect={(id) => { setSource({ kind: 'category', id }); setShowCategoryPicker(false); }}
          onClose={() => setShowCategoryPicker(false)}
          zIndex={1100}
        />
      )}
    </div>
  );
}

// P10 Category detail -- "the single place a category's money, provider,
// tasks and notes meet" (the mockup's own words). Opened from Budget/Team
// rows. Assigned-provider actions Message/View booking have no reachable
// destination screen from this overlay component -- a stated gap, not a
// dead click (tapping them shows that honestly rather than silently doing
// nothing). "Replace" opens the real recommend_providers flow via the
// plan's own Ask-SI thread, a genuine action, not a stub.
function CategoryDetailView({
  planId,
  planTitle,
  planCity,
  totalBudgetKobo,
  allCategories,
  category,
  tasks,
  onBack,
  onChanged,
}: {
  planId: string;
  planTitle: string;
  planCity: string | null;
  totalBudgetKobo: number;
  allCategories: WorkspaceCategory[];
  category: WorkspaceCategory;
  tasks: WorkspaceTask[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const [showSheet, setShowSheet] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const active = category.assignments.find((a) => a.status === 'assigned' || a.status === 'booked') || null;
  const left = Math.max(0, category.allocated_kobo - category.committed_kobo - category.paid_kobo);

  // S5-A: only a plan-only, unpaid/unbooked assignment is eligible here --
  // a real paid booking is explicitly protected (S5-B's own booking flow,
  // not implemented yet; "View booking" below stays a stated gap for it).
  async function removeAssignment() {
    if (!active) return;
    setRemoving(true);
    setRemoveError(null);
    const { error } = await supabase.rpc('remove_plan_assignment', { p_assignment_id: active.id });
    setRemoving(false);
    if (error) { setRemoveError(error.message); return; }
    setShowRemoveConfirm(false);
    onChanged();
  }

  async function toggleTask(task: WorkspaceTask) {
    if (task.completes_on_booking) return; // "can't be unticked manually -- the booking is the truth"
    const { error } = await supabase.from('plan_tasks').update({ done_at: task.done_at ? null : new Date().toISOString() }).eq('id', task.id);
    if (!error) onChanged();
  }

  const doneCount = tasks.filter((t) => !!t.done_at).length;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: -4 }}>
        <span onClick={onBack} role="button" aria-label="Back" style={{ fontSize: 19, color: '#e4d4ff', cursor: 'pointer' }}>←</span>
        <span style={{ flex: 1, fontSize: 13, color: '#a89db3' }}>{planTitle}</span>
        <span onClick={() => setShowSheet(true)} role="button" data-testid="ai-category-edit" style={{ fontSize: 13, color: '#d3b8ff', cursor: 'pointer' }}>Edit</span>
      </div>
      <div>
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em' }}>{category.label}</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {category.booked && <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: 'rgba(52,211,153,.12)', color: '#34d399' }}>PAID</span>}
          {category.is_priority && <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: 'rgba(163,92,255,.14)', color: '#d3b8ff' }}>★ PRIORITY</span>}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', borderRadius: 12, background: '#120e1a', border: '1px solid #221d2d' }}>
        {/* P10's own frame uses the compact "₦500k" form for all three
            tiles here (a tight 3-column grid, unlike Budget tab's own
            2x2 stat grid which stays full-precision) -- verified by
            rendered comparison, not assumed from the general convention. */}
        <div style={{ padding: 12 }}><div style={{ fontSize: 11, color: '#8a7f97' }}>Allocated</div><div style={{ fontSize: 15, fontWeight: 700, marginTop: 3 }}>{compactNaira(category.allocated_kobo / 100)}</div></div>
        <div style={{ padding: 12, borderLeft: '1px solid #1c1726' }}><div style={{ fontSize: 11, color: '#34d399' }}>Paid</div><div style={{ fontSize: 15, fontWeight: 700, marginTop: 3 }}>{compactNaira(category.paid_kobo / 100)}</div></div>
        <div style={{ padding: 12, borderLeft: '1px solid #1c1726' }}><div style={{ fontSize: 11, color: '#8a7f97' }}>Left</div><div style={{ fontSize: 15, fontWeight: 700, marginTop: 3 }}>{compactNaira(left / 100)}</div></div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97' }}>ASSIGNED</span>
        {!active ? (
          <div style={{ fontSize: 12.5, color: '#5e5470', padding: '12px 0' }}>No one assigned to this category yet.</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 12, borderRadius: 12, background: '#120e1a', border: '1px solid #221d2d' }}>
              <span style={{ width: 52, height: 52, borderRadius: 10, background: 'repeating-linear-gradient(45deg,#1c1726,#1c1726 8px,#181322 8px,#181322 16px)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{active.provider?.business_name || active.own_vendor_name || 'Provider'}</div>
                <div style={{ fontSize: 12, color: '#a89db3', marginTop: 2 }}>
                  {active.provider ? [active.provider.category, active.provider.location].filter(Boolean).join(' · ') : 'Own vendor'}
                </div>
                <div style={{ fontSize: 12, color: active.status === 'booked' ? '#34d399' : '#c084fc', marginTop: 3 }}>
                  {active.status === 'booked' ? 'Booking paid' : 'Committed'}{active.agreed_kobo != null ? ` · ${naira(active.agreed_kobo / 100)}` : ''}
                </div>
              </div>
              <span style={{ fontSize: 12, color: '#d3b8ff' }}>›</span>
            </div>
            {active.status === 'booked' ? (
              // S5-B (booked and paid) stays explicitly deferred -- the
              // mockup's own rule is "the planner never cancels or
              // refunds, open the real booking instead," and no
              // booking-detail screen exists yet to open. Stated gap, not
              // a fake destination.
              <div style={{ display: 'flex', gap: 8 }}>
                <span onClick={() => setActionNote('Messaging a provider from here is not built yet.')} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Message</span>
                <span onClick={() => setActionNote('Opening the real booking screen from here is not built yet.')} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>View booking</span>
              </div>
            ) : (
              // S5-A: a plan-only, unpaid/unbooked assignment can be
              // removed for real.
              <div style={{ display: 'flex', gap: 8 }}>
                <span onClick={() => setActionNote('Messaging a provider from here is not built yet.')} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Message</span>
                <span onClick={() => setShowRemoveConfirm(true)} role="button" data-testid="ai-category-remove" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid rgba(248,113,113,.45)', fontSize: 12.5, fontWeight: 700, color: '#f87171', cursor: 'pointer' }}>Remove</span>
              </div>
            )}
            {actionNote && <div style={{ fontSize: 11.5, color: '#8a7f97' }}>{actionNote}</div>}
            {showRemoveConfirm && active.status !== 'booked' && (
              <div style={{ padding: 16, borderRadius: 14, background: '#120e1a', border: '1px solid #2c2438', display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="ai-category-remove-confirm">
                <span style={{ fontSize: 16, fontWeight: 800 }}>Remove {active.provider?.business_name || active.own_vendor_name}?</span>
                <span style={{ fontSize: 13, color: '#a89db3', lineHeight: 1.5 }}>
                  {active.agreed_kobo ? `${naira(active.agreed_kobo / 100)} committed returns to ${category.label} as an estimate. ` : ''}Linked tasks reopen.
                </span>
                {removeError && <span style={{ fontSize: 12, color: '#fbbf24' }}>{removeError}</span>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <span onClick={() => setShowRemoveConfirm(false)} role="button" data-testid="ai-category-remove-keep" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Keep</span>
                  <span onClick={removeAssignment} role="button" data-testid="ai-category-remove-confirm-button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid rgba(248,113,113,.45)', fontSize: 12.5, fontWeight: 700, color: '#f87171', cursor: removing ? 'default' : 'pointer', opacity: removing ? 0.7 : 1 }}>{removing ? 'Removing…' : 'Remove'}</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97', marginBottom: 6 }}>TASKS · {doneCount} OF {tasks.length}</span>
        {tasks.length === 0 ? (
          <div style={{ fontSize: 12.5, color: '#5e5470', padding: '10px 0' }}>No tasks for this category yet.</div>
        ) : (
          tasks.map((t, i) => {
            const done = !!t.done_at;
            return (
              <div key={t.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: i < tasks.length - 1 ? '1px solid #1c1726' : 'none' }}>
                <span
                  onClick={() => toggleTask(t)}
                  role="button"
                  style={{ width: 20, height: 20, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#fff', cursor: t.completes_on_booking ? 'default' : 'pointer', background: done ? '#a35cff' : 'transparent', border: done ? 'none' : '1.5px solid #4a3f56' }}
                >
                  {done ? '✓' : ''}
                </span>
                <span style={{ flex: 1, fontSize: 13.5, color: done ? '#8a7f97' : '#f2eff6', textDecoration: done ? 'line-through' : 'none' }}>{t.title}</span>
                <span style={{ fontSize: 11, color: '#8a7f97' }}>{done && t.completes_on_booking ? 'via VENTS' : t.due_override || (t.offset_days != null ? `T-${t.offset_days}d` : '')}</span>
              </div>
            );
          })
        )}
      </div>
      {showSheet && (
        <AllocationSheet
          planId={planId}
          category={category}
          categories={allCategories}
          planCity={planCity}
          totalBudgetKobo={totalBudgetKobo}
          onClose={() => setShowSheet(false)}
          onSaved={onChanged}
        />
      )}
    </>
  );
}

// P11 Team tab -- every category as a "slot" row. Sort order is the
// mockup's own spec text: booked -> committed -> own vendor -> next due
// (expanded) -> open. "N on VENTS · from ₦X" / "No matches" per open
// category comes from the same real search_services_fuzzy_filtered RPC
// P09 uses, run once per open category.
// How long a fresh booking still gets P14's green receipt treatment --
// after this (or after the tab has been shown once this session, see the
// sessionStorage guard below), it "relaxes to a normal row" per the
// mockup's own spec text.
const JUST_BOOKED_WINDOW_MS = 10 * 60 * 1000;

function WorkspaceTeamTab({ data, planId, onOpenCategory, onAskSi, onChanged }: { data: PlanWorkspaceData; planId: string; onOpenCategory: (categoryId: string) => void; onAskSi: () => void; onChanged: () => void }) {
  const [matchInfo, setMatchInfo] = useState<Record<string, { count: number; floor: number | null }>>({});
  const [matchError, setMatchError] = useState<Record<string, boolean>>({});
  const [readiness, setReadiness] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [ownVendorCategory, setOwnVendorCategory] = useState<WorkspaceCategory | null>(null);
  const shownRef = useRef(false);

  // Contingency has no team slot (see teamCategories below) -- excluded from
  // both sides of the "N of M assigned" count, matching the mockup's Budget
  // tab treatment of it as a value-only line.
  const assignedCount = data.categories.filter((c) => !c.is_contingency && c.assignments.some((a) => a.status === 'assigned' || a.status === 'booked')).length;

  // The one real "just booked" assignment for THIS visit, if any -- real
  // updated_at timestamp, real sessionStorage "already shown" guard, never
  // a fabricated success state. Snapshotted into state exactly once on
  // mount (never re-derived mid-visit) -- marking it "seen" in
  // sessionStorage still triggers a re-render (the readiness toast's own
  // setState below does), and re-deriving straight from sessionStorage on
  // every render would make the receipt vanish the instant it's marked
  // seen, rather than staying for this visit and only relaxing on the
  // NEXT one.
  const [justBookedAssignment, setJustBookedAssignment] = useState<{ c: WorkspaceCategory; a: WorkspaceAssignment } | null>(null);

  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    const candidates = data.categories
      .map((c) => ({ c, a: c.assignments.find((a) => a.status === 'booked') }))
      .filter((x): x is { c: WorkspaceCategory; a: WorkspaceAssignment } => {
        if (!x.a) return false;
        const seenKey = `vents_si_seen_booked_${x.a.id}`;
        if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(seenKey)) return false;
        return Date.now() - new Date(x.a.updated_at).getTime() < JUST_BOOKED_WINDOW_MS;
      })
      .sort((x, y) => new Date(y.a.updated_at).getTime() - new Date(x.a.updated_at).getTime());
    const found = candidates[0] ?? null;
    if (!found) return;
    setJustBookedAssignment(found);
    try { sessionStorage.setItem(`vents_si_seen_booked_${found.a.id}`, '1'); } catch { /* sessionStorage unavailable -- the receipt just won't persist across a reload, not a crash */ }
    setReadiness(computeReadiness(data));
    const t = setTimeout(() => setReadiness(null), 5000);
    return () => clearTimeout(t);
    // Runs once per mount (shownRef guards re-entry) -- intentionally not
    // re-keyed off `data`, since that would re-arm the receipt every time
    // fetchPlanWorkspace refreshes (e.g. after the surplus "Move" write).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const surplusKobo = justBookedAssignment ? Math.max(0, justBookedAssignment.c.allocated_kobo - (justBookedAssignment.a.agreed_kobo ?? 0)) : 0;
  const bookedTask = justBookedAssignment ? data.tasks.find((t) => t.category_id === justBookedAssignment.c.id && t.completes_on_booking && !!t.done_at) : null;

  async function moveSurplusToUnallocated() {
    if (!justBookedAssignment || surplusKobo <= 0) return;
    setMoving(true);
    try {
      const { error } = await supabase.rpc('apply_plan_allocation_changes', {
        p_plan_id: planId,
        p_changes: [{ category_id: justBookedAssignment.c.id, new_allocated_kobo: justBookedAssignment.a.agreed_kobo ?? 0 }],
        p_actor: 'user',
      });
      if (!error) onChanged();
    } finally {
      setMoving(false);
    }
  }

  function slotState(c: WorkspaceCategory): 'booked' | 'committed' | 'own_vendor' | 'open' {
    const active = c.assignments.find((a) => a.status === 'assigned' || a.status === 'booked');
    if (!active) return 'open';
    if (active.status === 'booked') return 'booked';
    if (!active.provider_id && active.own_vendor_name) return 'own_vendor';
    return 'committed';
  }

  const openCategories = data.categories.filter((c) => slotState(c) === 'open');
  // S2-C: a custom category (vents_category === 'custom', added via "+
  // Category") never gets a VENTS provider search -- "stays first-class,
  // just without recommendations," per the mockup's own spec text.
  const isCustomCategory = (c: WorkspaceCategory) => c.vents_category === 'custom';
  const searchableOpenCategories = openCategories.filter((c) => !isCustomCategory(c));
  // Next-due = the open category with the soonest due task, shown
  // expanded per the mockup's "(expanded, one at a time)" note.
  function nextDueDate(c: WorkspaceCategory): number {
    const t = data.tasks.find((t) => t.category_id === c.id && !t.done_at && (t.due_override || t.offset_days != null));
    if (!t) return Infinity;
    if (t.due_override) return new Date(t.due_override).getTime();
    return data.plan.event_date ? new Date(data.plan.event_date).getTime() - (t.offset_days ?? 0) * 86400000 : Infinity;
  }
  const nextDueCategory = [...openCategories].sort((a, b) => nextDueDate(a) - nextDueDate(b)).find((c) => nextDueDate(c) < Infinity) || null;

  async function fetchMatchInfo(c: WorkspaceCategory) {
    try {
      const { data: rows, error } = await supabase.rpc('search_services_fuzzy_filtered', { p_query: c.label, p_category: c.key, p_limit: 50, p_location: data.plan.city, p_max_starting_price: null });
      if (error) throw error;
      const list = Array.isArray(rows) ? rows : [];
      const prices = list.map((r: any) => Number(r.starting_price)).filter((n: number) => isFinite(n) && n >= 0);
      setMatchInfo((prev) => ({ ...prev, [c.id]: { count: list.length, floor: prices.length ? Math.min(...prices) : null } }));
      setMatchError((prev) => { const next = { ...prev }; delete next[c.id]; return next; });
    } catch {
      // S3-C "Provider search failed" -- a real RPC error (including a
      // real Postgrest `error` the query resolved WITH, never silently
      // treated as "zero matches") renders a real retry, not a
      // permanently-blank row pretending to still be loading.
      setMatchError((prev) => ({ ...prev, [c.id]: true }));
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const c of searchableOpenCategories) {
        if (matchInfo[c.id] || matchError[c.id]) continue;
        if (cancelled) return;
        await fetchMatchInfo(c);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.plan.city, searchableOpenCategories.map((c) => c.id).join(',')]);

  const rank: Record<string, number> = { booked: 0, committed: 1, own_vendor: 2, open: 3 };
  // A contingency category (e.g. "Contingency ₦800,000") has no team slot --
  // the mockup's Budget tab shows it as a value-only line, never a row here.
  const teamCategories = data.categories.filter((c) => !c.is_contingency);
  const sorted = [...teamCategories].sort((a, b) => {
    const ra = a.id === nextDueCategory?.id ? 2.5 : rank[slotState(a)];
    const rb = b.id === nextDueCategory?.id ? 2.5 : rank[slotState(b)];
    return ra - rb;
  });

  // S4-B "Team · no categories yet" -- a draft whose brief hasn't been
  // confirmed has no plan_categories rows at all (create_plan_draft only
  // seeds them at creation; see executeCreatePlanDraft). Real missing
  // data, not an empty "0 of 0 assigned" header. Checked after every hook
  // above (never before an early return) so this component's hook order
  // stays identical across a 0 -> non-zero categories transition on the
  // same mounted instance (e.g. after confirming the brief elsewhere).
  if (data.categories.length === 0) {
    return (
      <div style={{ padding: 16, borderRadius: 14, background: '#120e1a', border: '1px solid #221d2d', display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="workspace-team-not-yet">
        <span style={{ fontSize: 16, fontWeight: 800 }}>No team slots yet</span>
        <span style={{ fontSize: 13, color: '#a89db3', lineHeight: 1.5 }}>
          Confirm the brief and VENTS AI suggests categories{data.plan.guests ? ` for a ${titleCase(data.plan.event_type)} of ${data.plan.guests}` : ` for your ${titleCase(data.plan.event_type)}`}.
        </span>
        <span onClick={onAskSi} role="button" data-testid="workspace-team-finish-brief" style={{ fontSize: 13, fontWeight: 700, color: '#d3b8ff', cursor: 'pointer' }}>Finish brief with VENTS AI ›</span>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 20, fontWeight: 800 }}>{assignedCount} of {teamCategories.length} assigned</span>
        <span onClick={() => setShowAddCategory(true)} role="button" data-testid="workspace-team-add-category" style={{ fontSize: 12, color: '#d3b8ff', cursor: 'pointer' }}>+ Category</span>
      </div>
      {sorted.map((c) => {
        const state = slotState(c);
        const active = c.assignments.find((a) => a.status === 'assigned' || a.status === 'booked');
        const isNextDue = c.id === nextDueCategory?.id;
        const info = matchInfo[c.id];

        // P14 "Provider assigned state" -- the one real just-booked receipt
        // this visit, not a generic success screen. Every line is real:
        // the completed task (if any), the real surplus amount (offered,
        // never auto-moved), and the real booking_id-backed "added to your
        // VENTS bookings" fact.
        if (justBookedAssignment && c.id === justBookedAssignment.c.id) {
          const a = justBookedAssignment.a;
          return (
            <div key={c.id} style={{ padding: 14, borderRadius: 12, background: 'rgba(52,211,153,.06)', border: '1px solid rgba(52,211,153,.35)', display: 'flex', flexDirection: 'column', gap: 10 }} data-testid={`workspace-team-row-${c.key}`}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#34d399', color: '#0a0810', fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>✓</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: '#8a7f97' }}>{c.label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{a.provider?.business_name || a.own_vendor_name}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{naira((a.agreed_kobo ?? 0) / 100)}</div>
                  <div style={{ fontSize: 11, color: '#34d399' }}>Paid · just now</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 10, borderTop: '1px solid rgba(52,211,153,.2)', fontSize: 12.5, color: '#c9c0d4' }}>
                {bookedTask && <span>✓ Task "{bookedTask.title}" completed</span>}
                {surplusKobo > 0 && (
                  <span>
                    ✓ {c.label} {naira(surplusKobo / 100)} under — moved to Unallocated?{' '}
                    <span onClick={moveSurplusToUnallocated} role="button" data-testid="workspace-team-move-surplus" style={{ color: '#d3b8ff', fontWeight: 700, cursor: moving ? 'default' : 'pointer' }}>{moving ? 'Moving…' : 'Move'}</span>
                  </span>
                )}
                <span>✓ Booking added to your VENTS bookings</span>
              </div>
            </div>
          );
        }

        // S2-C "Custom category, no VENTS match type" -- exact mockup copy
        // and layout: dashed glyph, "Not a VENTS service category · track
        // your own," and a real "Add" action (assign_own_vendor), never a
        // VENTS provider search for a category that was explicitly marked
        // as not mapping to one.
        if (!active && isCustomCategory(c)) {
          return (
            <div key={c.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 14px', borderRadius: 12, background: '#120e1a', border: '1px solid #221d2d' }} data-testid={`workspace-team-row-${c.key}`}>
              <span style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, border: '1.5px dashed #4a3f56' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{c.label}</div>
                <div style={{ fontSize: 12, color: '#a89db3', marginTop: 1 }}>Not a VENTS service category · track your own</div>
              </div>
              <span onClick={() => setOwnVendorCategory(c)} role="button" data-testid={`workspace-team-add-vendor-${c.id}`} style={{ fontSize: 12, color: '#d3b8ff', fontWeight: 700, cursor: 'pointer' }}>Add</span>
            </div>
          );
        }

        if (isNextDue) {
          return (
            <div key={c.id} style={{ padding: 14, borderRadius: 12, background: '#120e1a', border: '1px solid rgba(163,92,255,.35)', display: 'flex', flexDirection: 'column', gap: 10 }} data-testid={`workspace-team-row-${c.key}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div onClick={() => onOpenCategory(c.id)} role="button" style={{ cursor: 'pointer' }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{c.label}</div>
                  <div style={{ fontSize: 12, color: matchError[c.id] ? '#c9c0d4' : '#a89db3', marginTop: 2 }}>
                    {matchError[c.id]
                      ? `Couldn't load ${c.label.toLowerCase()} right now.`
                      : info
                        ? `${info.count} on VENTS · from ${info.floor != null ? naira(info.floor) : '—'} · budget ≈ ${naira(c.allocated_kobo / 100)}`
                        : `Finding ${c.label.toLowerCase()}${data.plan.city ? ` in ${data.plan.city}` : ''}…`}
                  </div>
                </div>
                {matchError[c.id] ? (
                  <span onClick={() => fetchMatchInfo(c)} role="button" data-testid={`workspace-team-retry-${c.id}`} style={{ fontSize: 12.5, fontWeight: 700, color: '#d3b8ff', cursor: 'pointer' }}>Retry</span>
                ) : (
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24' }}>Due soon</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {[0, 1, 2].map((i) => (
                  <span key={i} style={{ width: 32, height: 32, borderRadius: '50%', marginLeft: i > 0 ? -14 : 0, background: 'repeating-linear-gradient(45deg,#2c2438,#2c2438 5px,#231d2e 5px,#231d2e 10px)', border: '2px solid #120e1a' }} />
                ))}
                <span style={{ flex: 1 }} />
                <span onClick={() => onOpenCategory(c.id)} role="button" style={{ padding: '8px 14px', borderRadius: 9, background: 'rgba(163,92,255,.14)', color: '#d3b8ff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>View providers</span>
              </div>
            </div>
          );
        }

        const glyph =
          state === 'booked' ? { bg: '#34d399', color: '#0a0810', content: '✓' } :
          state === 'committed' ? { bg: '#a35cff', color: '#fff', content: '✓' } :
          state === 'own_vendor' ? { bg: 'transparent', color: '#c084fc', content: '↗', border: '1.5px solid #a35cff' } :
          { bg: 'transparent', color: 'transparent', content: '', border: '1.5px dashed #4a3f56' };

        return (
          <div key={c.id} onClick={() => onOpenCategory(c.id)} role="button" data-testid={`workspace-team-row-${c.key}`} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 14px', borderRadius: 12, background: '#120e1a', border: '1px solid #221d2d', cursor: 'pointer' }}>
            <span style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, fontSize: 12, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', background: glyph.bg, color: glyph.color, border: (glyph as any).border }}>{glyph.content}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#8a7f97' }}>{c.label}{state === 'own_vendor' ? ' · own vendor' : ''}</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 1, color: !active && matchError[c.id] ? '#c9c0d4' : undefined }}>
                {active
                  ? (active.provider?.business_name || active.own_vendor_name)
                  : matchError[c.id]
                    // S3-C "Provider search failed" -- a real RPC error, not
                    // silently treated as "zero matches" and not a
                    // permanently-stuck "Finding…" line either.
                    ? `Couldn't load ${c.label.toLowerCase()} right now.`
                    // S2-B's own literal copy: "Not started · N on VENTS" while open.
                    : info
                      ? (info.count > 0 ? `Not started · ${info.count} on VENTS` : `No matches within ${naira(c.allocated_kobo / 100)}`)
                      // S1-B's own literal copy: "Finding {category} in {city}…"
                      : `Finding ${c.label.toLowerCase()}${data.plan.city ? ` in ${data.plan.city}` : ''}…`}
              </div>
            </div>
            {active ? (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>{naira((active.agreed_kobo ?? 0) / 100)}</div>
                <div style={{ fontSize: 11, color: state === 'booked' ? '#34d399' : state === 'own_vendor' ? '#fbbf24' : '#c084fc' }}>
                  {state === 'booked' ? 'Paid' : state === 'own_vendor' ? (active.agreed_kobo != null && active.agreed_kobo > c.allocated_kobo ? `Over by ${naira((active.agreed_kobo - c.allocated_kobo) / 100)}` : 'Own vendor') : 'Committed'}
                </div>
              </div>
            ) : matchError[c.id] ? (
              <span onClick={(e) => { e.stopPropagation(); fetchMatchInfo(c); }} role="button" data-testid={`workspace-team-retry-${c.id}`} style={{ fontSize: 12.5, fontWeight: 700, color: '#d3b8ff', cursor: 'pointer' }}>Retry</span>
            ) : (
              // S2-B's own "Find" link (not a bare chevron) -- same
              // destination (onOpenCategory, the real discovery/assignment
              // flow) as tapping anywhere else on this row.
              <span style={{ fontSize: 12, color: '#d3b8ff', fontWeight: 700 }}>Find</span>
            )}
          </div>
        );
      })}
      {readiness != null && (
        <div style={{ position: 'fixed', left: 18, right: 18, bottom: 92, padding: '12px 14px', borderRadius: 12, background: '#1c1726', border: '1px solid #2c2438', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 12px 30px rgba(0,0,0,.5)', zIndex: 960 }} data-testid="workspace-readiness-toast">
          <span style={{ fontSize: 13, flex: 1 }}>Plan is now <b>{readiness}% ready</b></span>
          <span style={{ width: 60, height: 5, borderRadius: 9, background: '#2c2438', overflow: 'hidden', display: 'flex' }}>
            <span style={{ width: `${readiness}%`, background: '#a35cff' }} />
          </span>
        </div>
      )}
      {showAddCategory && (
        <AddCategorySheet planId={planId} onClose={() => setShowAddCategory(false)} onChanged={onChanged} />
      )}
      {ownVendorCategory && (
        <AddOwnVendorSheet category={ownVendorCategory} onClose={() => setOwnVendorCategory(null)} onChanged={onChanged} />
      )}
    </>
  );
}

// S2-C / "+ Category" -- a real add_plan_category() write (migration
// 0161), scoped by that function's own ownership check. The new row's
// vents_category is always 'custom' server-side, which is what routes it
// into S2-C's own row treatment above rather than a VENTS provider search.
function AddCategorySheet({ planId, onClose, onChanged }: { planId: string; onClose: () => void; onChanged: () => void }) {
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const t = label.trim();
    if (!t) { setError('Enter a category name.'); return; }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.rpc('add_plan_category', { p_plan_id: planId, p_label: t });
    setSaving(false);
    if (err) { setError(err.message); return; }
    onChanged();
    onClose();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,4,8,.72)', display: 'flex', alignItems: 'flex-end', zIndex: 980 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: '#120e1a', borderTop: '1px solid #2c2438', borderRadius: '18px 18px 0 0', padding: '18px 18px calc(18px + env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Add a category</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Fireworks"
          data-testid="workspace-add-category-input"
          style={{ background: '#1c1726', border: '1px solid #2c2438', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
        />
        {error && <span style={{ fontSize: 12, color: '#fbbf24' }}>{error}</span>}
        <div style={{ display: 'flex', gap: 8 }}>
          <span onClick={onClose} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Cancel</span>
          <span onClick={save} role="button" data-testid="workspace-add-category-save" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Adding…' : 'Add'}</span>
        </div>
      </div>
    </div>
  );
}

// S2-C's "Add" action -- a real assign_own_vendor() write (migration
// 0161), mirroring assign_plan_provider's own replace/paid-booking
// protection exactly. Name is the only required field; phone/amount are
// optional, matching how little the mockup's own copy demands.
function AddOwnVendorSheet({ category, onClose, onChanged }: { category: WorkspaceCategory; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const t = name.trim();
    if (!t) { setError('Enter a vendor name.'); return; }
    const naira = amount.trim() ? Number(amount) : null;
    if (naira != null && (!isFinite(naira) || naira < 0)) { setError('Enter a real amount in naira.'); return; }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.rpc('assign_own_vendor', {
      p_category_id: category.id,
      p_vendor_name: t,
      p_vendor_phone: phone.trim() || null,
      p_agreed_kobo: naira != null ? Math.round(naira * 100) : null,
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    onChanged();
    onClose();
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,4,8,.72)', display: 'flex', alignItems: 'flex-end', zIndex: 980 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: '#120e1a', borderTop: '1px solid #2c2438', borderRadius: '18px 18px 0 0', padding: '18px 18px calc(18px + env(safe-area-inset-bottom, 0px))', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Add your own vendor · {category.label}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Vendor name"
          data-testid="workspace-add-vendor-name-input"
          style={{ background: '#1c1726', border: '1px solid #2c2438', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
        />
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone (optional)"
          style={{ background: '#1c1726', border: '1px solid #2c2438', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
        />
        <input
          type="number"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Agreed amount in naira (optional)"
          style={{ background: '#1c1726', border: '1px solid #2c2438', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
        />
        {error && <span style={{ fontSize: 12, color: '#fbbf24' }}>{error}</span>}
        <div style={{ display: 'flex', gap: 8 }}>
          <span onClick={onClose} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Cancel</span>
          <span onClick={save} role="button" data-testid="workspace-add-vendor-save" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Adding…' : 'Add'}</span>
        </div>
      </div>
    </div>
  );
}

// Shared due-date math for Tasks/Timeline -- offset_days counts back from
// the plan's event_date (null when unset); due_override always wins when
// present. Returns null when neither the event date nor an override gives
// a real date to compute from (never fabricated).
function taskDueDate(t: WorkspaceTask, eventDateIso: string | null): Date | null {
  if (t.due_override) return new Date(t.due_override);
  if (eventDateIso && t.offset_days != null) {
    const d = new Date(eventDateIso);
    d.setDate(d.getDate() - t.offset_days);
    return d;
  }
  return null;
}
const fmtTaskDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// P16 Tasks tab + P17's completed-task visual states folded into the same
// rows (P17 is a state spec for P16's own rows, not a separate screen).
// Buckets (Overdue/This week/Next 2 weeks/Later/Event week/Completed) are
// computed from today against each task's real due date -- never a fixed
// demo bucket. "Just completed" shows a 4s purple-tick + Undo toast (both
// ends are real plan_tasks writes, never a frontend-only flip). A
// completes_on_booking task can't be manually toggled, matching
// CategoryDetailView's same rule, and "+ Add task" is a stated gap (no
// create-task tool/UI exists yet), not a silent dead button.
function WorkspaceTasksTab({ data, onChanged }: { data: PlanWorkspaceData; onChanged: () => void }) {
  const [justCompleted, setJustCompleted] = useState<{ id: string; prevDoneAt: string | null } | null>(null);
  const [showLater, setShowLater] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [addNote, setAddNote] = useState(false);

  useEffect(() => {
    if (!justCompleted) return;
    const t = setTimeout(() => setJustCompleted(null), 4000);
    return () => clearTimeout(t);
  }, [justCompleted]);

  // S4-C "Tasks · none yet" -- a draft's brief hasn't been confirmed, so
  // there's genuinely no task list to show (plan_tasks is seeded by SI's
  // guided flow once a brief is confirmed, never fabricated here). An
  // active plan with zero tasks is a real, different (rare) state and
  // falls through to the normal empty buckets below, not this card.
  if (data.plan.status === 'draft' && data.tasks.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="workspace-tasks-not-yet">
        <div style={{ padding: 16, borderRadius: 14, border: '1px dashed #2c2438', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: '#a89db3' }}>Tasks appear once the brief is confirmed.</span>
          <span onClick={() => setAddNote(true)} role="button" style={{ fontSize: 12.5, fontWeight: 700, color: '#d3b8ff', cursor: 'pointer' }}>+ Add</span>
        </div>
        {addNote && <div style={{ fontSize: 11.5, color: '#8a7f97' }}>Adding a task from here isn't built yet -- ask SI to add it instead.</div>}
      </div>
    );
  }

  const eventDateIso = data.plan.event_date;
  const categoryLabel = (id: string | null) => data.categories.find((c) => c.id === id)?.label ?? null;
  // P17-C's own copy includes the booked provider's name ("Done via VENTS
  // booking · Ade Studios"), not just the fact of the booking.
  const bookedProviderName = (categoryId: string | null) => {
    const assignment = data.categories.find((c) => c.id === categoryId)?.assignments.find((a) => a.status === 'booked');
    return assignment?.provider?.business_name || assignment?.own_vendor_name || null;
  };

  const withDue = data.tasks.map((t) => ({ t, due: taskDueDate(t, eventDateIso) }));
  const done = withDue.filter((x) => !!x.t.done_at);
  const open = withDue.filter((x) => !x.t.done_at);

  const DAY = 86400000;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const endOfWeek = startOfToday.getTime() + 7 * DAY;
  const endOf2Weeks = startOfToday.getTime() + 21 * DAY;
  const eventDateMs = eventDateIso ? new Date(eventDateIso).getTime() : null;
  const isEventWeek = (ms: number) => eventDateMs != null && ms >= eventDateMs - 7 * DAY && ms <= eventDateMs;

  const overdue = open.filter((x) => x.due && x.due.getTime() < startOfToday.getTime());
  const thisWeek = open.filter((x) => x.due && x.due.getTime() >= startOfToday.getTime() && x.due.getTime() < endOfWeek && !overdue.includes(x));
  const next2Weeks = open.filter((x) => x.due && x.due.getTime() >= endOfWeek && x.due.getTime() < endOf2Weeks);
  const eventWeek = open.filter((x) => x.due && isEventWeek(x.due.getTime()) && x.due.getTime() >= endOf2Weeks);
  const later = open.filter((x) => (!x.due || x.due.getTime() >= endOf2Weeks) && !eventWeek.includes(x));

  async function toggle(task: WorkspaceTask) {
    if (task.completes_on_booking) return; // "the booking is the truth" -- same rule as CategoryDetailView
    const wasDone = !!task.done_at;
    const { error } = await supabase.from('plan_tasks').update({ done_at: wasDone ? null : new Date().toISOString() }).eq('id', task.id);
    if (error) return;
    if (!wasDone) setJustCompleted({ id: task.id, prevDoneAt: task.done_at });
    else if (justCompleted?.id === task.id) setJustCompleted(null);
    onChanged();
  }

  async function undo(taskId: string, prevDoneAt: string | null) {
    const { error } = await supabase.from('plan_tasks').update({ done_at: prevDoneAt }).eq('id', taskId);
    setJustCompleted(null);
    if (!error) onChanged();
  }

  // Readiness-style progress bar, matching P16's own 18-segment look --
  // segment count is real (total task count), not hardcoded to 18.
  const total = data.tasks.length;

  function TaskRow({ x, amber }: { x: { t: WorkspaceTask; due: Date | null }; amber?: boolean }) {
    const isDoneRecently = justCompleted?.id === x.t.id;
    const autoCompleted = !!x.t.done_at && x.t.completes_on_booking;
    const label = categoryLabel(x.t.category_id);
    return (
      <div key={x.t.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '11px 0', borderBottom: '1px solid #1c1726' }}>
        <span
          onClick={() => toggle(x.t)}
          role="button"
          data-testid={`workspace-task-${x.t.id}`}
          style={{
            width: 22, height: 22, borderRadius: 6, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, cursor: x.t.completes_on_booking ? 'default' : 'pointer',
            background: autoCompleted ? '#34d399' : x.t.done_at ? '#a35cff' : 'transparent',
            color: autoCompleted ? '#0a0810' : '#fff',
            border: x.t.done_at ? 'none' : amber ? '1.5px solid #fbbf24' : '1.5px solid #4a3f56',
          }}
        >
          {x.t.done_at ? '✓' : ''}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, color: x.t.done_at ? '#a89db3' : '#f2eff6', textDecoration: x.t.done_at ? 'line-through' : 'none' }}>{x.t.title}</div>
          <div style={{ fontSize: 11.5, color: autoCompleted ? '#34d399' : amber ? '#fbbf24' : '#8a7f97', marginTop: 2 }}>
            {autoCompleted
              ? ['Done via VENTS booking', bookedProviderName(x.t.category_id)].filter(Boolean).join(' · ')
              : [label, x.due ? (amber ? `was due ${fmtTaskDate(x.due)}` : fmtTaskDate(x.due)) : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        {isDoneRecently && (
          <span onClick={() => undo(x.t.id, justCompleted!.prevDoneAt)} role="button" style={{ fontSize: 12, fontWeight: 700, color: '#d3b8ff', cursor: 'pointer' }}>Undo</span>
        )}
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 20, fontWeight: 800 }}>{done.length} / {total} done</span>
          <span onClick={() => setAddNote(true)} role="button" style={{ fontSize: 12, color: '#d3b8ff', cursor: 'pointer' }}>+ Add task</span>
        </div>
        <div style={{ display: 'flex', gap: 3 }}>
          {Array.from({ length: Math.max(total, 1) }).map((_, i) => (
            <span key={i} style={{ flex: 1, height: 5, borderRadius: 2, background: i < done.length ? '#a35cff' : '#2c2438' }} />
          ))}
        </div>
        {addNote && <div style={{ fontSize: 11.5, color: '#8a7f97' }}>Adding a task from here isn't built yet -- ask SI to add it instead.</div>}
      </div>

      {overdue.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#fbbf24', marginBottom: 4 }}>OVERDUE · {overdue.length}</span>
          {overdue.map((x) => <TaskRow key={x.t.id} x={x} amber />)}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97', marginBottom: 4 }}>THIS WEEK</span>
        {thisWeek.length === 0 ? <div style={{ padding: '14px 0', borderRadius: 12, border: '1px dashed #2c2438', fontSize: 13, color: '#a89db3', textAlign: 'center' }}>✓ Nothing left this week</div> : thisWeek.map((x) => <TaskRow key={x.t.id} x={x} />)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97', marginBottom: 4 }}>NEXT 2 WEEKS</span>
        {next2Weeks.length === 0 ? <div style={{ fontSize: 12.5, color: '#5e5470', padding: '8px 0' }}>Nothing due in this window.</div> : next2Weeks.map((x) => <TaskRow key={x.t.id} x={x} />)}
      </div>
      {!showLater ? (
        <div onClick={() => setShowLater(true)} role="button" style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, color: '#a89db3', cursor: 'pointer' }}>
          <span>Later · {later.length} · Event week · {eventWeek.length}</span>
          <span style={{ color: '#d3b8ff' }}>Show</span>
        </div>
      ) : (
        <>
          {later.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97', marginBottom: 4 }}>LATER</span>
              {later.map((x) => <TaskRow key={x.t.id} x={x} />)}
            </div>
          )}
          {eventWeek.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97', marginBottom: 4 }}>EVENT WEEK</span>
              {eventWeek.map((x) => <TaskRow key={x.t.id} x={x} />)}
            </div>
          )}
        </>
      )}
      {!showCompleted ? (
        <div onClick={() => setShowCompleted(true)} role="button" style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, color: '#8a7f97', cursor: 'pointer' }}>
          <span>Completed · {done.length}</span>
          <span style={{ color: '#d3b8ff' }}>Show</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {done.map((x) => <TaskRow key={x.t.id} x={x} />)}
        </div>
      )}
    </>
  );
}

// P18 Timeline tab -- milestones (plan_milestones, now read by
// fetchPlanWorkspace) mapped onto the real runway, each annotated with its
// real open-task overdue/done counts. Read-only per the mockup's own spec
// text ("dates move via tasks or the event date"); tapping a milestone
// switches to Tasks rather than filtering it (a stated, smaller scope --
// no per-phase filter state exists yet).
function WorkspaceTimelineTab({ data, planId, onOpenTasks, onChanged }: { data: PlanWorkspaceData; planId: string; onOpenTasks: () => void; onChanged: () => void }) {
  const [showSetDate, setShowSetDate] = useState(false);
  const eventDateIso = data.plan.event_date;
  const now = Date.now();
  const withDue = data.tasks.map((t) => ({ t, due: taskDueDate(t, eventDateIso) }));

  // S4-D "Timeline · no date" -- phases are counted back from the event
  // date (ends_offset_days), so with no date there is genuinely nothing
  // to derive a timeline from, regardless of how many milestone rows
  // exist. Checked before the milestones-empty case below since a
  // missing date is the more specific, more actionable explanation.
  if (!eventDateIso) {
    return (
      <>
        <div style={{ padding: 16, borderRadius: 14, background: '#120e1a', border: '1px solid #221d2d', display: 'flex', gap: 14, alignItems: 'center' }} data-testid="workspace-timeline-not-yet">
          <span style={{ width: 16, height: 16, borderRadius: 4, border: '2px dashed #4a3f56', transform: 'rotate(45deg)', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Pick a date to build the timeline</div>
            <div style={{ fontSize: 12, color: '#a89db3', marginTop: 3 }}>Phases are counted back from the event.</div>
          </div>
          <span onClick={() => setShowSetDate(true)} role="button" data-testid="workspace-timeline-set-date" style={{ fontSize: 12.5, fontWeight: 700, color: '#d3b8ff', cursor: 'pointer' }}>Set</span>
        </div>
        {showSetDate && (
          <SetEventDateSheet planId={planId} onClose={() => setShowSetDate(false)} onChanged={onChanged} />
        )}
      </>
    );
  }

  if (data.milestones.length === 0) {
    return <div style={{ fontSize: 12.5, color: '#786d87', textAlign: 'center', padding: 20 }}>No timeline phases yet for this plan.</div>;
  }

  const sorted = [...data.milestones].sort((a, b) => b.ends_offset_days - a.ends_offset_days); // furthest-from-event first = earliest phase
  const eventDateMs = eventDateIso ? new Date(eventDateIso).getTime() : null;

  function phaseEndsAt(m: WorkspaceMilestone): Date | null {
    if (!eventDateMs) return null;
    const d = new Date(eventDateMs);
    d.setDate(d.getDate() - m.ends_offset_days);
    return d;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {sorted.map((m, i) => {
        const endsAt = phaseEndsAt(m);
        const isPast = endsAt ? endsAt.getTime() < now : false;
        const nextUpcoming = !isPast && sorted.slice(0, i).every((pm) => {
          const pe = phaseEndsAt(pm);
          return pe ? pe.getTime() < now : false;
        });
        const inPhase = withDue.filter((x) => {
          if (!x.due) return false;
          const prevEnds = i > 0 ? phaseEndsAt(sorted[i - 1]) : null;
          return x.due.getTime() <= (endsAt?.getTime() ?? Infinity) && (!prevEnds || x.due.getTime() > prevEnds.getTime());
        });
        const overdueInPhase = inPhase.filter((x) => !x.t.done_at && x.due && x.due.getTime() < now).length;
        const doneInPhase = inPhase.filter((x) => !!x.t.done_at).length;

        return (
          <div key={m.id} onClick={onOpenTasks} role="button" style={{ display: 'flex', gap: 14, cursor: 'pointer' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 16 }}>
              {isPast ? (
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#34d399' }} />
              ) : nextUpcoming ? (
                <span style={{ width: 16, height: 16, borderRadius: '50%', background: '#0a0810', border: '4px solid #a35cff', boxShadow: '0 0 0 5px rgba(163,92,255,.15)' }} />
              ) : (
                <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid #4a3f56', marginTop: 2 }} />
              )}
              {i < sorted.length - 1 && <span style={{ flex: 1, width: 2, background: isPast ? '#34d399' : nextUpcoming ? 'linear-gradient(#a35cff,#2c2438)' : '#2c2438' }} />}
            </div>
            <div style={{ flex: 1, paddingBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: isPast ? '#34d399' : nextUpcoming ? '#d3b8ff' : '#8a7f97' }}>
                {isPast ? 'DONE' : nextUpcoming ? 'NOW' : 'UPCOMING'}{endsAt ? ` · BY ${fmtTaskDate(endsAt)}` : ''}
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>{m.label}</div>
              {inPhase.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  {overdueInPhase > 0 && <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'rgba(251,191,36,.1)', color: '#fbbf24' }}>{overdueInPhase} overdue</span>}
                  <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: '#1c1726', color: '#c9c0d4' }}>{doneInPhase} of {inPhase.length} done</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {eventDateMs && (
        <div style={{ display: 'flex', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 16 }}>
            <span style={{ width: 16, height: 16, borderRadius: 4, background: GRADIENT, transform: 'rotate(45deg)' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.5px', color: '#d3b8ff' }}>{fmtTaskDate(new Date(eventDateMs)).toUpperCase()}</div>
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>Event day</div>
          </div>
        </div>
      )}
    </div>
  );
}

// SUGGESTED prompt chips -- export's `suggestedPrompts` derived from SCEN's
// icon+prompt pairs (lines ~294-347, ~415).
// Exact copy and order from P01.html's SUGGESTED list -- drops the emoji
// per that frame's own "brand rules" note.
const SUGGESTED_PROMPTS: { label: string }[] = [
  { label: 'I need a wedding decorator under ₦300k in Lagos' },
  { label: 'Where is my ticket for my next event?' },
  { label: 'How much is in my VENTS Wallet?' },
];

function formatMoney(kobo: unknown): string {
  const n = typeof kobo === 'number' ? kobo : Number(kobo);
  if (!isFinite(n)) return String(kobo ?? '—');
  return `₦${(n / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------
// Card renderers -- shapes/colors match the export's cardEvents/
// cardProviders/cardInfo/cardConfirm/cardSuccess sc-if blocks exactly.
// ---------------------------------------------------------------------

function EventCardRow({ events, onOpenEvent }: { events: any[]; onOpenEvent?: (id: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', marginTop: 10, paddingBottom: 4 }}>
      {events.map((e) => (
        <div key={e.id} style={{ flexShrink: 0, width: 190, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, overflow: 'hidden' }}>
          <div
            style={{
              height: 90,
              background: e.image_url ? `url(${e.image_url}) center/cover` : 'repeating-linear-gradient(45deg,#1c1726,#1c1726 8px,#181322 8px,#181322 16px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: '#4a3f56',
            }}
          >
            {!e.image_url && 'EVENT PHOTO'}
          </div>
          <div style={{ padding: 10 }}>
            {e.category && (
              <span style={{ fontSize: 9, fontWeight: 700, color: '#d3b8ff', background: 'rgba(163,92,255,.15)', padding: '2px 6px', borderRadius: 5 }}>
                {e.category}
              </span>
            )}
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f0edf5', marginTop: 6 }}>{e.title}</div>
            <div style={{ fontSize: 10.5, color: '#a89db3', marginTop: 4 }}>{e.event_date ? new Date(e.event_date).toLocaleString('en-NG', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</div>
            <div style={{ fontSize: 10.5, color: '#a89db3', marginTop: 2 }}>{e.location || '—'}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#e8e3ee', marginTop: 6 }}>{e.price != null ? `From ₦${Number(e.price).toLocaleString('en-NG')}` : 'Free'}</div>
            <div
              onClick={() => onOpenEvent?.(e.id)}
              style={{ marginTop: 8, textAlign: 'center', padding: 6, borderRadius: 7, background: 'rgba(163,92,255,.14)', color: '#d3b8ff', fontSize: 11, fontWeight: 700, cursor: onOpenEvent ? 'pointer' : 'default' }}
            >
              View Event
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProviderCardRow({ providers, onOpenProvider }: { providers: any[]; onOpenProvider?: (id: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', marginTop: 10, paddingBottom: 4 }}>
      {providers.map((p, i) => {
        const id = p.provider_id ?? p.id;
        const price = p.service_price ?? p.starting_price;
        return (
          <div key={`${id}-${i}`} style={{ flexShrink: 0, width: 190, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, overflow: 'hidden' }}>
            <div
              style={{
                height: 90,
                background: p.photo_urls?.[0] ? `url(${p.photo_urls[0]}) center/cover` : 'repeating-linear-gradient(45deg,#1c1726,#1c1726 8px,#181322 8px,#181322 16px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: '#4a3f56',
              }}
            >
              {!p.photo_urls?.[0] && 'PROVIDER PHOTO'}
            </div>
            <div style={{ padding: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f0edf5' }}>{p.business_name}</div>
              <div style={{ fontSize: 10.5, color: '#a89db3', marginTop: 3 }}>{p.service_name || p.provider_category || p.category || 'Service'}</div>
              <div style={{ fontSize: 10.5, color: '#a89db3', marginTop: 2 }}>{p.location || '—'}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#e8e3ee', marginTop: 6 }}>{price != null ? `From ₦${Number(price).toLocaleString('en-NG')}` : '—'}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <div
                  onClick={() => onOpenProvider?.(id)}
                  style={{ flex: 1, textAlign: 'center', padding: 6, borderRadius: 7, background: '#1c1726', border: '1px solid #2c2438', color: '#c9c0d4', fontSize: 10.5, fontWeight: 700, cursor: onOpenProvider ? 'pointer' : 'default' }}
                >
                  Profile
                </div>
                <div
                  onClick={() => onOpenProvider?.(id)}
                  style={{ flex: 1, textAlign: 'center', padding: 6, borderRadius: 7, background: 'rgba(163,92,255,.14)', color: '#d3b8ff', fontSize: 10.5, fontWeight: 700, cursor: onOpenProvider ? 'pointer' : 'default' }}
                >
                  Book
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Builds the {k,v} rows for the info card from whichever tool produced it --
// the backend's `type` field on the card names the tool, per
// api/ai-assistant.ts's `cards.push({ type: block.name, data, source })`.
function infoRowsFor(type: string, data: any): { title: string; badgeLabel: string; badgeBg: string; badgeFg: string; rows: { k: string; v: string }[] } {
  const successBadge = { badgeBg: 'rgba(52,211,153,.12)', badgeFg: '#34d399' };
  const neutralBadge = { badgeBg: 'rgba(163,92,255,.14)', badgeFg: '#d3b8ff' };

  if (type === 'get_wallet_balance') {
    return { title: 'VENTS Wallet', badgeLabel: 'LIVE', ...neutralBadge, rows: [{ k: 'Balance', v: formatMoney(data?.balance_kobo) }] };
  }
  if (type === 'get_vents_cents_balance') {
    const spendable = data?.spendable ?? data?.balance ?? data;
    return { title: 'VENTS Cents', badgeLabel: 'LIVE', ...neutralBadge, rows: [{ k: 'Spendable', v: `${spendable ?? 0} VC` }] };
  }
  if (type === 'get_payment_status') {
    const status = String(data?.payment_status || data?.status || 'unknown').toUpperCase();
    const isGood = status === 'SUCCESSFUL' || status === 'PAID' || status === 'COMPLETED';
    return {
      title: `Payment · ${data?.payment_ref || data?.id || ''}`,
      badgeLabel: status,
      ...(isGood ? successBadge : neutralBadge),
      rows: [
        data?.amount != null && { k: 'Amount', v: formatMoney(data.amount) },
        data?.total_kobo != null && { k: 'Amount', v: formatMoney(data.total_kobo) },
        { k: 'Status', v: titleCase(String(data?.status || 'unknown')) },
      ].filter(Boolean) as { k: string; v: string }[],
    };
  }
  if (type === 'get_my_tickets') {
    const tickets = Array.isArray(data) ? data : [];
    const t = tickets[0];
    return {
      title: t ? `Ticket · ${t.ticket_type || 'General'}` : 'Your tickets',
      badgeLabel: t ? String(t.status || 'unknown').toUpperCase() : 'NONE',
      ...(t?.status === 'active' || t?.status === 'valid' ? successBadge : neutralBadge),
      rows: tickets.slice(0, 5).map((tk: any) => ({ k: tk.ticket_type || 'Ticket', v: `${titleCase(String(tk.status))} · ${formatMoney(tk.amount)}` })),
    };
  }
  if (type === 'get_my_bookings') {
    const bookings = Array.isArray(data) ? data : [];
    return {
      title: 'Your bookings',
      badgeLabel: bookings.length ? 'LIVE' : 'NONE',
      ...neutralBadge,
      rows: bookings.slice(0, 5).map((b: any) => ({ k: b.service_providers?.business_name || 'Booking', v: `${titleCase(String(b.status))} · ${formatMoney(b.total_kobo)}` })),
    };
  }
  // Generic fallback -- any other object becomes key/value rows directly.
  const obj = data && typeof data === 'object' ? data : { value: data };
  return {
    title: titleCase(type),
    badgeLabel: 'LIVE',
    ...neutralBadge,
    rows: Object.entries(obj).slice(0, 6).map(([k, v]) => ({ k: titleCase(k), v: typeof v === 'object' ? JSON.stringify(v) : String(v) })),
  };
}

function InfoCard({ type, data }: { type: string; data: unknown }) {
  const info = infoRowsFor(type, data);
  return (
    <div style={{ marginTop: 10, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f0edf5' }}>{info.title}</div>
        <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 7px', borderRadius: 6, background: info.badgeBg, color: info.badgeFg }}>{info.badgeLabel}</span>
      </div>
      {info.rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#c9c0d4', padding: '6px 0', borderTop: '1px solid #1c1726' }}>
          <div style={{ color: '#8a7f97' }}>{row.k}</div>
          <div style={{ color: '#e8e3ee', fontWeight: 600 }}>{row.v}</div>
        </div>
      ))}
      <div style={{ marginTop: 10, fontSize: 10.5, color: '#5e5470', display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#34d399', display: 'inline-block' }} />
        Synced from VENTS · just now
      </div>
    </div>
  );
}

function proposalRows(action: string, proposal: Record<string, unknown>): { title: string; confirmLabel: string; rows: { k: string; v: string }[] } {
  if (action === 'start_ticket_transfer') {
    return {
      title: 'Transfer Ticket',
      confirmLabel: 'Confirm Transfer',
      rows: [
        { k: 'Ticket', v: String(proposal.ticket_id) },
        { k: 'Recipient', v: String(proposal.recipient_identifier) },
      ],
    };
  }
  if (action === 'request_ticket_refund') {
    return {
      title: 'Request Refund',
      confirmLabel: 'Confirm Refund',
      rows: [
        { k: 'Ticket', v: String(proposal.ticket_id) },
        { k: 'Reason', v: String(proposal.reason) },
      ],
    };
  }
  if (action === 'start_service_booking') {
    const items = Array.isArray(proposal.items) ? (proposal.items as any[]) : [];
    return {
      title: 'Book Service',
      confirmLabel: 'Confirm Booking',
      rows: [
        { k: 'Provider', v: String(proposal.provider_id) },
        { k: 'Items', v: String(items.length) },
        ...(proposal.scheduled_date ? [{ k: 'Date', v: String(proposal.scheduled_date) }] : []),
      ],
    };
  }
  if (action === 'create_report') {
    return {
      title: 'Create Report',
      confirmLabel: 'Confirm Report',
      rows: [
        { k: 'Target', v: `${proposal.target_type} · ${proposal.target_id}` },
        { k: 'Reason', v: String(proposal.reason) },
      ],
    };
  }
  return { title: titleCase(action), confirmLabel: 'Confirm', rows: Object.entries(proposal).slice(0, 4).map(([k, v]) => ({ k: titleCase(k), v: String(v) })) };
}

function ConfirmationCard({
  action,
  params,
  proposal,
  resolved,
  onConfirm,
  onCancel,
}: {
  action: string;
  params: Record<string, unknown>;
  proposal: Record<string, unknown>;
  resolved?: 'confirmed' | 'cancelled';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { title, confirmLabel, rows } = proposalRows(action, proposal);
  return (
    <div style={{ marginTop: 10, background: '#120e1a', border: '1px solid rgba(251,191,36,.3)', borderRadius: 12, padding: 14 }} data-testid="ai-confirmation-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 9.5, fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,.1)', padding: '3px 7px', borderRadius: 6 }}>CONFIRMATION REQUIRED</span>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f0edf5', marginBottom: 6 }}>{title}</div>
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#c9c0d4', padding: '6px 0', borderTop: '1px solid #1c1726' }}>
          <div style={{ color: '#8a7f97' }}>{row.k}</div>
          <div style={{ color: '#e8e3ee', fontWeight: 600 }}>{row.v}</div>
        </div>
      ))}
      {!resolved && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <div
            onClick={onCancel}
            data-testid="ai-confirmation-cancel"
            style={{ flex: 1, textAlign: 'center', padding: 9, borderRadius: 8, background: '#1c1726', border: '1px solid #2c2438', color: '#c9c0d4', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
          >
            Cancel
          </div>
          <div
            onClick={onConfirm}
            data-testid="ai-confirmation-confirm"
            style={{ flex: 1, textAlign: 'center', padding: 9, borderRadius: 8, background: GRADIENT, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
          >
            {confirmLabel}
          </div>
        </div>
      )}
      {resolved === 'cancelled' && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: '#786d87' }}>Cancelled -- nothing was changed.</div>
      )}
    </div>
  );
}

function SuccessCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{ marginTop: 10, background: 'rgba(52,211,153,.08)', border: '1px solid rgba(52,211,153,.3)', borderRadius: 12, padding: 14, display: 'flex', gap: 10, alignItems: 'flex-start' }} data-testid="ai-success-card">
      <span style={{ fontSize: 16, color: '#34d399' }}>✓</span>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f0edf5' }}>{title}</div>
        <div style={{ fontSize: 11.5, color: '#a89db3', marginTop: 4, lineHeight: 1.5 }}>{detail}</div>
      </div>
    </div>
  );
}

// External/general-knowledge results (source:'external', from web_search)
// must never look like a bookable VENTS listing -- the export predates this
// field so there's no card shape for it there; this reuses the export's own
// amber/neutral palette for a small "not on VENTS" label instead of
// inventing a new color, and renders plain text, never the event/provider
// card templates, per api/ai-assistant.ts's system prompt rule #5.
function ExternalResultCard({ card }: { card: BackendCard }) {
  const isError = card.type === 'web_search_error';
  const results = !isError && Array.isArray(card.data) ? (card.data as any[]) : [];
  return (
    <div style={{ marginTop: 10, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: 14 }} data-testid="ai-external-card">
      <span style={{ fontSize: 9.5, fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,.1)', padding: '3px 7px', borderRadius: 6 }}>
        Found elsewhere — not on VENTS
      </span>
      {isError ? (
        <div style={{ fontSize: 11.5, color: '#a89db3', marginTop: 8 }}>Web search wasn't available for this.</div>
      ) : (
        results.slice(0, 4).map((r: any, i: number) => (
          <div key={i} style={{ marginTop: 8, paddingTop: i > 0 ? 8 : 0, borderTop: i > 0 ? '1px solid #1c1726' : 'none' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#e8e3ee' }}>{r.title || 'Result'}</div>
            {r.url && (
              <a href={r.url} target="_blank" rel="noreferrer" style={{ fontSize: 10.5, color: '#b892ff', wordBreak: 'break-all' }}>
                {r.url}
              </a>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// SI Planner cards -- frozen design spec §12: Estimated (striped/≈),
// Committed (purple) and Paid (green) never share a style; a purple
// PlanUpdateCard for plan edits is visually distinct from the amber
// ConfirmationCard above (which stays reserved for money/booking). All
// data here is the real tool result from api/_lib/aiTools.ts -- nothing
// below fabricates a number, a provider, or an availability claim.
// ---------------------------------------------------------------------

function naira(n: unknown): string {
  const v = typeof n === 'number' ? n : Number(n);
  if (!isFinite(v)) return '—';
  return `₦${v.toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
}

// Mockup's own secondary/denominator convention (P08/P25: "/ 1.2m", "of
// ₦8m", "₦4.35m / ₦8m") -- a compact ₦X.Xm/₦Xk form, used wherever the
// mockup abbreviates a comparison amount, while the primary hero figure
// stays full-precision via naira() above (e.g. P08's own "₦1,350,000" next
// to "/ 1.2m" on the same line -- never both abbreviated or both full).
function compactNaira(n: unknown): string {
  const v = typeof n === 'number' ? n : Number(n);
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000000) {
    const m = v / 1000000;
    return `₦${(Number.isInteger(m * 100) ? m : Math.round(m * 100) / 100).toString().replace(/\.0+$/, '')}m`;
  }
  if (abs >= 1000) {
    const k = Math.round(v / 1000);
    return `₦${k}k`;
  }
  return naira(v);
}

// Mockup's own date convention for a plan's real event_date -- "Sat 12
// Dec" (weekday + day + month, never a year, never raw ISO) -- used in
// every header/row/switcher that shows a plan's date (P07-P11, P25, P26).
function friendlyDate(iso: string | null | undefined, short?: boolean): string | null {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', short ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short' });
}

// BudgetBar: three segments that never share a style (§12 "Budget interaction").
function BudgetBar({ estimated, committed, paid, total, hideLegend }: { estimated: number; committed: number; paid: number; total: number | null; hideLegend?: boolean }) {
  const denom = total && total > 0 ? total : Math.max(estimated + committed + paid, 1);
  const pct = (n: number) => `${Math.min(100, (n / denom) * 100)}%`;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: '#1c1726' }}>
        <div style={{ width: pct(paid), background: '#34d399' }} />
        <div style={{ width: pct(committed), background: '#a35cff' }} />
        <div
          style={{
            width: pct(estimated),
            background: 'repeating-linear-gradient(45deg, rgba(163,92,255,.35) 0 4px, rgba(163,92,255,.12) 4px 8px)',
          }}
        />
      </div>
      {!hideLegend && (
        <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 10, color: '#8a7f97' }}>
          <span><span style={{ color: '#34d399' }}>●</span> Paid {naira(paid)}</span>
          <span><span style={{ color: '#a35cff' }}>●</span> Committed {naira(committed)}</span>
          <span>◆ Estimate · not a quote {naira(estimated)}</span>
        </div>
      )}
    </div>
  );
}

function PlanSummaryCard({ plan, onOpenPlan }: { plan: any; onOpenPlan?: (planId: string, title: string) => void }) {
  const categories: any[] = Array.isArray(plan?.categories) ? plan.categories : [];
  const totalEstimated = categories.reduce((s, c) => s + (c.estimated_naira || 0), 0);
  // Committed/paid totals come straight from get_plan's own budget_summary
  // (authoritative), never re-derived from the per-category rows here --
  // summing both would double count against that server-computed total.
  const totalCommitted = plan?.budget_summary?.total_committed_naira || 0;
  const totalPaid = plan?.budget_summary?.total_paid_naira || 0;
  return (
    <div style={{ marginTop: 10, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: 14 }} data-testid="ai-plan-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: '#f0edf5' }}>{plan?.title || 'Your plan'}</div>
          <div style={{ fontSize: 10.5, color: '#a89db3', marginTop: 2 }}>
            {titleCase(String(plan?.event_type || ''))}
            {plan?.city ? ` · ${plan.city}` : ''}
            {plan?.event_date ? ` · ${plan.event_date}` : ''}
          </div>
        </div>
        <span style={{ fontSize: 9.5, fontWeight: 700, padding: '3px 7px', borderRadius: 6, background: plan?.status === 'draft' ? 'rgba(251,191,36,.1)' : 'rgba(163,92,255,.14)', color: plan?.status === 'draft' ? '#fbbf24' : '#d3b8ff' }}>
          {String(plan?.status || 'draft').toUpperCase()}
        </span>
      </div>
      {plan?.total_budget_naira != null && (
        <div style={{ fontSize: 11.5, color: '#c9c0d4', marginTop: 10 }}>
          Total budget <b style={{ color: '#f0edf5' }}>{naira(plan.total_budget_naira)}</b>
        </div>
      )}
      {categories.length > 0 && (
        <>
          <BudgetBar estimated={totalEstimated} committed={totalCommitted} paid={totalPaid} total={plan?.total_budget_naira ?? null} />
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {categories.slice(0, 6).map((c: any) => {
              const assigned = Array.isArray(c.assignments) && c.assignments.length > 0;
              const booked = assigned && c.assignments.some((a: any) => a.status === 'booked');
              return (
                <div key={c.category_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11.5, padding: '6px 0', borderTop: '1px solid #1c1726' }}>
                  <span style={{ color: '#e4dfeb' }}>{c.label}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: '#8a7f97' }}>{naira(c.allocated_naira)}</span>
                    {assigned && (
                      <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 5, background: booked ? 'rgba(52,211,153,.12)' : 'rgba(163,92,255,.14)', color: booked ? '#34d399' : '#d3b8ff' }}>
                        {booked ? 'PAID' : 'ASSIGNED'}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            {categories.length > 6 && <div style={{ fontSize: 10.5, color: '#5e5470' }}>+ {categories.length - 6} more</div>}
          </div>
        </>
      )}
      {plan?.id && onOpenPlan && (
        <div
          onClick={() => onOpenPlan(plan.id, plan.title || 'Plan')}
          style={{ marginTop: 12, textAlign: 'center', padding: 9, borderRadius: 8, background: 'rgba(163,92,255,.14)', color: '#d3b8ff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
        >
          Open Plan
        </div>
      )}
    </div>
  );
}

// PlanUpdateCard: purple, distinct from the amber ConfirmationCard above.
// `applied=false` is SI's own suggestion -- nothing has changed yet, and
// the only way it does is the user tapping Apply (never auto-applied).
// `applied=true` is the real result of either a direct user instruction or
// an already-approved suggestion; it carries an Undo action wired to the
// real undo_plan_change RPC, never a frontend-only revert.
function PlanUpdateCard({
  data,
  applied,
  streaming,
  onApply,
  onUndo,
}: {
  data: any;
  applied: boolean;
  // S1-C "SI applying a change" -- whether a request is currently in
  // flight. `clicked` (below) distinguishes THIS card's own in-flight
  // Apply from some unrelated message the user sent meanwhile.
  streaming?: boolean;
  onApply?: () => void;
  onUndo?: (changeLogId: string) => void;
}) {
  const changes: any[] = Array.isArray(data?.proposed_changes) ? data.proposed_changes : [];
  const [undone, setUndone] = useState(false);
  const [clicked, setClicked] = useState(false);
  // Once the in-flight request settles (success or failure -- this card
  // has no way to tell which, since success renders as a SEPARATE
  // apply_plan_update card elsewhere in the thread, never a mutation of
  // this one), restore the real editable/error state rather than leaving
  // Apply stuck disabled forever.
  useEffect(() => {
    if (!streaming && clicked) setClicked(false);
  }, [streaming, clicked]);
  const applying = clicked && !!streaming;

  function handleApply() {
    if (applying) return; // prevents a duplicate apply_plan_update call from a fast double-tap
    setClicked(true);
    onApply?.();
  }

  return (
    <div style={{ marginTop: 10, background: applied ? '#120e1a' : 'rgba(163,92,255,.08)', border: applied ? '1px solid #221d2d' : '1px solid rgba(163,92,255,.35)', borderRadius: 12, padding: applied ? '12px 14px' : 14 }} data-testid="ai-plan-update-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: applied ? 9.5 : 9.5, fontWeight: 700, color: '#d3b8ff', background: 'rgba(163,92,255,.15)', padding: '3px 7px', borderRadius: 6 }}>
          {applied ? 'PLAN UPDATE' : 'SUGGESTED CHANGE'}
        </span>
        {applied && (
          <span style={{ fontSize: 11.5, color: '#34d399' }}>
            {undone ? 'Undone' : data?.change_log_id && onUndo ? (
              <>✓ Applied · <span onClick={() => { setUndone(true); onUndo(data.change_log_id); }} data-testid="ai-plan-update-undo" style={{ color: '#d3b8ff', fontWeight: 700, cursor: 'pointer' }}>Undo</span></>
            ) : (
              '✓ Applied'
            )}
          </span>
        )}
      </div>
      <div style={{ marginTop: applied ? 6 : 8, display: 'flex', flexDirection: 'column', gap: 6, paddingTop: applied ? 6 : 0 }}>
        {changes.map((c, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: applied ? 12.5 : 12, color: '#c9c0d4' }}>
            <span style={{ color: '#a89db3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label || c.key || c.category}</span>
            <span style={{ flexShrink: 0 }}>
              <span style={{ color: '#786d87' }}>{naira(c.before_naira)}</span>
              {' → '}
              <span style={{ color: '#f0edf5', fontWeight: 700 }}>{naira(c.after_naira)}</span>
            </span>
          </div>
        ))}
      </div>
      {!applied && onApply && (
        // S1-C's own layout/copy once tapped: "Updating budget…" + a
        // separate "Apply disabled" label, replacing the plain button.
        applying ? (
          <div style={{ marginTop: 12, padding: '9px 14px', borderRadius: 12, background: '#120e1a', border: '1px solid rgba(163,92,255,.35)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} data-testid="ai-plan-update-applying">
            <span style={{ fontSize: 13 }}>Updating budget…</span>
            <span style={{ fontSize: 12, color: '#8a7f97' }}>Apply disabled</span>
          </div>
        ) : (
          <div
            onClick={handleApply}
            role="button"
            data-testid="ai-plan-update-apply"
            style={{ marginTop: 12, textAlign: 'center', padding: 9, borderRadius: 8, background: GRADIENT, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
          >
            Apply
          </div>
        )
      )}
      {undone && <div style={{ marginTop: 10, fontSize: 11, color: '#786d87' }}>Reverted to the previous allocation.</div>}
    </div>
  );
}

// ProviderRecCard: recommend_providers' own shape (provider_id, starting_
// price_naira, is_sponsored, availability_note) -- distinct from the
// general search_services_or_providers ProviderCardRow above, since this
// one always carries the "confirm availability" note and an Assign action
// that goes through the real assign_provider tool, never a direct booking.
// P15 "No suitable provider" -- real numbers from executeRecommendProviders'
// own no_match branch (total_in_location/cheapest_above_ceiling_naira),
// never fabricated. "Raise to ₦X" uses the real cheapest starting_price
// above the ceiling. "Combine with..."/"Browse all" are stated gaps (no
// cross-category combine logic or a Services-browse deep link exists from
// this overlay) rather than fake buttons; "Add your own vendor" routes to
// the real chat flow the same way other non-VENTS-provider actions do.
function NoSuitableProviderCard({ data, onQuickAction }: { data: any; onQuickAction?: (text: string) => void }) {
  const categoryLabel = data?.category ? titleCase(String(data.category)) : 'this category';
  const zeroInLocation = data?.total_in_location === 0;
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="ai-no-suitable-provider-card">
      <div style={{ padding: '14px 4px 4px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-.01em', lineHeight: 1.2 }}>
          {zeroInLocation ? `VENTS doesn't have ${categoryLabel.toLowerCase()} providers in ${data?.location || 'this city'} yet.` : `No ${categoryLabel.toLowerCase()} providers on VENTS match yet.`}
        </span>
        {!zeroInLocation && (
          <span style={{ fontSize: 13, color: '#a89db3', lineHeight: 1.5 }}>
            There are {data.total_in_location} in {data?.location || 'this area'}, but all start above {naira(data.max_price_naira)}.
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {!zeroInLocation && data?.cheapest_above_ceiling_naira != null && (
          <div onClick={() => onQuickAction?.(`Raise the budget for ${categoryLabel} to ${naira(data.cheapest_above_ceiling_naira)}.`)} role="button" style={{ padding: 14, borderRadius: 12, background: '#120e1a', border: '1px solid rgba(163,92,255,.4)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Raise to {naira(data.cheapest_above_ceiling_naira)}</div>
              <div style={{ fontSize: 12, color: '#a89db3', marginTop: 2 }}>Shows real matches at this price</div>
            </div>
            <span style={{ color: '#d3b8ff' }}>›</span>
          </div>
        )}
        <div onClick={() => onQuickAction?.(`I want to add my own vendor for ${categoryLabel} instead of a VENTS provider.`)} role="button" style={{ padding: 14, borderRadius: 12, background: '#120e1a', border: '1px solid #221d2d', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Add your own vendor</div>
            <div style={{ fontSize: 12, color: '#a89db3', marginTop: 2 }}>Track someone you found off VENTS</div>
          </div>
          <span style={{ color: '#d3b8ff' }}>›</span>
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: '#5e5470' }}>
        "Combine with another category" and browsing all providers without filters aren't built from here yet.
      </div>
    </div>
  );
}

function ProviderRecCard({ providers, onAssign }: { providers: any[]; onAssign?: (p: any) => void }) {
  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', marginTop: 10, paddingBottom: 4 }}>
      {providers.map((p, i) => (
        <div key={`${p.provider_id}-${i}`} style={{ flexShrink: 0, width: 200, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f0edf5' }}>{p.business_name}</div>
            {p.is_sponsored && <span style={{ fontSize: 8.5, fontWeight: 700, color: '#786d87' }}>SPONSORED</span>}
          </div>
          <div style={{ fontSize: 10.5, color: '#a89db3', marginTop: 3 }}>{p.category || '—'} · {p.location || '—'}</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#e8e3ee', marginTop: 6 }}>
            {p.starting_price_naira != null ? `From ${naira(p.starting_price_naira)}` : 'Price not listed'}
          </div>
          <div style={{ fontSize: 9.5, color: '#fbbf24', marginTop: 6, lineHeight: 1.4 }}>{p.availability_note || 'Confirm availability with provider.'}</div>
          {onAssign && (
            <div
              onClick={() => onAssign(p)}
              style={{ marginTop: 8, textAlign: 'center', padding: 7, borderRadius: 7, background: 'rgba(163,92,255,.14)', color: '#d3b8ff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
            >
              Assign this provider
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// AssignedCard: the real result of assign_provider -- always "Assigned",
// never "Booked"/"Paid"/"Confirmed booking" unless booked is literally true
// (which assign_provider's own RPC never sets -- it only ever writes
// status='assigned'; booked can only become true through a later, separate
// real booking elsewhere, reflected the next time this plan is fetched).
function AssignedCard({ data }: { data: any }) {
  const booked = data?.booked === true;
  return (
    <div
      style={{ marginTop: 10, background: booked ? 'rgba(52,211,153,.08)' : 'rgba(163,92,255,.08)', border: `1px solid ${booked ? 'rgba(52,211,153,.3)' : 'rgba(163,92,255,.35)'}`, borderRadius: 12, padding: 14 }}
      data-testid="ai-assigned-card"
    >
      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f0edf5' }}>
        Provider {booked ? 'booked & paid' : 'assigned'} — {titleCase(String(data?.category || ''))}
      </div>
      <div style={{ fontSize: 11, color: '#a89db3', marginTop: 6 }}>
        {data?.agreed_amount_naira != null ? `Agreed amount: ${naira(data.agreed_amount_naira)}` : 'No amount agreed yet.'}
      </div>
      {!booked && (
        <div style={{ fontSize: 10.5, color: '#8a7f97', marginTop: 6 }}>
          Not booked yet — assigning a provider doesn't charge anything or create a reservation.
        </div>
      )}
    </div>
  );
}

// Lightweight result card for reschedule_plan/confirm_brief -- neither
// returns the full plan shape PlanSummaryCard needs, and neither is a
// budget change, so a plain note card (not a diff, not a budget bar) is
// the honest representation of what actually happened.
function PlanActionCard({ type, data }: { type: string; data: any }) {
  if (type === 'reschedule_plan') {
    return (
      <div style={{ marginTop: 10, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: 14 }} data-testid="ai-reschedule-card">
        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f0edf5' }}>Date updated: {data?.event_date}</div>
        {data?.note && <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 6 }}>{data.note}</div>}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 10, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: 14 }} data-testid="ai-confirm-brief-card">
      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f0edf5' }}>Brief confirmed</div>
      <div style={{ fontSize: 11, color: '#a89db3', marginTop: 4 }}>This plan is now active.</div>
    </div>
  );
}

// P02 "I CAUGHT" card -- renders offer_plan_intent's extracted fields as
// tiles (only the fields the model actually gave; nothing guessed to fill
// a gap). "Just chat" is a pure local dismiss (nothing to undo server-side
// since nothing was written); "Plan this event with SI" sends a real
// follow-up turn so the model proceeds into ask_plan_question itself.
function PlanOfferCard({ data, onAccept }: { data: any; onAccept?: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const tiles: { label: string; value: string }[] = [];
  if (data?.event_type) tiles.push({ label: 'Event', value: titleCase(String(data.event_type)) });
  if (typeof data?.guests === 'number') tiles.push({ label: 'Guests', value: String(data.guests) });
  if (data?.city) tiles.push({ label: 'City', value: String(data.city) });
  if (typeof data?.total_budget_naira === 'number') tiles.push({ label: 'Budget', value: naira(data.total_budget_naira) });

  return (
    <div style={{ marginTop: 10, background: '#120e1a', border: '1px solid rgba(163,92,255,.4)', borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="ai-plan-offer-card">
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '.14em', color: '#d3b8ff' }}>I CAUGHT</span>
      {tiles.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {tiles.map((t) => (
            <div key={t.label} style={{ padding: '9px 10px', borderRadius: 9, background: '#1c1726' }}>
              <div style={{ fontSize: 10.5, color: '#8a7f97' }}>{t.label}</div>
              <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2 }}>{t.value}</div>
            </div>
          ))}
        </div>
      )}
      {typeof data?.questions_remaining === 'number' && (
        <span style={{ fontSize: 12.5, color: '#a89db3' }}>About {data.questions_remaining} quick question{data.questions_remaining === 1 ? '' : 's'} to go.</span>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <span onClick={() => setDismissed(true)} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Just chat</span>
        <span onClick={onAccept} role="button" style={{ flex: 1.4, textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>Plan this event with VENTS AI</span>
      </div>
    </div>
  );
}

// P03/P04 QuestionCard -- one ask_plan_question result, single_choice or
// multi_select. Free-text is always still available (the real composer
// below it is untouched), and Skip sends an explicit real turn rather than
// silently doing nothing.
function PlanQuestionCard({ data, onAnswer }: { data: any; onAnswer?: (text: string) => void }) {
  const [answered, setAnswered] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  if (answered) return null;
  const options: { id: string; label: string; hint: string | null }[] = Array.isArray(data?.options) ? data.options : [];
  const isMulti = data?.question_type === 'multi_select';
  const maxSelect = typeof data?.max_select === 'number' ? data.max_select : options.length;

  function pickSingle(label: string) {
    setAnswered(true);
    onAnswer?.(label);
  }
  function toggleMulti(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= maxSelect) return prev;
      return [...prev, id];
    });
  }
  function submitMulti() {
    const labels = options.filter((o) => selected.includes(o.id)).map((o) => o.label);
    setAnswered(true);
    onAnswer?.(labels.join(', '));
  }

  return (
    <div style={{ marginTop: 10, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="ai-plan-question-card">
      {typeof data?.step === 'number' && (
        <div style={{ display: 'flex', gap: 4 }}>
          {Array.from({ length: Math.max(data.step_count_estimate || data.step, data.step) }).map((_, i) => (
            <span key={i} style={{ flex: 1, height: 3, borderRadius: 9, background: i < data.step ? '#a35cff' : '#2c2438' }} />
          ))}
        </div>
      )}
      {data?.lead_in && <div style={{ fontSize: 13.5, lineHeight: 1.55, color: '#e4dfeb' }}>{data.lead_in}</div>}
      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{data?.question}</div>
      {isMulti ? (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {options.map((o) => {
              const isSel = selected.includes(o.id);
              return (
                <span
                  key={o.id}
                  onClick={() => toggleMulti(o.id)}
                  role="button"
                  style={{ padding: '9px 13px', borderRadius: 99, background: isSel ? 'rgba(163,92,255,.14)' : '#1c1726', border: isSel ? '1px solid rgba(163,92,255,.55)' : '1px solid #2c2438', fontSize: 13, fontWeight: isSel ? 700 : 400, color: isSel ? '#f0e8ff' : '#d6cfe0', cursor: 'pointer' }}
                >
                  {isSel ? '✓ ' : ''}{o.label}
                </span>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#8a7f97' }}>Pick up to {maxSelect}</span>
            <span onClick={submitMulti} role="button" style={{ padding: '10px 18px', borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>Done</span>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {options.map((o) => (
            <div
              key={o.id}
              onClick={() => pickSingle(o.label)}
              role="button"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '13px 14px', borderRadius: 12, background: '#120e1a', border: '1px solid #2c2438', cursor: 'pointer' }}
            >
              <span style={{ fontSize: 13.5, fontWeight: 600, flexShrink: 0 }}>{o.label}</span>
              {o.hint && <span style={{ fontSize: 12, color: '#8a7f97', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.hint}</span>}
            </div>
          ))}
        </div>
      )}
      {data?.allow_skip !== false && (
        <span onClick={() => pickSingle('Skip for now.')} role="button" style={{ fontSize: 12, color: '#8a7f97', cursor: 'pointer' }}>Skip for now — you can add this later</span>
      )}
    </div>
  );
}

// P05 Event Brief -- read-only review before create_plan_draft runs.
// Inline per-row editors (date picker, city picker, guest stepper,
// currency input) from the mockup's own spec text are NOT built here --
// an explicit, stated gap, not a silently approximated one. "Build my
// plan" sends a real follow-up turn so create_plan_draft/confirm_brief
// are the ones that actually create anything, never this card itself.
// A short list for the city PickerSheet (same component the rest of VENTS
// uses for city/location). allowCustom on the sheet means this is a set of
// suggestions, not a hard allowlist -- any city the user types is usable.
const BRIEF_CITY_OPTIONS = ['Lagos', 'Abuja', 'Ibadan', 'Port Harcourt', 'Kano', 'Kaduna', 'Enugu', 'Benin City', 'Calabar', 'Jos', 'Abeokuta', 'Owerri'].map((c) => ({ value: c, label: c }));
const BRIEF_SETTING_OPTIONS = ['Indoor', 'Outdoor', 'Beach'];

type EditableBrief = {
  event_date: string | null;
  city: string | null;
  setting: string | null;
  guests: number | null;
  total_budget_naira: number | null;
};

// P05 Event Brief -- the mockup's own spec text says every row is tappable
// into an inline editor (date picker, PickerSheet for city, stepper for
// guests, currency input). Date uses the same native <input type="date">
// VENTS already uses in CreateEventScreen; city reuses the real
// PickerSheet component; guests gets a small +/- stepper (no existing
// VENTS stepper component to reuse, so this is the one genuinely new
// control, kept to the mockup's plain two-button shape); budget is a
// plain number input, same convention as CreateEventScreen's ticket-price
// field. Venue/Style/Priorities editing is NOT built -- an explicit,
// stated gap (Venue means assigning a real provider, Style/Priorities
// editing would need its own multi-select sheet; neither is in this pass).
//
// Edits are purely local display state until "Build my plan" is tapped --
// there is still no plan row to diverge from. On Build, the edited values
// are spelled out explicitly in the real chat turn sent to the model
// (never a silent frontend-only copy), so create_plan_draft -- the only
// thing that actually writes a plans row -- receives exactly what's shown
// on the card, not a guess reconstructed from earlier conversation.
function PlanBriefCard({ data, onBuild }: { data: any; onBuild?: (brief: EditableBrief) => void }) {
  const [built, setBuilt] = useState(false);
  const [editing, setEditing] = useState<'date' | 'location' | 'guests' | 'budget' | null>(null);
  const [showCityPicker, setShowCityPicker] = useState(false);
  const [brief, setBrief] = useState<EditableBrief>({
    event_date: data?.event_date ?? null,
    city: data?.city ?? null,
    setting: data?.setting ?? null,
    guests: typeof data?.guests === 'number' ? data.guests : null,
    total_budget_naira: typeof data?.total_budget_naira === 'number' ? data.total_budget_naira : null,
  });
  // Draft values for whichever row is open -- committed into `brief` only
  // on that row's own "Done", so a cancel (tapping the row again) discards
  // the in-progress edit rather than leaving a half-typed value live.
  const [draftGuests, setDraftGuests] = useState(brief.guests ?? 1);
  const [draftBudget, setDraftBudget] = useState(brief.total_budget_naira ?? 0);

  if (built) return null;

  const todayIso = new Date().toISOString().slice(0, 10);

  function openRow(row: 'date' | 'location' | 'guests' | 'budget') {
    if (editing === row) {
      setEditing(null);
      return;
    }
    if (row === 'guests') setDraftGuests(brief.guests ?? 1);
    if (row === 'budget') setDraftBudget(brief.total_budget_naira ?? 0);
    setEditing(row);
  }

  function handleBuild() {
    setBuilt(true);
    onBuild?.(brief);
  }

  const rows: { key: 'date' | 'location' | 'guests' | 'budget'; label: string; value: string }[] = [
    // P05's own frame shows the full "Sat 12 Dec 2026" (with year, unlike
    // friendlyDate()'s other call sites elsewhere in this file, which never
    // need one) -- a real review step before the plan is created, so
    // ambiguity across a year boundary matters here specifically.
    { key: 'date', label: 'Date', value: brief.event_date ? new Date(brief.event_date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'Not set yet' },
    { key: 'location', label: 'Location', value: [brief.city, brief.setting].filter(Boolean).join(' · ') || 'Not set yet' },
    { key: 'guests', label: 'Guests', value: brief.guests != null ? String(brief.guests) : 'Not set yet' },
    { key: 'budget', label: 'Total budget', value: brief.total_budget_naira != null ? naira(brief.total_budget_naira) : 'Not set yet' },
  ];
  const venueRow = { label: 'Venue', value: data?.venue_status || 'Not booked yet', amber: !data?.venue_status || /not booked/i.test(data.venue_status) };

  return (
    <div style={{ marginTop: 10, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="ai-plan-brief-card">
      <div>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em' }}>{data?.title || 'Your plan'}</div>
        {data?.host_names && <div style={{ fontSize: 13, color: '#a89db3', marginTop: 4 }}>{data.host_names}</div>}
      </div>
      <div style={{ borderRadius: 12, background: '#16111f', border: '1px solid #221d2d', overflow: 'hidden' }}>
        {rows.map((r, i) => (
          <div key={r.key} style={{ borderTop: i > 0 ? '1px solid #1c1726' : 'none' }}>
            <div
              onClick={() => openRow(r.key)}
              role="button"
              data-testid={`ai-brief-row-${r.key}`}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '13px 14px', cursor: 'pointer' }}
            >
              <span style={{ fontSize: 13, color: '#8a7f97', flexShrink: 0 }}>{r.label}</span>
              <span style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.value} <span style={{ color: '#8a7f97', fontWeight: 500 }}>{editing === r.key ? '⌄' : '›'}</span></span>
            </div>
            {editing === r.key && (
              <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {r.key === 'date' && (
                  <>
                    <input
                      type="date"
                      value={brief.event_date || ''}
                      min={todayIso}
                      onChange={(e) => setBrief((b) => ({ ...b, event_date: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '12px 14px', fontSize: 14, color: '#f0f0ff', fontFamily: 'inherit' }}
                    />
                    <span onClick={() => setEditing(null)} role="button" data-testid="ai-brief-row-date-done" style={{ textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>Done</span>
                  </>
                )}
                {r.key === 'location' && (
                  <>
                    <div
                      onClick={() => setShowCityPicker(true)}
                      role="button"
                      style={{ width: '100%', boxSizing: 'border-box', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '12px 14px', fontSize: 14, color: brief.city ? '#f0f0ff' : '#8b8fa8', cursor: 'pointer' }}
                    >
                      {brief.city || 'Choose a city'}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {BRIEF_SETTING_OPTIONS.map((s) => (
                        <span
                          key={s}
                          onClick={() => setBrief((b) => ({ ...b, setting: s.toLowerCase() }))}
                          role="button"
                          style={{ flex: 1, textAlign: 'center', padding: '8px 0', borderRadius: 99, fontSize: 12.5, cursor: 'pointer', background: brief.setting === s.toLowerCase() ? 'rgba(163,92,255,.14)' : '#1c1726', border: brief.setting === s.toLowerCase() ? '1px solid rgba(163,92,255,.55)' : '1px solid #2c2438', color: brief.setting === s.toLowerCase() ? '#f0e8ff' : '#d6cfe0', fontWeight: brief.setting === s.toLowerCase() ? 700 : 400 }}
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                    <span onClick={() => setEditing(null)} role="button" style={{ textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>Done</span>
                  </>
                )}
                {r.key === 'guests' && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
                      <span onClick={() => setDraftGuests((g) => Math.max(1, g - 1))} role="button" data-testid="ai-brief-guests-minus" style={{ width: 36, height: 36, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, cursor: 'pointer' }}>−</span>
                      <span style={{ fontSize: 17, fontWeight: 800, minWidth: 48, textAlign: 'center' }}>{draftGuests}</span>
                      <span onClick={() => setDraftGuests((g) => g + 1)} role="button" data-testid="ai-brief-guests-plus" style={{ width: 36, height: 36, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, cursor: 'pointer' }}>+</span>
                    </div>
                    <span
                      onClick={() => { setBrief((b) => ({ ...b, guests: draftGuests })); setEditing(null); }}
                      role="button"
                      data-testid="ai-brief-row-guests-done"
                      style={{ textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}
                    >
                      Done
                    </span>
                  </>
                )}
                {r.key === 'budget' && (
                  <>
                    <div style={{ position: 'relative' }}>
                      <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: '#8a7f97' }}>₦</span>
                      <input
                        type="number"
                        min={0}
                        value={draftBudget || ''}
                        onChange={(e) => setDraftBudget(Math.max(0, Number(e.target.value) || 0))}
                        style={{ width: '100%', boxSizing: 'border-box', background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '12px 14px 12px 28px', fontSize: 14, color: '#f0f0ff', fontFamily: 'inherit' }}
                      />
                    </div>
                    <span
                      onClick={() => { setBrief((b) => ({ ...b, total_budget_naira: draftBudget })); setEditing(null); }}
                      role="button"
                      data-testid="ai-brief-row-budget-done"
                      style={{ textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}
                    >
                      Done
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 14px', borderTop: '1px solid #1c1726' }}>
          <span style={{ fontSize: 13, color: '#8a7f97' }}>{venueRow.label}</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: venueRow.amber ? '#fbbf24' : '#f0edf5' }}>{venueRow.value}</span>
        </div>
      </div>
      {Array.isArray(data?.style) && data.style.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97' }}>STYLE</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {data.style.map((s: string) => <span key={s} style={{ padding: '5px 10px', borderRadius: 99, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12 }}>{s}</span>)}
          </div>
        </div>
      )}
      {Array.isArray(data?.priorities) && data.priorities.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.5px', color: '#8a7f97' }}>PRIORITIES · PROTECTED IN BUDGET</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {data.priorities.map((p: string, i: number) => <span key={p} style={{ padding: '5px 10px', borderRadius: 99, background: 'rgba(163,92,255,.14)', border: '1px solid rgba(163,92,255,.4)', fontSize: 12, color: '#f0e8ff' }}>{i + 1} · {p}</span>)}
          </div>
        </div>
      )}
      <span onClick={handleBuild} role="button" style={{ textAlign: 'center', padding: 13, borderRadius: 12, background: GRADIENT, fontSize: 14, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>Build my plan</span>
      <span style={{ textAlign: 'center', fontSize: 11.5, color: '#8a7f97' }}>You can change any of this later.</span>
      {showCityPicker && (
        <PickerSheet
          title="Choose a city"
          options={BRIEF_CITY_OPTIONS}
          value={brief.city || ''}
          allowCustom
          onSelect={(v) => { setBrief((b) => ({ ...b, city: v })); setShowCityPicker(false); }}
          onClose={() => setShowCityPicker(false)}
        />
      )}
    </div>
  );
}

// P27 "Which event?" -- one disambiguate_plans result. Each row is a real
// candidate the backend already confirmed still needs this category (see
// executeDisambiguatePlans); the "Something else" row is a static UI
// action, not server data, same precedent as PlanOfferCard's "Just chat".
function PlanDisambiguationCard({
  candidates,
  onSelectPlan,
  onSomethingElse,
}: {
  candidates: { plan_id: string; title: string; status: string; event_date: string | null; city: string | null; category_estimated_naira: number | null; category_label?: string | null }[];
  onSelectPlan: (planId: string, title: string) => void;
  onSomethingElse: () => void;
}) {
  const [resolved, setResolved] = useState(false);
  if (resolved) return null;
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="ai-plan-disambiguation-card">
      {candidates.map((c) => (
        <div
          key={c.plan_id}
          onClick={() => { setResolved(true); onSelectPlan(c.plan_id, c.title); }}
          role="button"
          data-testid={`ai-plan-disambiguation-option-${c.plan_id}`}
          style={{ padding: '12px 14px', borderRadius: 12, background: '#120e1a', border: '1px solid #2c2438', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
        >
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>◆ {c.title}</div>
            <div style={{ fontSize: 11.5, color: '#a89db3' }}>
              {c.status === 'draft' ? 'Draft' : (friendlyDate(c.event_date, true) || 'Date not set')}{c.city ? ` · ${c.city}` : ''}
              {c.category_estimated_naira != null ? ` · ≈ ${compactNaira(c.category_estimated_naira)}${c.category_label ? ` for ${c.category_label.toLowerCase()}` : ''}` : ''}
            </div>
          </div>
          <span style={{ color: '#d3b8ff' }}>›</span>
        </div>
      ))}
      <div
        onClick={() => { setResolved(true); onSomethingElse(); }}
        role="button"
        data-testid="ai-plan-disambiguation-something-else"
        style={{ padding: '12px 14px', borderRadius: 12, background: '#120e1a', border: '1px solid #2c2438', fontSize: 13.5, color: '#c9c0d4', cursor: 'pointer' }}
      >
        Something else
      </div>
    </div>
  );
}

// Builds the real chat-turn text sent on "Build my plan" -- spells out
// every brief field explicitly (edited or not) so create_plan_draft (the
// only thing that actually writes a plans row) is driven by exactly what
// the user saw on the card, never a silent frontend-only copy that could
// diverge from it. Starts with "build my plan" so BuildingPlanLoader's
// own detection (ConversationView's lastConvUserText check) still matches.
function buildPlanMessage(original: any, brief: EditableBrief): string {
  const parts: string[] = [];
  parts.push(`title "${original?.title || 'Untitled'}"`);
  if (original?.event_type) parts.push(`event type ${original.event_type}`);
  parts.push(`date ${brief.event_date || 'not set'}`);
  parts.push(`city ${brief.city || 'not set'}`);
  parts.push(`setting ${brief.setting || 'not set'}`);
  parts.push(`guests ${brief.guests ?? 'not set'}`);
  parts.push(`total budget ${brief.total_budget_naira != null ? naira(brief.total_budget_naira) : 'not set'}`);
  if (Array.isArray(original?.style) && original.style.length > 0) parts.push(`style ${original.style.join(', ')}`);
  if (Array.isArray(original?.priorities) && original.priorities.length > 0) parts.push(`priorities ${original.priorities.join(', ')}`);
  return `Build my plan with these final details: ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------
// Card dispatch -- routes a backend card to the right renderer by `type`.
// ---------------------------------------------------------------------

const EVENT_CARD_TYPES = new Set(['search_events', 'get_event']);
const PROVIDER_CARD_TYPES = new Set(['search_services_or_providers', 'get_provider_profile']);
const INFO_CARD_TYPES = new Set(['get_my_tickets', 'get_my_bookings', 'get_payment_status', 'get_wallet_balance', 'get_vents_cents_balance']);
const PLAN_SUMMARY_CARD_TYPES = new Set(['create_plan_draft', 'get_plan']);

function AssistantCards({
  cards,
  streaming,
  onOpenEvent,
  onOpenProvider,
  onOpenPlan,
  onQuickAction,
  onUndoChange,
  onSelectPlanForThread,
}: {
  cards: BackendCard[];
  // S1-C -- whether a request is currently in flight, so a just-tapped
  // Apply button can disable itself and say so, rather than risk a
  // duplicate apply_plan_update call.
  streaming?: boolean;
  onOpenEvent?: (id: string) => void;
  onOpenProvider?: (id: string) => void;
  onOpenPlan?: (planId: string, title: string) => void;
  // Fires a canned follow-up message through the normal chat pipeline --
  // used for Apply/Assign buttons, so the real apply_plan_update/
  // assign_provider tool executes server-side exactly as if the user had
  // typed the request themselves. Never a frontend-only state change.
  onQuickAction?: (text: string) => void;
  // Undo is the one exception that doesn't go through the model: it calls
  // the real undo_plan_change RPC directly (still fully RLS/ownership
  // enforced server-side), then triggers a refresh via onQuickAction.
  onUndoChange?: (changeLogId: string) => void;
  // P27 -- picking a plan in the disambiguation card attaches THIS SAME
  // free-chat thread to that plan (header chip appears, per the mockup's
  // own spec text) and continues the original request with plan context,
  // rather than opening a separate new thread the way P24's "Ask SI" does.
  onSelectPlanForThread?: (planId: string, title: string) => void;
}) {
  return (
    <>
      {cards.map((card, i) => {
        if (card.source === 'external' || card.source === 'general') {
          return <ExternalResultCard key={i} card={card} />;
        }
        if (EVENT_CARD_TYPES.has(card.type)) {
          const events = Array.isArray(card.data) ? card.data : card.data ? [card.data] : [];
          if (!events.length) return null;
          return <EventCardRow key={i} events={events} onOpenEvent={onOpenEvent} />;
        }
        if (PROVIDER_CARD_TYPES.has(card.type)) {
          const providers = Array.isArray(card.data) ? card.data : card.data ? [card.data] : [];
          if (!providers.length) return null;
          return <ProviderCardRow key={i} providers={providers} onOpenProvider={onOpenProvider} />;
        }
        if (INFO_CARD_TYPES.has(card.type)) {
          return <InfoCard key={i} type={card.type} data={card.data} />;
        }
        if (PLAN_SUMMARY_CARD_TYPES.has(card.type)) {
          return <PlanSummaryCard key={i} plan={card.data} onOpenPlan={onOpenPlan} />;
        }
        if (card.type === 'propose_plan_update') {
          return (
            <PlanUpdateCard
              key={i}
              data={card.data}
              applied={false}
              streaming={streaming}
              onApply={() => onQuickAction?.('Apply that change.')}
            />
          );
        }
        if (card.type === 'apply_plan_update') {
          return <PlanUpdateCard key={i} data={card.data} applied onUndo={onUndoChange} />;
        }
        if (card.type === 'recommend_providers') {
          const providers = Array.isArray(card.data) ? card.data : [];
          if (providers.length === 1 && providers[0]?.no_match) {
            return <NoSuitableProviderCard key={i} data={providers[0]} onQuickAction={onQuickAction} />;
          }
          if (!providers.length) {
            // Honest empty state, not silence, for a shape the no_match
            // branch above doesn't cover (e.g. no price ceiling was given
            // at all, so executeRecommendProviders had no ceiling to
            // explain -- just zero real results).
            return (
              <div key={i} style={{ marginTop: 10, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: 14, fontSize: 11.5, color: '#786d87' }} data-testid="ai-no-providers-card">
                No matching providers on VENTS right now — try a different category, location, or a higher budget.
              </div>
            );
          }
          return (
            <ProviderRecCard
              key={i}
              providers={providers}
              onAssign={(p) => onQuickAction?.(`Assign provider ${p.provider_id} (${p.business_name}) to this category.`)}
            />
          );
        }
        if (card.type === 'assign_provider') {
          return <AssignedCard key={i} data={card.data} />;
        }
        if (card.type === 'reschedule_plan' || card.type === 'confirm_brief') {
          return <PlanActionCard key={i} type={card.type} data={card.data} />;
        }
        if (card.type === 'offer_plan_intent') {
          return <PlanOfferCard key={i} data={card.data} onAccept={() => onQuickAction?.('Yes, plan this event with VENTS AI.')} />;
        }
        if (card.type === 'ask_plan_question') {
          return <PlanQuestionCard key={i} data={card.data} onAnswer={(text) => onQuickAction?.(text)} />;
        }
        if (card.type === 'preview_plan_brief') {
          return <PlanBriefCard key={i} data={card.data} onBuild={(brief) => onQuickAction?.(buildPlanMessage(card.data, brief))} />;
        }
        if (card.type === 'disambiguate_plans') {
          const cardData = card.data as any;
          const candidates = Array.isArray(cardData?.candidates) ? cardData.candidates : [];
          if (candidates.length === 0) return null; // nothing genuinely open -- SYSTEM_PROMPT 6j already has the model say so in prose instead.
          return (
            <PlanDisambiguationCard
              key={i}
              candidates={candidates}
              onSelectPlan={(planId, title) => onSelectPlanForThread?.(planId, title)}
              onSomethingElse={() => onQuickAction?.("Something else -- not tied to a specific plan.")}
            />
          );
        }
        // Confirmed-action result cards (start_ticket_transfer,
        // request_ticket_refund, start_service_booking, create_report) --
        // api/ai-assistant.ts pushes these on the confirmedAction path's
        // response, so render the real result as a success card.
        if (card.type === 'start_ticket_transfer' || card.type === 'request_ticket_refund' || card.type === 'start_service_booking' || card.type === 'create_report') {
          return <SuccessCard key={i} title={`${titleCase(card.type)} completed`} detail="This was just carried out on your real VENTS account." />;
        }
        return null;
      })}
    </>
  );
}

// ---------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------

export function VentsAiScreen({
  onClose,
  onOpenEvent,
  onOpenProvider,
  isDesktop,
  seedPrompt,
  currentUserCountryIso,
}: {
  onClose: () => void;
  onOpenEvent?: (id: string) => void;
  onOpenProvider?: (id: string) => void;
  // Right contextual panel is desktop/tablet-only, matching the export's
  // `showRightPanel = !isMobile && !!rightPanel`. Reuses a plain
  // window.innerWidth check since this repo has no existing responsive
  // breakpoint helper to reuse (grep found none).
  isDesktop?: boolean;
  // Contextual entry points (Home/Services sparkle, event details' "Ask
  // VENTS AI to plan this night") pre-fill the composer with real context
  // via this prop -- never auto-sent, the user still taps Send themselves,
  // so this touches no AI backend call or access check, only the text box
  // they'd otherwise have typed into. `nonce` lets the same text be
  // reapplied if the user asks about the same event twice in a row.
  seedPrompt?: { text: string; nonce: number } | null;
  // Default for the Area control -- the authenticated user's own saved
  // profile country (App.tsx's currentUser?.country), never a GPS-derived
  // one substituted silently. Undefined for a signed-out/no-country
  // account, in which case Area simply starts unset.
  currentUserCountryIso?: string;
}) {
  const [conversations, setConversations] = useState<LocalConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  // Applies a contextual seed prompt to the composer -- only while on the
  // Home view with no active conversation (a seed arriving mid-conversation
  // would otherwise clobber whatever the user is already typing or
  // mid-send). Keyed on seedPrompt?.nonce, not just its text, so tapping
  // "Ask VENTS AI" about the same event twice still re-applies it.
  useEffect(() => {
    if (seedPrompt?.text && !activeId) setInputText(seedPrompt.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedPrompt?.nonce]);
  const [streaming, setStreaming] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Set alongside errorText when the server's error has a known `code`
  // (ventsAi.ts attaches it from the response's `error` field) -- lets the
  // error banner below show a real "View Plans" action specifically for
  // AI_BETA_RESTRICTED (no active subscription), instead of only ever
  // showing plain text with no path forward.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // Dedicated Plan Workspace screen (P07/P08) -- distinct destination from
  // a plan's chat thread (P24: "Ask SI opens the plan thread; Open plan
  // opens Overview"). null means neither workspace tab is open.
  const [workspacePlanId, setWorkspacePlanId] = useState<string | null>(null);
  // Real paywall (AiPlansScreen) -- opened from HomeView's status pill.
  // entitlementRefreshKey is bumped on a verified purchase so HomeView's
  // own get_my_ai_entitlement() re-fetch (keyed on this value) picks up
  // the new access state immediately, without a logout/reload.
  const [showPlans, setShowPlans] = useState(false);
  const [entitlementRefreshKey, setEntitlementRefreshKey] = useState(0);
  const nextId = useRef(1);

  const active = conversations.find((c) => c.id === activeId) || null;

  function titleFromText(text: string): string {
    const t = text.trim();
    return t.length > 36 ? `${t.slice(0, 36)}…` : t || 'New chat';
  }

  // `openNewPlanThread`: when set, this call is the FIRST message of a
  // brand-new plan-pinned conversation (see openPlan below) -- bypasses
  // the activeId-based resolution entirely so the new conversation (with
  // its planId already attached) and this first send happen as one atomic
  // step, rather than racing React's async state updates (setActiveId from
  // a caller wouldn't be visible yet inside this same synchronous call).
  async function sendText(
    text: string,
    openNewPlanThread?: { convId: string; planId: string; title: string },
    // Explicit target conversation id, bypassing the `activeId` state read
    // below -- needed when the caller just called setActiveId() in this
    // same synchronous tick (e.g. re-opening a plan's existing thread from
    // the Workspace screen) and so can't rely on `activeId` having updated
    // yet.
    targetConvId?: string,
    // P27 -- attaches an EXISTING free-chat thread to a plan as part of
    // this same send (picking a disambiguation option), rather than
    // racing a separate setConversations call against this closure's
    // stale `conversations` read, same reasoning as targetConvId above.
    attachPlanId?: string
  ) {
    const q = text.trim();
    if (!q || streaming) return;
    setInputText('');
    setErrorText(null);
    setErrorCode(null);

    let convId: string;
    let planId: string | undefined;
    let history: ChatMessage[];

    if (openNewPlanThread) {
      convId = openNewPlanThread.convId;
      planId = openNewPlanThread.planId;
      history = [];
      setActiveId(convId);
      const newConv: LocalConversation = {
        id: convId,
        title: openNewPlanThread.title,
        messages: [{ role: 'user', text: q }],
        updatedAt: Date.now(),
        planId,
      };
      setConversations((prev) => [newConv, ...prev]);
    } else {
      // Compute the target conversation and its prior history synchronously
      // from the current `conversations` state (available directly, since
      // this runs from an event handler) rather than inside a setState
      // updater -- React does not guarantee an updater function runs
      // synchronously before this async function's next line, so mutating a
      // closed-over `convId` variable from inside one is not reliable here.
      const resolvedId = targetConvId || activeId;
      const existing = resolvedId ? conversations.find((c) => c.id === resolvedId) : undefined;
      history = existing ? existing.messages : [];
      planId = attachPlanId || existing?.planId;
      convId = resolvedId || '';
      if (!convId) {
        convId = `c${nextId.current++}`;
        setActiveId(convId);
        const newConv: LocalConversation = { id: convId, title: titleFromText(q), messages: [{ role: 'user', text: q }], updatedAt: Date.now(), planId };
        setConversations((prev) => [newConv, ...prev]);
      } else {
        const targetId = convId;
        setConversations((prev) =>
          prev.map((c) => (c.id === targetId ? { ...c, messages: [...c.messages, { role: 'user', text: q }], updatedAt: Date.now(), ...(attachPlanId ? { planId: attachPlanId } : {}) } : c))
        );
      }
    }

    setStreaming(true);
    try {
      // When this is a plan's pinned thread, every outgoing user turn
      // carries the plan id as context for the model's own tool calls
      // (§01 IA: "every request carries plan_id") -- display text (what
      // the user actually sees in the bubble) is never touched, only the
      // copy sent to the API. This is a hint for which tool arguments the
      // model should use, never an authorization mechanism: every plan
      // tool independently re-verifies ownership server-side regardless.
      const apiMessages: VentsAiMessage[] = [...history, { role: 'user' as const, text: q }].map((m) => ({
        role: m.role,
        content: planId && m.role === 'user' ? `[plan_id: ${planId}] ${m.text}` : m.text,
      }));
      const res = await sendVentsAiMessage(apiMessages);
      appendAssistantResponse(convId, res);
    } catch (e: any) {
      // Per the export's STATE_CARDS tone ("Something went wrong … Nothing
      // was charged or changed") -- adapted copy, no literal states screen.
      setErrorText(e?.message || "Something went wrong reaching VENTS AI. Nothing was charged or changed.");
      setErrorCode(e?.code || null);
    } finally {
      setStreaming(false);
    }
  }

  function appendAssistantResponse(convId: string, res: any) {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        let msg: ChatMessage;
        if (res.type === 'confirmation_required') {
          msg = {
            role: 'assistant',
            text: res.text || "This needs your confirmation before it happens.",
            confirmation: { action: res.action, params: res.params, proposal: res.proposal, token: res.token },
          };
        } else {
          msg = { role: 'assistant', text: res.text || '', cards: res.cards || [] };
        }
        return { ...c, messages: [...c.messages, msg], updatedAt: Date.now() };
      })
    );
  }

  async function handleConfirm(convId: string, msgIndex: number, confirmation: NonNullable<ChatMessage['confirmation']>) {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        const messages = c.messages.map((m, i) => (i === msgIndex ? { ...m, confirmation: { ...m.confirmation!, resolved: 'confirmed' as const } } : m));
        return { ...c, messages };
      })
    );
    setStreaming(true);
    try {
      const res = await sendVentsAiMessage([], { action: confirmation.action, params: confirmation.params, token: confirmation.token });
      appendAssistantResponse(convId, res);
    } catch (e: any) {
      setErrorText(e?.message || "That didn't go through. Nothing was charged or changed.");
    } finally {
      setStreaming(false);
    }
  }

  function handleCancel(convId: string, msgIndex: number) {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        const messages = c.messages.map((m, i) => (i === msgIndex ? { ...m, confirmation: { ...m.confirmation!, resolved: 'cancelled' as const } } : m));
        return { ...c, messages };
      })
    );
  }

  // Opens (or returns to) a plan's own pinned thread -- reuses an
  // already-open thread for this plan this session rather than spawning a
  // second competing one, and otherwise starts a fresh thread whose very
  // first turn asks SI for the plan's current state (always the real,
  // authoritative get_plan result -- never a cached/guessed summary).
  function openPlan(planId: string, title: string, firstMessage?: string) {
    const existingThread = conversations.find((c) => c.planId === planId);
    if (existingThread) {
      setActiveId(existingThread.id);
      if (firstMessage) sendText(firstMessage, undefined, existingThread.id);
      return;
    }
    const convId = `c${nextId.current++}`;
    sendText(firstMessage || 'Show me this plan.', { convId, planId, title: title || 'Plan' });
  }

  // Undo goes straight to the real RPC (still fully RLS/ownership
  // enforced server-side -- see undo_plan_change, migration 0157), not
  // through the model -- there is nothing for SI to "decide" about an
  // undo the user already explicitly tapped. Refreshes the thread with
  // the plan's real post-undo state afterward, same as any other mutation.
  async function handleUndoChange(convId: string, changeLogId: string) {
    try {
      const { error } = await supabase.rpc('undo_plan_change', { p_change_log_id: changeLogId });
      if (error) throw error;
    } catch (e: any) {
      setErrorText(e?.message || "Undo didn't go through.");
      return;
    }
    if (activeId === convId) {
      sendText('Show me the updated plan after that undo.');
    }
  }

  const inConversation = !!active;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: '#0a0810', color: '#f2eff6', fontFamily: "'Inter',system-ui,sans-serif", display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingTop: 'env(safe-area-inset-top, 0px)' }}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'flex', minWidth: 0, position: 'relative' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
            {workspacePlanId ? (
              <PlanWorkspaceView
                planId={workspacePlanId}
                onBack={() => setWorkspacePlanId(null)}
                onAskSi={(title) => {
                  setWorkspacePlanId(null);
                  openPlan(workspacePlanId, title);
                }}
                onComposerSend={(text) => {
                  setWorkspacePlanId(null);
                  openPlan(workspacePlanId, '', text);
                }}
                onSwitchPlan={(id) => setWorkspacePlanId(id)}
                onStartNewPlan={(prompt) => { setWorkspacePlanId(null); setInputText(prompt); }}
              />
            ) : !inConversation ? (
              <HomeView
                inputText={inputText}
                onInputChange={setInputText}
                onSend={() => sendText(inputText)}
                onClose={onClose}
                conversations={conversations}
                onOpenConversation={(id) => setActiveId(id)}
                onOpenPlan={openPlan}
                onOpenWorkspace={(planId) => setWorkspacePlanId(planId)}
                onQuickSend={(text) => sendText(text)}
                errorText={errorText}
                errorCode={errorCode}
                isDesktop={isDesktop}
                onViewPlans={() => setShowPlans(true)}
                entitlementRefreshKey={entitlementRefreshKey}
                currentUserCountryIso={currentUserCountryIso}
              />
            ) : (
              <ConversationView
                conversation={active!}
                streaming={streaming}
                inputText={inputText}
                onInputChange={setInputText}
                onSend={() => sendText(inputText)}
                onBack={() => setActiveId(null)}
                onConfirm={(idx, conf) => handleConfirm(active!.id, idx, conf)}
                onCancel={(idx) => handleCancel(active!.id, idx)}
                onOpenEvent={onOpenEvent}
                onOpenProvider={onOpenProvider}
                onOpenPlan={openPlan}
                onQuickAction={(text) => sendText(text)}
                onUndoChange={(changeLogId) => handleUndoChange(active!.id, changeLogId)}
                onSelectPlanForThread={(planId, title) => sendText(`Use my "${title}" plan for this.`, undefined, active!.id, planId)}
                errorText={errorText}
                errorCode={errorCode}
                onViewPlans={() => setShowPlans(true)}
              />
            )}
          </div>
          {isDesktop && inConversation && <RightPanel conversation={active!} />}
        </div>
      </div>
      {showPlans && (
        <AiPlansScreen
          onClose={() => setShowPlans(false)}
          onSubscribed={() => {
            // Bumping this re-runs HomeView's get_my_ai_entitlement() fetch
            // -- the real post-purchase refresh, not a client-side flag.
            setEntitlementRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

// SI's two rooms (§01 IA: "SI gains a second room. Nothing else moves --
// Chat (today's HomeView/ConversationView) and Plans (new)"). Per P01/P24's
// own spec text, plan threads now appear inline in RECENT CONVERSATIONS
// (marked with a ◆), and the Plans tab shows a live count badge -- neither
// is filtered out or static.
// "VENTS AI Home Review.dc.html" (refined variant 1b/1c) -- the full-width
// "access: active" row from the originally-approved "1a" screen becomes a
// small header status pill. Real data only: sourced from the same
// get_my_ai_entitlement() RPC AiAccessScreen.tsx already reads (STABLE,
// SECURITY DEFINER, scoped to auth.uid() -- no way to ask for someone
// else's status), never fabricated or derived from local state. Colors
// mirror AiAccessScreen's own state semantics (green = usable right now,
// amber = needs attention, grey = still loading) without duplicating its
// full gating logic here -- this pill is informational, not a gate; actual
// enforcement still happens server-side in check_and_reserve_ai_usage().
type AiStatusPill = { label: string; dot: string; bg: string; border: string; color: string };

function resolveStatusPill(ent: {
  plan_id: string | null;
  status: string;
  used_units?: number;
  hard_ceiling?: number;
  period_end?: string | null;
  grace_until?: string | null;
} | null): AiStatusPill {
  if (!ent) return { label: 'Checking access…', dot: '#5e5470', bg: 'rgba(255,255,255,.06)', border: 'rgba(255,255,255,.12)', color: '#b4aecb' };
  const periodEndPassed = !!ent.period_end && new Date(ent.period_end).getTime() < Date.now();
  if (!ent.plan_id || ent.status === 'inactive') {
    return { label: 'VENTS AI access: not subscribed', dot: '#fbbf24', bg: 'rgba(251,191,36,.08)', border: 'rgba(251,191,36,.3)', color: '#fbbf24' };
  }
  if (ent.status === 'expired' || ent.status === 'canceled' || (periodEndPassed && !ent.grace_until)) {
    return { label: 'VENTS AI access: expired', dot: '#f87171', bg: 'rgba(248,113,113,.08)', border: 'rgba(248,113,113,.3)', color: '#f87171' };
  }
  if (ent.hard_ceiling && (ent.used_units ?? 0) >= ent.hard_ceiling) {
    return { label: 'VENTS AI access: limit reached', dot: '#fbbf24', bg: 'rgba(251,191,36,.08)', border: 'rgba(251,191,36,.3)', color: '#fbbf24' };
  }
  if (ent.status === 'trialing') {
    return { label: 'VENTS AI access: trial', dot: '#34d399', bg: 'rgba(52,211,153,.08)', border: 'rgba(52,211,153,.3)', color: '#34d399' };
  }
  if (ent.status === 'grace') {
    return { label: 'VENTS AI access: renewal pending', dot: '#fbbf24', bg: 'rgba(251,191,36,.08)', border: 'rgba(251,191,36,.3)', color: '#fbbf24' };
  }
  return { label: 'VENTS AI access: active', dot: '#34d399', bg: 'rgba(52,211,153,.08)', border: 'rgba(52,211,153,.3)', color: '#34d399' };
}

// Mood/Budget/Area -- the design's "tune a search" card condensed to three
// menu chips opening iOS-style sheets (same PickerSheet component used
// throughout the rest of the app, e.g. ServicesHomeScreen's country
// picker). These are real, functional controls: a selection composes into
// the actual composer text the user still has to tap Send on -- never an
// auto-sent or fabricated AI response, same seed-then-send pattern the
// contextual entry points (Home/Services sparkle) already use elsewhere
// in this file. Option sets are plain, generic presets (not AI-generated
// or scraped data) -- nothing here claims to be live inventory.
const MOOD_OPTIONS = ['Chill', 'Romantic', 'Adventure', 'Nightlife', 'Luxury', 'Family-friendly'];
const BUDGET_OPTIONS = ['Under ₦10,000', '₦10,000–₦50,000', '₦50,000–₦150,000', 'Over ₦150,000'];

// Rotating Home headline -- cut to short, bold phrases per the approved
// design review, rotating every ~2.5s (HomeView's own effect, skipped
// entirely under prefers-reduced-motion).
const HOME_HEADLINES = ['What are we planning?', 'Where are we going?', "What's the vibe?", 'What experience are you looking for?'];

function HomeView({
  inputText,
  onInputChange,
  onSend,
  onClose,
  conversations,
  onOpenConversation,
  onOpenPlan,
  onOpenWorkspace,
  onQuickSend,
  errorText,
  errorCode,
  isDesktop,
  onViewPlans,
  entitlementRefreshKey,
  currentUserCountryIso,
}: {
  inputText: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
  conversations: LocalConversation[];
  onOpenConversation: (id: string) => void;
  onOpenPlan: (planId: string, title: string) => void;
  onOpenWorkspace: (planId: string) => void;
  onQuickSend: (text: string) => void;
  errorText: string | null;
  errorCode?: string | null;
  isDesktop?: boolean;
  onViewPlans: () => void;
  entitlementRefreshKey: number;
  currentUserCountryIso?: string;
}) {
  const [room, setRoom] = useState<'chat' | 'plans'>('chat');
  const [entitlement, setEntitlement] = useState<any>(null);
  const [tuneSheet, setTuneSheet] = useState<'mood' | 'budget' | 'area' | null>(null);
  // Area defaults from the user's own saved profile country (never a
  // GPS-derived one substituted silently) -- initialized once, lazily, so
  // a user who then explicitly clears/changes it isn't fought by this
  // default re-applying on every render.
  const profileCountry = currentUserCountryIso ? COUNTRY_CODES.find((c) => c.iso === currentUserCountryIso) : undefined;
  const [tuneValues, setTuneValues] = useState<{ mood: string; budget: string; area: string }>({
    mood: '', budget: '', area: profileCountry?.name || '',
  });
  const [areaCity, setAreaCity] = useState('');
  const [budgetCustom, setBudgetCustom] = useState('');

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('get_my_ai_entitlement').then(({ data, error }) => {
      if (!cancelled && !error) setEntitlement(data);
    });
    return () => { cancelled = true; };
    // Re-fetches after a verified purchase (AiPlansScreen bumps this via
    // onSubscribed) -- the real post-purchase refresh, no logout needed.
  }, [entitlementRefreshKey]);

  function applyTuneSelection(field: 'mood' | 'budget' | 'area', value: string) {
    setTuneValues((prev) => ({ ...prev, [field]: value }));
    setTuneSheet(null);
    const next = { ...tuneValues, [field]: value };
    const parts = [next.mood, next.budget, next.area].filter(Boolean);
    if (parts.length > 0) {
      onInputChange(`Something ${parts.join(', ').toLowerCase()}`);
    }
  }

  // "What are we planning?" / "Where are we going?" etc, rotating every
  // 2.5s -- pure text swap, no layout shift or motion beyond the fade
  // itself, and skipped entirely under prefers-reduced-motion (the
  // headline just shows the first phrase, static).
  const [headlineIndex, setHeadlineIndex] = useState(0);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setHeadlineIndex((i) => (i + 1) % HOME_HEADLINES.length), 2500);
    return () => clearInterval(id);
  }, []);
  // Lifted up from PlansListView so both the Plans-tab badge/list and the
  // Chat tab's promo/"Continue planning" card (P01/P24) can read the same
  // real `plans` rows without two independent, possibly-inconsistent fetches.
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);

  async function loadPlans() {
    // Single aggregate RPC -- never an N+1 of per-plan reads just to show
    // readiness/committed/overdue on this list (see migration 0160's
    // get_plans_overview()).
    const { data, error } = await supabase.rpc('get_plans_overview');
    if (error) {
      setPlansError(error.message);
      setPlans([]);
      return;
    }
    // Defensive against test/mock rpc dispatchers that return a fixed
    // shape for every rpc name -- a real get_plans_overview() always
    // returns an array (possibly empty), never a bare object.
    setPlans(Array.isArray(data) ? (data as PlanSummary[]) : []);
  }

  useEffect(() => {
    loadPlans();
  }, []);

  // Recency-sorted, un-filtered -- a plan's pinned thread shows up here
  // like any other conversation, just marked with a ◆ (P24's own spec).
  const recentConversations = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '18px 16px 30px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '.08em', color: '#c4b5fd', textTransform: 'uppercase' as const }}>VENTS AI</div>
          <div onClick={onClose} style={{ fontSize: 19, color: '#a89db3', cursor: 'pointer', padding: 4 }} aria-label="Close VENTS AI" role="button">✕</div>
        </div>

        {/* Centered dimensional orb -- layered radial gradients (lit
            sphere + offset highlight + a rotating glassy sheen + outer
            glow halo) rather than a flat circle with a glyph. Pure CSS,
            no new dependency, frozen to a static single frame under
            prefers-reduced-motion (handled inside Vents3DOrb itself). */}
        <Vents3DOrb size={76} />

        {/* Rotating headline -- plain text swap every ~2.5s (see the
            effect above), frozen on the first phrase under
            prefers-reduced-motion. */}
        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <div data-testid="vents-ai-headline" style={{ fontSize: 24, fontWeight: 800, color: '#f5f2f8', letterSpacing: '-.01em' }}>
            {HOME_HEADLINES[headlineIndex]}
          </div>
          <div style={{ fontSize: 13, color: '#a89db3', margin: '6px 0 0' }}>
            Ask about events, services, tickets, wallet or bookings — or plan a whole event, step by step.
          </div>
        </div>
        <div style={{ height: 16 }} />

        {/* Two things, same destination: the pill (real status, small by
            design -- a status indicator shouldn't shout) and an explicit,
            unmistakable "View Plans" action next to it, so the only
            subscription entry point on this screen isn't a 32px dot a
            user could plausibly miss. Both call onViewPlans -- there is
            exactly one way this screen opens AiPlansScreen, just two
            visible affordances for it. Reachable regardless of
            app_config.ai_entitlement_enforced -- this row isn't gated on
            that flag at all, only on get_my_ai_entitlement() actually
            resolving (or still loading, which the pill's own "Checking
            access…" label already covers). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          {(() => {
            const pill = resolveStatusPill(entitlement);
            return (
              <div
                onClick={onViewPlans}
                role="button"
                style={{ display: 'flex', alignItems: 'center', gap: 7, height: 32, padding: '0 12px', borderRadius: 16, background: pill.bg, border: `1px solid ${pill.border}`, cursor: 'pointer', width: 'fit-content' }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 4, background: pill.dot, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: pill.color, fontFamily: "'Manrope',sans-serif" }}>{pill.label}</span>
              </div>
            );
          })()}
          <button
            onClick={onViewPlans}
            data-testid="vents-ai-view-plans"
            aria-label="View VENTS AI plans"
            style={{
              height: 32, padding: '0 14px', borderRadius: 16, border: '1px solid rgba(139,92,246,0.5)',
              background: 'rgba(139,92,246,0.14)', color: '#d3b8ff', fontSize: 12, fontWeight: 700,
              fontFamily: "'Manrope',sans-serif", cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            View Plans <span style={{ fontSize: 13 }}>›</span>
          </button>
        </div>

        <div style={{ display: 'flex', background: '#120e1a', border: '1px solid #221d2d', borderRadius: 11, padding: 3, marginBottom: 18 }}>
          {([['chat', 'Chat'], ['plans', plans && plans.length > 0 ? `Plans · ${plans.length}` : 'Plans']] as const).map(([id, label]) => (
            <div
              key={id}
              onClick={() => setRoom(id as 'chat' | 'plans')}
              data-testid={`si-room-${id}`}
              style={{
                flex: 1, textAlign: 'center', padding: 8, borderRadius: 8, fontSize: 13, fontWeight: room === id ? 700 : 600, cursor: 'pointer',
                background: room === id ? '#1c1726' : 'transparent',
                color: room === id ? '#f2eff6' : '#a89db3',
              }}
            >
              {label}
            </div>
          ))}
        </div>

        {room === 'chat' ? (
          <>
            <div style={{ position: 'relative', marginBottom: 12 }}>
              <input
                value={inputText}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSend()}
                placeholder="Ask about events or plans"
                // 16px, not 13.5px -- mobile Safari zooms the whole page on
                // focus for any text input under 16px, which this screen's
                // fixed full-viewport layout has no graceful recovery from.
                // Matches the design review's own note ("Inputs are
                // 16px-equivalent to avoid Safari zoom on focus").
                style={{ width: '100%', boxSizing: 'border-box', background: '#120e1a', border: '1px solid #2a2438', borderRadius: 14, padding: '15px 52px 15px 16px', fontSize: 16, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
              />
              <div onClick={onSend} style={{ position: 'absolute', right: 8, top: 8, width: 36, height: 36, borderRadius: 10, background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', fontSize: 14 }}>↑</div>
            </div>

            {/* Mood/Budget/Area -- compact popovers anchored directly under
                each chip, never a fullscreen sheet (PickerSheet, used
                elsewhere in this app, is a position:fixed/inset:0 overlay
                -- wrong for three small filter controls). Each chip's
                wrapper is position:relative so its popover anchors to it. */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
              {(['mood', 'budget', 'area'] as const).map((key) => {
                const label = key === 'mood' ? 'Mood' : key === 'budget' ? 'Budget' : 'Area';
                const selected = tuneValues[key];
                return (
                  <div key={key} style={{ position: 'relative' }}>
                    <div
                      onClick={() => setTuneSheet(tuneSheet === key ? null : key)}
                      role="button"
                      data-testid={`vents-ai-tune-${key}`}
                      style={{ height: 36, padding: '0 14px', borderRadius: 18, background: selected ? 'rgba(163,92,255,.16)' : '#161020', border: `1px solid ${selected ? 'rgba(163,92,255,.4)' : '#2a2438'}`, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: selected ? '#d3b8ff' : '#e8e3ee', cursor: 'pointer', fontFamily: "'Manrope',sans-serif" }}
                    >
                      {selected || label} <span style={{ fontSize: 10, color: '#8a7f97' }}>⌄</span>
                    </div>
                    {tuneSheet === key && (
                      <TunePopover
                        field={key}
                        value={tuneValues[key]}
                        onSelect={(v) => applyTuneSelection(key, v)}
                        onClose={() => setTuneSheet(null)}
                        areaCity={areaCity}
                        onAreaCityChange={setAreaCity}
                        budgetCustom={budgetCustom}
                        onBudgetCustomChange={setBudgetCustom}
                        profileCountryName={profileCountry?.name}
                        preferredRegionIso={(currentUserCountryIso || 'NG').toLowerCase()}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {errorText && (
              <div style={{ marginBottom: 18, fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 10, padding: 10 }}>
                <div>{errorText}</div>
                {errorCode === 'AI_BETA_RESTRICTED' && (
                  <button
                    onClick={onViewPlans}
                    data-testid="vents-ai-error-view-plans"
                    style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, color: '#d3b8ff', fontSize: 12, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    View Plans ›
                  </button>
                )}
              </div>
            )}

            {plans && plans.length > 0 ? (
              <ContinuePlanningCard
                plan={plans[0]}
                onAskSi={() => onOpenPlan(plans[0].id, plans[0].title)}
                onOpenWorkspace={() => onOpenWorkspace(plans[0].id)}
              />
            ) : plans !== null && !plansError ? (
              <NewPlannerPromoCard onPickType={onQuickSend} />
            ) : null}

            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: '#5e5470', marginBottom: 10 }}>SUGGESTED</div>
            <div style={{ display: 'grid', gridTemplateColumns: isDesktop ? 'repeat(3, minmax(0, 1fr))' : '1fr', gap: 10, marginBottom: 26 }}>
              {SUGGESTED_PROMPTS.map((p, i) => (
                <div
                  key={i}
                  onClick={() => onInputChange(p.label)}
                  style={{ cursor: 'pointer', background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: '13px 14px', fontSize: 12.5, color: '#d6cfe0' }}
                >
                  {p.label}
                </div>
              ))}
            </div>

            {/* Recent is real-or-absent -- fed only by this session's saved
                conversations (see this file's own comment on why that's
                in-memory, not a backend table). With none, the whole
                section is omitted, not an empty-state filler line -- per
                the design review's own note #6. */}
            {recentConversations.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: '#5e5470', marginBottom: 10 }}>RECENT CONVERSATIONS</div>
                {recentConversations.map((c) => {
                  const lastAi = [...c.messages].reverse().find((m) => m.role === 'assistant');
                  return (
                    <div
                      key={c.id}
                      onClick={() => onOpenConversation(c.id)}
                      style={{ cursor: 'pointer', background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: '13px 14px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: '#e8e3ee' }}>{c.planId ? '◆ ' : ''}{c.title}</div>
                        <div style={{ fontSize: 11, color: '#786d87', marginTop: 2 }}>{lastAi ? lastAi.text.slice(0, 42) : ''}</div>
                      </div>
                      <div style={{ fontSize: 10.5, color: '#5e5470', flexShrink: 0, marginLeft: 10 }}>{new Date(c.updatedAt).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}</div>
                    </div>
                  );
                })}
              </>
            )}
          </>
        ) : (
          <PlansListView plans={plans} plansError={plansError} onOpenPlan={onOpenPlan} onOpenWorkspace={onOpenWorkspace} onStartNewPlan={(prompt) => { setRoom('chat'); onInputChange(prompt); }} onPlansChanged={loadPlans} />
        )}
      </div>
    </div>
  );
}

// Dimensional purple "glass" orb for the Home header -- layered radial
// gradients (a soft outer halo, a lit sphere with its own inner shadow/
// highlight, a glossy sheen) rather than a flat circle or a star glyph, per
// the design review's explicit "no flat star / no 2D illustration"
// requirement. Reuses the exact ventsAiOrbGlow/ventsAiOrbFloat keyframes
// already defined in VentsAiUnlockedScreen.tsx (same values, so the two
// screens' orbs read as the same visual object) and the same
// prefers-reduced-motion override pattern. `size` controls everything
// proportionally so this one component serves every call site.
function Vents3DOrb({ size }: { size: number }) {
  return (
    <div style={{ position: 'relative', width: size, height: size, margin: '0 auto' }}>
      <div
        style={{
          position: 'absolute', inset: -size * 0.2, borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(139,92,246,.45), transparent)',
          animation: 'ventsAiOrbGlow 4.5s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          background: 'radial-gradient(circle at 32% 28%, #e9ddff 0%, #a78bfa 22%, #6d28d9 58%, #1b1140 100%)',
          boxShadow: 'inset 0 -10px 24px rgba(0,0,0,.45), inset 0 8px 18px rgba(255,255,255,.28)',
          animation: 'ventsAiOrbFloat 6s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute', left: '24%', top: '16%', width: '34%', height: '20%',
          borderRadius: '50%', background: 'rgba(255,255,255,.35)', filter: 'blur(5px)',
        }}
      />
      <style>{`
        @keyframes ventsAiOrbGlow { 0%, 100% { opacity: .55; transform: scale(.94); } 50% { opacity: 1; transform: scale(1.06); } }
        @keyframes ventsAiOrbFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @media (prefers-reduced-motion: reduce) {
          @keyframes ventsAiOrbGlow { 0%, 100% { opacity: .8; transform: scale(1); } }
          @keyframes ventsAiOrbFloat { 0%, 100% { transform: translateY(0); } }
        }
      `}</style>
    </div>
  );
}

// Compact popover for Mood/Budget/Area, anchored directly under its chip
// (position:absolute within the chip's position:relative wrapper) -- never
// the fullscreen PickerSheet used elsewhere in this app. Mood/Budget are
// simple option lists; Budget additionally takes a free-typed NGN amount;
// Area takes a typed location with real Google Places geocoding
// (loadGoogleMaps() + AutocompleteSuggestion.fetchAutocompleteSuggestions,
// the same API LocationPicker.tsx already uses -- GPS is intentionally not
// requested here since a typed location must stay fully usable without any
// permission prompt) plus the profile-country default and full country list.
function TunePopover({
  field,
  value,
  onSelect,
  onClose,
  areaCity,
  onAreaCityChange,
  budgetCustom,
  onBudgetCustomChange,
  profileCountryName,
  preferredRegionIso,
}: {
  field: 'mood' | 'budget' | 'area';
  value: string;
  onSelect: (v: string) => void;
  onClose: () => void;
  areaCity: string;
  onAreaCityChange: (v: string) => void;
  budgetCustom: string;
  onBudgetCustomChange: (v: string) => void;
  profileCountryName?: string;
  preferredRegionIso: string;
}) {
  const [areaSuggestions, setAreaSuggestions] = useState<{ key: string; mainText: string; secondaryText: string }[]>([]);
  const sessionTokenRef = useRef<any>(null);

  useEffect(() => {
    if (field !== 'area' || !areaCity.trim()) {
      setAreaSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        try {
          const { loadGoogleMaps } = await import('../../lib/googleMaps');
          await loadGoogleMaps();
          const google = (window as any).google;
          if (typeof google?.maps?.places?.AutocompleteSuggestion?.fetchAutocompleteSuggestions !== 'function') return;
          if (!sessionTokenRef.current) sessionTokenRef.current = new google.maps.places.AutocompleteSessionToken();
          const response = await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
            input: areaCity,
            includedRegionCodes: [preferredRegionIso],
            sessionToken: sessionTokenRef.current,
          });
          if (cancelled) return;
          const mapped = (response?.suggestions || [])
            .filter((s: any) => s.placePrediction)
            .map((s: any, i: number) => {
              const p = s.placePrediction;
              return { key: p.placeId || String(i), mainText: p.mainText?.text ?? p.text?.text ?? '', secondaryText: p.secondaryText?.text ?? '' };
            });
          setAreaSuggestions(mapped);
        } catch {
          // Geocoding is a convenience, not a requirement -- a denied key,
          // offline device, or SDK failure just means no suggestions; the
          // plain typed value in areaCity remains fully usable either way.
          setAreaSuggestions([]);
        }
      })();
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [field, areaCity, preferredRegionIso]);

  return (
    <div
      role="dialog"
      aria-label={`${field} options`}
      style={{
        position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 20,
        width: field === 'area' ? 280 : 220, maxHeight: 320, overflowY: 'auto',
        background: '#161020', border: '1px solid #2a2438', borderRadius: 14,
        boxShadow: '0 12px 32px rgba(0,0,0,.5)', padding: 10,
        fontFamily: "'Manrope',sans-serif",
      }}
    >
      {field === 'mood' && (
        <>
          {MOOD_OPTIONS.map((m) => (
            <div
              key={m}
              onClick={() => onSelect(m)}
              data-testid={`vents-ai-tune-option-${m}`}
              style={{ padding: '9px 10px', borderRadius: 8, fontSize: 13, color: value === m ? '#d3b8ff' : '#e8e3ee', background: value === m ? 'rgba(163,92,255,.14)' : 'transparent', cursor: 'pointer' }}
            >
              {m}
            </div>
          ))}
        </>
      )}

      {field === 'budget' && (
        <>
          {BUDGET_OPTIONS.map((b) => (
            <div
              key={b}
              onClick={() => onSelect(b)}
              data-testid={`vents-ai-tune-option-${b}`}
              style={{ padding: '9px 10px', borderRadius: 8, fontSize: 13, color: value === b ? '#d3b8ff' : '#e8e3ee', background: value === b ? 'rgba(163,92,255,.14)' : 'transparent', cursor: 'pointer' }}
            >
              {b}
            </div>
          ))}
          <div style={{ borderTop: '1px solid #2a2438', margin: '8px 0', paddingTop: 8 }}>
            <div style={{ fontSize: 11, color: '#8a7f97', marginBottom: 6 }}>Or enter an amount (₦)</div>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={budgetCustom}
              onChange={(e) => onBudgetCustomChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && budgetCustom.trim()) onSelect(`₦${Number(budgetCustom).toLocaleString()}`);
              }}
              placeholder="e.g. 75000"
              data-testid="vents-ai-tune-budget-custom"
              style={{ width: '100%', boxSizing: 'border-box', background: '#0e0a15', border: '1px solid #2a2438', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: '#e8e3ee', outline: 'none' }}
            />
            <button
              onClick={() => budgetCustom.trim() && onSelect(`₦${Number(budgetCustom).toLocaleString()}`)}
              disabled={!budgetCustom.trim()}
              data-testid="vents-ai-tune-budget-custom-apply"
              style={{ marginTop: 6, width: '100%', border: 0, borderRadius: 8, padding: '7px 0', fontSize: 12.5, fontWeight: 700, color: '#fff', background: budgetCustom.trim() ? GRADIENT : '#2a2438', cursor: budgetCustom.trim() ? 'pointer' : 'default' }}
            >
              Use this amount
            </button>
          </div>
        </>
      )}

      {field === 'area' && (
        <>
          <input
            value={areaCity}
            onChange={(e) => onAreaCityChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && areaCity.trim()) onSelect(areaCity.trim()); }}
            placeholder={profileCountryName ? `City, state or area in ${profileCountryName}` : 'Type a city, state or area'}
            data-testid="vents-ai-tune-area-input"
            style={{ width: '100%', boxSizing: 'border-box', background: '#0e0a15', border: '1px solid #2a2438', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: '#e8e3ee', outline: 'none', marginBottom: 8 }}
          />
          {areaSuggestions.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {areaSuggestions.map((s) => (
                <div
                  key={s.key}
                  onClick={() => onSelect(s.mainText)}
                  style={{ padding: '8px 10px', borderRadius: 8, fontSize: 12.5, color: '#e8e3ee', cursor: 'pointer' }}
                >
                  {s.mainText}
                  {s.secondaryText && <span style={{ color: '#8a7f97' }}> · {s.secondaryText}</span>}
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11, color: '#8a7f97', margin: '2px 0 6px' }}>Or choose a country</div>
          {profileCountryName && (
            <div
              onClick={() => onSelect(profileCountryName)}
              data-testid="vents-ai-tune-area-profile-country"
              style={{ padding: '9px 10px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: value === profileCountryName ? '#d3b8ff' : '#e8e3ee', background: value === profileCountryName ? 'rgba(163,92,255,.14)' : 'rgba(255,255,255,.04)', cursor: 'pointer', marginBottom: 4 }}
            >
              {profileCountryName} (your profile)
            </div>
          )}
          {COUNTRY_CODES.filter((c) => c.name !== profileCountryName).map((c) => (
            <div
              key={c.iso}
              onClick={() => onSelect(c.name)}
              style={{ padding: '9px 10px', borderRadius: 8, fontSize: 13, color: value === c.name ? '#d3b8ff' : '#e8e3ee', background: value === c.name ? 'rgba(163,92,255,.14)' : 'transparent', cursor: 'pointer' }}
            >
              {c.name}
            </div>
          ))}
        </>
      )}

      <div
        onClick={onClose}
        role="button"
        data-testid="vents-ai-tune-close"
        style={{ marginTop: 8, textAlign: 'center', fontSize: 11.5, color: '#8a7f97', cursor: 'pointer', paddingTop: 8, borderTop: '1px solid #2a2438' }}
      >
        Close
      </div>
    </div>
  );
}

// Plans room (P25). `plans`/`plansError` are lifted up into HomeView (one
// get_plans_overview() RPC call via the user's own RLS-scoped client) so
// the Chat tab's promo/Continue-planning card and this list never disagree
// from two independent fetches. Sorted by event date with drafts last
// (P25's own spec text: "Sorted by event date; drafts (brief unconfirmed)
// last") -- get_plans_overview() already orders event_date first, so the
// only reshuffle needed here is pulling draft rows to the end.
function PlansListView({
  plans,
  plansError,
  onOpenPlan,
  onOpenWorkspace,
  onStartNewPlan,
  onPlansChanged,
}: {
  plans: PlanSummary[] | null;
  plansError: string | null;
  onOpenPlan: (planId: string, title: string) => void;
  onOpenWorkspace: (planId: string) => void;
  onStartNewPlan: (prompt: string) => void;
  onPlansChanged: () => void;
}) {
  const loadError = plansError;
  const [menuPlanId, setMenuPlanId] = useState<string | null>(null);
  const [renamePlan, setRenamePlan] = useState<PlanSummary | null>(null);
  const [deletePlan, setDeletePlan] = useState<PlanSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showPastArchived, setShowPastArchived] = useState(false);

  const upcoming = (plans ?? []).filter((p) => p.status === 'draft' || p.status === 'active');
  const active = upcoming.filter((p) => p.status === 'active');
  const drafts = upcoming.filter((p) => p.status === 'draft');
  const sorted = [...active, ...drafts]; // event-date order already set by get_plans_overview(); drafts last.
  const pastPlans = (plans ?? []).filter((p) => p.status === 'past');
  const archivedPlans = (plans ?? []).filter((p) => p.status === 'archived');

  async function rename(p: PlanSummary, title: string) {
    setActionError(null);
    const t = title.trim();
    if (!t) return;
    // plans_update_own RLS already scopes this to the caller's own row --
    // never trusts anything but the authenticated client for ownership.
    const { error } = await supabase.from('plans').update({ title: t }).eq('id', p.id);
    if (error) { setActionError(error.message); return; }
    setRenamePlan(null);
    onPlansChanged();
  }

  async function archive(p: PlanSummary) {
    setActionError(null);
    setMenuPlanId(null);
    const { error } = await supabase.from('plans').update({ status: 'archived' }).eq('id', p.id);
    if (error) { setActionError(error.message); return; }
    onPlansChanged();
  }

  async function duplicateAsTemplate(p: PlanSummary) {
    setActionError(null);
    setMenuPlanId(null);
    const { error } = await supabase.rpc('duplicate_plan_as_template', { p_plan_id: p.id, p_title: `${p.title} (template)` });
    if (error) { setActionError(error.message); return; }
    onPlansChanged();
  }

  async function confirmDelete(p: PlanSummary) {
    setActionError(null);
    // plans_delete_own RLS already scopes this to the caller's own row.
    const { error } = await supabase.from('plans').delete().eq('id', p.id);
    if (error) { setActionError(error.message); return; }
    setDeletePlan(null);
    onPlansChanged();
  }

  function row(p: PlanSummary) {
    const totalKobo = p.total_kobo ?? 0;
    const pct = Math.max(0, Math.min(100, p.readiness_pct));
    const daysToGo = p.event_date ? Math.max(0, Math.round((new Date(p.event_date).getTime() - Date.now()) / 86400000)) : null;
    // "Status chip shows only the single most important state" (P25's own
    // spec text) -- draft wins outright, then overdue, then plain active.
    const chip = p.status === 'draft'
      ? { label: 'DRAFT', bg: '#1c1726', color: '#a89db3' }
      : p.overdue_task_count > 0
        ? { label: `${p.overdue_task_count} OVERDUE`, bg: 'rgba(251,191,36,.1)', color: '#fbbf24' }
        : { label: 'ACTIVE', bg: 'rgba(163,92,255,.15)', color: '#d3b8ff' };

    return (
      <div key={p.id} data-testid="si-plan-row" style={{ position: 'relative', background: '#120e1a', border: `1px solid ${p.status === 'active' && p.overdue_task_count === 0 ? 'rgba(163,92,255,.4)' : '#221d2d'}`, borderRadius: 14, padding: 16, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div onClick={() => onOpenPlan(p.id, p.title)} role="button" style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800 }}>{p.title}</div>
            <div style={{ fontSize: 12.5, color: '#a89db3', marginTop: 3 }}>
              {friendlyDate(p.event_date) || 'Date not set'} · {p.city || 'City not set'}{p.guests ? ` · ${p.guests}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 7px', borderRadius: 6, background: chip.bg, color: chip.color }}>{chip.label}</span>
            <span
              onClick={(e) => { e.stopPropagation(); onOpenWorkspace(p.id); }}
              role="button"
              data-testid="si-plan-open-workspace"
              style={{ fontSize: 11, fontWeight: 700, color: '#d3b8ff', cursor: 'pointer' }}
            >
              Open ›
            </span>
            <span
              onClick={(e) => { e.stopPropagation(); setMenuPlanId((v) => (v === p.id ? null : p.id)); }}
              role="button"
              aria-label="Plan actions"
              data-testid={`si-plan-menu-${p.id}`}
              style={{ fontSize: 15, color: '#8a7f97', cursor: 'pointer', padding: '2px 4px' }}
            >
              ⋯
            </span>
          </div>
        </div>

        {p.status === 'draft' ? (
          <div style={{ fontSize: 12, color: '#a89db3' }}>
            Brief incomplete · <span onClick={() => onOpenPlan(p.id, p.title)} role="button" style={{ color: '#d3b8ff', fontWeight: 700, cursor: 'pointer' }}>Finish with VENTS AI</span>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 3, height: 5 }}>
              <span style={{ width: `${pct}%`, borderRadius: 9, background: '#a35cff' }} />
              <span style={{ flex: 1, borderRadius: 9, background: '#2c2438' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#a89db3' }} onClick={() => onOpenPlan(p.id, p.title)} role="button">
              <span>{pct}% ready{daysToGo != null ? ` · ${daysToGo} days` : ''}</span>
              <span>{naira(p.committed_or_paid_kobo / 100)}{totalKobo > 0 ? ` / ${naira(totalKobo / 100)} committed` : ' committed'}</span>
            </div>
          </>
        )}

        {menuPlanId === p.id && (
          <div
            onClick={(e) => e.stopPropagation()}
            data-testid={`si-plan-menu-open-${p.id}`}
            style={{ position: 'absolute', top: 42, right: 14, background: '#1a1522', border: '1px solid #2c2438', borderRadius: 10, padding: 6, zIndex: 20, boxShadow: '0 12px 30px rgba(0,0,0,.5)', minWidth: 190 }}
          >
            <div onClick={() => { setMenuPlanId(null); setRenamePlan(p); }} role="button" data-testid={`si-plan-rename-${p.id}`} style={{ padding: '10px 12px', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#e8e3ee', cursor: 'pointer' }}>Rename</div>
            <div onClick={() => duplicateAsTemplate(p)} role="button" data-testid={`si-plan-duplicate-${p.id}`} style={{ padding: '10px 12px', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#e8e3ee', cursor: 'pointer' }}>Duplicate as template</div>
            <div onClick={() => archive(p)} role="button" data-testid={`si-plan-archive-${p.id}`} style={{ padding: '10px 12px', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#e8e3ee', cursor: 'pointer' }}>Archive</div>
            <div onClick={() => { setMenuPlanId(null); setDeletePlan(p); }} role="button" data-testid={`si-plan-delete-${p.id}`} style={{ padding: '10px 12px', borderRadius: 7, fontSize: 13, fontWeight: 600, color: '#f87171', cursor: 'pointer' }}>Delete</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {actionError && (
        <div style={{ marginBottom: 12, fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 10, padding: 10 }}>{actionError}</div>
      )}

      {plans === null ? (
        // S1 Loading.
        <div style={{ fontSize: 12, color: '#5e5470', textAlign: 'center', padding: 20 }}>Loading your plans…</div>
      ) : loadError ? (
        // S3 Error.
        <div style={{ fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 10, padding: 12 }}>
          Couldn't load your plans — {loadError}
        </div>
      ) : upcoming.length === 0 ? (
        // S2-A -- exact mockup copy/layout: title, subtitle, type chips (prefill+send,
        // same precedent as the Chat tab's NewPlannerPromoCard), and a real "Start a
        // plan" CTA that enters the existing plan-creation flow (never a fake navigation).
        <div style={{ padding: '24px 18px', borderRadius: 14, background: '#120e1a', border: '1px solid #221d2d', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-.01em' }}>No plans yet</span>
          <span style={{ fontSize: 13.5, color: '#a89db3', lineHeight: 1.5 }}>Tell VENTS AI about an event and it'll build the plan with you.</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['Plan a wedding', 'Help me plan a wedding'], ['Plan a birthday', 'Help me plan a birthday'], ['Plan a conference', 'Help me plan a conference']].map(([label, prompt]) => (
              <span
                key={label}
                onClick={() => onStartNewPlan(prompt)}
                role="button"
                data-testid={`si-plans-empty-chip-${label.split(' ').pop()}`}
                style={{ fontSize: 12, padding: '7px 11px', borderRadius: 99, background: '#1c1726', border: '1px solid #2c2438', color: '#d6cfe0', cursor: 'pointer' }}
              >
                {label}
              </span>
            ))}
          </div>
          <span
            onClick={() => onStartNewPlan("I'm planning an event.")}
            role="button"
            data-testid="si-new-plan"
            style={{ height: 46, borderRadius: 12, background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#fff', cursor: 'pointer' }}
          >
            Start a plan
          </span>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: '#8a7f97' }}>UPCOMING</span>
            {/* P25's own layout: "+ New plan" is this small inline link
                beside UPCOMING once plans exist -- the big gradient CTA
                is S2-A's own treatment, only for the genuinely-empty state
                above. */}
            <span onClick={() => onStartNewPlan("I'm planning an event.")} role="button" data-testid="si-new-plan" style={{ fontSize: 13, fontWeight: 700, color: '#d3b8ff', cursor: 'pointer' }}>+ New plan</span>
          </div>
          {sorted.map(row)}
        </>
      )}

      {plans !== null && !loadError && (pastPlans.length > 0 || archivedPlans.length > 0) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#8a7f97', paddingTop: 4 }}>
          <span>Past · {pastPlans.length} · Archived · {archivedPlans.length}</span>
          <span onClick={() => setShowPastArchived((v) => !v)} role="button" data-testid="si-plans-show-past" style={{ color: '#d3b8ff', cursor: 'pointer' }}>
            {showPastArchived ? 'Hide' : 'Show'}
          </span>
        </div>
      )}
      {showPastArchived && [...pastPlans, ...archivedPlans].map((p) => (
        <div key={p.id} onClick={() => onOpenPlan(p.id, p.title)} role="button" style={{ cursor: 'pointer', background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: '13px 14px', marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#e8e3ee' }}>{p.title}</div>
            <div style={{ fontSize: 11, color: '#786d87', marginTop: 2 }}>{titleCase(p.event_type)}{p.city ? ` · ${p.city}` : ''}{friendlyDate(p.event_date) ? ` · ${friendlyDate(p.event_date)}` : ''}</div>
          </div>
          <span style={{ fontSize: 9.5, fontWeight: 700, padding: '3px 7px', borderRadius: 6, background: '#1c1726', color: '#a89db3' }}>{p.status.toUpperCase()}</span>
        </div>
      ))}

      {renamePlan && (
        <RenamePlanSheet plan={renamePlan} onCancel={() => setRenamePlan(null)} onSave={(title) => rename(renamePlan, title)} />
      )}
      {deletePlan && (
        <DeletePlanConfirmDialog plan={deletePlan} onCancel={() => setDeletePlan(null)} onConfirm={() => confirmDelete(deletePlan)} />
      )}
    </div>
  );
}

// Rename -- a minimal inline-edit sheet, same visual language as the
// other bottom sheets in this file (DateChangeSheet etc).
function RenamePlanSheet({ plan, onCancel, onSave }: { plan: PlanSummary; onCancel: () => void; onSave: (title: string) => void }) {
  const [title, setTitle] = useState(plan.title);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,4,8,.72)', display: 'flex', alignItems: 'flex-end', zIndex: 980 }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', background: '#120e1a', borderTop: '1px solid #2c2438', borderRadius: '18px 18px 0 0', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Rename plan</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="si-plan-rename-input"
          style={{ background: '#1c1726', border: '1px solid #2c2438', borderRadius: 10, padding: '10px 12px', fontSize: 13.5, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <span onClick={onCancel} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Cancel</span>
          <span onClick={() => onSave(title)} role="button" data-testid="si-plan-rename-save" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>Save</span>
        </div>
      </div>
    </div>
  );
}

// P25's own spec text: "Delete (ConfirmDialog)" -- deletion is irreversible
// (a real row delete via plans_delete_own RLS), so it always confirms first.
function DeletePlanConfirmDialog({ plan, onCancel, onConfirm }: { plan: PlanSummary; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,4,8,.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 980 }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 300, background: '#120e1a', border: '1px solid #2c2438', borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Delete "{plan.title}"?</span>
        <span style={{ fontSize: 12.5, color: '#a89db3' }}>This permanently deletes the plan, its budget, team, tasks and timeline. This can't be undone.</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <span onClick={onCancel} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Cancel</span>
          <span onClick={onConfirm} role="button" data-testid="si-plan-delete-confirm" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#fb7185', fontSize: 12.5, fontWeight: 700, color: '#2a0810', cursor: 'pointer' }}>Delete</span>
        </div>
      </div>
    </div>
  );
}

// P06 "Building the plan" loading state -- shown in place of the generic
// typing-dots indicator specifically while the real create_plan_draft/
// confirm_brief round-trip is in flight. The mockup's own 5-item checklist
// ticks each item as a REAL server stage returns; this backend has no
// per-stage progress signal (create_plan_draft is one request/response,
// not a stream), so rather than fake those ticks against state that
// doesn't exist, this renders the frame's shell (icon/title/subtitle) with
// a single honest "Working on it…" indeterminate line instead of 5
// fabricated checkmarks. Documented gap, not a silent one.
function BuildingPlanLoader({ title }: { title: string }) {
  return (
    <div style={{ padding: '40px 8px 16px', display: 'flex', flexDirection: 'column', gap: 24 }} data-testid="ai-building-plan-loader">
      <span style={{ width: 56, height: 56, borderRadius: '50%', background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, color: '#fff', boxShadow: '0 0 0 10px rgba(163,92,255,.08)' }}>✦</span>
      <div>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em', lineHeight: 1.2 }}>Building your<br />{title} plan</div>
        <div style={{ fontSize: 13, color: '#a89db3', marginTop: 8 }}>Usually under 20 seconds.</div>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid #a35cff', borderRightColor: 'transparent', flexShrink: 0, animation: 'ventsAiSpin 0.8s linear infinite' }} />
        <span style={{ fontSize: 14, fontWeight: 600 }}>Working on it…</span>
      </div>
      <style>{`@keyframes ventsAiSpin{to{transform:rotate(360deg);}}`}</style>
    </div>
  );
}

function ConversationView({
  conversation,
  streaming,
  inputText,
  onInputChange,
  onSend,
  onBack,
  onConfirm,
  onCancel,
  onOpenEvent,
  onOpenProvider,
  onOpenPlan,
  onQuickAction,
  onUndoChange,
  onSelectPlanForThread,
  errorText,
  errorCode,
  onViewPlans,
}: {
  conversation: LocalConversation;
  streaming: boolean;
  inputText: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onBack: () => void;
  onConfirm: (idx: number, confirmation: NonNullable<ChatMessage['confirmation']>) => void;
  onCancel: (idx: number) => void;
  onOpenEvent?: (id: string) => void;
  onOpenProvider?: (id: string) => void;
  onOpenPlan?: (planId: string, title: string) => void;
  onQuickAction?: (text: string) => void;
  onUndoChange?: (changeLogId: string) => void;
  onSelectPlanForThread?: (planId: string, title: string) => void;
  errorText: string | null;
  errorCode?: string | null;
  onViewPlans?: () => void;
}) {
  // Used only to switch the streaming indicator to BuildingPlanLoader
  // (P06) specifically for the "Build my plan." turn -- every other
  // in-flight turn keeps the generic typing-dots indicator.
  const lastConvUserText = [...conversation.messages].reverse().find((m) => m.role === 'user')?.text || '';
  return (
    <>
      <style>{`@keyframes ventsAiDotFade{0%,80%,100%{opacity:.25;}40%{opacity:1;}}`}</style>
      <div style={{ height: 56, flexShrink: 0, borderBottom: '1px solid #1c1726', display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', background: '#0b0812' }}>
        <div onClick={onBack} role="button" aria-label="Back" style={{ fontSize: 19, color: '#e4d4ff', cursor: 'pointer' }}>←</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#f2eff6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conversation.title}</div>
          {conversation.planId && (
            <div style={{ fontSize: 10, color: '#d3b8ff', marginTop: 1 }}>◆ Plan thread · VENTS AI sees this plan</div>
          )}
        </div>
        <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, color: '#34d399', background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.3)', padding: '4px 8px', borderRadius: 6, flexShrink: 0 }}>
          ● LIVE DATA
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 16px 8px' }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          {conversation.messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
                <div style={{ maxWidth: '78%', background: 'rgba(163,92,255,.16)', border: '1px solid rgba(163,92,255,.3)', color: '#f0e8ff', borderRadius: '14px 14px 3px 14px', padding: '11px 14px', fontSize: 13, lineHeight: 1.5 }}>
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} style={{ display: 'flex', gap: 9, marginBottom: 16, alignItems: 'flex-start' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 }}>
                  <span style={{ fontSize: 11, color: '#fff' }}>✦</span>
                </div>
                <div style={{ maxWidth: '82%' }}>
                  {m.text && (
                    <div style={{ background: '#120e1a', border: '1px solid #221d2d', borderRadius: '3px 14px 14px 14px', padding: '11px 14px', fontSize: 13, lineHeight: 1.55, color: '#e4dfeb' }}>
                      {m.text}
                    </div>
                  )}
                  {m.cards && m.cards.length > 0 && (
                    <AssistantCards
                      cards={m.cards}
                      streaming={streaming}
                      onOpenEvent={onOpenEvent}
                      onOpenProvider={onOpenProvider}
                      onOpenPlan={onOpenPlan}
                      onQuickAction={onQuickAction}
                      onUndoChange={onUndoChange}
                      onSelectPlanForThread={onSelectPlanForThread}
                    />
                  )}
                  {m.confirmation && (
                    <ConfirmationCard
                      action={m.confirmation.action}
                      params={m.confirmation.params}
                      proposal={m.confirmation.proposal}
                      resolved={m.confirmation.resolved}
                      onConfirm={() => onConfirm(i, m.confirmation!)}
                      onCancel={() => onCancel(i)}
                    />
                  )}
                </div>
              </div>
            )
          )}

          {errorText && (
            lastConvUserText.trim().toLowerCase().startsWith('build my plan') ? (
              // S3-A "Plan generation failed" -- the exact failed turn is
              // still right there to retry (never a fabricated retry that
              // just dismisses the error); "Edit brief" is a real chat
              // turn, not a dead button, since the brief itself is only
              // ever a display-only card (no plans row exists yet on this
              // path) -- there is no separate persisted draft to edit.
              <div style={{ marginBottom: 14, padding: 18, borderRadius: 14, background: '#120e1a', border: '1px solid #221d2d', display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="ai-plan-build-error-card">
                <span style={{ fontSize: 17, fontWeight: 800 }}>Couldn't build your plan</span>
                <span style={{ fontSize: 13, color: '#a89db3', lineHeight: 1.5 }}>Nothing was lost — your brief details are still here. Nothing was charged or changed.</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span
                    onClick={() => onQuickAction?.("I'd like to edit the brief before building.")}
                    role="button"
                    data-testid="ai-plan-build-error-edit"
                    style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}
                  >
                    Edit brief
                  </span>
                  <span
                    onClick={() => onQuickAction?.(lastConvUserText)}
                    role="button"
                    data-testid="ai-plan-build-error-retry"
                    style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}
                  >
                    Try again
                  </span>
                </div>
              </div>
            ) : (
              // S3-D generic retryable error (existing pattern) -- Retry
              // re-sends the exact failed turn, same real pipeline, never
              // a button that only dismisses the banner.
              <div style={{ marginBottom: 14, fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 10, padding: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <span>{errorText}</span>
                {errorCode === 'AI_BETA_RESTRICTED' && onViewPlans ? (
                  <span onClick={onViewPlans} role="button" data-testid="vents-ai-error-view-plans" style={{ fontWeight: 700, color: '#d3b8ff', cursor: 'pointer', flexShrink: 0 }}>View Plans ›</span>
                ) : lastConvUserText && (
                  <span onClick={() => onQuickAction?.(lastConvUserText)} role="button" data-testid="ai-generic-error-retry" style={{ fontWeight: 700, color: '#fbbf24', cursor: 'pointer', flexShrink: 0 }}>Retry</span>
                )}
              </div>
            )
          )}

          {streaming && (
            lastConvUserText.trim().toLowerCase().startsWith('build my plan') ? (
              // P06's own frame shows the real event title ("Beach Wedding
              // plan"), not the conversation's own title -- which is just
              // titleFromText() of the user's first raw message (e.g. "I
              // want to plan a wedding plan", the same literal-text issue
              // already flagged and deferred for P27's thread header, but
              // fixable here specifically: the real title is sitting right
              // there in this same conversation's own preview_plan_brief
              // card, so there's no need to defer to SI-generated titles.
              <BuildingPlanLoader
                title={
                  ([...conversation.messages].reverse()
                    .flatMap((m) => m.cards || [])
                    .find((c) => c.type === 'preview_plan_brief')
                    ?.data as { title?: string } | undefined
                  )?.title || conversation.title
                }
              />
            ) : (
              <div style={{ display: 'flex', gap: 9, marginBottom: 16 }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: 11, color: '#fff' }}>✦</span>
                </div>
                <div style={{ background: '#120e1a', border: '1px solid #221d2d', borderRadius: '3px 14px 14px 14px', padding: '13px 16px', display: 'flex', gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8a7f97', animation: 'ventsAiDotFade 1.2s infinite' }} />
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8a7f97', animation: 'ventsAiDotFade 1.2s infinite .15s' }} />
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8a7f97', animation: 'ventsAiDotFade 1.2s infinite .3s' }} />
                </div>
              </div>
            )
          )}
        </div>
      </div>
      <div style={{ flexShrink: 0, padding: '10px 16px calc(16px + env(safe-area-inset-bottom, 0px))', background: '#0b0812', borderTop: '1px solid #1c1726' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', position: 'relative' }}>
          <input
            value={inputText}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            placeholder={conversation.planId ? `Ask VENTS AI about ${conversation.title}…` : 'Ask a follow-up…'}
            style={{ width: '100%', boxSizing: 'border-box', background: '#161020', border: '1px solid #2a2438', borderRadius: 12, padding: '12px 48px 12px 14px', fontSize: 13, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
          />
          <div onClick={onSend} style={{ position: 'absolute', right: 6, top: 6, width: 30, height: 30, borderRadius: 8, background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', fontSize: 13 }}>↑</div>
        </div>
      </div>
    </>
  );
}

// Right contextual panel (desktop/tablet), export lines ~270-284 -- context
// pulled from the most recent card with items/info in this conversation.
function RightPanel({ conversation }: { conversation: LocalConversation }) {
  const lastWithCards = [...conversation.messages].reverse().find((m) => m.role === 'assistant' && m.cards && m.cards.length > 0);
  if (!lastWithCards || !lastWithCards.cards) return null;
  const card = lastWithCards.cards.find((c) => c.source !== 'external' && c.source !== 'general');
  if (!card) return null;

  let title = '—';
  let subtitle = '';
  let rows: { k: string; v: string }[] = [];
  let cta = 'Open in VENTS';
  if (EVENT_CARD_TYPES.has(card.type)) {
    const e = Array.isArray(card.data) ? (card.data as any[])[0] : (card.data as any);
    if (!e) return null;
    title = e.title;
    subtitle = e.location || '';
    rows = [{ k: 'Date', v: e.event_date || '—' }, { k: 'Price', v: e.price != null ? `₦${e.price}` : '—' }];
    cta = 'View full event page';
  } else if (PROVIDER_CARD_TYPES.has(card.type)) {
    const p = Array.isArray(card.data) ? (card.data as any[])[0] : (card.data as any);
    if (!p) return null;
    title = p.business_name;
    subtitle = p.provider_category || p.category || '';
    rows = [{ k: 'Location', v: p.location || '—' }];
    cta = 'View provider profile';
  } else if (INFO_CARD_TYPES.has(card.type)) {
    const info = infoRowsFor(card.type, card.data);
    title = info.title;
    subtitle = 'Synced from live VENTS data';
    rows = info.rows;
  } else {
    return null;
  }

  return (
    <div style={{ width: 300, flexShrink: 0, borderLeft: '1px solid #211c2c', background: '#0d0a15', padding: 20, overflowY: 'auto' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, color: '#5e5470', marginBottom: 12 }}>DETAILS</div>
      <div style={{ height: 150, background: 'repeating-linear-gradient(45deg,#1c1726,#1c1726 8px,#181322 8px,#181322 16px)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: '#4a3f56' }}>
        DETAILS
      </div>
      <div style={{ fontSize: 15, fontWeight: 800, color: '#f5f2f8', marginTop: 14 }}>{title}</div>
      <div style={{ fontSize: 12, color: '#a89db3', marginTop: 6, lineHeight: 1.6 }}>{subtitle}</div>
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#c9c0d4', padding: '8px 0', borderTop: '1px solid #1c1726' }}>
          <div style={{ color: '#8a7f97' }}>{row.k}</div>
          <div style={{ color: '#e8e3ee', fontWeight: 600 }}>{row.v}</div>
        </div>
      ))}
      <div style={{ marginTop: 14, textAlign: 'center', padding: 10, borderRadius: 9, background: 'rgba(163,92,255,.14)', color: '#d3b8ff', fontSize: 12.5, fontWeight: 700 }}>{cta}</div>
    </div>
  );
}
