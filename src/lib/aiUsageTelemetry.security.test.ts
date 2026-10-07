import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Phase 5A -- static-analysis proof (same approach as every other
// *.security.test.ts here; no live Postgres harness in this repo) that
// ai_usage_events has no client-reachable read/write path and no column
// capable of holding PII, and that record_ai_usage_event() cannot touch
// any other table (entitlement/usage/billing).

let sql: string;

beforeAll(() => {
  sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '0167_ai_usage_telemetry.sql'), 'utf8');
});

describe('ai_usage_events: no PII columns, no direct client access', () => {
  it('has RLS enabled and defines zero policies -- anon/authenticated cannot read or write it at all', () => {
    expect(sql).toMatch(/ALTER TABLE public\.ai_usage_events ENABLE ROW LEVEL SECURITY;/);
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });

  it('declares no column that could hold a prompt, message, tool payload, image, email, username, auth user id, or IP address', () => {
    const createIdx = sql.indexOf('CREATE TABLE IF NOT EXISTS public.ai_usage_events');
    const closeIdx = sql.indexOf(');', createIdx);
    const tableDef = sql.slice(createIdx, closeIdx);
    // Checks COLUMN NAMES specifically (not the SQL `text` type keyword,
    // which legitimately appears as the type of surface/model/status).
    expect(tableDef).not.toMatch(/^\s*(prompt|message|content|tool_input|tool_result|tool_args|image|email|username|user_id|auth_user_id|ip_address|ip)\s+/im);
  });

  it('every usage-metric column is nullable (no NOT NULL), matching "NULL when Anthropic did not report it, never a guess"', () => {
    const createIdx = sql.indexOf('CREATE TABLE IF NOT EXISTS public.ai_usage_events');
    const closeIdx = sql.indexOf(');', createIdx);
    const tableDef = sql.slice(createIdx, closeIdx);
    for (const col of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'web_search_requests', 'estimated_cost_usd']) {
      const colLine = tableDef.match(new RegExp(`${col}\\s+\\S+[^,\\n]*`))?.[0] ?? '';
      expect(colLine, `${col} should not be NOT NULL`).not.toMatch(/NOT NULL/);
    }
  });

  it('round_id is a bare uuid with no foreign key to users/auth.users -- it groups rounds without identifying anyone', () => {
    expect(sql).toMatch(/round_id\s+uuid NOT NULL/);
    expect(sql).not.toMatch(/round_id[^,]*REFERENCES/);
  });
});

describe('record_ai_usage_event: single project_admin-only writer, cannot touch any other table', () => {
  it('has no EXECUTE grant to anon or authenticated', () => {
    const revoke = sql.match(/REVOKE ALL ON FUNCTION public\.record_ai_usage_event\([^;]*;/)?.[0] ?? '';
    expect(revoke).toMatch(/anon/);
    expect(revoke).toMatch(/authenticated/);
    const grant = sql.match(/GRANT EXECUTE ON FUNCTION public\.record_ai_usage_event\([^;]*;/)?.[0] ?? '';
    expect(grant).toMatch(/project_admin/);
    expect(grant).not.toMatch(/\bauthenticated\b/);
  });

  it('its body only ever inserts into ai_usage_events -- no reference to ai_entitlements, ai_usage_periods, app_config, or any wallet/payment table', () => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.record_ai_usage_event');
    const end = sql.indexOf('\n$function$;', start);
    const fn = sql.slice(start, end);
    expect(fn).toMatch(/INSERT INTO public\.ai_usage_events/);
    expect(fn).not.toMatch(/ai_entitlements|ai_usage_periods|app_config|wallet|paystack|vents_cents/i);
  });

  it('validates surface and status against a fixed allow-list before inserting', () => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.record_ai_usage_event');
    const end = sql.indexOf('\n$function$;', start);
    const fn = sql.slice(start, end);
    expect(fn).toMatch(/IF p_surface NOT IN \('chat', 'extraction', 'vision'\) THEN/);
    expect(fn).toMatch(/IF p_status NOT IN \('success', 'error'\) THEN/);
  });
});
