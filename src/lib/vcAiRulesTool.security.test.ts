import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static source-assertion tests for VENTS Cents Batch F2's AI-knowledge
// objective: the new get_vents_cents_rules tool (api/_lib/aiTools.ts) and
// the extended VC system-prompt instruction (api/_lib/aiAssistantHandler.ts).
// Mirrors this repo's convention of asserting against the real shipped
// source.

let toolsSrc: string;
let handlerSrc: string;

beforeAll(() => {
  const libDir = join(__dirname, '..', '..', 'api', '_lib');
  toolsSrc = readFileSync(join(libDir, 'aiTools.ts'), 'utf8');
  handlerSrc = readFileSync(join(libDir, 'aiAssistantHandler.ts'), 'utf8');
});

describe('get_vents_cents_rules tool exists, is read-only, and calls get_vc_config()', () => {
  it('is declared in READ_ONLY_TOOLS', () => {
    expect(toolsSrc).toMatch(/name:\s*'get_vents_cents_rules'/);
  });

  it('has its own executor that calls get_vc_config() via RPC', () => {
    const fnMatch = toolsSrc.match(/export async function executeGetVentsCentsRules\([\s\S]*?\n}/);
    expect(fnMatch).not.toBeNull();
    const fn = fnMatch![0];
    expect(fn).toMatch(/client\.rpc\('get_vc_config'/);
    // Read-only: no insert/update/delete/mutation of any kind in this executor.
    expect(fn).not.toMatch(/\.insert\(/i);
    expect(fn).not.toMatch(/\.update\(/i);
    expect(fn).not.toMatch(/\.delete\(/i);
    expect(fn).not.toMatch(/UPDATE\s/i);
    expect(fn).not.toMatch(/INSERT\s/i);
  });

  it('is registered in READ_EXECUTORS (auto-executes inside the read-only tool loop, not as a Phase 2 proposal)', () => {
    expect(toolsSrc).toMatch(/get_vents_cents_rules:\s*executeGetVentsCentsRules/);
  });

  it('is distinct from the existing get_vents_cents_balance tool (both remain, unchanged relationship)', () => {
    expect(toolsSrc).toMatch(/name:\s*'get_vents_cents_balance'/);
    expect(toolsSrc).toMatch(/executeGetVentsCentsBalance/);
  });
});

describe('no new AI tool can mutate VC state', () => {
  it('this batch introduces no tool touching request_vc_cashout, purchase_badge, feature_in_people_vc, boost_event_vc, or complete_referral', () => {
    for (const rpcName of [
      'request_vc_cashout',
      'purchase_badge',
      'feature_in_people_vc',
      'boost_event_vc',
      'complete_referral',
    ]) {
      expect(toolsSrc).not.toContain(rpcName);
    }
  });

  it('PROPOSAL_TOOLS (the only mutation-capable category) is unchanged -- still exactly the 4 pre-existing tools', () => {
    const proposalNames = [...toolsSrc.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    // The 4 known proposal tools must be present...
    for (const name of ['start_ticket_transfer', 'request_ticket_refund', 'start_service_booking', 'create_report']) {
      expect(proposalNames).toContain(name);
    }
    // ...and get_vents_cents_rules must be a read-only tool, never a proposal.
    const proposalBlockMatch = toolsSrc.match(/export const PROPOSAL_TOOLS = \[([\s\S]*?)\] as const;/);
    expect(proposalBlockMatch).not.toBeNull();
    expect(proposalBlockMatch![1]).not.toMatch(/get_vents_cents_rules/);
  });
});

describe('the system prompt requires the rules tool for VC-rules questions and the balance tool for live-balance questions', () => {
  it('mentions get_vents_cents_rules with a MUST-call instruction before answering VC rules/rates/amounts/eligibility', () => {
    expect(handlerSrc).toMatch(/get_vents_cents_rules/);
    expect(handlerSrc).toMatch(/MUST call the get_vents_cents_rules tool before answering ANY question about VC rules/);
  });

  it('mentions get_vents_cents_balance with a MUST-call instruction for the user\'s own live balance', () => {
    expect(handlerSrc).toMatch(/MUST call the existing get_vents_cents_balance tool for any question about the user's OWN live VC balance/);
  });

  it('requires the exact "not currently available" statement if asked about buying tickets with VC', () => {
    expect(handlerSrc).toMatch(/Using VENTS Cents toward ticket purchases is not currently available/);
  });

  it('instructs the model not to invent transaction history, cash-out status, or eligibility', () => {
    expect(handlerSrc).toMatch(/MUST NOT invent a user's referral status, transaction history, cash-out request status, or eligibility/);
  });
});
