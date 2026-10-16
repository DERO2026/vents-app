import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression coverage for the confirmed production defect fixed by
// supabase/migrations/0183_approve_admin_action_capability_executors.sql:
// approve_admin_action() had no CASE branch for 'set_organizer_capability'
// or 'set_service_provider_capability', the two action types
// setOrganizerCapability()/setServiceProviderCapability() (this file,
// below) submit via request_admin_action() whenever the caller isn't a
// Super Admin.
//
// There is no live Postgres available in this test environment, so this
// cannot be a true end-to-end SQL test. Instead, the mock below is a small,
// faithful re-implementation of the actual SQL this migration adds --
// mirroring request_admin_action's insert-only behavior and
// approve_admin_action's real CASE dispatch, self-approval block, and
// "status only flips to approved after the executor succeeds" ordering
// (the UPDATE ... SET status='approved' runs strictly after the CASE in
// the real function, so a raised exception anywhere in the CASE leaves the
// row untouched at 'pending' -- this mock preserves that exact ordering,
// not just the end state). It proves the full
// Sub-Admin-submits -> Super-Admin-approves -> real capability RPC executes
// round trip, and that a malformed/missing payload is rejected rather than
// silently coerced -- it does not prove the live PostgREST/Postgres runtime
// accepts this exact SQL (that would require applying the migration to a
// real database, which this task explicitly does not do).

interface ActionRequest {
  id: string;
  action_type: string;
  target_type: string;
  target_id: string;
  payload: Record<string, any>;
  requested_by: string;
  status: 'pending' | 'approved' | 'rejected';
}

let requests: ActionRequest[] = [];
let requestIdSeq = 0;
const capabilityRpcCalls: { name: string; args: any }[] = [];
let currentCallerId = 'super-1';
let currentCallerIsSuperAdmin = true;

// Faithful re-implementation of approve_admin_action's CASE dispatch for
// just the two new branches plus the two pre-existing ones nearest them
// (toggle_user_verified, for contrast) -- enough to prove the new branches
// are wired correctly and didn't disturb an existing one.
function simulateApproveAdminAction(requestId: string, approverId: string, approverIsSuperAdmin: boolean): { data: any; error: { message: string } | null } {
  if (!approverIsSuperAdmin) {
    return { data: null, error: { message: 'Super Admin access required' } };
  }
  const r = requests.find((x) => x.id === requestId);
  if (!r) return { data: null, error: { message: 'Request not found' } };
  if (r.status !== 'pending') return { data: null, error: { message: `Request already ${r.status}` } };
  if (r.requested_by === approverId) return { data: null, error: { message: 'Cannot approve your own request' } };

  try {
    switch (r.action_type) {
      case 'set_organizer_capability': {
        const raw = r.payload?.is_organizer;
        const text = raw === true ? 'true' : raw === false ? 'false' : raw == null ? null : String(raw);
        if (text !== 'true' && text !== 'false') {
          throw new Error(`set_organizer_capability requires a boolean payload.is_organizer (got: ${text})`);
        }
        capabilityRpcCalls.push({ name: 'admin_set_organizer_capability', args: { p_user_id: r.target_id, p_enabled: text === 'true' } });
        break;
      }
      case 'set_service_provider_capability': {
        const raw = r.payload?.is_service_provider;
        const text = raw === true ? 'true' : raw === false ? 'false' : raw == null ? null : String(raw);
        if (text !== 'true' && text !== 'false') {
          throw new Error(`set_service_provider_capability requires a boolean payload.is_service_provider (got: ${text})`);
        }
        capabilityRpcCalls.push({ name: 'admin_set_service_provider_capability', args: { p_user_id: r.target_id, p_enabled: text === 'true' } });
        break;
      }
      case 'toggle_user_verified': {
        capabilityRpcCalls.push({ name: 'admin_toggle_user_verified', args: { p_user_id: r.target_id, p_verified: !!r.payload?.verified } });
        break;
      }
      default:
        throw new Error(`No executor mapped for action_type: ${r.action_type}`);
    }
  } catch (e: any) {
    // Mirrors the real function: an exception anywhere inside the CASE
    // aborts before the status UPDATE runs, so the row stays 'pending'.
    return { data: null, error: { message: e.message } };
  }

  r.status = 'approved';
  return { data: { ...r }, error: null };
}

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args?: any) => {
      if (name === 'request_admin_action') {
        if (!currentCallerIsSuperAdmin === false) { /* no-op, keeps type checker quiet */ }
        const id = `req-${++requestIdSeq}`;
        requests.push({
          id,
          action_type: args.p_action_type,
          target_type: args.p_target_type,
          target_id: args.p_target_id,
          payload: args.p_payload ?? {},
          requested_by: currentCallerId,
          status: 'pending',
        });
        return Promise.resolve({ data: { id }, error: null });
      }
      if (name === 'admin_set_organizer_capability' || name === 'admin_set_service_provider_capability') {
        // Direct (Super Admin) execution path -- never reached in the
        // Sub-Admin tests below, but exercised by submitOrExecute's
        // isSuperAdmin=true branch elsewhere in this suite.
        capabilityRpcCalls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

import { setOrganizerCapability, setServiceProviderCapability } from './adminUserEventActions';

beforeEach(() => {
  requests = [];
  requestIdSeq = 0;
  capabilityRpcCalls.length = 0;
  currentCallerId = 'sub-1';
  currentCallerIsSuperAdmin = false;
});

describe('set_organizer_capability: Sub-Admin submit -> Super Admin approve -> real RPC executes', () => {
  it('a Sub-Admin\'s grant request is queued, not executed directly', async () => {
    const res = await setOrganizerCapability(false, 'user-1', 'target@x.com', false, true);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ action_type: 'set_organizer_capability', target_id: 'user-1', payload: { is_organizer: true }, status: 'pending' });
    expect(capabilityRpcCalls).toHaveLength(0); // not executed yet
  });

  it('a different Super Admin approving it actually calls admin_set_organizer_capability with the right args, and the request becomes approved only after that succeeds', async () => {
    await setOrganizerCapability(false, 'user-1', 'target@x.com', false, true);
    const requestId = requests[0].id;

    const approval = simulateApproveAdminAction(requestId, 'super-1', true);
    expect(approval.error).toBeNull();
    expect(capabilityRpcCalls).toEqual([{ name: 'admin_set_organizer_capability', args: { p_user_id: 'user-1', p_enabled: true } }]);
    expect(requests[0].status).toBe('approved');
  });

  it('revoking (enabled=false) sends p_enabled: false through to the real RPC, not a truthy coercion', async () => {
    await setOrganizerCapability(false, 'user-1', 'target@x.com', true, false);
    const requestId = requests[0].id;
    simulateApproveAdminAction(requestId, 'super-1', true);
    expect(capabilityRpcCalls).toEqual([{ name: 'admin_set_organizer_capability', args: { p_user_id: 'user-1', p_enabled: false } }]);
  });

  it('a malformed/missing payload is rejected, the RPC is never called, and the request stays pending (not falsely approved)', async () => {
    await setOrganizerCapability(false, 'user-1', 'target@x.com', false, true);
    requests[0].payload = {}; // simulate a missing/corrupted payload
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error?.message).toMatch(/requires a boolean payload\.is_organizer/);
    expect(capabilityRpcCalls).toHaveLength(0);
    expect(requests[0].status).toBe('pending'); // never flipped to approved
  });

  it('self-approval is blocked, same as every other action type', async () => {
    currentCallerId = 'super-1';
    await setOrganizerCapability(false, 'user-1', 'target@x.com', false, true);
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error?.message).toBe('Cannot approve your own request');
    expect(requests[0].status).toBe('pending');
  });

  it('a Sub-Admin attempting to approve (even someone else\'s request) is rejected -- Super-Admin-only check is preserved', async () => {
    await setOrganizerCapability(false, 'user-1', 'target@x.com', false, true);
    const approval = simulateApproveAdminAction(requests[0].id, 'sub-2', false);
    expect(approval.error?.message).toBe('Super Admin access required');
    expect(requests[0].status).toBe('pending');
  });

  it('a Super Admin caller executes directly, bypassing the queue entirely', async () => {
    const res = await setOrganizerCapability(true, 'user-1', 'target@x.com', false, true);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(0); // never queued
    expect(capabilityRpcCalls).toEqual([{ name: 'admin_set_organizer_capability', args: { p_user_id: 'user-1', p_enabled: true } }]);
  });
});

describe('set_service_provider_capability: Sub-Admin submit -> Super Admin approve -> real RPC executes', () => {
  it('a Sub-Admin\'s grant request is queued, approval calls admin_set_service_provider_capability with the right args, and only then becomes approved', async () => {
    const res = await setServiceProviderCapability(false, 'user-2', 'provider@x.com', false, true);
    expect(res.ok).toBe(true);
    expect(requests[0]).toMatchObject({ action_type: 'set_service_provider_capability', target_id: 'user-2', payload: { is_service_provider: true }, status: 'pending' });

    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error).toBeNull();
    expect(capabilityRpcCalls).toEqual([{ name: 'admin_set_service_provider_capability', args: { p_user_id: 'user-2', p_enabled: true } }]);
    expect(requests[0].status).toBe('approved');
  });

  it('a malformed payload is rejected without executing the RPC or approving the request', async () => {
    await setServiceProviderCapability(false, 'user-2', 'provider@x.com', false, true);
    requests[0].payload = { is_service_provider: 'yes' }; // not a real boolean
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error?.message).toMatch(/requires a boolean payload\.is_service_provider/);
    expect(capabilityRpcCalls).toHaveLength(0);
    expect(requests[0].status).toBe('pending');
  });
});

describe('approving one capability request never touches the other action type\'s executor, and a pre-existing branch (toggle_user_verified) still works unchanged', () => {
  it('approving set_organizer_capability does not call the service-provider RPC', async () => {
    await setOrganizerCapability(false, 'user-1', 'x', false, true);
    simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(capabilityRpcCalls.find((c) => c.name === 'admin_set_service_provider_capability')).toBeUndefined();
  });

  it('toggle_user_verified (a pre-existing, unrelated branch) is unaffected by adding the two new branches', () => {
    requests.push({ id: 'req-tv', action_type: 'toggle_user_verified', target_type: 'user', target_id: 'user-3', payload: { verified: true }, requested_by: 'sub-1', status: 'pending' });
    const approval = simulateApproveAdminAction('req-tv', 'super-1', true);
    expect(approval.error).toBeNull();
    expect(capabilityRpcCalls).toEqual([{ name: 'admin_toggle_user_verified', args: { p_user_id: 'user-3', p_verified: true } }]);
    expect(requests.find((r) => r.id === 'req-tv')!.status).toBe('approved');
  });
});
