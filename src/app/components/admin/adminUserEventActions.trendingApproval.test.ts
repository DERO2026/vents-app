import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression coverage for the confirmed production defect fixed by
// supabase/migrations/0185_approve_admin_action_trending_executor.sql:
// approve_admin_action() had no CASE branch for 'toggle_event_trending', the
// action type toggleEventTrending() (this file, below) submits via
// request_admin_action() whenever the caller isn't a Super Admin.
//
// REVISED after a follow-up audit found the first version of this fix had a
// silent correctness bug: toggleEventTrending() never set a `payload` key,
// so request_admin_action() always stored payload = {}, and the executor's
// COALESCE-to-false fallback meant every approved request resolved to
// `trending: false` regardless of the admin's actual intent -- an "enable"
// click could be silently approved as a no-op/disable. Fixed on both ends:
// toggleEventTrending() now sends `payload: { trending: nextTrending }`,
// and the simulated executor below now validates that payload strictly
// (mirroring 0185's real validation) instead of defaulting it.
//
// There is no live Postgres available in this test environment, so this
// cannot be a true end-to-end SQL test (same caveat as
// adminUserEventActions.capabilityApproval.test.ts). The mock below is a
// small, faithful re-implementation of 0185's actual CASE dispatch for the
// new branch plus its nearest sibling (toggle_event_featured, for
// contrast), preserving the real function's exact ordering: the status
// UPDATE only runs after the CASE succeeds, so a raised exception leaves
// the request at 'pending'.

interface ActionRequest {
  id: string;
  action_type: string;
  target_id: string;
  payload: Record<string, any>;
  requested_by: string;
  status: 'pending' | 'approved' | 'rejected';
}

let requests: ActionRequest[] = [];
let requestIdSeq = 0;
const eventRpcCalls: { name: string; args: any }[] = [];
let currentCallerId = 'sub-1';
let currentCallerIsSuperAdmin = false;

// Faithful re-implementation of 0185's CASE dispatch for the new
// toggle_event_trending branch (strict validation) plus its nearest sibling
// toggle_event_featured (unchanged COALESCE pattern, for contrast).
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
      case 'toggle_event_trending': {
        const raw = r.payload?.trending;
        const text = raw === true ? 'true' : raw === false ? 'false' : raw == null ? null : String(raw);
        if (text !== 'true' && text !== 'false') {
          throw new Error(`toggle_event_trending requires a boolean payload.trending (got: ${text})`);
        }
        eventRpcCalls.push({ name: 'admin_set_event_trending', args: { p_event_id: r.target_id, p_trending: text === 'true' } });
        break;
      }
      case 'toggle_event_featured': {
        const featured = r.payload?.featured === true ? true : r.payload?.featured === false ? false : false; // COALESCE(..., false) -- unchanged, pre-existing pattern
        const duration = typeof r.payload?.duration_days === 'number' ? r.payload.duration_days : 14; // COALESCE(..., 14)
        eventRpcCalls.push({ name: 'admin_set_event_featured', args: { p_event_id: r.target_id, p_featured: featured, p_duration_days: duration } });
        break;
      }
      default:
        throw new Error(`No executor mapped for action_type: ${r.action_type}`);
    }
  } catch (e: any) {
    return { data: null, error: { message: e.message } };
  }

  r.status = 'approved';
  return { data: { ...r }, error: null };
}

vi.mock('../../../lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args?: any) => {
      if (name === 'request_admin_action') {
        const id = `req-${++requestIdSeq}`;
        requests.push({
          id,
          action_type: args.p_action_type,
          target_id: args.p_target_id,
          payload: args.p_payload ?? {},
          requested_by: currentCallerId,
          status: 'pending',
        });
        return Promise.resolve({ data: { id }, error: null });
      }
      if (name === 'admin_set_event_trending') {
        eventRpcCalls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

import { toggleEventTrending } from './adminUserEventActions';

beforeEach(() => {
  requests = [];
  requestIdSeq = 0;
  eventRpcCalls.length = 0;
  currentCallerId = 'sub-1';
  currentCallerIsSuperAdmin = false;
});

describe('toggle_event_trending: Sub-Admin submit -> Super Admin approve -> real RPC executes', () => {
  it('a Sub-Admin\'s trend request is queued with the intended boolean in payload.trending, not executed directly', async () => {
    const res = await toggleEventTrending(false, 'event-1', 'My Event', false);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ action_type: 'toggle_event_trending', target_id: 'event-1', payload: { trending: true }, status: 'pending' });
    expect(eventRpcCalls).toHaveLength(0); // not executed yet
  });

  it('ENABLING Trending: a Super Admin approving a request to turn trending ON actually calls admin_set_event_trending with p_trending: true, and only then approves', async () => {
    await toggleEventTrending(false, 'event-1', 'My Event', false); // currently NOT trending -> requests ON
    const requestId = requests[0].id;

    const approval = simulateApproveAdminAction(requestId, 'super-1', true);
    expect(approval.error).toBeNull();
    expect(eventRpcCalls).toEqual([{ name: 'admin_set_event_trending', args: { p_event_id: 'event-1', p_trending: true } }]);
    expect(requests[0].status).toBe('approved');
  });

  it('DISABLING Trending: a Super Admin approving a request to turn trending OFF actually calls admin_set_event_trending with p_trending: false, and only then approves', async () => {
    await toggleEventTrending(false, 'event-1', 'My Event', true); // currently trending -> requests OFF
    const requestId = requests[0].id;

    expect(requests[0].payload).toEqual({ trending: false });
    const approval = simulateApproveAdminAction(requestId, 'super-1', true);
    expect(approval.error).toBeNull();
    expect(eventRpcCalls).toEqual([{ name: 'admin_set_event_trending', args: { p_event_id: 'event-1', p_trending: false } }]);
    expect(requests[0].status).toBe('approved');
  });

  it('a missing payload.trending is rejected, the RPC is never called, and the request stays pending -- an enable request can never be silently approved as a disable', async () => {
    await toggleEventTrending(false, 'event-1', 'My Event', false);
    requests[0].payload = {}; // simulate a corrupted/stripped payload
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error?.message).toMatch(/requires a boolean payload\.trending/);
    expect(eventRpcCalls).toHaveLength(0);
    expect(requests[0].status).toBe('pending'); // never flipped to approved
  });

  it('a malformed (non-boolean) payload.trending is rejected the same way', async () => {
    await toggleEventTrending(false, 'event-1', 'My Event', false);
    requests[0].payload = { trending: 'yes' };
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error?.message).toMatch(/requires a boolean payload\.trending \(got: yes\)/);
    expect(eventRpcCalls).toHaveLength(0);
    expect(requests[0].status).toBe('pending');
  });

  it('self-approval is blocked, same as every other action type', async () => {
    currentCallerId = 'super-1';
    await toggleEventTrending(false, 'event-1', 'My Event', false);
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error?.message).toBe('Cannot approve your own request');
    expect(requests[0].status).toBe('pending');
  });

  it('a Sub-Admin attempting to approve is rejected -- Super-Admin-only check is preserved', async () => {
    await toggleEventTrending(false, 'event-1', 'My Event', false);
    const approval = simulateApproveAdminAction(requests[0].id, 'sub-2', false);
    expect(approval.error?.message).toBe('Super Admin access required');
    expect(requests[0].status).toBe('pending');
  });

  it('a Super Admin caller executes directly, bypassing the queue entirely', async () => {
    const res = await toggleEventTrending(true, 'event-1', 'My Event', false);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(0); // never queued
    expect(eventRpcCalls).toEqual([{ name: 'admin_set_event_trending', args: { p_event_id: 'event-1', p_trending: true } }]);
  });

  it('a request already approved cannot be approved again (stale/duplicate click) -- RPC fires once, second attempt is rejected with no second RPC call', async () => {
    await toggleEventTrending(false, 'event-1', 'My Event', false);
    const requestId = requests[0].id;

    const first = simulateApproveAdminAction(requestId, 'super-1', true);
    expect(first.error).toBeNull();
    expect(eventRpcCalls).toHaveLength(1);

    const second = simulateApproveAdminAction(requestId, 'super-1', true);
    expect(second.error?.message).toBe('Request already approved');
    expect(eventRpcCalls).toHaveLength(1); // admin_set_event_trending not called twice
  });

  it('a rejected request cannot later be approved', async () => {
    await toggleEventTrending(false, 'event-1', 'My Event', false);
    requests[0].status = 'rejected';
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error?.message).toBe('Request already rejected');
    expect(eventRpcCalls).toHaveLength(0);
  });

  it('a stale/nonexistent request id (e.g. already deleted) is rejected cleanly', () => {
    const approval = simulateApproveAdminAction('does-not-exist', 'super-1', true);
    expect(approval.error?.message).toBe('Request not found');
    expect(eventRpcCalls).toHaveLength(0);
  });

  it('approving a trending request does not call the featured RPC, and a pre-existing toggle_event_featured request still works unchanged', () => {
    requests.push({ id: 'req-feat', action_type: 'toggle_event_featured', target_id: 'event-2', payload: { featured: true, duration_days: 14 }, requested_by: 'sub-1', status: 'pending' });
    const approval = simulateApproveAdminAction('req-feat', 'super-1', true);
    expect(approval.error).toBeNull();
    expect(eventRpcCalls).toEqual([{ name: 'admin_set_event_featured', args: { p_event_id: 'event-2', p_featured: true, p_duration_days: 14 } }]);
    expect(eventRpcCalls.find((c) => c.name === 'admin_set_event_trending')).toBeUndefined();
  });
});
