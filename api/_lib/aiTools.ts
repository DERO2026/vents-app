import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// VENTS AI tool schemas + executors. Every executor here calls the EXACT
// same RPC/table query the app's own screens already use (see the
// per-function comments below for which screen) -- this file adds no new
// business logic, no new RLS bypass, and no service-role client. Every
// Supabase client used by an executor is built from the calling user's OWN
// forwarded access token via `buildUserSupabaseClient`, with the anon key --
// reads and writes are exactly as RLS-scoped as if the user had called them
// from the app directly.
//
// Phase 1 tools (search_events, get_event, search_services_or_providers,
// get_provider_profile, get_my_tickets, get_my_bookings, get_payment_status,
// get_wallet_balance, get_vents_cents_balance) are read-only and are wired to
// auto-execute inside api/ai-assistant.ts's tool-use loop.
//
// Phase 2 tools (start_ticket_transfer, request_ticket_refund,
// start_service_booking, create_report) are mutating/consequential.
// api/ai-assistant.ts never calls their real executors from inside the
// model's tool-use loop -- it calls buildProposal() below, mints a
// confirmation token (api/_lib/aiConfirmation.ts), and returns a
// `{proposal, requiresConfirmation: true}` response to the client instead.
// The real executors below (executeStartTicketTransfer, etc.) only run
// after the client re-POSTs `confirmedAction` with a verified token,
// entirely outside the model loop.
//
// cancel_service_booking (migration 0077) is deliberately NOT exposed here
// at all -- its own migration header marks it not-yet-deployed to
// production, so it is omitted rather than defined-but-disabled.

export function buildUserSupabaseClient(accessToken: string): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Supabase environment not configured on server');
  }
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------
// Anthropic tool-use JSON schemas
// ---------------------------------------------------------------------

export const READ_ONLY_TOOLS = [
  {
    name: 'search_events',
    description:
      'Search live VENTS events by keyword (title/description/category/organizer). Use this for any question about what events exist, are happening, or match a description -- never guess or fabricate event names, dates, prices, or availability.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search query, e.g. "afrobeats lagos" or "comedy show this weekend".' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_event',
    description: 'Fetch full live details for one specific VENTS event by its id, including current price and ticket types.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The event UUID.' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'search_services_or_providers',
    description:
      'Search live VENTS service providers and their bookable services by keyword and/or category (e.g. photographers, makeup artists, caterers, DJs, decorators). Never fabricate provider names, prices, or availability.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search query, e.g. "makeup artist ikeja".' },
        category: { type: 'string', description: 'Optional exact category to filter by, if the user named one.' },
        limit: { type: 'number', description: 'Max results to return (default 10, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_provider_profile',
    description: 'Fetch full live profile details for one specific VENTS service provider by their provider id.',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: { type: 'string', description: 'The service provider UUID.' },
      },
      required: ['provider_id'],
    },
  },
  {
    name: 'get_my_tickets',
    description: "List the current user's own live VENTS tickets (their purchases), most recent first.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'get_my_bookings',
    description: "List the current user's own live VENTS service bookings (as a customer), most recent first.",
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'get_payment_status',
    description: "Look up the live payment status of a specific ticket or service booking the current user owns.",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['ticket', 'booking'], description: 'Whether the id refers to a ticket or a service booking.' },
        id: { type: 'string', description: 'The ticket or booking UUID.' },
      },
      required: ['type', 'id'],
    },
  },
  {
    name: 'get_wallet_balance',
    description: "Get the current user's live VENTS wallet balance.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_vents_cents_balance',
    description: "Get the current user's live VENTS Cents (VC) spendable balance.",
    input_schema: { type: 'object', properties: {} },
  },
] as const;

export const PROPOSAL_TOOLS = [
  {
    name: 'start_ticket_transfer',
    description:
      "Propose transferring one of the current user's tickets to another VENTS user by email or username. This only PROPOSES the transfer -- it never executes it. The user must explicitly confirm before it happens.",
    input_schema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket UUID to transfer.' },
        recipient_identifier: { type: 'string', description: "The recipient's email address or username." },
      },
      required: ['ticket_id', 'recipient_identifier'],
    },
  },
  {
    name: 'request_ticket_refund',
    description:
      "Propose refunding one of the current user's tickets, with a reason. This only PROPOSES the refund -- it never executes it. The user must explicitly confirm before it happens.",
    input_schema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'string', description: 'The ticket UUID to refund.' },
        reason: { type: 'string', description: 'Why the user wants a refund.' },
      },
      required: ['ticket_id', 'reason'],
    },
  },
  {
    name: 'start_service_booking',
    description:
      'Propose booking one or more services from a VENTS service provider. This only PROPOSES the booking -- it never executes it or charges anything. The user must explicitly confirm before it happens.',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: { type: 'string', description: 'The service provider UUID.' },
        items: {
          type: 'array',
          description: 'The services being booked.',
          items: {
            type: 'object',
            properties: {
              service_id: { type: 'string' },
              quantity: { type: 'number' },
            },
            required: ['service_id', 'quantity'],
          },
        },
        scheduled_date: { type: 'string', description: 'YYYY-MM-DD, optional.' },
        scheduled_time: { type: 'string', description: 'HH:MM 24hr, optional.' },
        location: { type: 'string', description: 'Optional service location.' },
        notes: { type: 'string', description: 'Optional notes for the provider.' },
      },
      required: ['provider_id', 'items'],
    },
  },
  {
    name: 'create_report',
    description:
      'Propose filing a report against an event, provider, user, or other VENTS content. This only PROPOSES the report -- it never files it. The user must explicitly confirm before it happens.',
    input_schema: {
      type: 'object',
      properties: {
        target_type: { type: 'string', description: 'What is being reported, e.g. "event", "service_provider", "user".' },
        target_id: { type: 'string', description: 'The UUID of the thing being reported.' },
        reason: { type: 'string', description: 'The report reason/category.' },
        details: { type: 'string', description: 'Optional extra details.' },
      },
      required: ['target_type', 'target_id', 'reason'],
    },
  },
] as const;

export const ALL_TOOLS = [...READ_ONLY_TOOLS, ...PROPOSAL_TOOLS];

export const READ_ONLY_TOOL_NAMES = new Set(READ_ONLY_TOOLS.map((t) => t.name));
export const PROPOSAL_TOOL_NAMES = new Set(PROPOSAL_TOOLS.map((t) => t.name));

// Anthropic's native server-side web search tool. Bounded max_uses per turn
// so a single conversation round can't run up unbounded search cost -- see
// api/ai-assistant.ts for how it's wired into the tools array and how its
// tool_use/web_search_tool_result blocks are excluded from the manual
// READ_ONLY/PROPOSAL dispatch below (it runs on Anthropic's infrastructure,
// never through executeReadOnlyTool).
export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const WEB_SEARCH_MAX_USES = 3;
export const WEB_SEARCH_TOOL = {
  type: 'web_search_20260209',
  name: WEB_SEARCH_TOOL_NAME,
  max_uses: WEB_SEARCH_MAX_USES,
} as const;

// The `source` a structured result card came from, for the (future) UI to
// distinguish live VENTS data from externally-sourced or general-knowledge
// content. Defaults to 'vents' for every existing card producer below since
// all of them wrap a VENTS-database read.
export type CardSource = 'vents' | 'external' | 'general';

function clampLimit(limit: unknown, fallback = 10, max = 50): number {
  const n = typeof limit === 'number' && isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(Math.max(n, 1), max);
}

// ---------------------------------------------------------------------
// Phase 1 read-only executors
// ---------------------------------------------------------------------

// Mirrors HomeScreen.tsx's own search_events_fuzzy call.
export async function executeSearchEvents(client: SupabaseClient, input: any) {
  const limit = clampLimit(input?.limit);
  const { data, error } = await client.rpc('search_events_fuzzy', {
    p_query: String(input?.query ?? ''),
    p_limit: limit,
    p_offset: 0,
  });
  if (error) throw new Error(error.message);
  return (data ?? []).map((e: any) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    image_url: e.image_url,
    location: e.location,
    event_date: e.event_date,
    price: e.price,
    category: e.category,
    categories: e.categories,
    is_18_plus: e.is_18_plus,
    organizer_name: e.organizer_name,
  }));
}

// Mirrors EventDetailsScreen.tsx's single-event fetch, kept to the same
// RLS-visible columns (no organizer-only or admin-only fields).
export async function executeGetEvent(client: SupabaseClient, input: any) {
  const eventId = String(input?.event_id ?? '');
  const { data, error } = await client
    .from('events')
    .select(
      'id, title, description, image_url, location, event_date, end_date, price, category, categories, ticket_types, is_18_plus, is_featured, organizer_id'
    )
    .eq('id', eventId)
    .single();
  if (error) throw new Error(error.message);

  const { data: stats } = await client.rpc('get_event_ticket_stats', { p_event_ids: [eventId] });
  const stat = Array.isArray(stats) ? stats[0] : null;

  return {
    ...data,
    sold_count: stat?.sold_count ?? null,
    sold_quantity: stat?.sold_quantity ?? null,
  };
}

// Calls the new search_services_fuzzy RPC (migration 0081), the fuzzy/
// keyword search this feature needed and that did not previously exist.
export async function executeSearchServicesOrProviders(client: SupabaseClient, input: any) {
  const limit = clampLimit(input?.limit);
  const { data, error } = await client.rpc('search_services_fuzzy', {
    p_query: String(input?.query ?? ''),
    p_category: input?.category ? String(input.category) : null,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

// Mirrors the provider profile lookup used by provider profile screens.
export async function executeGetProviderProfile(client: SupabaseClient, input: any) {
  const providerId = String(input?.provider_id ?? '');
  const { data, error } = await client
    .from('service_providers')
    .select(
      'id, business_name, category, description, location, photo_urls, starting_price, starting_price_currency, services_offered, offers_home_service, offers_delivery, offers_same_day, status'
    )
    .eq('id', providerId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Mirrors UserProfileScreen.tsx's "my tickets" query -- RLS
// (tickets_select_own, per AGENTS.md) already scopes this to the caller.
export async function executeGetMyTickets(client: SupabaseClient, input: any) {
  const limit = clampLimit(input?.limit);
  const { data, error } = await client
    .from('tickets')
    .select('id, event_id, quantity, status, payment_status, amount, ticket_type, checked_in, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

// Mirrors the customer "my bookings" screen's query, RLS-scoped by
// service_bookings_select_own_customer (0054).
export async function executeGetMyBookings(client: SupabaseClient, input: any) {
  const limit = clampLimit(input?.limit);
  const { data, error } = await client
    .from('service_bookings')
    .select(
      'id, provider_id, status, payment_status, scheduled_date, scheduled_time, location, currency, subtotal_kobo, fee_kobo, total_kobo, created_at, service_providers(business_name)'
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

// No dedicated status RPC exists for either type -- selects only the
// status columns off the row the RLS policies already scope to the caller.
export async function executeGetPaymentStatus(client: SupabaseClient, input: any) {
  const id = String(input?.id ?? '');
  if (input?.type === 'booking') {
    const { data, error } = await client
      .from('service_bookings')
      .select('id, status, payment_status, payment_ref, total_kobo, currency')
      .eq('id', id)
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  const { data, error } = await client
    .from('tickets')
    .select('id, status, payment_status, payment_ref, amount, refund_id, refund_reason')
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Mirrors CustomerWalletScreen.tsx / CheckoutScreen.tsx's get_my_wallet call.
export async function executeGetWalletBalance(client: SupabaseClient) {
  const { data, error } = await client.rpc('get_my_wallet');
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return { balance_kobo: row?.balance_kobo ?? 0 };
}

export async function executeGetVentsCentsBalance(client: SupabaseClient) {
  const { data, error } = await client.rpc('get_my_vc_balance');
  if (error) throw new Error(error.message);
  return data ?? { spendable: 0 };
}

const READ_EXECUTORS: Record<string, (client: SupabaseClient, input: any) => Promise<unknown>> = {
  search_events: executeSearchEvents,
  get_event: executeGetEvent,
  search_services_or_providers: executeSearchServicesOrProviders,
  get_provider_profile: executeGetProviderProfile,
  get_my_tickets: executeGetMyTickets,
  get_my_bookings: executeGetMyBookings,
  get_payment_status: executeGetPaymentStatus,
  get_wallet_balance: executeGetWalletBalance,
  get_vents_cents_balance: executeGetVentsCentsBalance,
};

export async function executeReadOnlyTool(name: string, client: SupabaseClient, input: any): Promise<unknown> {
  const fn = READ_EXECUTORS[name];
  if (!fn) throw new Error(`Unknown read-only tool: ${name}`);
  return fn(client, input);
}

// ---------------------------------------------------------------------
// Phase 2 proposal builders (never auto-executed from the model loop)
// ---------------------------------------------------------------------

export function buildProposal(name: string, input: any): { proposal: Record<string, unknown> } {
  switch (name) {
    case 'start_ticket_transfer':
      return {
        proposal: {
          action: 'start_ticket_transfer',
          summary: `Transfer ticket ${input?.ticket_id} to ${input?.recipient_identifier}`,
          ticket_id: input?.ticket_id,
          recipient_identifier: input?.recipient_identifier,
        },
      };
    case 'request_ticket_refund':
      return {
        proposal: {
          action: 'request_ticket_refund',
          summary: `Refund ticket ${input?.ticket_id}: ${input?.reason}`,
          ticket_id: input?.ticket_id,
          reason: input?.reason,
        },
      };
    case 'start_service_booking':
      return {
        proposal: {
          action: 'start_service_booking',
          summary: `Book ${Array.isArray(input?.items) ? input.items.length : 0} service(s) from provider ${input?.provider_id}`,
          provider_id: input?.provider_id,
          items: input?.items ?? [],
          scheduled_date: input?.scheduled_date ?? null,
          scheduled_time: input?.scheduled_time ?? null,
          location: input?.location ?? null,
          notes: input?.notes ?? null,
        },
      };
    case 'create_report':
      return {
        proposal: {
          action: 'create_report',
          summary: `Report ${input?.target_type} ${input?.target_id}: ${input?.reason}`,
          target_type: input?.target_type,
          target_id: input?.target_id,
          reason: input?.reason,
          details: input?.details ?? null,
        },
      };
    default:
      throw new Error(`Unknown proposal tool: ${name}`);
  }
}

// ---------------------------------------------------------------------
// Phase 2 real executors -- run ONLY after confirmation token verification,
// never from inside the model's tool-use loop.
// ---------------------------------------------------------------------

// Calls initiate_ticket_transfer exactly as the app's own transfer flow does.
export async function executeStartTicketTransfer(client: SupabaseClient, params: any) {
  const { data, error } = await client.rpc('initiate_ticket_transfer', {
    p_ticket_id: params.ticket_id,
    p_recipient_identifier: params.recipient_identifier,
  });
  if (error) throw new Error(error.message);
  return { transfer_id: data };
}

// Calls the existing api/wallet/refund-ticket.ts endpoint (which wraps
// refund_ticket) rather than the RPC directly, per this feature's spec --
// that endpoint also does the Paystack-side refund call this RPC cannot do
// on its own.
export async function executeRequestTicketRefund(accessToken: string, origin: string, params: any) {
  const res = await fetch(`${origin}/api/wallet/refund-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ ticket_id: params.ticket_id, reason: params.reason }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || 'Refund could not be started');
  return body;
}

// Calls create_service_booking exactly as the app's own booking flow does.
export async function executeStartServiceBooking(client: SupabaseClient, params: any) {
  const { data, error } = await client.rpc('create_service_booking', {
    p_provider_id: params.provider_id,
    p_items: params.items,
    p_scheduled_date: params.scheduled_date ?? null,
    p_scheduled_time: params.scheduled_time ?? null,
    p_location: params.location ?? null,
    p_notes: params.notes ?? null,
  });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data[0] : data;
}

// Direct insert into `reports`, same shape as ReportModal.tsx.
export async function executeCreateReport(client: SupabaseClient, userId: string, params: any) {
  const { data, error } = await client
    .from('reports')
    .insert([
      {
        reporter_id: userId,
        target_type: params.target_type,
        target_id: params.target_id,
        reason: params.reason,
        details: params.details ?? null,
      },
    ])
    .select('id, status')
    .single();
  if (error) throw new Error(error.message);
  return data;
}
