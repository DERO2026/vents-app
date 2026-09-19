import { useRef, useState } from 'react';
import { sendVentsAiMessage, type VentsAiMessage } from '../../lib/ventsAi';

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
};

// SUGGESTED prompt chips -- export's `suggestedPrompts` derived from SCEN's
// icon+prompt pairs (lines ~294-347, ~415).
const SUGGESTED_PROMPTS: { icon: string; label: string }[] = [
  { icon: '🎫', label: 'Find concerts in Abuja this weekend' },
  { icon: '💐', label: 'I need a wedding decorator under ₦300k in Lagos' },
  { icon: '🎟️', label: 'Where is my ticket for my next event?' },
  { icon: '💳', label: 'Has my payment gone through?' },
  { icon: '👛', label: 'How much is in my VENTS Wallet?' },
  { icon: '↩️', label: 'Can I get a refund on a ticket?' },
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
// Card dispatch -- routes a backend card to the right renderer by `type`.
// ---------------------------------------------------------------------

const EVENT_CARD_TYPES = new Set(['search_events', 'get_event']);
const PROVIDER_CARD_TYPES = new Set(['search_services_or_providers', 'get_provider_profile']);
const INFO_CARD_TYPES = new Set(['get_my_tickets', 'get_my_bookings', 'get_payment_status', 'get_wallet_balance', 'get_vents_cents_balance']);

function AssistantCards({
  cards,
  onOpenEvent,
  onOpenProvider,
}: {
  cards: BackendCard[];
  onOpenEvent?: (id: string) => void;
  onOpenProvider?: (id: string) => void;
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
  const nextId = useRef(1);

  const active = conversations.find((c) => c.id === activeId) || null;

  function titleFromText(text: string): string {
    const t = text.trim();
    return t.length > 36 ? `${t.slice(0, 36)}…` : t || 'New chat';
  }

  async function sendText(text: string) {
    const q = text.trim();
    if (!q || streaming) return;
    setInputText('');
    setErrorText(null);

    // Compute the target conversation and its prior history synchronously
    // from the current `conversations` state (available directly, since
    // this runs from an event handler) rather than inside a setState
    // updater -- React does not guarantee an updater function runs
    // synchronously before this async function's next line, so mutating a
    // closed-over `convId` variable from inside one is not reliable here.
    const existing = activeId ? conversations.find((c) => c.id === activeId) : undefined;
    const history: ChatMessage[] = existing ? existing.messages : [];
    let convId = activeId;
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

    setStreaming(true);
    try {
      const apiMessages: VentsAiMessage[] = [...history, { role: 'user' as const, text: q }].map((m) => ({ role: m.role, content: m.text }));
      const res = await sendVentsAiMessage(apiMessages);
      appendAssistantResponse(convId, res);
    } catch (e: any) {
      // Per the export's STATE_CARDS tone ("Something went wrong … Nothing
      // was charged or changed") -- adapted copy, no literal states screen.
      setErrorText(e?.message || "Something went wrong reaching VENTS AI. Nothing was charged or changed.");
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

  const inConversation = !!active;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: '#0a0810', color: '#f2eff6', fontFamily: "'Inter',system-ui,sans-serif", display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'flex', minWidth: 0, position: 'relative' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
            {!inConversation ? (
              <HomeView
                inputText={inputText}
                onInputChange={setInputText}
                onSend={() => sendText(inputText)}
                onClose={onClose}
                conversations={conversations}
                onOpenConversation={(id) => setActiveId(id)}
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

function HomeView({
  inputText,
  onInputChange,
  onSend,
  onClose,
  conversations,
  onOpenConversation,
  errorText,
}: {
  inputText: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
  conversations: LocalConversation[];
  onOpenConversation: (id: string) => void;
  errorText: string | null;
}) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '18px 16px 30px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: 15, color: '#fff' }}>✦</span>
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, color: '#f5f2f8' }}>VENTS AI</div>
          </div>
          <div onClick={onClose} style={{ fontSize: 19, color: '#a89db3', cursor: 'pointer', padding: 4 }} aria-label="Close VENTS AI" role="button">✕</div>
        </div>
        <div style={{ fontSize: 13, color: '#a89db3', margin: '6px 0 18px' }}>
          Ask about events, services, tickets, wallet or bookings — answered from real VENTS data.
        </div>

        <div style={{ position: 'relative', marginBottom: 24 }}>
          <input
            value={inputText}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            placeholder="Ask VENTS AI anything…"
            style={{ width: '100%', boxSizing: 'border-box', background: '#120e1a', border: '1px solid #2a2438', borderRadius: 14, padding: '15px 52px 15px 16px', fontSize: 13.5, color: '#e8e3ee', outline: 'none', fontFamily: 'inherit' }}
          />
          <div onClick={onSend} style={{ position: 'absolute', right: 8, top: 8, width: 36, height: 36, borderRadius: 10, background: GRADIENT, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', fontSize: 14 }}>↑</div>
        </div>

        {errorText && (
          <div style={{ marginBottom: 18, fontSize: 12, color: '#fbbf24', background: 'rgba(251,191,36,.08)', border: '1px solid rgba(251,191,36,.3)', borderRadius: 10, padding: 10 }}>
            {errorText}
          </div>
        )}

        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: '#5e5470', marginBottom: 10 }}>SUGGESTED</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginBottom: 26 }}>
          {SUGGESTED_PROMPTS.map((p, i) => (
            <div
              key={i}
              onClick={() => onInputChange(p.label)}
              style={{ cursor: 'pointer', background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: '13px 14px', fontSize: 12.5, color: '#d6cfe0', display: 'flex', alignItems: 'center', gap: 10 }}
            >
              <span style={{ fontSize: 14, flexShrink: 0 }}>{p.icon}</span>
              {p.label}
            </div>
          ))}
        </div>

        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: '#5e5470', marginBottom: 10 }}>RECENT CONVERSATIONS</div>
        {conversations.length === 0 ? (
          <div style={{ fontSize: 12, color: '#5e5470' }}>No conversations yet this session.</div>
        ) : (
          conversations.map((c) => {
            const lastAi = [...c.messages].reverse().find((m) => m.role === 'assistant');
            return (
              <div
                key={c.id}
                onClick={() => onOpenConversation(c.id)}
                style={{ cursor: 'pointer', background: '#120e1a', border: '1px solid #221d2d', borderRadius: 12, padding: '13px 14px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#e8e3ee' }}>{c.title}</div>
                  <div style={{ fontSize: 11, color: '#786d87', marginTop: 2 }}>{lastAi ? lastAi.text.slice(0, 42) : ''}</div>
                </div>
                <div style={{ fontSize: 10.5, color: '#5e5470', flexShrink: 0, marginLeft: 10 }}>{new Date(c.updatedAt).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' })}</div>
              </div>
            );
          })
        )}
      </div>
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
  errorText: string | null;
}) {
  return (
    <>
      <style>{`@keyframes ventsAiDotFade{0%,80%,100%{opacity:.25;}40%{opacity:1;}}`}</style>
      <div style={{ height: 56, flexShrink: 0, borderBottom: '1px solid #1c1726', display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', background: '#0b0812' }}>
        <div onClick={onBack} role="button" aria-label="Back" style={{ fontSize: 19, color: '#e4d4ff', cursor: 'pointer' }}>←</div>
        <div style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: '#f2eff6' }}>{conversation.title}</div>
        <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, color: '#34d399', background: 'rgba(52,211,153,.1)', border: '1px solid rgba(52,211,153,.3)', padding: '4px 8px', borderRadius: 6 }}>
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
                  {m.cards && m.cards.length > 0 && <AssistantCards cards={m.cards} onOpenEvent={onOpenEvent} onOpenProvider={onOpenProvider} />}
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
          )}
        </div>
      </div>
      <div style={{ flexShrink: 0, padding: '10px 16px 16px', background: '#0b0812', borderTop: '1px solid #1c1726' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', position: 'relative' }}>
          <input
            value={inputText}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            placeholder="Ask a follow-up…"
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
