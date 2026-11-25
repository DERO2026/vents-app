import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guards for 0224_coming_soon_events.sql and undo_0224.sql. Behaviour
// is proven by executing the real migration on the production-shaped money
// stack in scripts/local-pg-test/run-coming-soon-verification.sh; these keep
// the security-relevant shape from regressing in later edits.

let m: string; let undo: string; let cron: string;
const fn = (name: string) => m.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`))?.[0] ?? '';

beforeAll(() => {
  const root = join(__dirname, '..', '..');
  m = readFileSync(join(root, 'supabase', 'migrations', '0224_coming_soon_events.sql'), 'utf8');
  undo = readFileSync(join(root, 'supabase', 'rollback', 'undo_0224.sql'), 'utf8');
  cron = readFileSync(join(root, 'api', 'cron', 'run.ts'), 'utf8');
});

describe('0224: checkout protection rests on the existing purchase gate', () => {
  it('refuses to apply unless every ticket-creating function refuses non-live events', () => {
    expect(m).toContain("p.proname IN ('create_pending_purchase', 'finalize_pending_purchase', 'purchase_ticket')");
    expect(m).toContain("IF position('status <> ''live''' IN r.prosrc) = 0 THEN");
    expect(m).toContain("does not refuse non-live events; Coming Soon would be purchasable");
    expect(m).toMatch(/purchase_ticket_with_tokens[\s\S]*no longer delegates to purchase_ticket/);
  });

  it('changes no purchase, payment, wallet or promotion function', () => {
    for (const name of ['create_pending_purchase', 'finalize_pending_purchase', 'purchase_ticket', 'purchase_ticket_with_tokens',
      'confirm_ticket_payment', 'confirm_ticket_payment_via_wallet', 'credit_organizer_wallet', 'refund_ticket', 'activate_event_promotion',
      'admin_set_event_trending', 'ticket_fee_quote', 'search_events_fuzzy']) {
      expect(m).not.toMatch(new RegExp(`(CREATE OR REPLACE|DROP) FUNCTION public\\.${name}\\b`));
    }
    expect(m).not.toMatch(/\b(wallet|ledger|payout|paystack)\w*\s*\(/i);
  });

  it('only adds coming_soon to the status CHECK (live and draft keep their meaning)', () => {
    expect(m).toContain("CHECK ((status = ANY (ARRAY['live'::text, 'draft'::text, 'coming_soon'::text])))");
    expect(m).toContain("CHECK (status <> 'coming_soon' OR sales_open_at IS NOT NULL)");
    expect(m).toContain('CHECK (sales_open_at IS NULL OR sales_open_at <= event_date)');
  });
});

describe('0224: guard trigger', () => {
  const g = () => fn('events_sales_schedule_guard');
  it('restricts client writes only, and is not SECURITY DEFINER (so current_user is the caller)', () => {
    expect(g()).toContain("IF current_user <> 'authenticated' THEN RETURN NEW; END IF;");
    expect(g().slice(0, g().indexOf('AS $function$'))).not.toMatch(/SECURITY DEFINER/); // header only (the body's comment mentions it)
  });
  it('a scheduled event cannot be set live directly; sales time only moves to the future, never cleared, frozen once live', () => {
    expect(g()).toMatch(/ELSIF NEW\.status = 'live' AND NEW\.sales_open_at IS NOT NULL THEN\s+RAISE EXCEPTION 'Ticket sales for this event open at the scheduled time/);
    expect(g()).toContain("A scheduled ticket sales opening cannot be removed");
    expect(g()).toContain("Ticket sales are already open; the opening time can no longer be changed");
    expect(g()).toContain("IF NEW.sales_open_at <= now() THEN");
  });
  it('Coming Soon needs the organizer capability, a never-sold and non-cancelled event', () => {
    expect(g()).toContain("IF NOT (COALESCE(public.is_organizer(), false) OR COALESCE(public.is_admin(), false)) THEN");
    expect(g()).toContain("IF OLD.status = 'live' OR public.event_has_sales_history(OLD.id) THEN");
    expect(g()).toContain("IF OLD.cancelled_at IS NOT NULL THEN");
  });
  it('event_has_sales_history answers only for the caller\'s own event (or an admin)', () => {
    expect(fn('event_has_sales_history')).toContain('AND (e.organizer_id = auth.uid() OR COALESCE(public.is_admin(), false))');
  });
});

describe('0224: opening sales', () => {
  const core = () => fn('event_open_sales_core');
  it('locks the row, refuses before sales_open_at, skips deleted/cancelled/hidden/ended, keeps the same row', () => {
    expect(core()).toContain('FROM public.events WHERE id = p_event_id FOR UPDATE;');
    expect(core()).toMatch(/IF e\.sales_open_at > now\(\) THEN[\s\S]*'not_due'/);
    for (const r of ['unavailable', 'hidden_by_admin', 'ended', 'already_open']) expect(core()).toContain(`'${r}'`);
    expect(core()).toContain("UPDATE public.events SET status = 'live' WHERE id = e.id;");
    expect(core()).not.toMatch(/INSERT INTO public\.events/);
    expect(core()).not.toMatch(/is_featured|featured_until|admin_trending/);
  });
  it('notifies each subscriber exactly once, in the same statement that marks them', () => {
    expect(core()).toMatch(/WITH due AS \(\s+UPDATE public\.event_sale_alerts a\s+SET notified_at = now\(\)\s+WHERE a\.event_id = e\.id AND a\.notified_at IS NULL\s+RETURNING a\.user_id\s+\)\s+INSERT INTO public\.notifications/);
    expect(core()).toContain("jsonb_build_object('type', 'event_sales_open', 'eventId', e.id::text)");
    expect(core()).toContain("'event_update'"); // an existing notifications_type_check value
  });
  it('the scheduler isolates failures per event and only opens coming_soon events', () => {
    const due = fn('open_due_event_sales');
    expect(due).toMatch(/BEGIN\s+v_res := public\.event_open_sales_core\(r\.id, false\);[\s\S]*EXCEPTION WHEN OTHERS THEN/);
    expect(due).toContain("WHERE status = 'coming_soon' AND sales_open_at <= now()");
  });
  it('grants: anyone may ask to open (never early); only project_admin runs the scheduler; nobody calls the core', () => {
    expect(m).toContain('GRANT EXECUTE ON FUNCTION public.open_event_sales(uuid) TO anon, authenticated, project_admin;');
    expect(m).toContain('GRANT EXECUTE ON FUNCTION public.open_due_event_sales(integer) TO project_admin;');
    expect(m).toContain('REVOKE ALL ON FUNCTION public.event_open_sales_core(uuid, boolean) FROM PUBLIC, anon, authenticated;');
    expect(m).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.event_open_sales_core/);
  });
  it('registers the per-minute pg_cron job only when pg_cron exists; the Vercel cron is a backstop', () => {
    expect(m).toContain("cron.schedule('vents_open_due_event_sales', '* * * * *', 'SELECT public.open_due_event_sales(200)')");
    expect(m).toContain("IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN");
    expect(cron).toContain("callProjectAdminRpc<any>('open_due_event_sales', [500])");
  });
});

describe('0224: Notify me subscriptions are private', () => {
  it('RLS: users read only their own rows; no client writes', () => {
    expect(m).toContain('ALTER TABLE public.event_sale_alerts ENABLE ROW LEVEL SECURITY;');
    expect(m).toMatch(/CREATE POLICY select_own_event_sale_alerts ON public\.event_sale_alerts\s+FOR SELECT TO authenticated\s+USING \(user_id = \(SELECT auth\.uid\(\)\)\);/);
    expect(m).toContain('REVOKE ALL ON public.event_sale_alerts FROM PUBLIC, anon, authenticated;');
    expect(m).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON public\.event_sale_alerts TO[^;]*authenticated/);
    expect(m).toContain('PRIMARY KEY (event_id, user_id)');
  });
  it('subscribe requires a signed-in user and a visible Coming Soon event; duplicates are a no-op', () => {
    const sub = fn('subscribe_event_sale_alert');
    expect(sub).toContain("IF v_uid IS NULL THEN RAISE EXCEPTION 'Sign in");
    expect(sub).toContain("IF e.status <> 'coming_soon' THEN RAISE EXCEPTION 'Event not found'; END IF;");
    expect(sub).toContain('ON CONFLICT (event_id, user_id) DO NOTHING;');
    expect(m).toMatch(/GRANT EXECUTE ON FUNCTION public\.subscribe_event_sale_alert\(uuid\) TO authenticated, project_admin;/);
  });
  it('organizers get counts for their own events only, never who', () => {
    const c = fn('get_my_event_sale_alert_counts');
    expect(c).toContain('WHERE e.organizer_id = auth.uid()');
    expect(c).toMatch(/RETURNS TABLE\(event_id uuid, subscribers integer, notified integer\)/);
    expect(c).not.toMatch(/a\.user_id\s*(,|AS|FROM)/);
  });
});

describe('undo_0224.sql', () => {
  it('is gated and refuses to drop Coming Soon events or pending subscriptions silently', () => {
    expect(undo).toContain("IF current_setting('vents.rollback_confirm', true) IS DISTINCT FROM 'undo-0224' THEN");
    expect(undo).toContain("vents.rollback_coming_soon_to_draft");
    expect(undo).toContain("vents.rollback_discard_sale_alerts");
  });
  it('restores 0005\'s status CHECK and removes only 0224 objects; its only data change is coming_soon -> draft', () => {
    expect(undo).toContain("ADD CONSTRAINT events_status_check CHECK ((status = ANY (ARRAY['live'::text, 'draft'::text])));");
    const sql = undo.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql.match(/\b(UPDATE\s+public\.\w+[^;]*|DELETE\s+FROM[^;]*|INSERT\s+INTO[^;]*|TRUNCATE[^;]*)/gi)).toEqual([
      "UPDATE public.events SET status = 'draft' WHERE status = 'coming_soon'",
    ]);
    expect(sql).not.toMatch(/\b(tickets|pending_purchases|notifications|wallet)\b/);
  });
});
