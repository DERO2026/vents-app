#!/usr/bin/env bash
# Real-execution verification of migration 0224 (Coming Soon events, Notify
# me alerts, scheduled sales opening) on the production-shaped money stack
# used by run-event-cancellation-verification.sh: 0201 -> 0219 plus the
# verbatim production purchase functions (live-money-functions.sql:
# create_pending_purchase, finalize_pending_purchase, confirm_ticket_payment
# -- each md5-pinned against production in 0203).
#
# Proves: lifecycle transitions and their guards (same event id throughout),
# that Coming Soon events cannot be bought through the real purchase
# functions and become purchasable -- at unchanged prices -- once opened,
# that sales never open early (scheduler, lazy open, organizer, direct
# writes), exactly-once Notify-me delivery (retries, concurrency, partial
# failure), RLS/privacy of subscriptions, time zone handling, and the undo.
#
# SAFETY: local PostgreSQL over its Unix socket only, in a database this
# script creates and always drops. Refuses to start if the environment points
# at any hosted database. Never reads .env files. No network.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
DB_NAME="vents_local_pg_coming_soon"
SOCKET_DIR="/var/run/postgresql"

die() { echo "REFUSING TO RUN: $1" >&2; exit 2; }
for var in DATABASE_URL PROJECT_ADMIN_DATABASE_URL SUPABASE_DB_URL POSTGRES_URL POSTGRES_PRISMA_URL \
           PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPASSWORD PGPASSFILE PGSSLMODE; do
  if [ -n "${!var:-}" ]; then die "\$$var is set. Unset it; this test only connects to the local Unix socket."; fi
done
if env | grep -qiE 'supabase\.(co|com)|pooler\.|rds\.amazonaws\.com|neon\.tech|render\.com'; then
  die "an environment variable references a hosted database host."
fi
[[ "$DB_NAME" =~ ^vents_local_pg_[a-z_]+$ ]] || die "database name '$DB_NAME' is not a local test name."
[ -S "$SOCKET_DIR/.s.PGSQL.5432" ] || die "no local PostgreSQL socket at $SOCKET_DIR (start it: pg_ctlcluster 16 main start)."
pg() { sudo -u postgres env -i PATH="/usr/bin:/bin" psql -h "$SOCKET_DIR" -p 5432 -v ON_ERROR_STOP=1 "$@"; }
PSQL=(pg -d "$DB_NAME")
server_check="$(pg -d postgres -tA -c "SELECT (inet_server_addr() IS NULL)::text || '/' || (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin'))::text;" | tail -n1)"
[ "$server_check" = "true/true" ] || die "connection is not a local, non-Supabase PostgreSQL server ($server_check)."

TMP=$(mktemp -d); OUT="$TMP/out"; ERR="$TMP/err"; PAYSTACK_LOG="$TMP/paystack_refund_calls"; : >"$PAYSTACK_LOG"
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT


TMP=$(mktemp -d); OUT="$TMP/out"; ERR="$TMP/err"
cleanup() { rm -rf "$TMP"; pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" >/dev/null 2>&1 || true; }
trap cleanup EXIT

ORG="00000000-0000-0000-0000-0000000d0a01"; ORG2="00000000-0000-0000-0000-0000000d0a02"
EXORG="00000000-0000-0000-0000-0000000d0a03"   # organizer capability revoked
ADMIN="00000000-0000-0000-0000-0000000d0a11"
U1="00000000-0000-0000-0000-0000000d0b01"; U2="00000000-0000-0000-0000-0000000d0b02"; U3="00000000-0000-0000-0000-0000000d0b03"
GONE="00000000-0000-0000-0000-0000000d0b04"    # deleted account
CTRL="00000000-0000-0000-0000-0000000d0e00"    # ordinary live event (control)
TT='[{"name": "Regular", "price": 10000, "quantity": 100}, {"name": "VIP", "price": 25000, "quantity": 10}]'

PASSES=0; FAILS=0
pass() { echo "PASS: $1"; PASSES=$((PASSES+1)); }
fail() { echo "FAIL: $1" >&2; FAILS=$((FAILS+1)); }
as() { printf "SET test.uid='%s'; SET ROLE authenticated; %s" "$1" "$2"; }
anon() { printf "SET ROLE anon; %s" "$1"; }  # fresh session: no test.uid
val() { "${PSQL[@]}" -tA -c "$1" 2>"$ERR" | tail -n1; }
valq() { "${PSQL[@]}" -q -tA -c "$1" 2>"$ERR"; }   # whole output, no command tags (multi-statement probes)
expect_value() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; cat "$ERR" >&2; fi; }
expect_ok() { if "${PSQL[@]}" -c "$2" >"$OUT" 2>"$ERR"; then pass "$1"; else fail "$1"; cat "$ERR" >&2; fi; }
expect_error() {
  if "${PSQL[@]}" -c "$3" >"$OUT" 2>"$ERR"; then fail "$1 (expected an exception, call succeeded)"; return; fi
  if grep -q -- "$2" "$ERR"; then pass "$1"; else fail "$1 (wrong error)"; cat "$ERR" >&2; fi
}
# An organizer creates an event through PostgREST (events insert under RLS).
create() {  # create <organizer> <status> <event_date sql> <sales_open_at sql|NULL> [title] -> id
  val "$(as "$1" "WITH i AS (INSERT INTO public.events (organizer_id, title, location, event_date, status, sales_open_at, ticket_types, ticket_goal)
        VALUES ('$1', '${5:-Afrobeats Live}', 'Eko Hotel, Lagos, Victoria Island', $3, '$2', $4, '$TT'::jsonb, 100) RETURNING id) SELECT id FROM i;")"
}
# Simulates the clock passing the planned opening (as the database owner, like time itself).
make_due() { "${PSQL[@]}" -q -c "UPDATE public.events SET sales_open_at = now() - interval '1 second' WHERE id = '$1';"; }
open_as() { val "$(as "$1" "SELECT public.open_event_sales('$2')::text;")"; }
open_anon() { val "$(anon "SELECT public.open_event_sales('$1')::text;")"; }
j() { echo "$1" | jq -r "$2"; }
status() { val "SELECT status FROM public.events WHERE id = '$1';"; }
notes() { val "SELECT count(*) FROM public.notifications WHERE push_data->>'eventId' = '$1' AND push_data->>'type' = 'event_sales_open';"; }
pending() {  # pending <buyer> <event> <ticket type> -> payment_ref (or error text)
  val "$(as "$1" "SELECT public.create_pending_purchase('$2', '$3', '[{\"name\": \"A\"}]'::jsonb, NULL, NULL)->>'payment_ref';")"
}

echo "== Building throwaway database $DB_NAME (0201 -> 0219 + production purchase functions) =="
pg -d postgres -q -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE);" -c "CREATE DATABASE $DB_NAME;"
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-vents-earn.sql" >/dev/null
for m in 0193_vents_earn_foundation 0196_recruiter_invite_target_uses_organizer_capability 0197_vents_earn_notifications_use_valid_type; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null
done
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-representative-rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$MIG/0201_vents_earn_representative_rewards.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-live-payout-extras.sql" >/dev/null
"${PSQL[@]}" -q -c "SET vents.migration_local_test = 'on';" -f "$MIG/0202_payout_engine_safety.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-earnings-policies.sql" >/dev/null
"${PSQL[@]}" -q -f "$SCRIPT_DIR/live-money-functions.sql" >/dev/null
for m in 0203_earnings_policies 0205_payout_cancelled_transfer_safety 0206_earnings_adjustment 0207_withdrawal_bank_reassignment 0208_ticket_fee_1_5_3_5 \
         0209_representative_referral_links 0210_referral_connections 0216_representative_rewards_free_events_never_qualify 0217_representative_reward_fixed_50000; do
  "${PSQL[@]}" -q -f "$MIG/$m.sql" >/dev/null 2>&1
done
"${PSQL[@]}" -q -f "$SCRIPT_DIR/schema-event-cancellation.sql" >/dev/null
"${PSQL[@]}" -q <<SQL
GRANT EXECUTE ON FUNCTION public.create_pending_purchase(uuid,text,jsonb,text,text), public.confirm_ticket_payment_via_wallet(text),
  public.refund_ticket(uuid,text), public.soft_delete_event(uuid,text), public.attach_ticket_refund_id(uuid,text),
  public.admin_revert_stuck_refund(uuid,text) TO authenticated;
-- Production shape of events access (0002 columns; 0012 grants; 0008 RLS
-- policies, verbatim): authenticated may UPDATE any column of an event it
-- organizes -- which is why the deletion guard is a trigger.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS deleted_by uuid;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS reason text;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.events TO authenticated;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS select_events ON public.events;
DROP POLICY IF EXISTS update_events ON public.events;
CREATE POLICY select_events ON public.events FOR SELECT TO public USING (((deleted_at IS NULL) OR (organizer_id = ( SELECT auth.uid() AS uid)) OR public.is_admin()));
CREATE POLICY update_events ON public.events FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = organizer_id) OR public.is_admin())) WITH CHECK (((( SELECT auth.uid() AS uid) = organizer_id) OR public.is_admin()));
GRANT SELECT ON public.tickets TO authenticated;
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tickets_local_read ON public.tickets;
-- Ticket holders, the event's organizer and admins read tickets (as production's select policies allow).
CREATE POLICY tickets_local_read ON public.tickets FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin()
  OR EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND e.organizer_id = auth.uid()));
-- (0218/0219 are applied below, after this block.)
-- Production pieces the base schema lacks, verbatim:
--   0005 events_status_check; 0121 is_organizer(); 0130 insert_events.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.events ADD CONSTRAINT events_status_check CHECK ((status = ANY (ARRAY['live'::text, 'draft'::text])));
CREATE OR REPLACE FUNCTION public.is_organizer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS \$function\$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND (is_organizer = true OR role = 'admin')
  );
\$function\$;
DROP POLICY IF EXISTS insert_events ON public.events;
CREATE POLICY insert_events ON public.events
  FOR INSERT
  WITH CHECK (((auth.uid() = organizer_id AND public.is_organizer()) OR public.is_admin()));
GRANT SELECT ON public.notifications TO authenticated;
DO \$r\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF; END \$r\$;
GRANT USAGE ON SCHEMA public, auth TO anon;
GRANT SELECT ON public.events TO anon;
INSERT INTO public.users (id, role, is_organizer, full_name, email) VALUES
  ('$ORG', 'user', true, 'Org One', 'org@example.test'), ('$ORG2', 'user', true, 'Org Two', 'org2@example.test'),
  ('$EXORG', 'user', false, 'Former Org', 'exorg@example.test'), ('$ADMIN', 'admin', false, 'Admin', 'a@example.test'),
  ('$U1', 'user', false, 'User One', 'u1@example.test'), ('$U2', 'user', false, 'User Two', 'u2@example.test'),
  ('$U3', 'user', false, 'User Three', 'u3@example.test'), ('$GONE', 'user', false, 'Gone', 'g@example.test');
INSERT INTO public.events (id, organizer_id, title, location, event_date, status, ticket_types, ticket_goal) VALUES
  ('$CTRL', '$ORG', 'Control live event', 'Eko Hotel, Lagos, Victoria Island', now() + interval '20 days', 'live', '$TT'::jsonb, 100);
SQL
"${PSQL[@]}" -q -f "$MIG/0218_event_cancellation_workflow.sql" >/dev/null 2>&1
"${PSQL[@]}" -q -f "$MIG/0219_event_cancellation_safety_fixes.sql" >/dev/null 2>&1
ALTER_ADMIN_COLS="ALTER TABLE public.events ADD COLUMN IF NOT EXISTS image_url text, ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS featured_until timestamptz, ADD COLUMN IF NOT EXISTS admin_trending boolean NOT NULL DEFAULT false;"
"${PSQL[@]}" -q -c "$ALTER_ADMIN_COLS"
# 0182's promotion/hidden guard, verbatim (latest definition).
python3 - "$MIG/0182_admin_manual_trending_control.sql" > "$TMP/protect.sql" <<'PY'
import sys; t=open(sys.argv[1]).read(); i=t.index('CREATE OR REPLACE FUNCTION public.protect_event_promotion_columns()'); j=t.index('$function$;', t.index('AS $function$', i)+12)+11; print(t[i:j])
PY
"${PSQL[@]}" -q < "$TMP/protect.sql"
"${PSQL[@]}" -q -c "CREATE TRIGGER trg_protect_event_promotion_columns BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.protect_event_promotion_columns();"

echo "== Migration 0224: precheck, apply =="
expect_error "precheck refuses if a purchase function stops refusing non-live events" "does not refuse non-live events" \
  "BEGIN; CREATE OR REPLACE FUNCTION public.purchase_ticket(p_event_id uuid) RETURNS void LANGUAGE sql AS 'SELECT NULL'; $(cat "$MIG/0224_coming_soon_events.sql") ROLLBACK;"
expect_value "the refused attempt changed nothing" "$(val "SELECT count(*) FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'sales_open_at';")" "0"
expect_ok "0224 applies in one transaction on top of 0201-0219" "BEGIN; $(cat "$MIG/0224_coming_soon_events.sql") COMMIT;"
# Determinism: the real per-minute job would race the tests below that make
# an event due and then open it themselves. Paused here; it runs only in the
# "real pg_cron job" section, which tests the scheduler itself.
cron_job() { "${PSQL[@]}" -q -c "SELECT cron.alter_job(jobid, active := $1) FROM cron.job WHERE jobname = 'vents_open_due_event_sales';" >/dev/null; }
cron_job false

echo "== Lifecycle: create Coming Soon (same id through every transition) =="
EV1=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '2 days'" "Afrobeats Live")
expect_value "organizer creates a Coming Soon event with a future sales time" "$(status "$EV1")" "coming_soon"
expect_error "Coming Soon without a sales time is refused" "events_coming_soon_sales_time" "$(as "$ORG" "INSERT INTO public.events (organizer_id, title, location, event_date, status) VALUES ('$ORG', 'X', 'L', now() + interval '9 days', 'coming_soon');")"
expect_error "a sales time in the past is refused" "must be in the future" "$(as "$ORG" "INSERT INTO public.events (organizer_id, title, location, event_date, status, sales_open_at) VALUES ('$ORG', 'X', 'L', now() + interval '9 days', 'coming_soon', now() - interval '1 minute');")"
expect_error "a sales time after the event starts is refused" "events_sales_open_before_start" "$(as "$ORG" "INSERT INTO public.events (organizer_id, title, location, event_date, status, sales_open_at) VALUES ('$ORG', 'X', 'L', now() + interval '9 days', 'coming_soon', now() + interval '10 days');")"
expect_error "a live event cannot be created with a future sales time" "published as Coming Soon" "$(as "$ORG" "INSERT INTO public.events (organizer_id, title, location, event_date, status, sales_open_at) VALUES ('$ORG', 'X', 'L', now() + interval '9 days', 'live', now() + interval '1 day');")"
expect_error "a non-organizer cannot create a live event (existing 0130 RLS, unchanged)" "row-level security" "$(as "$U1" "INSERT INTO public.events (organizer_id, title, location, event_date, status) VALUES ('$U1', 'X', 'L', now() + interval '9 days', 'live');")"
expect_error "a non-organizer cannot create a Coming Soon event (guard, then RLS)" "Only approved organizers" "$(as "$U1" "INSERT INTO public.events (organizer_id, title, location, event_date, status, sales_open_at) VALUES ('$U1', 'X', 'L', now() + interval '9 days', 'coming_soon', now() + interval '1 day');")"
expect_ok "existing flow unchanged: organizer still creates an ordinary live event" "$(as "$ORG" "INSERT INTO public.events (organizer_id, title, location, event_date, status, ticket_types) VALUES ('$ORG', 'Plain live', 'L', now() + interval '9 days', 'live', '$TT'::jsonb);")"
expect_ok "existing flow unchanged: ordinary draft -> live -> draft toggle" "$(as "$ORG" "UPDATE public.events SET status = 'draft' WHERE title = 'Plain live'; UPDATE public.events SET status = 'live' WHERE title = 'Plain live';")"

echo "== Lifecycle: Draft -> Coming Soon, edits, and refused shortcuts =="
DR=$(create "$ORG" draft "now() + interval '30 days'" NULL "Draft show")
expect_ok "draft -> Coming Soon with a future sales time" "$(as "$ORG" "UPDATE public.events SET status = 'coming_soon', sales_open_at = now() + interval '1 day' WHERE id = '$DR';")"
expect_value "same event id, now coming_soon" "$(val "SELECT id || '/' || status FROM public.events WHERE id = '$DR';")" "$DR/coming_soon"
expect_ok "organizer edits details and the flyer before sales open" "$(as "$ORG" "UPDATE public.events SET title = 'Draft show (new date)', image_url = 'https://cdn.example.test/flyer2.jpg', event_date = now() + interval '40 days' WHERE id = '$DR';")"
expect_ok "organizer moves the sales time to another future time" "$(as "$ORG" "UPDATE public.events SET sales_open_at = now() + interval '3 days' WHERE id = '$DR';")"
expect_error "moving the sales time into the past is refused" "must be in the future" "$(as "$ORG" "UPDATE public.events SET sales_open_at = now() - interval '1 hour' WHERE id = '$DR';")"
expect_error "removing the sales time is refused" "cannot be removed" "$(as "$ORG" "UPDATE public.events SET sales_open_at = NULL WHERE id = '$DR';")"
expect_error "Coming Soon -> live directly is refused (sales cannot open early)" "open at the scheduled time" "$(as "$ORG" "UPDATE public.events SET status = 'live' WHERE id = '$DR';")"
expect_ok "Coming Soon -> hidden as draft is allowed" "$(as "$ORG" "UPDATE public.events SET status = 'draft' WHERE id = '$DR';")"
expect_error "hidden scheduled event -> live directly is refused too (Manage Events 'Make Live' path)" "open at the scheduled time" "$(as "$ORG" "UPDATE public.events SET status = 'live' WHERE id = '$DR';")"
expect_ok "draft -> Coming Soon again" "$(as "$ORG" "UPDATE public.events SET status = 'coming_soon' WHERE id = '$DR';")"
expect_error "an admin also cannot set a scheduled event live directly" "open at the scheduled time" "$(as "$ADMIN" "UPDATE public.events SET status = 'live' WHERE id = '$DR';")"
"${PSQL[@]}" -q -c "$(as "$ORG2" "UPDATE public.events SET title = 'hijack' WHERE id = '$DR';")" >/dev/null 2>&1 || true
expect_value "another organizer's update touched nothing" "$(val "SELECT title FROM public.events WHERE id = '$DR';")" "Draft show (new date)"
# Admins hide events through their admin RPC (SECURITY DEFINER), as here.
expect_ok "an admin hides a Coming Soon event (hidden_by_admin)" "UPDATE public.events SET hidden_by_admin = true WHERE id = '$DR';"
expect_error "the organizer cannot unhide it (existing 0182 guard)" "hidden_by_admin can only be changed by an admin" "$(as "$ORG" "UPDATE public.events SET hidden_by_admin = false WHERE id = '$DR';")"

EXEV=$(val "WITH i AS (INSERT INTO public.events (organizer_id, title, location, event_date, status) VALUES ('$EXORG', 'Old draft', 'L', now() + interval '9 days', 'draft') RETURNING id) SELECT id FROM i;")
expect_error "a user whose organizer capability was revoked cannot publish as Coming Soon" "Only approved organizers" "$(as "$EXORG" "UPDATE public.events SET status = 'coming_soon', sales_open_at = now() + interval '1 day' WHERE id = '$EXEV';")"

echo "== Lifecycle: events that were on sale, or cancelled, never become Coming Soon =="
expect_error "live -> Coming Soon is refused" "cannot go back to Coming Soon" "$(as "$ORG" "UPDATE public.events SET status = 'coming_soon', sales_open_at = now() + interval '1 day' WHERE id = '$CTRL';")"
REF=$(pending "$U1" "$CTRL" Regular)
expect_ok "control event: a real purchase goes through" "SELECT public.finalize_pending_purchase('$REF'); SELECT public.confirm_ticket_payment('$REF', $(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$REF';"));"
expect_ok "organizer hides the sold event as a draft (existing behaviour)" "$(as "$ORG" "UPDATE public.events SET status = 'draft' WHERE id = '$CTRL';")"
expect_error "live -> draft -> Coming Soon is refused once anything was sold" "cannot go back to Coming Soon" "$(as "$ORG" "UPDATE public.events SET status = 'coming_soon', sales_open_at = now() + interval '1 day' WHERE id = '$CTRL';")"
"${PSQL[@]}" -q -c "$(as "$ORG" "UPDATE public.events SET status = 'live' WHERE id = '$CTRL';")"
CXL=$(create "$ORG" draft "now() + interval '30 days'" NULL "Cancelled show")
"${PSQL[@]}" -q <<SQL
INSERT INTO public.event_cancellation_requests (id, event_id, organizer_id, reason, status, decided_at, decided_by)
VALUES ('00000000-0000-0000-0000-0000000d0c01', '$CXL', '$ORG', 'Venue withdrew, cannot proceed', 'completed', now(), '$ADMIN');
UPDATE public.events SET cancelled_at = now(), cancellation_request_id = '00000000-0000-0000-0000-0000000d0c01' WHERE id = '$CXL';
SQL
expect_error "a cancelled event cannot be published as Coming Soon" "was cancelled" "$(as "$ORG" "UPDATE public.events SET status = 'coming_soon', sales_open_at = now() + interval '1 day' WHERE id = '$CXL';")"

echo "== Checkout: Coming Soon events cannot be bought (real production purchase functions) =="
expect_error "create_pending_purchase refuses a Coming Soon event" "not currently open for ticket purchases" "$(as "$U1" "SELECT public.create_pending_purchase('$EV1', 'Regular', '[{\"name\": \"A\"}]'::jsonb, NULL, NULL);")"
expect_error "... as a payment request for someone else too" "not currently open for ticket purchases" "$(as "$U1" "SELECT public.create_pending_purchase('$EV1', 'VIP', '[{\"name\": \"A\"}]'::jsonb, NULL, 'u2@example.test');")"
expect_value "no pending purchase or ticket exists for it" "$(val "SELECT (SELECT count(*) FROM public.pending_purchases WHERE event_id = '$EV1') || '/' || (SELECT count(*) FROM public.tickets WHERE event_id = '$EV1');")" "0/0"
expect_error "a client cannot write a ticket row directly" "permission denied" "$(as "$U1" "INSERT INTO public.tickets (event_id, user_id, ticket_type) VALUES ('$EV1', '$U1', 'Regular');")"
expect_error "a client cannot flip the status column to bypass it" "open at the scheduled time" "$(as "$ORG" "UPDATE public.events SET status = 'live' WHERE id = '$EV1';")"

echo "== Notify me: subscribe, duplicates, privacy =="
expect_error "signed-out users cannot subscribe" "permission denied" "$(anon "SELECT public.subscribe_event_sale_alert('$EV1');")"
expect_error "no auth.uid() cannot subscribe" "Sign in" "SELECT public.subscribe_event_sale_alert('$EV1');"
R=$(val "$(as "$U1" "SELECT public.subscribe_event_sale_alert('$EV1')::text;")"); expect_value "U1 subscribes" "$(j "$R" '.subscribed,.created' | tr '\n' /)" "true/true/"
R=$(val "$(as "$U1" "SELECT public.subscribe_event_sale_alert('$EV1')::text;")"); expect_value "subscribing twice is a no-op (no duplicate)" "$(j "$R" '.created')" "false"
expect_value "exactly one subscription row for U1" "$(val "SELECT count(*) FROM public.event_sale_alerts WHERE event_id = '$EV1' AND user_id = '$U1';")" "1"
for u in "$U2" "$U3" "$GONE"; do "${PSQL[@]}" -q -c "$(as "$u" "SELECT public.subscribe_event_sale_alert('$EV1');")" >/dev/null; done
expect_value "U1 sees only their own subscription" "$(val "$(as "$U1" "SELECT count(*) || '/' || bool_and(user_id = '$U1') FROM public.event_sale_alerts;")")" "1/true"
expect_value "the organizer cannot read subscriber rows" "$(val "$(as "$ORG" "SELECT count(*) FROM public.event_sale_alerts;")")" "0"
expect_error "anon cannot read subscriptions" "permission denied" "$(anon "SELECT count(*) FROM public.event_sale_alerts;")"
expect_error "a client cannot insert a subscription directly" "permission denied" "$(as "$U1" "INSERT INTO public.event_sale_alerts (event_id, user_id) VALUES ('$EV1', '$U2');")"
expect_error "a client cannot mark itself notified" "permission denied" "$(as "$U1" "UPDATE public.event_sale_alerts SET notified_at = now();")"
expect_value "organizer sees a count only (4 subscribers), no identities" "$(val "$(as "$ORG" "SELECT subscribers || '/' || notified FROM public.get_my_event_sale_alert_counts() WHERE event_id = '$EV1';")")" "4/0"
expect_value "another organizer gets no count for it" "$(val "$(as "$ORG2" "SELECT count(*) FROM public.get_my_event_sale_alert_counts() WHERE event_id = '$EV1';")")" "0"
expect_value "event_has_sales_history reveals nothing about someone else's event" "$(val "$(as "$U1" "SELECT public.event_has_sales_history('$CTRL');")")" "f"
expect_error "subscribing to an ordinary live event is refused" "already on sale" "$(as "$U1" "SELECT public.subscribe_event_sale_alert('$CTRL');")"
expect_error "subscribing to an admin-hidden event is refused" "Event not found" "$(as "$U1" "SELECT public.subscribe_event_sale_alert('$DR');")"
expect_error "subscribing to a draft is refused" "Event not found" "$(as "$U1" "SELECT public.subscribe_event_sale_alert('$EXEV');")"
"${PSQL[@]}" -q -c "$(as "$U3" "SELECT public.unsubscribe_event_sale_alert('$EV1');")" >/dev/null
expect_value "U3 unsubscribes" "$(val "SELECT count(*) FROM public.event_sale_alerts WHERE event_id = '$EV1' AND user_id = '$U3';")" "0"
"${PSQL[@]}" -q -c "$(as "$U3" "SELECT public.subscribe_event_sale_alert('$EV1');")" >/dev/null; "${PSQL[@]}" -q -c "$(as "$U3" "SELECT public.unsubscribe_event_sale_alert('$EV1');")" >/dev/null
expect_value "re-subscribe then unsubscribe again leaves no row" "$(val "SELECT count(*) FROM public.event_sale_alerts WHERE event_id = '$EV1' AND user_id = '$U3';")" "0"
"${PSQL[@]}" -q -c "UPDATE public.users SET deleted_at = now() WHERE id = '$GONE';"

echo "== Opening: never early =="
R=$(open_anon "$EV1"); expect_value "opening before the sales time does nothing (anon)" "$(j "$R" '.opened,.reason' | tr '\n' /)" "false/not_due/"
R=$(open_as "$ORG" "$EV1"); expect_value "... nor for the organizer" "$(j "$R" '.reason')" "not_due"
expect_value "open_due_event_sales skips events not yet due" "$(val "SELECT public.open_due_event_sales(50)->>'opened';")" "0"
expect_value "still Coming Soon, nobody notified" "$(status "$EV1")/$(notes "$EV1")" "coming_soon/0"

echo "== Opening: time zones =="
TZ_EV=$(create "$ORG" coming_soon "now() + interval '30 days'" "(to_char((now() + interval '2 minutes') AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD\"T\"HH24:MI:SS') || '+01:00')::timestamptz" "Lagos time show")
expect_value "a sales time entered in Lagos time (+01:00) is stored as the same instant in UTC" \
  "$(val "SELECT abs(extract(epoch FROM (sales_open_at - (now() + interval '2 minutes')))) < 2 FROM public.events WHERE id = '$TZ_EV';")" "t"
R=$(open_anon "$TZ_EV"); expect_value "two minutes ahead in Lagos time is not due yet" "$(j "$R" '.reason')" "not_due"

echo "== Opening: the scheduled time arrives =="
"${PSQL[@]}" -q -c "UPDATE public.events SET image_url = 'https://cdn.example.test/flyer.jpg', is_featured = false WHERE id = '$EV1';"
FP="SELECT md5(row(id, title, image_url, organizer_id, location, event_date, ticket_types, ticket_goal, is_featured, featured_until, admin_trending, hidden_by_admin)::text) FROM public.events WHERE id = '$EV1';"
BEFORE=$(val "$FP")
make_due "$EV1"
R=$(open_anon "$EV1"); expect_value "first viewer's lazy open opens it and notifies subscribers once (U1, U2; not the deleted account)" "$(j "$R" '.opened,.notified' | tr '\n' /)" "true/2/"
expect_value "same event row, now live" "$(val "SELECT count(*) || '/' || max(status) FROM public.events WHERE id = '$EV1';")" "1/live"
AFTER=$(val "$FP")
expect_value "flyer, details, organizer, venue, tickets and promotion flags unchanged" "$AFTER" "$BEFORE"
expect_value "no duplicate event was created" "$(val "SELECT count(*) FROM public.events WHERE title = 'Afrobeats Live';")" "1"
expect_value "each subscriber got one notification linking to the event (type, icon, push_data)" \
  "$(val "SELECT string_agg(user_id::text || ':' || type || ':' || icon || ':' || (push_data->>'eventId' = '$EV1'), ',' ORDER BY user_id) FROM public.notifications WHERE push_data->>'type' = 'event_sales_open';")" \
  "$U1:event_update:🎟️:true,$U2:event_update:🎟️:true"
expect_value "U1 can read their in-app notification (no push token needed)" "$(val "$(as "$U1" "SELECT count(*) FROM public.notifications WHERE user_id = '$U1' AND push_data->>'type' = 'event_sales_open';")")" "1"
expect_value "subscriptions are marked notified" "$(val "SELECT count(*) FILTER (WHERE notified_at IS NOT NULL) || '/' || count(*) FROM public.event_sale_alerts WHERE event_id = '$EV1';")" "3/3"
R=$(open_anon "$EV1"); expect_value "opening again is a no-op" "$(j "$R" '.reason')" "already_open"
expect_value "open_due_event_sales finds nothing more for it" "$(val "SELECT public.open_due_event_sales(50)->>'opened';")" "0"
expect_value "still exactly one notification per subscriber" "$(notes "$EV1")" "2"
expect_value "organizer count after opening: 3 subscribed, 3 marked notified" "$(val "$(as "$ORG" "SELECT subscribers || '/' || notified FROM public.get_my_event_sale_alert_counts() WHERE event_id = '$EV1';")")" "3/3"
expect_error "Notify me on an event already on sale is refused" "already on sale" "$(as "$U3" "SELECT public.subscribe_event_sale_alert('$EV1');")"
"${PSQL[@]}" -q -c "$(as "$U1" "SELECT public.unsubscribe_event_sale_alert('$EV1');")" >/dev/null
expect_value "unsubscribing after delivery keeps the delivered record" "$(val "SELECT count(*) FROM public.event_sale_alerts WHERE event_id = '$EV1' AND user_id = '$U1';")" "1"
expect_error "sales time is frozen once sales are open" "can no longer be changed" "$(as "$ORG" "UPDATE public.events SET sales_open_at = now() + interval '1 day' WHERE id = '$EV1';")"

echo "== Checkout: sales open at the right time, prices unchanged =="
REF=$(pending "$U1" "$EV1" VIP)
expect_value "create_pending_purchase now succeeds" "$(test -n "$REF" && echo ok)" "ok"
CREF=$(pending "$U2" "$CTRL" VIP)
expect_value "amount charged equals an identical ordinary live event (fees untouched)" \
  "$(val "SELECT (SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$REF') = (SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$CREF');")" "t"
expect_ok "the purchase finalizes and is confirmed" "SELECT public.finalize_pending_purchase('$REF'); SELECT public.confirm_ticket_payment('$REF', $(val "SELECT amount_kobo FROM public.pending_purchases WHERE payment_ref = '$REF';"));"
expect_value "a paid ticket exists on the same event id" "$(val "SELECT count(*) FROM public.tickets WHERE event_id = '$EV1' AND payment_status = 'paid';")" "1"

echo "== Scheduler: batch, hidden/deleted/ended skipped, failures isolated and retried =="
A=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Batch A")
B=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Batch B")
H=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Hidden C")
X=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Deleted D")
E=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Ended E")
for ev in "$A" "$B" "$H"; do for u in "$U1" "$U2"; do "${PSQL[@]}" -q -c "$(as "$u" "SELECT public.subscribe_event_sale_alert('$ev');")" >/dev/null; done; done
for ev in "$A" "$B" "$H" "$X" "$E"; do make_due "$ev"; done
"${PSQL[@]}" -q -c "UPDATE public.events SET hidden_by_admin = true WHERE id = '$H';" -c "UPDATE public.events SET deleted_at = now() WHERE id = '$X';" \
  -c "UPDATE public.events SET event_date = now() - interval '3 days', sales_open_at = now() - interval '4 days' WHERE id = '$E';"
# Batch B's notification insert fails once (e.g. a transient error): it must not block A or lose B.
"${PSQL[@]}" -q -c "CREATE FUNCTION public.boom() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN IF NEW.body LIKE 'Batch B%' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END \$\$; CREATE TRIGGER t_boom BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.boom();"
R=$(val "SELECT public.open_due_event_sales(50)::text;")
expect_value "run 1: A opened (2 notified), B failed and was isolated" "$(j "$R" '.opened,.notified,.failed' | tr '\n' /)" "1/2/1/"
expect_value "B stays Coming Soon with no partial delivery (all-or-nothing)" "$(status "$B")/$(notes "$B")/$(val "SELECT count(notified_at) FROM public.event_sale_alerts WHERE event_id = '$B';")" "coming_soon/0/0"
expect_value "hidden, deleted and ended events were not opened" "$(status "$H")/$(status "$X")/$(status "$E")" "coming_soon/coming_soon/coming_soon"
"${PSQL[@]}" -q -c "DROP TRIGGER t_boom ON public.notifications; DROP FUNCTION public.boom();"
R=$(val "SELECT public.open_due_event_sales(50)::text;")
expect_value "run 2 (delayed retry): B opens, its 2 subscribers notified once" "$(j "$R" '.opened,.notified,.failed' | tr '\n' /)" "1/2/0/"
expect_value "A was not notified twice" "$(notes "$A")" "2"
"${PSQL[@]}" -q -c "UPDATE public.events SET hidden_by_admin = false WHERE id = '$H';"
expect_value "after an admin unhides it, the next run opens the hidden one" "$(val "SELECT public.open_due_event_sales(50)->>'opened';")/$(status "$H")/$(notes "$H")" "1/live/2"

echo "== Opening: concurrent openers notify once =="
C=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Race F")
for u in "$U1" "$U2" "$U3"; do "${PSQL[@]}" -q -c "$(as "$u" "SELECT public.subscribe_event_sale_alert('$C');")" >/dev/null; done
make_due "$C"
( "${PSQL[@]}" -q -c "BEGIN; SELECT public.event_open_sales_core('$C', false); SELECT pg_sleep(1); COMMIT;" >/dev/null 2>&1 & )
sleep 0.3
R=$(open_anon "$C"); sleep 1.2
R2=$(val "SELECT public.open_due_event_sales(50)::text;")
expect_value "the racing anon call waited on the row lock and found it already open" "$(j "$R" '.reason')" "already_open"
expect_value "exactly one notification per subscriber after the race" "$(notes "$C")" "3"

echo "== Notify me racing the opening: nobody is missed =="
RA=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Race subscribe A")
make_due "$RA"
# The opening holds the event row; a subscription arriving meanwhile waits, then sees it on sale.
( "${PSQL[@]}" -q -c "BEGIN; SELECT public.event_open_sales_core('$RA', false); SELECT pg_sleep(1.5); COMMIT;" >/dev/null 2>&1 & )
sleep 0.4
"${PSQL[@]}" -c "$(as "$U3" "SELECT public.subscribe_event_sale_alert('$RA');")" >/dev/null 2>"$ERR" || true
sleep 1.5
if grep -q "already on sale" "$ERR"; then pass "a subscription during the opening waited, then was told tickets are on sale"; else fail "subscription during opening not serialized"; cat "$ERR" >&2; fi
expect_value "no orphan (never-notified) subscription was left behind" "$(val "SELECT count(*) FROM public.event_sale_alerts WHERE event_id = '$RA' AND notified_at IS NULL;")" "0"
RB=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Race subscribe B")
make_due "$RB"
# A subscription in flight holds a share lock; the opening waits for it, then notifies it.
( "${PSQL[@]}" -q -c "$(as "$U3" "BEGIN; SELECT public.subscribe_event_sale_alert('$RB'); SELECT pg_sleep(1.5); COMMIT;")" >/dev/null 2>&1 & )
sleep 0.4
R=$(open_anon "$RB"); sleep 0.3
expect_value "an opening during a subscription waited for it and notified that subscriber" "$(j "$R" '.opened,.notified' | tr '\n' /)" "true/1/"

echo "== Opening: a hidden-as-draft scheduled event =="
DH=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Draft hidden G")
"${PSQL[@]}" -q -c "$(as "$ORG" "UPDATE public.events SET status = 'draft' WHERE id = '$DH';")"
make_due "$DH"
expect_value "the scheduler never opens a draft" "$(val "SELECT public.open_due_event_sales(50)->>'opened';")/$(status "$DH")" "0/draft"
R=$(open_anon "$DH"); expect_value "a stranger cannot open a draft" "$(j "$R" '.reason')/$(status "$DH")" "not_scheduled/draft"
R=$(open_as "$ORG2" "$DH"); expect_value "another organizer cannot open it" "$(j "$R" '.reason')" "not_scheduled"
R=$(open_as "$ORG" "$DH"); expect_value "its organizer can open it once due" "$(j "$R" '.opened')/$(status "$DH")" "true/live"

echo "== Privileged paths can't open sales either (only open_event_sales can) =="
python3 - "$MIG/0004_functions.sql" > "$TMP/restore.sql" <<'PY'
import re,sys
t=open(sys.argv[1]).read()
for n in ['is_admin_or_root','admin_restore_deleted_event']:
    m=list(re.finditer(r'CREATE OR REPLACE FUNCTION public\.'+n+r'\([\s\S]*?AS \$function\$[\s\S]*?\$function\$',t))
    if m: print(m[-1].group(0)+';')
PY
"${PSQL[@]}" -q < "$TMP/restore.sql"
RS=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '2 days'" "Restore me")
"${PSQL[@]}" -q -c "$(as "$U1" "SELECT public.subscribe_event_sale_alert('$RS');")" >/dev/null
"${PSQL[@]}" -q -c "$(as "$ORG" "SELECT public.soft_delete_event('$RS', 'oops');")" >/dev/null 2>&1 || "${PSQL[@]}" -q -c "UPDATE public.events SET deleted_at = now(), status = 'draft' WHERE id = '$RS';"
expect_value "deleted Coming Soon event is a deleted draft" "$(val "SELECT status || '/' || (deleted_at IS NOT NULL) FROM public.events WHERE id = '$RS';")" "draft/true"
expect_ok "admin restores it (verbatim 0004 admin_restore_deleted_event, which sets status 'live')" "$(as "$ADMIN" "SELECT public.admin_restore_deleted_event('$RS');")"
expect_value "it comes back as Coming Soon, NOT on sale before its time" "$(status "$RS")" "coming_soon"
expect_value "... and nobody was notified" "$(notes "$RS")" "0"
expect_error "... so it still can't be bought" "not currently open for ticket purchases" "$(as "$U2" "SELECT public.create_pending_purchase('$RS', 'Regular', '[{\"name\": \"A\"}]'::jsonb, NULL, NULL);")"
PLAIN_DEL=$(create "$ORG" draft "now() + interval '30 days'" NULL "Plain deleted")
"${PSQL[@]}" -q -c "UPDATE public.events SET deleted_at = now() WHERE id = '$PLAIN_DEL';"
expect_ok "restoring an ordinary deleted event (no schedule)" "$(as "$ADMIN" "SELECT public.admin_restore_deleted_event('$PLAIN_DEL');")"
expect_value "... still goes live exactly as before (unchanged behaviour)" "$(status "$PLAIN_DEL")" "live"
expect_ok "the table owner (maintenance SQL; the role SECURITY DEFINER functions run as) setting a scheduled event live" "UPDATE public.events SET status = 'live' WHERE id = '$RS';"
expect_value "... keeps it Coming Soon" "$(status "$RS")" "coming_soon"
expect_ok "even with the opening marker set for a DIFFERENT event" "SELECT set_config('vents.event_sales_opening', '$EV1', false); UPDATE public.events SET status = 'live' WHERE id = '$RS';"
expect_value "... it stays Coming Soon" "$(status "$RS")" "coming_soon"
expect_error "a client that sets the marker itself is still refused" "open at the scheduled time" "$(as "$ORG" "SELECT set_config('vents.event_sales_opening', '$RS', false); UPDATE public.events SET status = 'live' WHERE id = '$RS';")"
make_due "$RS"
R=$(open_anon "$RS"); expect_value "when due, open_event_sales opens it and notifies its subscriber once" "$(j "$R" '.opened,.notified' | tr '\n' /)" "true/1/"

echo "== Scheduler: the real pg_cron job (every minute) =="
cron_job true
expect_value "0224 enabled pg_cron" "$(val "SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron';")" "1"
expect_value "the job is registered every minute, calling open_due_event_sales(200), active" \
  "$(val "SELECT schedule || '|' || command || '|' || active FROM cron.job WHERE jobname = 'vents_open_due_event_sales';")" "* * * * *|SELECT public.open_due_event_sales(200)|true"
expect_value "its run log is pruned daily (this job's rows only)" "$(val "SELECT count(*) FROM cron.job WHERE jobname = 'vents_open_due_event_sales_log_cleanup' AND command LIKE '%jobname = ''vents_open_due_event_sales''%';")" "1"
SCH=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Scheduled by cron")
LATER=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '1 day'" "Not due yet")
for u in "$U1" "$U2"; do "${PSQL[@]}" -q -c "$(as "$u" "SELECT public.subscribe_event_sale_alert('$SCH');")" >/dev/null; done
make_due "$SCH"
RUNS_BEFORE=$(val "SELECT count(*) FROM cron.job_run_details d JOIN cron.job j USING (jobid) WHERE j.jobname = 'vents_open_due_event_sales';")
echo "   (waiting for pg_cron's next minute tick, up to 75s)"
for i in $(seq 1 75); do [ "$(status "$SCH")" = "live" ] && break; sleep 1; done
expect_value "pg_cron opened the due event on its own, within a minute" "$(status "$SCH")" "live"
expect_value "... and notified its two subscribers exactly once" "$(notes "$SCH")" "2"
expect_value "... the run is recorded as succeeded" "$(val "SELECT count(*) > $RUNS_BEFORE AND bool_and(status = 'succeeded') FROM cron.job_run_details d JOIN cron.job j USING (jobid) WHERE j.jobname = 'vents_open_due_event_sales';")" "t"
expect_value "the same run left a not-yet-due event closed (never early)" "$(status "$LATER")" "coming_soon"
cron_job false

echo "== Grants =="
expect_value "anon cannot run the scheduler" "$(val "SELECT has_function_privilege('anon', 'public.open_due_event_sales(integer)', 'EXECUTE');")" "f"
expect_value "authenticated cannot run the scheduler" "$(val "SELECT has_function_privilege('authenticated', 'public.open_due_event_sales(integer)', 'EXECUTE');")" "f"
expect_value "nobody calls the core opener directly" "$(val "SELECT has_function_privilege('authenticated', 'public.event_open_sales_core(uuid,boolean)', 'EXECUTE') OR has_function_privilege('anon', 'public.event_open_sales_core(uuid,boolean)', 'EXECUTE');")" "f"
expect_value "anon cannot subscribe" "$(val "SELECT has_function_privilege('anon', 'public.subscribe_event_sale_alert(uuid)', 'EXECUTE');")" "f"

echo "== 0225: promotions -- production shape before the fix (verbatim 0002/0005/0007/0008/0012/0181 + 0180/0090/0182) =="
"${PSQL[@]}" -q <<SQL
CREATE TABLE public.event_promotions (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, event_id uuid NOT NULL, organizer_id uuid NOT NULL, plan_type text NOT NULL, start_date timestamptz NOT NULL, end_date timestamptz NOT NULL, status text NOT NULL DEFAULT 'active'::text, created_at timestamptz NOT NULL DEFAULT now(), payment_ref text);
ALTER TABLE public.event_promotions ADD CONSTRAINT event_promotions_plan_type_check CHECK ((plan_type = ANY (ARRAY['featured'::text, 'trending'::text, 'boosted'::text])));
ALTER TABLE public.event_promotions ADD CONSTRAINT event_promotions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'expired'::text, 'pending'::text])));
CREATE UNIQUE INDEX idx_event_promotions_payment_ref ON public.event_promotions USING btree (payment_ref);
ALTER TABLE public.event_promotions ENABLE ROW LEVEL SECURITY;
CREATE POLICY delete_event_promotions ON public.event_promotions FOR DELETE TO authenticated USING ((organizer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY insert_event_promotions ON public.event_promotions FOR INSERT TO authenticated WITH CHECK (((organizer_id = ( SELECT auth.uid() AS uid)) AND (event_id IN ( SELECT events.id
   FROM public.events
  WHERE (events.organizer_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY update_event_promotions ON public.event_promotions FOR UPDATE TO authenticated USING ((organizer_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((organizer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY select_event_promotions ON public.event_promotions FOR SELECT TO authenticated USING (organizer_id = (SELECT auth.uid()));
GRANT DELETE, INSERT, SELECT, UPDATE ON public.event_promotions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_promotions TO project_admin;
SQL
python3 - "$MIG" > "$TMP/promo_fns.sql" <<'PY'
import re,sys
m=sys.argv[1]
for n,f in [('activate_event_promotion','0180_reject_boosted_event_promotion_activation'),('admin_set_event_featured','0090_harden_event_featuring'),('admin_set_event_trending','0182_admin_manual_trending_control')]:
    t=open(f'{m}/{f}.sql').read()
    print(list(re.finditer(r'CREATE OR REPLACE FUNCTION public\.'+n+r'\([\s\S]*?AS \$function\$[\s\S]*?\$function\$',t))[-1].group(0)+';')
PY
"${PSQL[@]}" -q < "$TMP/promo_fns.sql"
# Production grants, verbatim (0137, 0090, 0182).
"${PSQL[@]}" -q <<'SQL'
REVOKE ALL ON FUNCTION public.activate_event_promotion(uuid, text, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_event_promotion(uuid, text, integer, text, uuid) TO project_admin;
REVOKE ALL ON FUNCTION public.admin_set_event_featured(uuid, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_event_featured(uuid, boolean, integer) TO authenticated, project_admin;
REVOKE ALL ON FUNCTION public.admin_set_event_trending(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_event_trending(uuid, boolean) TO authenticated, project_admin;
SQL
"${PSQL[@]}" -q -c "ALTER TABLE public.admin_logs ALTER COLUMN admin_id DROP NOT NULL;" 2>/dev/null || true
P_LIVE=$(create "$ORG" live "now() + interval '30 days'" NULL "Promo live")
P_DRAFT=$(create "$ORG" draft "now() + interval '30 days'" NULL "Promo draft")
P_CS=$(create "$ORG" coming_soon "now() + interval '30 days'" "now() + interval '2 days'" "Promo coming soon")
P_HID=$(create "$ORG" live "now() + interval '30 days'" NULL "Promo hidden")
P_END=$(create "$ORG" live "now() + interval '30 days'" NULL "Promo ended")
P_DEL=$(create "$ORG" live "now() + interval '30 days'" NULL "Promo deleted")
"${PSQL[@]}" -q -c "UPDATE public.events SET hidden_by_admin = true WHERE id = '$P_HID';" -c "UPDATE public.events SET event_date = now() - interval '3 days' WHERE id = '$P_END';" -c "UPDATE public.events SET deleted_at = now() WHERE id = '$P_DEL';"
activate() { printf "SELECT public.activate_event_promotion('%s', '%s', 7, '%s', '%s');" "$1" "$2" "$3" "${4:-$ORG}"; }
# The holes, demonstrated on the pre-0225 definitions (each rolled back).
expect_ok "BEFORE 0225: an organizer can INSERT a free 'active' trending promotion row directly (the hole)" \
  "BEGIN; $(as "$ORG" "INSERT INTO public.event_promotions (event_id, organizer_id, plan_type, start_date, end_date, status) VALUES ('$P_LIVE', '$ORG', 'trending', now(), now() + interval '30 days', 'active');") ROLLBACK;"
expect_ok "BEFORE 0225: the paid path activates Featured on a Coming Soon event (the hole)" "BEGIN; $(activate "$P_CS" featured REF_HOLE) ROLLBACK;"
PIN_BEFORE=$(val "SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('activate_event_promotion','admin_set_event_featured','admin_set_event_trending');")

echo "== 0225: approved fingerprints for admin_set_event_featured (repo body, or the verified production body) =="
# The verified production body = the repo body (0090) without its two comment
# lines. Variants built from it: one code change, and a different comment.
python3 - "$MIG/0090_harden_event_featuring.sql" "$TMP" <<'PY'
import re,sys
t=open(sys.argv[1]).read(); out=sys.argv[2]
f=list(re.finditer(r'CREATE OR REPLACE FUNCTION public\.admin_set_event_featured\([\s\S]*?AS \$function\$[\s\S]*?\$function\$',t))[-1].group(0)
c="  -- Was: is_admin(). Sub-Admins must now submit via request_admin_action\n  -- ('toggle_event_featured') and have an Admin/Root approve it (see 0092).\n"
assert f.count(c)==1
prod=f.replace(c,'',1)
open(f'{out}/featured_prod.sql','w').write(prod+';\n')
assert prod.count('p_duration_days > 90')==1
open(f'{out}/featured_code_change.sql','w').write(prod.replace('p_duration_days > 90','p_duration_days > 365')+';\n')
open(f'{out}/featured_other_comment.sql','w').write(f.replace(c,"  -- an unreviewed comment\n",1)+';\n')
PY
FEATURED_MD5="SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE oid = 'public.admin_set_event_featured(uuid,boolean,integer)'::regprocedure;"
expect_value "the harness starts from the reviewed repo body (approved fingerprint 1)" "$(val "$FEATURED_MD5")" "cb47d23e3c486406259f41fe9cc01ceb"
expect_value "the reconstructed production body has exactly the verified production fingerprint (approved fingerprint 2)" \
  "$(valq "BEGIN; $(cat "$TMP/featured_prod.sql") $FEATURED_MD5 ROLLBACK;" | grep -E '^[0-9a-f]{32}$')" "66a3bd2f21ec0813a5aa8e9100ed8aec"
expect_value "0225 applies over the verified production body, and the eligibility check is installed" \
  "$(valq "BEGIN; $(cat "$TMP/featured_prod.sql") $(cat "$MIG/0225_promotion_eligibility.sql") SELECT 'installed:' || (position('event_promotion_block_reason' IN prosrc) > 0) FROM pg_proc WHERE oid = 'public.admin_set_event_featured(uuid,boolean,integer)'::regprocedure; ROLLBACK;" | grep '^installed:')" "installed:true"
expect_error "0225 refuses a production body with a one-token code change (90 -> 365 days)" "admin_set_event_featured differs from the definition" \
  "BEGIN; $(cat "$TMP/featured_code_change.sql") $(cat "$MIG/0225_promotion_eligibility.sql") ROLLBACK;"
expect_error "0225 refuses any other comment-only variant (only the two verified bodies pass)" "admin_set_event_featured differs from the definition" \
  "BEGIN; $(cat "$TMP/featured_other_comment.sql") $(cat "$MIG/0225_promotion_eligibility.sql") ROLLBACK;"
expect_error "an unexpected change to another pinned function is still refused (activate_event_promotion)" "activate_event_promotion differs from the definition" \
  "BEGIN; CREATE OR REPLACE FUNCTION public.activate_event_promotion(p_event_id uuid, p_plan_type text, p_duration_days integer, p_payment_ref text, p_organizer_id uuid) RETURNS void LANGUAGE plpgsql AS 'BEGIN NULL; END'; $(cat "$MIG/0225_promotion_eligibility.sql") ROLLBACK;"
cat > "$TMP/undo_from_prod.sql" <<SQL
BEGIN;
$(cat "$TMP/featured_prod.sql")
CREATE TEMP TABLE pre AS SELECT regexp_replace(prosrc, E'\\n[ \\t]*--[^\\n]*', '', 'g') AS code FROM pg_proc WHERE oid = 'public.admin_set_event_featured(uuid,boolean,integer)'::regprocedure;
$(cat "$MIG/0225_promotion_eligibility.sql")
SET LOCAL vents.rollback_confirm = 'undo-0225';
$(cat "$REPO_ROOT/supabase/rollback/undo_0225.sql")
SELECT md5(replace(p.prosrc, E'\\r', '')) || '|' || (regexp_replace(p.prosrc, E'\\n[ \\t]*--[^\\n]*', '', 'g') = pre.code) || '|' || (position('event_promotion_block_reason' IN p.prosrc) = 0)
  FROM pg_proc p, pre WHERE p.oid = 'public.admin_set_event_featured(uuid,boolean,integer)'::regprocedure;
ROLLBACK;
SQL
expect_value "rollback from the production variant restores the reviewed repo body: same executable code, check removed" \
  "$(valq "$(cat "$TMP/undo_from_prod.sql")" | grep -E '^[0-9a-f]{32}\|')" "cb47d23e3c486406259f41fe9cc01ceb|true|true"
expect_value "every probe above was rolled back (still the repo body, no 0225 objects)" \
  "$(val "$FEATURED_MD5")|$(val "SELECT count(*) FROM pg_proc WHERE proname IN ('event_promotion_block_reason','get_event_promotion_eligibility');")" "cb47d23e3c486406259f41fe9cc01ceb|0"

echo "== 0225: precheck and apply =="
expect_error "0225 refuses if a pinned function drifted from the repo definition" "differs from the definition this migration was written against" \
  "BEGIN; CREATE OR REPLACE FUNCTION public.admin_set_event_featured(p_event_id uuid, p_featured boolean, p_duration_days integer DEFAULT 14) RETURNS void LANGUAGE sql AS 'SELECT NULL'; $(cat "$MIG/0225_promotion_eligibility.sql") ROLLBACK;"
expect_ok "0225 applies in one transaction" "BEGIN; $(cat "$MIG/0225_promotion_eligibility.sql") COMMIT;"
expect_error "a second apply refuses (pins now differ): 0225 never silently re-runs over a changed body" "differs from the definition" "BEGIN; $(cat "$MIG/0225_promotion_eligibility.sql") ROLLBACK;"

echo "== 0225: the paid path (activate_event_promotion) =="
expect_ok "eligible live event: Featured activates as before" "$(activate "$P_LIVE" featured REF_OK1)"
expect_value "... promotion row written and the event featured (unchanged behaviour)" "$(val "SELECT (SELECT count(*) FROM public.event_promotions WHERE payment_ref = 'REF_OK1' AND status = 'active' AND plan_type = 'featured') || '/' || (SELECT is_featured AND featured_until > now() + interval '6 days' FROM public.events WHERE id = '$P_LIVE');")" "1/true"
expect_ok "eligible live event: Trending activates as before" "$(activate "$P_LIVE" trending REF_OK2)"
expect_ok "a replayed reference is still a no-op" "$(activate "$P_LIVE" featured REF_OK1)"
"${PSQL[@]}" -q -c "$(as "$ORG" "UPDATE public.events SET status = 'draft' WHERE id = '$P_LIVE';")"
expect_ok "... even after the event stops being eligible (a retry never errors)" "$(activate "$P_LIVE" featured REF_OK1)"
expect_value "replays wrote nothing new" "$(val "SELECT count(*) FROM public.event_promotions WHERE event_id = '$P_LIVE';")" "2"
"${PSQL[@]}" -q -c "$(as "$ORG" "UPDATE public.events SET status = 'live' WHERE id = '$P_LIVE';")"
for case in "$P_DRAFT:not_on_sale:draft" "$P_CS:not_on_sale:Coming Soon" "$CXL:cancelled:cancelled" "$P_HID:hidden_by_admin:admin-hidden" "$P_END:ended:ended" "$P_DEL:deleted:deleted"; do
  ev="${case%%:*}"; rest="${case#*:}"; reason="${rest%%:*}"; label="${rest#*:}"
  expect_error "paid Featured refused for a $label event ($reason)" "not eligible for promotion ($reason)" "$(activate "$ev" featured "REF_F_$reason")"
  expect_error "paid Trending refused for a $label event ($reason)" "not eligible for promotion ($reason)" "$(activate "$ev" trending "REF_T_$reason")"
done
expect_value "refusals wrote no promotion row and featured nothing" "$(val "SELECT (SELECT count(*) FROM public.event_promotions WHERE payment_ref LIKE 'REF_F_%' OR payment_ref LIKE 'REF_T_%') || '/' || (SELECT count(*) FROM public.events WHERE is_featured AND id <> '$P_LIVE');")" "0/0"
expect_error "ownership check unchanged" "You do not own this event" "$(activate "$P_LIVE" featured REF_X "$ORG2")"
expect_value "no client can call the paid path (0137 grants unchanged)" "$(val "SELECT has_function_privilege('authenticated', 'public.activate_event_promotion(uuid,text,integer,text,uuid)', 'EXECUTE');")" "f"

echo "== 0225: admin Featured / Trending =="
expect_error "admin cannot feature a Coming Soon event" "not eligible for promotion (not_on_sale)" "$(as "$ADMIN" "SELECT public.admin_set_event_featured('$P_CS', true, 7);")"
expect_error "admin cannot feature a cancelled event" "not eligible for promotion (cancelled)" "$(as "$ADMIN" "SELECT public.admin_set_event_featured('$CXL', true, 7);")"
expect_error "admin cannot feature an ended event" "not eligible for promotion (ended)" "$(as "$ADMIN" "SELECT public.admin_set_event_featured('$P_END', true, 7);")"
expect_ok "admin features an eligible live event (unchanged)" "$(as "$ADMIN" "SELECT public.admin_set_event_featured('$P_LIVE', true, 7);")"
expect_ok "un-featuring is never blocked (even a Coming Soon event)" "$(as "$ADMIN" "SELECT public.admin_set_event_featured('$P_CS', false);")"
expect_error "Trending: Coming Soon still refused by the existing status check" "is not eligible for public discovery" "$(as "$ADMIN" "SELECT public.admin_set_event_trending('$P_CS', true);")"
expect_error "Trending: a cancelled event is refused (0218 makes it a draft; existing check)" "is not eligible for public discovery" "$(as "$ADMIN" "SELECT public.admin_set_event_trending('$CXL', true);")"
expect_error "Trending: ended now refused (was allowed)" "not eligible for promotion (ended)" "$(as "$ADMIN" "SELECT public.admin_set_event_trending('$P_END', true);")"
expect_ok "Trending on an eligible live event works (unchanged)" "$(as "$ADMIN" "SELECT public.admin_set_event_trending('$P_LIVE', true);")"
expect_ok "removing Trending is never blocked" "$(as "$ADMIN" "SELECT public.admin_set_event_trending('$P_END', false);")"
expect_error "Sub-admin/user still cannot call them directly (unchanged)" "Super Admin access required" "$(as "$ORG" "SELECT public.admin_set_event_featured('$P_LIVE', true, 7);")"

echo "== 0225: event_promotions is no longer writable by clients =="
expect_error "organizer cannot INSERT a promotion row" "permission denied" "$(as "$ORG" "INSERT INTO public.event_promotions (event_id, organizer_id, plan_type, start_date, end_date, status) VALUES ('$P_LIVE', '$ORG', 'trending', now(), now() + interval '30 days', 'active');")"
expect_error "organizer cannot extend a paid promotion" "permission denied" "$(as "$ORG" "UPDATE public.event_promotions SET end_date = now() + interval '365 days' WHERE payment_ref = 'REF_OK1';")"
expect_error "organizer cannot delete promotion rows" "permission denied" "$(as "$ORG" "DELETE FROM public.event_promotions WHERE payment_ref = 'REF_OK1';")"
expect_value "organizer still reads their own promotions (Promotions screen)" "$(val "$(as "$ORG" "SELECT count(*) FROM public.event_promotions;")")" "2"
expect_value "another organizer reads none of them (0181 unchanged)" "$(val "$(as "$ORG2" "SELECT count(*) FROM public.event_promotions;")")" "0"

echo "== 0225: pre-payment eligibility check for the app =="
expect_value "owner, live event: eligible" "$(val "$(as "$ORG" "SELECT public.get_event_promotion_eligibility('$P_LIVE')::text;")" | jq -c .)" '{"reason":null,"eligible":true}'
expect_value "owner, Coming Soon event: not eligible (not_on_sale)" "$(val "$(as "$ORG" "SELECT public.get_event_promotion_eligibility('$P_CS')->>'reason';")")" "not_on_sale"
expect_value "someone else's event: reveals nothing" "$(val "$(as "$U1" "SELECT public.get_event_promotion_eligibility('$P_HID')::text;")" | jq -c .)" '{"reason":"not_found","eligible":false}'
expect_value "anon cannot call it" "$(val "SELECT has_function_privilege('anon', 'public.get_event_promotion_eligibility(uuid)', 'EXECUTE');")" "f"
expect_value "the rule itself is not client-callable" "$(val "SELECT has_function_privilege('authenticated', 'public.event_promotion_block_reason(uuid)', 'EXECUTE');")" "f"

echo "== 0225: rollback =="
UNDO5="$REPO_ROOT/supabase/rollback/undo_0225.sql"
expect_error "undo_0225 refused without confirmation" "set vents.rollback_confirm" "$(cat "$UNDO5")"
PROMO_ROWS=$(val "SELECT count(*) || '/' || string_agg(id::text, ',' ORDER BY id) FROM public.event_promotions;")
expect_ok "undo_0225 runs in one transaction" "BEGIN; SET LOCAL vents.rollback_confirm = 'undo-0225'; $(cat "$UNDO5") COMMIT;"
expect_value "the three functions are byte-identical to before 0225" "$(val "SELECT string_agg(proname || ':' || md5(prosrc), ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('activate_event_promotion','admin_set_event_featured','admin_set_event_trending');")" "$PIN_BEFORE"
expect_value "0225's functions are gone; promotion rows untouched" "$(val "SELECT count(*) FROM pg_proc WHERE proname IN ('event_promotion_block_reason','get_event_promotion_eligibility');")|$(val "SELECT count(*) || '/' || string_agg(id::text, ',' ORDER BY id) FROM public.event_promotions;")" "0|$PROMO_ROWS"
expect_ok "undo_0225 is re-runnable" "BEGIN; SET LOCAL vents.rollback_confirm = 'undo-0225'; $(cat "$UNDO5") COMMIT;"
expect_ok "0225 re-applies cleanly after undo (pins match again)" "BEGIN; $(cat "$MIG/0225_promotion_eligibility.sql") COMMIT;"

echo "== Rollback: supabase/rollback/undo_0224.sql =="
UNDO="$REPO_ROOT/supabase/rollback/undo_0224.sql"
"${PSQL[@]}" -q -c "$(as "$U1" "SELECT public.subscribe_event_sale_alert('$TZ_EV');")" >/dev/null   # one pending subscription
CS_BEFORE=$(val "SELECT count(*) FROM public.events WHERE status = 'coming_soon';")
EVENTS_BEFORE=$(val "SELECT count(*) FROM public.events;"); TICKETS_BEFORE=$(val "SELECT count(*) || '/' || sum(amount) FROM public.tickets;"); NOTES_BEFORE=$(val "SELECT count(*) FROM public.notifications;")
expect_error "undo refused without confirmation" "set vents.rollback_confirm" "$(cat "$UNDO")"
expect_error "undo refused while Coming Soon events exist" "Coming Soon event" "SET vents.rollback_confirm = 'undo-0224'; $(cat "$UNDO")"
expect_error "undo refused while pending Notify-me subscriptions exist" "pending Notify-me" "SET vents.rollback_confirm = 'undo-0224'; SET vents.rollback_coming_soon_to_draft = 'yes'; $(cat "$UNDO")"
expect_value "refused undos changed nothing" "$(val "SELECT count(*) FROM public.events WHERE status = 'coming_soon';")/$(val "SELECT count(*) FROM public.event_sale_alerts WHERE notified_at IS NULL;")" "$CS_BEFORE/1"
expect_ok "undo runs in one transaction with all confirmations" "BEGIN; SET LOCAL vents.rollback_confirm = 'undo-0224'; SET LOCAL vents.rollback_coming_soon_to_draft = 'yes'; SET LOCAL vents.rollback_discard_sale_alerts = 'yes'; $(cat "$UNDO") COMMIT;"
expect_value "undo removed 0224's cron jobs but kept the pg_cron extension" "$(val "SELECT (SELECT count(*) FROM cron.job WHERE jobname LIKE 'vents_open_due_event_sales%') || '/' || (SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron');")" "0/1"
expect_value "0005's status CHECK is restored" "$(val "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'events_status_check';")" "CHECK ((status = ANY (ARRAY['live'::text, 'draft'::text])))"
expect_value "0224's objects are gone" "$(val "SELECT (to_regclass('public.event_sale_alerts') IS NULL) || '/' || (SELECT count(*) FROM pg_proc WHERE proname IN ('open_event_sales','open_due_event_sales','event_open_sales_core','subscribe_event_sale_alert','unsubscribe_event_sale_alert','get_my_event_sale_alert_counts','events_sales_schedule_guard','event_has_sales_history')) || '/' || (SELECT count(*) FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'sales_open_at');")" "true/0/0"
expect_value "every event, ticket and notification survives; opened events stay live" \
  "$(val "SELECT count(*) FROM public.events;")|$(val "SELECT count(*) || '/' || sum(amount) FROM public.tickets;")|$(val "SELECT count(*) FROM public.notifications;")|$(status "$EV1")" "$EVENTS_BEFORE|$TICKETS_BEFORE|$NOTES_BEFORE|live"
expect_value "former Coming Soon events are private drafts" "$(status "$TZ_EV")" "draft"
expect_ok "existing draft -> live toggle still works after undo" "$(as "$ORG" "UPDATE public.events SET status = 'live' WHERE id = '$TZ_EV';")"
expect_ok "undo is re-runnable" "BEGIN; SET LOCAL vents.rollback_confirm = 'undo-0224'; $(cat "$UNDO") COMMIT;"
expect_ok "0224 re-applies cleanly after undo" "BEGIN; $(cat "$MIG/0224_coming_soon_events.sql") COMMIT;"
expect_value "re-applying re-registers the job once (no duplicates)" "$(val "SELECT count(*) FROM cron.job WHERE jobname = 'vents_open_due_event_sales';")" "1"
expect_ok "0224 is idempotent for the scheduler (second apply of the cron block)" "BEGIN; $(python3 -c "import sys;t=open(sys.argv[1]).read();print(t[t.index('DO \$cron\$'):])" "$MIG/0224_coming_soon_events.sql") COMMIT;"
expect_value "still exactly one job after re-running the cron block" "$(val "SELECT count(*) FROM cron.job WHERE jobname = 'vents_open_due_event_sales';")" "1"

echo
echo "$PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ] && echo "ALL CHECKS PASSED" || exit 1
