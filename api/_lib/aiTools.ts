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
  // get_vents_cents_rules is deliberately NOT exposed yet: its executor calls
  // get_vc_config() (supabase/migrations/0085_authoritative_vc_config.sql),
  // which is part of the VC Cash-out batch and hasn't been merged/deployed
  // yet -- re-enable this tool (and executeGetVentsCentsRules/its
  // READ_EXECUTORS entry below) once that migration ships.
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

// SI Planner tools (Batch 2) -- a THIRD category, distinct from both
// READ_ONLY_TOOLS (auto-executed, nothing changes) and PROPOSAL_TOOLS
// (never auto-executed, always end the turn with a signed-token
// confirmation before anything happens). Per the frozen design spec's own
// "Correct -- do not change in code" rule, plan edits are NOT money:
// "Purple PlanUpdateCard for plan edits vs amber ConfirmationCard for
// money." So these tools auto-execute inside the model loop exactly like
// READ_ONLY_TOOLS (no signed token -- ownership is enforced by RLS plus
// each RPC's own auth.uid() check, not by a confirmation round trip), but
// propose_plan_update is deliberately READ-ONLY (computes a diff, writes
// nothing) and apply_plan_update is the only one of the eight that writes
// a budget change -- the system prompt (api/_lib/aiAssistantHandler.ts) is
// what actually enforces "a bare SI suggestion must go through
// propose_plan_update, never straight to apply_plan_update" -- there is no
// server-side token for this distinction because, unlike a ticket refund
// or a service booking, a planning allocation is reversible (Undo, see
// apply_plan_allocation_changes/undo_plan_change, migration 0157) rather
// than consequential in the way money is.
export const PLAN_TOOLS = [
  {
    name: 'create_plan_draft',
    description:
      "Create a new personal event plan from a conversation, with whatever the user has already said -- leave anything not yet known as null/omitted rather than asking for a complete form up front. Seeds the plan's standard category list for its event_type (e.g. a wedding gets venue/catering/photography/etc.) with every category unallocated (0) -- never invent a budget split; that happens later via propose_plan_update/apply_plan_update once a total budget is actually known.",
    input_schema: {
      type: 'object',
      properties: {
        event_type: { type: 'string', description: 'e.g. "wedding", "birthday", "conference", "private_dinner", or any other free-text event type.' },
        title: { type: 'string', description: 'A short plan title, e.g. "Beach Wedding" or "Tola\'s 30th".' },
        event_date: { type: 'string', description: 'YYYY-MM-DD, optional -- omit if not yet known.' },
        end_date: { type: 'string', description: 'YYYY-MM-DD, optional, for a multi-day event.' },
        city: { type: 'string', description: 'Optional.' },
        guests: { type: 'number', description: 'Optional estimated guest count.' },
        setting: { type: 'string', description: 'Optional, e.g. "indoor", "outdoor", "beach".' },
        total_budget_naira: { type: 'number', description: 'Optional total budget in naira, if the user has already stated one.' },
      },
      required: ['event_type', 'title'],
    },
  },
  {
    name: 'get_plan',
    description:
      "Fetch the full current state of one of the current user's own plans: brief, budget totals (estimated/committed/paid, never mixed), categories, provider assignments, tasks, and milestones. Always call this before answering a question about an existing plan's state -- never guess or recall stale figures from earlier in the conversation.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'The plan UUID. If the user hasn\'t named a plan and only one exists, use that one.' },
      },
      required: ['plan_id'],
    },
  },
  {
    name: 'propose_plan_update',
    description:
      "Compute and return a proposed budget reallocation WITHOUT changing anything -- use this for SI's OWN unprompted suggestion (e.g. \"I'd recommend allocating more to photography\"). This never writes to the plan; the user must separately choose to apply it (apply_plan_update) before it takes effect. Do NOT use this for a direct, unambiguous user instruction -- call apply_plan_update straight away for those instead.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        changes: {
          type: 'array',
          description: 'Category reallocations to preview.',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string', description: 'The category key or id, e.g. "photography".' },
              new_allocation_naira: { type: 'number' },
            },
            required: ['category', 'new_allocation_naira'],
          },
        },
      },
      required: ['plan_id', 'changes'],
    },
  },
  {
    name: 'apply_plan_update',
    description:
      "Actually apply a budget reallocation to the plan -- use this for a direct, explicit user instruction (e.g. \"move 300k from decoration to catering\") right away, or after the user has explicitly agreed to a previously proposed change (propose_plan_update). The change is reversible by the user afterward (Undo), but never claim you've reversed a real payment this way -- this only ever touches planning allocations, never a booking or Paystack transaction.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string', description: 'The category key or id.' },
              new_allocation_naira: { type: 'number' },
            },
            required: ['category', 'new_allocation_naira'],
          },
        },
        actor: { type: 'string', description: '"user" for a direct instruction, "si" only when the user just tapped Apply on your own prior suggestion.' },
      },
      required: ['plan_id', 'changes', 'actor'],
    },
  },
  {
    name: 'recommend_providers',
    description:
      'Search real VENTS service providers to recommend for a plan category, optionally filtered by location and a maximum price. NEVER state or imply a provider is "available" on the event date -- VENTS has no availability data; always tell the user to confirm availability with the provider directly. Prices shown are only real starting_price data already on file -- never invent or estimate a provider\'s price.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'e.g. "photographer", "makeup artist".' },
        category: { type: 'string', description: 'Optional exact category filter.' },
        location: { type: 'string', description: 'Optional location filter, e.g. "Lagos".' },
        max_price_naira: { type: 'number', description: 'Optional maximum starting price in naira -- a provider with no price on file is excluded rather than assumed to fit.' },
        limit: { type: 'number', description: 'Max results (default 10, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'assign_provider',
    description:
      "Assign a real VENTS provider the user has chosen to a plan category, at an agreed amount. This does NOT book or charge anything -- assigned is not booked. Replaces any prior shortlisted/assigned provider for that category (never a category that's already paid-booked, which this refuses). Never claim this created a booking or reservation.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        category: { type: 'string', description: 'The category key or id.' },
        provider_id: { type: 'string', description: 'The service provider UUID, from a prior recommend_providers result.' },
        agreed_amount_naira: { type: 'number', description: 'Optional amount agreed with the provider, in naira.' },
      },
      required: ['plan_id', 'category', 'provider_id'],
    },
  },
  {
    name: 'reschedule_plan',
    description:
      "Change a plan's event date. This never touches bookings, payments, or financial records -- if the plan has an assigned provider, the assignment is left exactly as-is, and the user should be told to confirm the new date with that provider directly.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        event_date: { type: 'string', description: 'YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'YYYY-MM-DD, optional.' },
      },
      required: ['plan_id', 'event_date'],
    },
  },
  {
    name: 'confirm_brief',
    description:
      "Mark a draft plan's brief as confirmed once enough is known to be useful (title and event type are always enough -- date, budget, and guest count can stay unknown; do not force completeness). This only changes the plan's status for display purposes; it never requires or checks any specific field being filled in.",
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
      },
      required: ['plan_id'],
    },
  },
  // The three tools below are pure formatting/validation -- like
  // propose_plan_update, they touch no table and create no plan row; they
  // exist only so the pre-plan slot-filling conversation (mockup frames
  // P02-P05: intent detected -> structured questions -> brief review,
  // all BEFORE a plans row exists) renders as real structured cards
  // instead of the model's prose being guessed at by the frontend.
  // create_plan_draft is still the only tool that actually writes a row,
  // and it only runs once the user has reviewed preview_plan_brief and
  // explicitly asked to proceed (see SYSTEM_PROMPT point 6h).
  {
    name: 'offer_plan_intent',
    description:
      "Call this the moment you detect the user wants a whole event planned (not just one service booked), to surface what you've already understood as a confirmable offer -- NEVER create a plan yet. Renders as a card with the extracted fields as tiles and two actions: accept (start the guided Q&A) or dismiss (stay in plain chat). Leave any field you don't know yet out entirely -- do not guess a value just to fill the card.",
    input_schema: {
      type: 'object',
      properties: {
        event_type: { type: 'string' },
        title: { type: 'string', description: 'Short working title, e.g. "Beach wedding".' },
        guests: { type: 'number' },
        city: { type: 'string' },
        total_budget_naira: { type: 'number' },
        questions_remaining: { type: 'number', description: 'Your honest estimate of how many more questions are needed -- shown as "About N quick questions to go." Keep it small and update it on later offer_plan_intent calls if it changes.' },
      },
      required: ['event_type'],
    },
  },
  {
    name: 'ask_plan_question',
    description:
      "Ask ONE structured question while gathering the details needed for a new plan (after offer_plan_intent has been accepted), instead of writing it as plain text. Renders as a card: your lead_in reacting to the user's last answer, then the options as tappable rows (single_choice) or toggle chips (multi_select, capped at max_select). The user can always answer free-text instead, or skip. Ask ONE thing per call -- never bundle multiple questions into one call's options list.",
    input_schema: {
      type: 'object',
      properties: {
        working_title: { type: 'string', description: 'The plan\'s working title so far, e.g. "Beach wedding" -- shown in the card header.' },
        step: { type: 'number', description: '1-based index of this question.' },
        step_count_estimate: { type: 'number', description: 'Your current best estimate of the total number of questions -- this can change between calls; the UI labels it "~N" to signal that.' },
        lead_in: { type: 'string', description: 'A short line reacting to the user\'s previous answer before asking the next question -- keeps it conversational, not a form.' },
        question: { type: 'string', description: 'The question itself.' },
        question_type: { type: 'string', enum: ['single_choice', 'multi_select'] },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              hint: { type: 'string', description: 'Optional short right-aligned hint, e.g. "Add details".' },
            },
            required: ['id', 'label'],
          },
        },
        max_select: { type: 'number', description: 'Only for multi_select -- the max number of options the user may pick.' },
        allow_skip: { type: 'boolean', description: 'Default true -- whether "Skip for now" is offered.' },
      },
      required: ['step', 'question', 'question_type', 'options'],
    },
  },
  {
    name: 'preview_plan_brief',
    description:
      "Once enough is known (title + event_type is always enough -- never force completeness), call this to show the full brief for review BEFORE creating anything. Renders as a full-screen brief card with a single 'Build my plan' action. Only after the user confirms from there do you call create_plan_draft (immediately followed by confirm_brief) -- never create the plan before this preview has been shown and agreed to.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        event_type: { type: 'string' },
        host_names: { type: 'string', description: 'Optional, e.g. "Tolu & Dami".' },
        event_date: { type: 'string', description: 'YYYY-MM-DD, optional.' },
        city: { type: 'string' },
        setting: { type: 'string', description: 'e.g. "indoor", "outdoor", "beach".' },
        guests: { type: 'number' },
        venue_status: { type: 'string', description: 'Plain-language venue status, e.g. "Not booked -- SI will help". Omit if genuinely unknown; never invent a status.' },
        total_budget_naira: { type: 'number' },
        style: { type: 'array', items: { type: 'string' }, description: 'Style tags the user gave, e.g. ["Elegant", "Modern", "Beach"].' },
        priorities: { type: 'array', items: { type: 'string' }, description: 'Ordered list (most important first) of what gets protected in the budget -- from the multi-select priorities question, max 3.' },
      },
      required: ['title', 'event_type'],
    },
  },
] as const;

export const ALL_TOOLS = [...READ_ONLY_TOOLS, ...PROPOSAL_TOOLS, ...PLAN_TOOLS];

export const READ_ONLY_TOOL_NAMES = new Set(READ_ONLY_TOOLS.map((t) => t.name));
export const PROPOSAL_TOOL_NAMES = new Set(PROPOSAL_TOOLS.map((t) => t.name));
export const PLAN_TOOL_NAMES = new Set(PLAN_TOOLS.map((t) => t.name));

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

// executeGetVentsCentsRules (calls get_vc_config(), migrations 0085/0086) is
// deliberately omitted until the VC Cash-out batch ships -- see the
// get_vents_cents_rules removal note in READ_ONLY_TOOLS above.

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

// ---------------------------------------------------------------------
// SI Planner tool executors (Batch 2) -- auto-executed inside the model
// loop, same as Phase 1 read tools (see the PLAN_TOOLS comment above for
// why these don't go through the Phase 2 confirmation-token flow). Every
// executor here uses the SAME user-forwarded client as every other tool
// in this file -- never a service-role client -- so a plan tool can never
// see or touch another user's plan: ownership is enforced twice, once by
// each table's/RPC's own RLS-or-auth.uid() check, and again here by never
// trusting a client-supplied owner/user id for anything but the one value
// (userId) the server itself already authenticated.
// ---------------------------------------------------------------------

const NAIRA_TO_KOBO = 100;

function toKobo(naira: unknown): number | null {
  if (naira === null || naira === undefined) return null;
  const n = Number(naira);
  if (!isFinite(n) || n < 0) throw new Error('Amount must be a non-negative number');
  return Math.round(n * NAIRA_TO_KOBO);
}

function fromKobo(kobo: unknown): number | null {
  if (kobo === null || kobo === undefined) return null;
  return Number(kobo) / NAIRA_TO_KOBO;
}

// Event-type category templates (§12 "Event-type templates (server
// data)") -- every category starts fully unallocated (0). This is
// deliberately NOT a percentage-of-budget split: no authoritative split
// numbers exist in this codebase, and inventing one would be exactly the
// "SI invents prices" failure mode the design spec repeatedly rules out.
// SI proposes real allocations later, once it actually knows the budget
// and the user's priorities, via propose_plan_update/apply_plan_update.
const EVENT_TYPE_CATEGORIES: Record<string, string[]> = {
  wedding: ['venue', 'catering', 'photography', 'videography', 'decoration', 'music', 'sound', 'mc', 'cake', 'makeup', 'transport', 'invitations', 'security'],
  birthday: ['venue', 'food', 'cake', 'decoration', 'dj', 'photography', 'entertainment'],
  conference: ['venue', 'av', 'stage', 'speakers', 'registration', 'branding', 'catering', 'security', 'photography', 'streaming', 'staff'],
  private_dinner: ['venue', 'menu', 'drinks', 'decoration', 'music'],
};
const DEFAULT_CATEGORIES = ['venue', 'catering', 'decoration', 'photography', 'music'];

function categoryLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ');
}

export async function executeCreatePlanDraft(client: SupabaseClient, userId: string, input: any) {
  const eventType = String(input?.event_type ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  const title = String(input?.title ?? '').trim();
  if (!eventType) throw new Error('event_type is required');
  if (!title) throw new Error('title is required');

  const totalKobo = toKobo(input?.total_budget_naira);

  const { data: plan, error } = await client
    .from('plans')
    .insert([{
      owner_id: userId,
      kind: 'personal',
      event_type: eventType,
      title,
      status: 'draft',
      event_date: input?.event_date ?? null,
      end_date: input?.end_date ?? null,
      city: input?.city ?? null,
      guests: typeof input?.guests === 'number' ? input.guests : null,
      setting: input?.setting ?? null,
      total_kobo: totalKobo,
      currency: 'NGN',
    }])
    .select()
    .single();
  if (error) throw new Error(error.message);

  const categoryKeys = EVENT_TYPE_CATEGORIES[eventType] ?? DEFAULT_CATEGORIES;
  const { error: catError } = await client
    .from('plan_categories')
    .insert(categoryKeys.map((key, idx) => ({
      plan_id: plan.id,
      key,
      label: categoryLabel(key),
      allocated_kobo: 0,
      sort: idx,
    })));
  if (catError) throw new Error(catError.message);

  return {
    plan_id: plan.id,
    title: plan.title,
    event_type: plan.event_type,
    status: plan.status,
    event_date: plan.event_date,
    city: plan.city,
    guests: plan.guests,
    total_budget_naira: fromKobo(plan.total_kobo),
    categories: categoryKeys,
  };
}

// Resolves a model-supplied "category" (either a plan_categories.id uuid,
// or a plain key like "photography") to a real row scoped to the given
// plan -- never trusts a bare id without checking it actually belongs to
// this plan, same defensive check Batch 2's SQL functions make server-side.
async function resolvePlanCategory(client: SupabaseClient, planId: string, category: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(category);
  const { data, error } = await client
    .from('plan_categories')
    .select('id, key, label, allocated_kobo')
    .eq('plan_id', planId)
    .eq(isUuid ? 'id' : 'key', category)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Category "${category}" not found on this plan`);
  return data;
}

export async function executeGetPlan(client: SupabaseClient, _userId: string, input: any) {
  const planId = String(input?.plan_id ?? '');
  const { data: plan, error } = await client.from('plans').select('*').eq('id', planId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!plan) throw new Error('Plan not found');

  const { data: categories } = await client
    .from('plan_categories')
    .select('id, key, label, allocated_kobo, is_priority, is_contingency, sort')
    .eq('plan_id', planId)
    .order('sort');
  const categoryIds = (categories ?? []).map((c: any) => c.id);

  const [{ data: assignments }, { data: tasks }, { data: milestones }, { data: messages }] = await Promise.all([
    categoryIds.length
      ? client.from('plan_assignments').select('id, category_id, provider_id, own_vendor_name, agreed_kobo, status, booking_id, updated_at').in('category_id', categoryIds)
      : Promise.resolve({ data: [] as any[] }),
    client.from('plan_tasks').select('id, category_id, title, offset_days, due_override, done_at, source').eq('plan_id', planId),
    client.from('plan_milestones').select('id, phase_key, label, ends_offset_days').eq('plan_id', planId),
    client.from('plan_messages').select('role, content, created_at').eq('plan_id', planId).order('created_at', { ascending: false }).limit(20),
  ]);

  // Providers/bookings referenced by ANY assignment (not just active ones)
  // -- a cancelled assignment still needs its provider name and its real
  // refund status (see the P21 fix, migration 0158: cancel_service_booking
  // now syncs plan_assignments.status to 'cancelled', but the model still
  // needs to read the real service_bookings refund fields rather than
  // assume a full refund).
  const providerIds = [...new Set((assignments ?? []).map((a: any) => a.provider_id).filter(Boolean))];
  const bookingIds = [...new Set((assignments ?? []).map((a: any) => a.booking_id).filter(Boolean))];
  const [{ data: providers }, { data: bookings }] = await Promise.all([
    providerIds.length ? client.from('service_providers').select('id, business_name').in('id', providerIds) : Promise.resolve({ data: [] as any[] }),
    bookingIds.length ? client.from('service_bookings').select('id, status, payment_status, refund_reason').in('id', bookingIds) : Promise.resolve({ data: [] as any[] }),
  ]);
  const providerById = new Map<string, any>((providers ?? []).map((p: any) => [p.id, p]));
  const bookingById = new Map<string, any>((bookings ?? []).map((b: any) => [b.id, b]));

  const assignmentsByCategory = new Map<string, any[]>();
  for (const a of assignments ?? []) {
    const list = assignmentsByCategory.get(a.category_id) ?? [];
    list.push(a);
    assignmentsByCategory.set(a.category_id, list);
  }

  let totalCommitted = 0;
  let totalPaid = 0;
  const categoriesOut = (categories ?? []).map((c: any) => {
    const catAssignments = assignmentsByCategory.get(c.id) ?? [];
    const activeAssignments = catAssignments.filter((a) => a.status === 'assigned' || a.status === 'booked');
    const committed = activeAssignments.filter((a) => a.status === 'assigned').reduce((s: number, a: any) => s + (a.agreed_kobo ?? 0), 0);
    const paid = activeAssignments.filter((a) => a.status === 'booked').reduce((s: number, a: any) => s + (a.agreed_kobo ?? 0), 0);
    totalCommitted += committed;
    totalPaid += paid;
    const estimated = Math.max(0, (c.allocated_kobo ?? 0) - committed - paid);

    // The most recently cancelled assignment, only surfaced when the
    // category has no currently-active one -- so "what happened to my
    // photographer" can be answered from a real row, not silence, without
    // ever showing a stale cancelled assignment alongside a fresh one.
    const recentlyCancelled = activeAssignments.length === 0
      ? catAssignments.filter((a) => a.status === 'cancelled').sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0]
      : null;

    return {
      category_id: c.id,
      key: c.key,
      label: c.label,
      allocated_naira: fromKobo(c.allocated_kobo),
      estimated_naira: fromKobo(estimated),
      committed_naira: fromKobo(committed),
      paid_naira: fromKobo(paid),
      is_priority: c.is_priority,
      is_contingency: c.is_contingency,
      assignments: activeAssignments.map((a: any) => ({
        provider_id: a.provider_id,
        business_name: a.provider_id ? providerById.get(a.provider_id)?.business_name ?? null : null,
        own_vendor_name: a.own_vendor_name,
        agreed_amount_naira: fromKobo(a.agreed_kobo),
        status: a.status,
      })),
      recently_cancelled: recentlyCancelled
        ? {
            business_name: recentlyCancelled.provider_id ? providerById.get(recentlyCancelled.provider_id)?.business_name ?? null : null,
            own_vendor_name: recentlyCancelled.own_vendor_name,
            agreed_amount_naira: fromKobo(recentlyCancelled.agreed_kobo),
            // Real refund status, read off the real booking -- NEVER assume
            // "fully refunded" here; state exactly what the booking says.
            refund_status: recentlyCancelled.booking_id ? bookingById.get(recentlyCancelled.booking_id)?.payment_status ?? null : null,
          }
        : null,
    };
  });

  return {
    plan_id: plan.id,
    title: plan.title,
    event_type: plan.event_type,
    status: plan.status,
    event_date: plan.event_date,
    end_date: plan.end_date,
    city: plan.city,
    guests: plan.guests,
    setting: plan.setting,
    total_budget_naira: fromKobo(plan.total_kobo),
    budget_summary: {
      total_committed_naira: fromKobo(totalCommitted),
      total_paid_naira: fromKobo(totalPaid),
    },
    categories: categoriesOut,
    tasks: (tasks ?? []).map((t: any) => ({
      id: t.id, category_id: t.category_id, title: t.title, offset_days: t.offset_days,
      due_override: t.due_override, done: !!t.done_at, source: t.source,
    })),
    milestones: milestones ?? [],
    recent_messages: (messages ?? []).reverse(),
  };
}

// Pure computation, writes nothing -- see the PLAN_TOOLS comment on why
// this is the one tool SI must use for its own unprompted suggestions.
export async function executeProposePlanUpdate(client: SupabaseClient, _userId: string, input: any) {
  const planId = String(input?.plan_id ?? '');
  const changes = Array.isArray(input?.changes) ? input.changes : [];
  if (changes.length === 0) throw new Error('No changes given');

  const resolved = await Promise.all(
    changes.map(async (c: any) => {
      const cat = await resolvePlanCategory(client, planId, String(c.category));
      const newKobo = toKobo(c.new_allocation_naira);
      return {
        category_id: cat.id,
        key: cat.key,
        label: cat.label,
        before_naira: fromKobo(cat.allocated_kobo),
        after_naira: fromKobo(newKobo),
      };
    })
  );

  return { plan_id: planId, proposed_changes: resolved, applied: false };
}

export async function executeApplyPlanUpdate(client: SupabaseClient, _userId: string, input: any) {
  const planId = String(input?.plan_id ?? '');
  const changes = Array.isArray(input?.changes) ? input.changes : [];
  if (changes.length === 0) throw new Error('No changes given');
  const actor = input?.actor === 'si' ? 'si' : 'user';

  const resolvedChanges = await Promise.all(
    changes.map(async (c: any) => {
      const cat = await resolvePlanCategory(client, planId, String(c.category));
      return { category_id: cat.id, new_allocated_kobo: toKobo(c.new_allocation_naira) };
    })
  );

  const { data: changeLogId, error } = await client.rpc('apply_plan_allocation_changes', {
    p_plan_id: planId,
    p_changes: resolvedChanges,
    p_actor: actor,
  });
  if (error) throw new Error(error.message);

  return { plan_id: planId, change_log_id: changeLogId, applied: true, actor };
}

export async function executeRecommendProviders(client: SupabaseClient, _userId: string, input: any) {
  const limit = clampLimit(input?.limit);
  // service_providers.starting_price (0034) is a plain naira numeric, not
  // kobo -- unlike every plans/plan_categories amount column, which really
  // is kobo. No conversion here; p_max_starting_price takes the same
  // naira value the model was given.
  const maxPriceNaira = input?.max_price_naira != null ? Number(input.max_price_naira) : null;
  if (maxPriceNaira !== null && (!isFinite(maxPriceNaira) || maxPriceNaira < 0)) {
    throw new Error('max_price_naira must be a non-negative number');
  }
  const { data, error } = await client.rpc('search_services_fuzzy_filtered', {
    p_query: String(input?.query ?? ''),
    p_category: input?.category ? String(input.category) : null,
    p_limit: limit,
    p_location: input?.location ? String(input.location) : null,
    p_max_starting_price: maxPriceNaira,
  });
  if (error) throw new Error(error.message);

  // Clean organic/sponsored boundary (Batch 2 §10): no sponsor/featured
  // data exists anywhere in this codebase yet, so this is always false --
  // never a hardcoded true, never influenced by anything -- and sort order
  // stays match_score only. A future Featured Provider feature plugs in by
  // setting this per-row from real data; it must never affect `ORDER BY`
  // in search_services_fuzzy_filtered itself.
  return (data ?? []).map((row: any) => ({
    provider_id: row.provider_id,
    business_name: row.business_name,
    category: row.provider_category,
    location: row.location,
    starting_price_naira: row.starting_price != null ? Number(row.starting_price) : null,
    service_id: row.service_id,
    service_name: row.service_name,
    service_price_naira: row.service_price,
    is_sponsored: false,
    availability_note: 'Confirm availability with provider.',
  }));
}

export async function executeAssignProvider(client: SupabaseClient, _userId: string, input: any) {
  const planId = String(input?.plan_id ?? '');
  const cat = await resolvePlanCategory(client, planId, String(input?.category ?? ''));
  const agreedKobo = toKobo(input?.agreed_amount_naira);

  const { data, error } = await client.rpc('assign_plan_provider', {
    p_category_id: cat.id,
    p_provider_id: String(input?.provider_id ?? ''),
    p_agreed_kobo: agreedKobo,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;

  return {
    category: cat.key,
    provider_id: row.provider_id,
    agreed_amount_naira: fromKobo(row.agreed_kobo),
    status: row.status,
    booked: row.status === 'booked',
  };
}

export async function executeReschedulePlan(client: SupabaseClient, _userId: string, input: any) {
  const planId = String(input?.plan_id ?? '');
  const eventDate = input?.event_date ? String(input.event_date) : null;
  if (!eventDate) throw new Error('event_date is required');

  const { data, error } = await client
    .from('plans')
    .update({ event_date: eventDate, end_date: input?.end_date ?? null })
    .eq('id', planId)
    .select('id, event_date, end_date')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Plan not found');

  const { data: categoryRows } = await client.from('plan_categories').select('id').eq('plan_id', planId);
  const categoryIds = (categoryRows ?? []).map((c: any) => c.id);
  const { data: assignments } = categoryIds.length
    ? await client.from('plan_assignments').select('id').in('category_id', categoryIds).in('status', ['assigned', 'booked'])
    : { data: [] as any[] };

  return {
    plan_id: data.id,
    event_date: data.event_date,
    end_date: data.end_date,
    has_assigned_providers: (assignments?.length ?? 0) > 0,
    note: (assignments?.length ?? 0) > 0
      ? 'This plan has assigned providers -- confirm the new date with each of them directly. No booking or payment was changed.'
      : undefined,
  };
}

export async function executeConfirmBrief(client: SupabaseClient, _userId: string, input: any) {
  const planId = String(input?.plan_id ?? '');
  const { data, error } = await client
    .from('plans')
    .update({ status: 'active' })
    .eq('id', planId)
    .eq('status', 'draft')
    .select('id, status')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Plan not found, or its brief is already confirmed');
  return data;
}

// Pure formatting/validation -- no table touched, no plan_id (none exists
// yet pre-creation). See the PLAN_TOOLS comment above these three schemas.
async function executeOfferPlanIntent(_client: SupabaseClient, _userId: string, input: any) {
  return {
    event_type: input?.event_type != null ? String(input.event_type) : null,
    title: input?.title != null ? String(input.title) : null,
    guests: typeof input?.guests === 'number' ? input.guests : null,
    city: input?.city != null ? String(input.city) : null,
    total_budget_naira: typeof input?.total_budget_naira === 'number' ? input.total_budget_naira : null,
    questions_remaining: typeof input?.questions_remaining === 'number' ? input.questions_remaining : null,
  };
}

async function executeAskPlanQuestion(_client: SupabaseClient, _userId: string, input: any) {
  const options = Array.isArray(input?.options)
    ? input.options.map((o: any) => ({ id: String(o?.id ?? ''), label: String(o?.label ?? ''), hint: o?.hint != null ? String(o.hint) : null }))
    : [];
  return {
    working_title: input?.working_title != null ? String(input.working_title) : null,
    step: typeof input?.step === 'number' ? input.step : null,
    step_count_estimate: typeof input?.step_count_estimate === 'number' ? input.step_count_estimate : null,
    lead_in: input?.lead_in != null ? String(input.lead_in) : null,
    question: String(input?.question ?? ''),
    question_type: input?.question_type === 'multi_select' ? 'multi_select' : 'single_choice',
    options,
    max_select: typeof input?.max_select === 'number' ? input.max_select : null,
    allow_skip: input?.allow_skip !== false,
  };
}

async function executePreviewPlanBrief(_client: SupabaseClient, _userId: string, input: any) {
  return {
    title: String(input?.title ?? ''),
    event_type: String(input?.event_type ?? ''),
    host_names: input?.host_names != null ? String(input.host_names) : null,
    event_date: input?.event_date != null ? String(input.event_date) : null,
    city: input?.city != null ? String(input.city) : null,
    setting: input?.setting != null ? String(input.setting) : null,
    guests: typeof input?.guests === 'number' ? input.guests : null,
    venue_status: input?.venue_status != null ? String(input.venue_status) : null,
    total_budget_naira: typeof input?.total_budget_naira === 'number' ? input.total_budget_naira : null,
    style: Array.isArray(input?.style) ? input.style.map(String) : [],
    priorities: Array.isArray(input?.priorities) ? input.priorities.map(String) : [],
  };
}

const PLAN_EXECUTORS: Record<string, (client: SupabaseClient, userId: string, input: any) => Promise<unknown>> = {
  create_plan_draft: executeCreatePlanDraft,
  get_plan: executeGetPlan,
  propose_plan_update: executeProposePlanUpdate,
  apply_plan_update: executeApplyPlanUpdate,
  recommend_providers: executeRecommendProviders,
  assign_provider: executeAssignProvider,
  reschedule_plan: executeReschedulePlan,
  confirm_brief: executeConfirmBrief,
  offer_plan_intent: executeOfferPlanIntent,
  ask_plan_question: executeAskPlanQuestion,
  preview_plan_brief: executePreviewPlanBrief,
};

export async function executePlanTool(name: string, client: SupabaseClient, userId: string, input: any): Promise<unknown> {
  const fn = PLAN_EXECUTORS[name];
  if (!fn) throw new Error(`Unknown plan tool: ${name}`);
  return fn(client, userId, input);
}
