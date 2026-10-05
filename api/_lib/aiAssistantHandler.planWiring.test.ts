import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Source-level wiring test (same approach as
// src/lib/ventsAiSettingsToggleWiring.test.ts) for how
// api/_lib/aiAssistantHandler.ts dispatches the new SI Planner tools. A
// full handler-level test isn't attempted here -- it would need a live
// Anthropic API call and a live Supabase session, which this test suite
// has no harness for -- so this verifies the wiring that actually
// determines the planner's two safety properties: plan tools auto-execute
// like read tools (never the money confirmation flow), and the executor
// gets the server's own authenticated session id, never a client-supplied
// one.

let handlerSrc: string;

beforeAll(() => {
  handlerSrc = readFileSync(join(__dirname, 'aiAssistantHandler.ts'), 'utf8');
});

describe('aiAssistantHandler.ts: SI Planner tool dispatch', () => {
  it('imports PLAN_TOOL_NAMES and executePlanTool from aiTools', () => {
    expect(handlerSrc).toMatch(/PLAN_TOOL_NAMES/);
    expect(handlerSrc).toMatch(/executePlanTool/);
  });

  it('includes plan tools as auto-executed (isPlanTool), not behind the proposal/confirmation branch', () => {
    expect(handlerSrc).toMatch(/PLAN_TOOL_NAMES\.has\(block\.name\)/);
    expect(handlerSrc).toMatch(/executePlanTool\(block\.name, client, session\.userId, block\.input\)/);
  });

  it('never passes a client-supplied user id to executePlanTool -- only the server-verified session.userId', () => {
    const call = handlerSrc.match(/executePlanTool\([^)]*\)/)?.[0] ?? '';
    expect(call).toContain('session.userId');
    expect(call).not.toMatch(/params\.user_id|input\.user_id|block\.input\.user_id/);
  });

  it('the proposal/confirmation branch (PROPOSAL_TOOL_NAMES) runs before the auto-execute branch, so a plan tool never accidentally gets treated as a money action', () => {
    const proposalIdx = handlerSrc.indexOf('PROPOSAL_TOOL_NAMES.has(b.name)');
    const dispatchIdx = handlerSrc.indexOf('PLAN_TOOL_NAMES.has(block.name)');
    expect(proposalIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(proposalIdx).toBeLessThan(dispatchIdx);
  });

  it('system prompt instructs the model to use propose_plan_update for its own suggestions and apply_plan_update only for a direct instruction or an agreed Apply', () => {
    expect(handlerSrc).toMatch(/propose_plan_update first/);
    expect(handlerSrc).toMatch(/Never call apply_plan_update for your own suggestion before the user has agreed/);
  });

  it('system prompt forbids claiming provider availability and forbids treating an estimate as a price', () => {
    expect(handlerSrc).toMatch(/NEVER state or imply a provider is "available"/);
    expect(handlerSrc).toMatch(/an SI estimate must never be presented as if it were a provider's actual price/);
  });

  it('system prompt distinguishes assigned from booked', () => {
    expect(handlerSrc).toMatch(/assign_provider records which provider the user chose for a category -- it is NEVER a booking/);
  });

  it('system prompt says an Undo never reverses a real payment', () => {
    expect(handlerSrc).toMatch(/never imply this can undo a real Paystack payment, booking, or any financial transaction/);
  });
});
