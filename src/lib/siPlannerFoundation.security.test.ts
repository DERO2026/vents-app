import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static-analysis tests (same approach as every other *.security.test.ts in
// this repo) for the SI Planner Batch 1/2/3 migrations (0156, 0157).

let m0156: string;
let m0157: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0156 = readFileSync(join(dir, '0156_si_planner_foundation.sql'), 'utf8');
  m0157 = readFileSync(join(dir, '0157_si_planner_tools.sql'), 'utf8');
});

function fn(source: string, name: string): string {
  const match = source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}[\\s\\S]*?\\$function\\$\\s*;`));
  return match?.[0] ?? '';
}

describe('set_plan_category_allocation (0156): the one write path for allocated_kobo', () => {
  it('is SECURITY DEFINER with search_path locked down', () => {
    const f = fn(m0156, 'set_plan_category_allocation');
    expect(f).toMatch(/SECURITY DEFINER/);
    expect(f).toMatch(/SET search_path TO ''/);
  });

  it('rejects an unauthenticated caller', () => {
    expect(fn(m0156, 'set_plan_category_allocation')).toMatch(/auth\.uid\(\) IS NULL/);
  });

  it('rejects a non-owner (unless admin/root)', () => {
    const f = fn(m0156, 'set_plan_category_allocation');
    expect(f).toMatch(/v_owner_id IS DISTINCT FROM auth\.uid\(\)/);
    expect(f).toMatch(/public\.is_admin_or_root\(\)/);
  });

  it('enforces allocation >= committed/paid and total <= plan budget', () => {
    const f = fn(m0156, 'set_plan_category_allocation');
    expect(f).toMatch(/can''t be set below what''s already committed or paid/);
    expect(f).toMatch(/over its total budget/);
  });

  it('is granted to authenticated only, never anon or PUBLIC', () => {
    expect(m0156).toMatch(/REVOKE ALL ON FUNCTION public\.set_plan_category_allocation\(uuid, bigint\) FROM PUBLIC;/);
    expect(m0156).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_plan_category_allocation\(uuid, bigint\) TO authenticated;/);
    expect(m0156).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.set_plan_category_allocation[^;]*anon/);
  });
});

describe('search_services_fuzzy_filtered (0156): additive, never replaces the original', () => {
  it('does not alter the original 3-arg search_services_fuzzy function', () => {
    expect(m0156).not.toMatch(/CREATE OR REPLACE FUNCTION public\.search_services_fuzzy\(/);
  });

  it('excludes a provider with no starting_price on file when a max price filter is given, rather than assuming it fits', () => {
    const f = fn(m0156, 'search_services_fuzzy_filtered');
    expect(f).toMatch(/p_max_starting_price IS NULL OR \(sp\.starting_price IS NOT NULL AND sp\.starting_price <= p_max_starting_price\)/);
  });

  it('is SECURITY DEFINER with search_path locked down', () => {
    const f = fn(m0156, 'search_services_fuzzy_filtered');
    expect(f).toMatch(/SECURITY DEFINER/);
    expect(f).toMatch(/SET search_path TO ''/);
  });
});

describe('apply_plan_allocation_changes (0157): orchestrates set_plan_category_allocation, never duplicates it', () => {
  it('calls set_plan_category_allocation for every change rather than writing allocated_kobo directly', () => {
    const f = fn(m0157, 'apply_plan_allocation_changes');
    expect(f).toMatch(/PERFORM public\.set_plan_category_allocation\(v_category_id, v_new_kobo\)/);
    expect(f).not.toMatch(/UPDATE public\.plan_categories\s+SET allocated_kobo/);
  });

  it('rejects an unauthenticated caller and a non-owner', () => {
    const f = fn(m0157, 'apply_plan_allocation_changes');
    expect(f).toMatch(/auth\.uid\(\) IS NULL/);
    expect(f).toMatch(/Only the plan owner can change its budget/);
  });

  it('applies decreases before increases, so a net-neutral swap never trips an intermediate over-budget check', () => {
    const f = fn(m0157, 'apply_plan_allocation_changes');
    expect(f).toMatch(/FOR v_pass IN 0\.\.1 LOOP/);
    expect(f).toMatch(/v_pass = 0 AND v_new_kobo <= v_old_kobo/);
  });

  it('refuses a category id that does not belong to the given plan', () => {
    expect(fn(m0157, 'apply_plan_allocation_changes')).toMatch(/does not belong to this plan/);
  });

  it('constrains actor to user or si, and is granted to authenticated only', () => {
    expect(fn(m0157, 'apply_plan_allocation_changes')).toMatch(/p_actor NOT IN \('user', 'si'\)/);
    expect(m0157).toMatch(/REVOKE ALL ON FUNCTION public\.apply_plan_allocation_changes\(uuid, jsonb, text\) FROM PUBLIC;/);
    expect(m0157).toMatch(/GRANT EXECUTE ON FUNCTION public\.apply_plan_allocation_changes\(uuid, jsonb, text\) TO authenticated;/);
  });
});

describe('undo_plan_change (0157): reversible, time-boxed, once per log row', () => {
  it('refuses an already-undone change', () => {
    expect(fn(m0157, 'undo_plan_change')).toMatch(/This change was already undone/);
  });

  it('refuses a change older than 24 hours', () => {
    expect(fn(m0157, 'undo_plan_change')).toMatch(/interval '24 hours'/);
  });

  it('rejects a non-owner', () => {
    expect(fn(m0157, 'undo_plan_change')).toMatch(/Only the plan owner can undo this change/);
  });

  it('reverts through set_plan_category_allocation, not a direct column write', () => {
    const f = fn(m0157, 'undo_plan_change');
    expect(f).toMatch(/PERFORM public\.set_plan_category_allocation/);
    expect(f).not.toMatch(/UPDATE public\.plan_categories\s+SET allocated_kobo/);
  });

  it('never references service_bookings or payment -- an undo can only touch planning allocations', () => {
    const f = fn(m0157, 'undo_plan_change');
    expect(f.toLowerCase()).not.toMatch(/service_bookings|payment_status|paystack/);
  });
});

describe('assign_plan_provider (0157): assigned is never booked', () => {
  it('only ever inserts status assigned, never booked', () => {
    const f = fn(m0157, 'assign_plan_provider');
    expect(f).toMatch(/VALUES \(p_category_id, p_provider_id, p_agreed_kobo, 'assigned'\)/);
    expect(f).not.toMatch(/'booked'\)/);
  });

  it('refuses to replace a category that already has a paid (booked) assignment', () => {
    const f = fn(m0157, 'assign_plan_provider');
    expect(f).toMatch(/a\.status = 'booked'/);
    expect(f).toMatch(/already has a paid booking/);
  });

  it('only cancels shortlisted/assigned rows when replacing, never a booked one', () => {
    const f = fn(m0157, 'assign_plan_provider');
    expect(f).toMatch(/WHERE category_id = p_category_id AND status IN \('shortlisted', 'assigned'\)/);
  });

  it('only assigns to an approved provider listing', () => {
    expect(fn(m0157, 'assign_plan_provider')).toMatch(/v_provider_status <> 'approved'/);
  });

  it('never touches service_bookings -- assignment is purely a planning record', () => {
    expect(fn(m0157, 'assign_plan_provider').toLowerCase()).not.toMatch(/service_bookings/);
  });
});

describe('plan_change_log (0157): client cannot forge or erase its own history', () => {
  it('has no client-facing INSERT/UPDATE/DELETE policy, only SELECT', () => {
    const section = m0157.slice(m0157.indexOf('plan_change_log'), m0157.indexOf('apply_plan_allocation_changes'));
    expect(section).toMatch(/CREATE POLICY plan_change_log_select_own/);
    expect(section).not.toMatch(/CREATE POLICY plan_change_log_insert/);
    expect(section).not.toMatch(/CREATE POLICY plan_change_log_update/);
    expect(section).not.toMatch(/CREATE POLICY plan_change_log_delete/);
  });
});

describe('table grants (0157 §5): authenticated only, never anon', () => {
  it('grants DML on every Batch 1 table to authenticated and never to anon', () => {
    const grantSection = m0157.slice(m0157.indexOf('Table-level grants'));
    expect(grantSection).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.plans TO authenticated;/);
    expect(grantSection).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.plan_categories TO authenticated;/);
    expect(grantSection).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.plan_assignments TO authenticated;/);
    expect(grantSection).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.plan_tasks TO authenticated;/);
    expect(grantSection).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.plan_milestones TO authenticated;/);
    expect(grantSection).toMatch(/GRANT SELECT, INSERT ON public\.plan_messages TO authenticated;/);
    expect(grantSection).toMatch(/GRANT SELECT ON public\.plan_change_log TO authenticated;/);
    expect(grantSection).not.toMatch(/TO anon/);
  });
});

describe('plan_messages (0156): the persisted per-plan SI thread, read/written only as the plan owner', () => {
  it('RLS is enabled', () => {
    expect(m0156).toMatch(/ALTER TABLE public\.plan_messages ENABLE ROW LEVEL SECURITY;/);
  });

  it('SELECT is scoped to the plan owner (or admin/root), never a bare caller-supplied plan_id', () => {
    const section = m0156.slice(m0156.indexOf('CREATE POLICY plan_messages_select_own'), m0156.indexOf('CREATE POLICY plan_messages_insert_own'));
    expect(section).toMatch(/p\.owner_id = auth\.uid\(\) OR public\.is_admin_or_root\(\)/);
  });

  it('INSERT is scoped to the plan owner only -- no admin/root bypass on writes, and no insert as anyone else\'s plan', () => {
    const section = m0156.slice(m0156.indexOf('CREATE POLICY plan_messages_insert_own'));
    const policyText = section.slice(0, section.indexOf(';') + 1);
    expect(policyText).toMatch(/p\.owner_id = auth\.uid\(\)/);
  });

  it('has no UPDATE or DELETE policy -- a persisted conversation turn can never be edited or erased by a client', () => {
    expect(m0156).not.toMatch(/CREATE POLICY plan_messages_update/);
    expect(m0156).not.toMatch(/CREATE POLICY plan_messages_delete/);
  });

  it('role is constrained to user/assistant -- a client cannot inject a third message role', () => {
    expect(m0156).toMatch(/CONSTRAINT plan_messages_role_check CHECK \(role IN \('user', 'assistant'\)\)/);
  });
});

describe('aiAssistantHandler.ts persistPlanTurn (Batch 3): plan message persistence never becomes the plan\'s source of truth', () => {
  let handlerSrc: string;
  beforeAll(() => {
    handlerSrc = readFileSync(join(__dirname, '..', '..', 'api', '_lib', 'aiAssistantHandler.ts'), 'utf8');
  });

  it('only persists a plan_id that came from a tool call that actually succeeded, never a bare model-supplied id', () => {
    expect(handlerSrc).toMatch(/Only reached on success, so a plan_id for a plan this user\s*\n\s*\/\/ doesn't own \(the executor would have thrown\) never lands\s*\n\s*\/\/ here\./);
    expect(handlerSrc).toMatch(/const planId = result\?\.plan_id \?\? block\.input\?\.plan_id;/);
  });

  it('relies on plan_messages RLS as the real authorization boundary for the insert, not on where planId came from', () => {
    expect(handlerSrc).toMatch(/RLS \(plan_messages_insert_own, 0156\) requires the plan to exist and/);
  });

  it('skips persistence entirely when zero or more than one plan was touched, rather than guessing which plan a reply belongs to', () => {
    expect(handlerSrc).toMatch(/if \(touchedPlanIds\.size === 1\) \{/);
  });

  it('a persistence failure is caught and logged, never thrown back to the caller -- conversation history is best-effort, not the source of truth for plan state', () => {
    const fnBody = handlerSrc.match(/async function persistPlanTurn[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fnBody).toMatch(/try \{/);
    expect(fnBody).toMatch(/\} catch \(err\) \{/);
  });
});
