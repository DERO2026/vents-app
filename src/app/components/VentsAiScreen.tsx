import { useEffect, useRef, useState } from 'react';
import { sendVentsAiMessage, type VentsAiMessage } from '../../lib/ventsAi';
import { supabase } from '../../lib/supabase';

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

type PlanSummary = {
  id: string;
  title: string;
  event_type: string;
  status: string;
  event_date: string | null;
  city: string | null;
  total_kobo: number | null;
  currency: string;
  created_at: string;
};

type WorkspaceCategory = {
  id: string;
  key: string;
  label: string;
  allocated_kobo: number;
  is_priority: boolean;
  committed_kobo: number;
  paid_kobo: number;
  booked: boolean;
};

type WorkspaceTask = { id: string; title: string; offset_days: number | null; due_override: string | null; done_at: string | null };

type PlanWorkspaceData = {
  plan: { id: string; title: string; event_type: string; status: string; event_date: string | null; city: string | null; guests: number | null; total_kobo: number | null };
  categories: WorkspaceCategory[];
  tasks: WorkspaceTask[];
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
    .select('id, key, label, allocated_kobo, is_priority, sort')
    .eq('plan_id', planId)
    .order('sort');
  const categoryIds = (categories ?? []).map((c: any) => c.id);

  const { data: assignments } = categoryIds.length
    ? await supabase.from('plan_assignments').select('category_id, agreed_kobo, status').in('category_id', categoryIds)
    : { data: [] as any[] };
  const { data: tasks } = await supabase
    .from('plan_tasks')
    .select('id, title, offset_days, due_override, done_at')
    .eq('plan_id', planId);

  const byCategory = new Map<string, any[]>();
  for (const a of assignments ?? []) {
    const list = byCategory.get(a.category_id) ?? [];
    list.push(a);
    byCategory.set(a.category_id, list);
  }

  return {
    plan,
    categories: (categories ?? []).map((c: any) => {
      const active = (byCategory.get(c.id) ?? []).filter((a) => a.status === 'assigned' || a.status === 'booked');
      return {
        id: c.id,
        key: c.key,
        label: c.label,
        allocated_kobo: c.allocated_kobo ?? 0,
        is_priority: !!c.is_priority,
        committed_kobo: active.filter((a) => a.status === 'assigned').reduce((s, a) => s + (a.agreed_kobo ?? 0), 0),
        paid_kobo: active.filter((a) => a.status === 'booked').reduce((s, a) => s + (a.agreed_kobo ?? 0), 0),
        booked: active.some((a) => a.status === 'booked'),
      };
    }),
    tasks: tasks ?? [],
  };
}

// P01's "NEW · SI PLANNER" promo card -- shown on the Chat tab only when
// the user has no plan yet. Exact copy/colors/radii from P01.html. Type
// chips prefill AND immediately send ("Help me plan a {type}"), per that
// frame's own spec text ("Type chips prefill ... and send").
function NewPlannerPromoCard({ onPickType }: { onPickType: (text: string) => void }) {
  const TYPES = ['Wedding', 'Birthday', 'Conference', 'Something else'];
  return (
    <div style={{ padding: 16, borderRadius: 14, background: 'linear-gradient(160deg, rgba(163,92,255,.16), rgba(18,14,26,1) 70%)', border: '1px solid rgba(163,92,255,.35)', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
      <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '.16em', color: '#d3b8ff' }}>NEW · SI PLANNER</span>
      <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-.01em' }}>Plan an event with SI</span>
      <span style={{ fontSize: 13, color: '#c9c0d4', lineHeight: 1.5 }}>Tell SI what you're hosting. Get a budget, a team of VENTS providers, tasks and a timeline.</span>
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

  const tasksDone = data.tasks.filter((t) => !!t.done_at).length;
  const tasksTotal = data.tasks.length;
  const tasksPct = tasksTotal > 0 ? tasksDone / tasksTotal : 0;
  const assignedCategories = data.categories.filter((c) => c.committed_kobo > 0 || c.paid_kobo > 0 || c.booked).length;
  const categoriesTotal = data.categories.length;
  const teamPct = categoriesTotal > 0 ? assignedCategories / categoriesTotal : 0;
  const totalAllocated = data.categories.reduce((s, c) => s + c.allocated_kobo, 0);
  const totalCommittedOrPaid = data.categories.reduce((s, c) => s + c.committed_kobo + c.paid_kobo, 0);
  const budgetPct = totalAllocated > 0 ? Math.min(1, totalCommittedOrPaid / totalAllocated) : 0;
  const readiness = Math.round((tasksPct * 0.5 + teamPct * 0.35 + budgetPct * 0.15) * 100);
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
        <span onClick={onAskSi} role="button" style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: '#1c1726', border: '1px solid #2c2438', fontSize: 12.5, fontWeight: 700, color: '#c9c0d4', cursor: 'pointer' }}>Ask SI</span>
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
}: {
  planId: string;
  onBack: () => void;
  onAskSi: (title: string) => void;
  onComposerSend: (text: string) => void;
}) {
  const [tab, setTab] = useState<'overview' | 'budget' | 'team' | 'tasks' | 'timeline'>('overview');
  const [data, setData] = useState<PlanWorkspaceData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composerText, setComposerText] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setLoadError(null);
    fetchPlanWorkspace(planId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setLoadError(e?.message || 'Could not load this plan.'); });
    return () => { cancelled = true; };
  }, [planId]);

  const TABS: { id: typeof tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'budget', label: 'Budget' },
    { id: 'team', label: 'Team' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'timeline', label: 'Timeline' },
  ];

  const composerPlaceholder = tab === 'budget' ? '"Move ₦300k from décor to photos"' : `Ask SI about ${data?.plan.title || 'this plan'}…`;

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
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>
              {data?.plan.title || 'Plan'} <span style={{ fontSize: 13, color: '#d3b8ff' }}>▾</span>
            </div>
            <div style={{ fontSize: 11.5, color: '#a89db3' }}>
              {data?.plan.event_date ? data.plan.event_date : ''}{data?.plan.city ? ` · ${data.plan.city}` : ''}{data?.plan.guests ? ` · ${data.plan.guests} guests` : ''}
            </div>
          </div>
          <span style={{ width: 34, height: 34, borderRadius: 10, background: '#1c1726', border: '1px solid #2c2438', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c9c0d4' }}>⋯</span>
        </div>
        <div style={{ display: 'flex', gap: 20, fontSize: 13, fontWeight: 600, color: '#8a7f97' }}>
          {TABS.map((t) => (
            <span
              key={t.id}
              onClick={() => setTab(t.id)}
              data-testid={`workspace-tab-${t.id}`}
              style={{ padding: '10px 0', cursor: 'pointer', color: tab === t.id ? '#f2eff6' : '#8a7f97', borderBottom: tab === t.id ? '2px solid #a35cff' : 'none' }}
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
        ) : tab === 'overview' ? (
          <WorkspaceOverviewTab data={data} onOpenBudget={() => setTab('budget')} />
        ) : tab === 'budget' ? (
          <WorkspaceBudgetTab data={data} />
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
  const tasksPct = tasksTotal > 0 ? tasksDone / tasksTotal : 0;

  const assignedCategories = data.categories.filter((c) => c.committed_kobo > 0 || c.paid_kobo > 0 || c.booked).length;
  const categoriesTotal = data.categories.length;
  const teamPct = categoriesTotal > 0 ? assignedCategories / categoriesTotal : 0;

  const totalAllocated = data.categories.reduce((s, c) => s + c.allocated_kobo, 0);
  const totalCommittedOrPaid = data.categories.reduce((s, c) => s + c.committed_kobo + c.paid_kobo, 0);
  const budgetPct = totalAllocated > 0 ? Math.min(1, totalCommittedOrPaid / totalAllocated) : 0;

  const readiness = Math.round((tasksPct * 0.5 + teamPct * 0.35 + budgetPct * 0.15) * 100);

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
          <span style={{ fontSize: 12, color: '#a89db3' }}>left to commit of {naira(totalBudget)}</span>
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
          upNext.map((t, i) => (
            <div key={t.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '11px 0', borderBottom: i < upNext.length - 1 ? '1px solid #1c1726' : 'none' }}>
              <span style={{ width: 20, height: 20, borderRadius: 6, border: '1.5px solid #4a3f56', flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 14 }}>{t.title}</span>
              <span style={{ fontSize: 11.5, color: '#a89db3' }}>{t.due_override || (t.offset_days != null ? `T-${t.offset_days}d` : '')}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// Budget tab (P08). Rows sorted per P08's own spec text: over-budget first,
// then committed, then estimates. "+N more" is not implemented here --
// all categories are shown (an honest gap vs. the mockup's truncation,
// not a fabricated count).
function WorkspaceBudgetTab({ data }: { data: PlanWorkspaceData }) {
  const totalBudget = (data.plan.total_kobo ?? 0) / 100;
  const totalCommitted = data.categories.reduce((s, c) => s + c.committed_kobo, 0) / 100;
  const totalPaid = data.categories.reduce((s, c) => s + c.paid_kobo, 0) / 100;
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

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 12, color: '#8a7f97' }}>Total budget</span>
          <span style={{ fontSize: 12, color: '#d3b8ff', cursor: 'pointer' }}>Edit</span>
        </div>
        <span style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.02em' }}>{naira(totalBudget)}</span>
        <BudgetBar estimated={totalEstimated} committed={totalCommitted} paid={totalPaid} total={totalBudget || null} />
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
            <div key={c.id} style={{ padding: '9px 0', borderBottom: i < sorted.length - 1 ? '1px solid #1c1726' : 'none', display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{c.label} {c.is_priority && <span style={{ fontSize: 10, color: '#d3b8ff' }}>★</span>}</span>
                <span style={{ fontSize: 13 }}>
                  {s === 'estimate' ? (
                    <span style={{ color: '#c9c0d4' }}>≈ {naira(allocated)}</span>
                  ) : (
                    <><b>{naira(spent)}</b> <span style={{ color: '#8a7f97' }}>/ {naira(allocated)}</span></>
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

// BudgetBar: three segments that never share a style (§12 "Budget interaction").
function BudgetBar({ estimated, committed, paid, total }: { estimated: number; committed: number; paid: number; total: number | null }) {
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
      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 10, color: '#8a7f97' }}>
        <span><span style={{ color: '#34d399' }}>●</span> Paid {naira(paid)}</span>
        <span><span style={{ color: '#a35cff' }}>●</span> Committed {naira(committed)}</span>
        <span>◆ Estimate · not a quote {naira(estimated)}</span>
      </div>
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
  onApply,
  onUndo,
}: {
  data: any;
  applied: boolean;
  onApply?: () => void;
  onUndo?: (changeLogId: string) => void;
}) {
  const changes: any[] = Array.isArray(data?.proposed_changes) ? data.proposed_changes : [];
  const [undone, setUndone] = useState(false);
  return (
    <div style={{ marginTop: 10, background: 'rgba(163,92,255,.08)', border: '1px solid rgba(163,92,255,.35)', borderRadius: 12, padding: 14 }} data-testid="ai-plan-update-card">
      <span style={{ fontSize: 9.5, fontWeight: 700, color: '#d3b8ff', background: 'rgba(163,92,255,.15)', padding: '3px 7px', borderRadius: 6 }}>
        {applied ? (undone ? 'UNDONE' : 'PLAN UPDATED') : 'SUGGESTED CHANGE'}
      </span>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {changes.map((c, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#c9c0d4' }}>
            <span>{c.label || c.key || c.category}</span>
            <span>
              <span style={{ color: '#786d87', textDecoration: applied ? 'line-through' : 'none' }}>{naira(c.before_naira)}</span>
              {' → '}
              <span style={{ color: '#f0edf5', fontWeight: 700 }}>{naira(c.after_naira)}</span>
            </span>
          </div>
        ))}
      </div>
      {!applied && onApply && (
        <div
          onClick={onApply}
          data-testid="ai-plan-update-apply"
          style={{ marginTop: 12, textAlign: 'center', padding: 9, borderRadius: 8, background: GRADIENT, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
        >
          Apply
        </div>
      )}
      {applied && !undone && data?.change_log_id && onUndo && (
        <div
          onClick={() => {
            setUndone(true);
            onUndo(data.change_log_id);
          }}
          data-testid="ai-plan-update-undo"
          style={{ marginTop: 12, textAlign: 'center', padding: 9, borderRadius: 8, background: '#1c1726', border: '1px solid #2c2438', color: '#c9c0d4', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
        >
          Undo
        </div>
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
        <span onClick={onAccept} role="button" style={{ flex: 1.4, textAlign: 'center', padding: 10, borderRadius: 9, background: GRADIENT, fontSize: 12.5, fontWeight: 700, color: '#fff', cursor: 'pointer' }}>Plan this event with SI</span>
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
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 14px', borderRadius: 12, background: '#120e1a', border: '1px solid #2c2438', cursor: 'pointer' }}
            >
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{o.label}</span>
              {o.hint && <span style={{ fontSize: 12, color: '#8a7f97' }}>{o.hint}</span>}
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
function PlanBriefCard({ data, onBuild }: { data: any; onBuild?: () => void }) {
  const [built, setBuilt] = useState(false);
  if (built) return null;
  const rows: { label: string; value: string; amber?: boolean }[] = [
    { label: 'Date', value: data?.event_date || 'Not set yet' },
    { label: 'Location', value: [data?.city, data?.setting].filter(Boolean).join(' · ') || 'Not set yet' },
    { label: 'Guests', value: typeof data?.guests === 'number' ? String(data.guests) : 'Not set yet' },
    { label: 'Venue', value: data?.venue_status || 'Not booked yet', amber: !data?.venue_status || /not booked/i.test(data.venue_status) },
    { label: 'Total budget', value: typeof data?.total_budget_naira === 'number' ? naira(data.total_budget_naira) : 'Not set yet' },
  ];
  function handleBuild() {
    setBuilt(true);
    onBuild?.();
  }
  return (
    <div style={{ marginTop: 10, background: '#120e1a', border: '1px solid #221d2d', borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }} data-testid="ai-plan-brief-card">
      <div>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-.02em' }}>{data?.title || 'Your plan'}</div>
        {data?.host_names && <div style={{ fontSize: 13, color: '#a89db3', marginTop: 4 }}>{data.host_names}</div>}
      </div>
      <div style={{ borderRadius: 12, background: '#16111f', border: '1px solid #221d2d', overflow: 'hidden' }}>
        {rows.map((r, i) => (
          <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 13px', borderTop: i > 0 ? '1px solid #1c1726' : 'none' }}>
            <span style={{ fontSize: 12.5, color: '#8a7f97' }}>{r.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: r.amber ? '#fbbf24' : '#f0edf5' }}>{r.value}</span>
          </div>
        ))}
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
    </div>
  );
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
  onOpenEvent,
  onOpenProvider,
  onOpenPlan,
  onQuickAction,
  onUndoChange,
}: {
  cards: BackendCard[];
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
              onApply={() => onQuickAction?.('Apply that change.')}
            />
          );
        }
        if (card.type === 'apply_plan_update') {
          return <PlanUpdateCard key={i} data={card.data} applied onUndo={onUndoChange} />;
        }
        if (card.type === 'recommend_providers') {
          const providers = Array.isArray(card.data) ? card.data : [];
          if (!providers.length) {
            // P15 "No suitable provider" -- an honest empty state, not
            // silence, when the filters (category/location/max price)
            // matched nothing real.
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
          return <PlanOfferCard key={i} data={card.data} onAccept={() => onQuickAction?.('Yes, plan this event with SI.')} />;
        }
        if (card.type === 'ask_plan_question') {
          return <PlanQuestionCard key={i} data={card.data} onAnswer={(text) => onQuickAction?.(text)} />;
        }
        if (card.type === 'preview_plan_brief') {
          return <PlanBriefCard key={i} data={card.data} onBuild={() => onQuickAction?.('Build my plan.')} />;
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
}: {
  onClose: () => void;
  onOpenEvent?: (id: string) => void;
  onOpenProvider?: (id: string) => void;
  // Right contextual panel is desktop/tablet-only, matching the export's
  // `showRightPanel = !isMobile && !!rightPanel`. Reuses a plain
  // window.innerWidth check since this repo has no existing responsive
  // breakpoint helper to reuse (grep found none).
  isDesktop?: boolean;
}) {
  const [conversations, setConversations] = useState<LocalConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Dedicated Plan Workspace screen (P07/P08) -- distinct destination from
  // a plan's chat thread (P24: "Ask SI opens the plan thread; Open plan
  // opens Overview"). null means neither workspace tab is open.
  const [workspacePlanId, setWorkspacePlanId] = useState<string | null>(null);
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
    targetConvId?: string
  ) {
    const q = text.trim();
    if (!q || streaming) return;
    setInputText('');
    setErrorText(null);

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
      planId = existing?.planId;
      convId = resolvedId || '';
      if (!convId) {
        convId = `c${nextId.current++}`;
        setActiveId(convId);
        const newConv: LocalConversation = { id: convId, title: titleFromText(q), messages: [{ role: 'user', text: q }], updatedAt: Date.now() };
        setConversations((prev) => [newConv, ...prev]);
      } else {
        const targetId = convId;
        setConversations((prev) =>
          prev.map((c) => (c.id === targetId ? { ...c, messages: [...c.messages, { role: 'user', text: q }], updatedAt: Date.now() } : c))
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
      setErrorText(e?.message || "Something went wrong reaching VENTS SI. Nothing was charged or changed.");
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
                errorText={errorText}
              />
            )}
          </div>
          {isDesktop && inConversation && <RightPanel conversation={active!} />}
        </div>
      </div>
    </div>
  );
}

// SI's two rooms (§01 IA: "SI gains a second room. Nothing else moves --
// Chat (today's HomeView/ConversationView) and Plans (new)"). Per P01/P24's
// own spec text, plan threads now appear inline in RECENT CONVERSATIONS
// (marked with a ◆), and the Plans tab shows a live count badge -- neither
// is filtered out or static.
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
}) {
  const [room, setRoom] = useState<'chat' | 'plans'>('chat');
  // Lifted up from PlansListView so both the Plans-tab badge/list and the
  // Chat tab's promo/"Continue planning" card (P01/P24) can read the same
  // real `plans` rows without two independent, possibly-inconsistent fetches.
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('plans')
        .select('id, title, event_type, status, event_date, city, total_kobo, currency, created_at')
        .order('created_at', { ascending: false });
      if (cancelled) return;
      if (error) {
        setPlansError(error.message);
        setPlans([]);
        return;
      }
      setPlans((data as PlanSummary[]) || []);
    })();
    return () => { cancelled = true; };
  }, []);

  // Recency-sorted, un-filtered -- a plan's pinned thread shows up here
  // like any other conversation, just marked with a ◆ (P24's own spec).
  const recentConversations = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '18px 16px 30px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: 15, color: '#fff' }}>✦</span>
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, color: '#f5f2f8' }}>VENTS SI</div>
          </div>
          <div onClick={onClose} style={{ fontSize: 19, color: '#a89db3', cursor: 'pointer', padding: 4 }} aria-label="Close VENTS SI" role="button">✕</div>
        </div>
        <div style={{ fontSize: 13, color: '#a89db3', margin: '6px 0 16px' }}>
          Ask about events, services, tickets, wallet or bookings — or plan a whole event, step by step.
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
            <div style={{ position: 'relative', marginBottom: 24 }}>
              <input
                value={inputText}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onSend()}
                placeholder="Ask VENTS SI anything…"
                style={{ width: '100%', boxSizing: 'border-box', background: '#120e1a', border: '1px solid #2a2438', borderRadius: 14, padding: '15px 52px 15px 16px', fontSize: 13.5, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
              />
              <div onClick={onSend} style={{ position: 'absolute', right: 8, top: 8, width: 36, height: 36, borderRadius: 10, background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', fontSize: 14 }}>↑</div>
            </div>

            {errorText && (
              <div style={{ marginBottom: 18, fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 10, padding: 10 }}>
                {errorText}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginBottom: 26 }}>
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

            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: '#5e5470', marginBottom: 10 }}>RECENT CONVERSATIONS</div>
            {recentConversations.length === 0 ? (
              <div style={{ fontSize: 12, color: '#5e5470' }}>No conversations yet this session.</div>
            ) : (
              recentConversations.map((c) => {
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
              })
            )}
          </>
        ) : (
          <PlansListView plans={plans} plansError={plansError} onOpenPlan={onOpenPlan} onOpenWorkspace={onOpenWorkspace} onStartNewPlan={(prompt) => { setRoom('chat'); onInputChange(prompt); }} />
        )}
      </div>
    </div>
  );
}

// Plans room (P25-style list). `plans`/`plansError` are lifted up into
// HomeView (same `plans` table read via the user's own RLS-scoped client)
// so the Chat tab's promo/Continue-planning card and this list never
// disagree from two independent fetches.
function PlansListView({
  plans,
  plansError,
  onOpenPlan,
  onOpenWorkspace,
  onStartNewPlan,
}: {
  plans: PlanSummary[] | null;
  plansError: string | null;
  onOpenPlan: (planId: string, title: string) => void;
  onOpenWorkspace: (planId: string) => void;
  onStartNewPlan: (prompt: string) => void;
}) {
  const loadError = plansError;
  return (
    <div>
      <div
        onClick={() => onStartNewPlan("I'm planning an event.")}
        data-testid="si-new-plan"
        style={{ cursor: 'pointer', marginBottom: 16, padding: '13px 14px', borderRadius: 12, background: 'rgba(163,92,255,.12)', border: '1px solid rgba(163,92,255,.35)', color: '#d3b8ff', fontSize: 13, fontWeight: 700, textAlign: 'center' }}
      >
        + New Plan
      </div>

      {plans === null ? (
        // S1 Loading.
        <div style={{ fontSize: 12, color: '#5e5470', textAlign: 'center', padding: 20 }}>Loading your plans…</div>
      ) : loadError ? (
        // S3 Error.
        <div style={{ fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 10, padding: 12 }}>
          Couldn't load your plans — {loadError}
        </div>
      ) : plans.length === 0 ? (
        // S2 Empty.
        <div style={{ fontSize: 12.5, color: '#786d87', textAlign: 'center', padding: '20px 10px', lineHeight: 1.6 }}>
          No plans yet. Tell SI what you're planning — "Beach wedding, 120 guests, Lagos, ₦8m" — and it'll start one for you.
        </div>
      ) : (
        plans.map((p) => (
          <div
            key={p.id}
            onClick={() => onOpenPlan(p.id, p.title)}
            style={{ cursor: 'pointer', background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: '13px 14px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#e8e3ee' }}>{p.title}</div>
              <div style={{ fontSize: 11, color: '#786d87', marginTop: 2 }}>
                {titleCase(p.event_type)}{p.city ? ` · ${p.city}` : ''}{p.event_date ? ` · ${p.event_date}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, marginLeft: 10 }}>
              <span style={{ fontSize: 9.5, fontWeight: 700, padding: '3px 7px', borderRadius: 6, background: p.status === 'draft' ? 'rgba(251,191,36,.1)' : 'rgba(163,92,255,.14)', color: p.status === 'draft' ? '#fbbf24' : '#d3b8ff' }}>
                {p.status.toUpperCase()}
              </span>
              <span
                onClick={(e) => { e.stopPropagation(); onOpenWorkspace(p.id); }}
                role="button"
                data-testid="si-plan-open-workspace"
                style={{ fontSize: 11, fontWeight: 700, color: '#d3b8ff', cursor: 'pointer' }}
              >
                Open ›
              </span>
            </div>
          </div>
        ))
      )}
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
  errorText,
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
  errorText: string | null;
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
            <div style={{ fontSize: 10, color: '#d3b8ff', marginTop: 1 }}>◆ Plan thread · SI sees this plan</div>
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
                      onOpenEvent={onOpenEvent}
                      onOpenProvider={onOpenProvider}
                      onOpenPlan={onOpenPlan}
                      onQuickAction={onQuickAction}
                      onUndoChange={onUndoChange}
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
            <div style={{ marginBottom: 14, fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 10, padding: 10 }}>
              {errorText}
            </div>
          )}

          {streaming && (
            lastConvUserText.trim().toLowerCase() === 'build my plan.' ? (
              <BuildingPlanLoader title={conversation.title} />
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
            placeholder={conversation.planId ? `Ask SI about ${conversation.title}…` : 'Ask a follow-up…'}
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
