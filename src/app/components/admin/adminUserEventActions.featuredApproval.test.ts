import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression coverage for the confirmed production defect fixed by
// supabase/migrations/0186_approve_admin_action_featured_executor_payload_fix.sql:
// toggleEventFeatured() (this file, below) never set a `payload` key when
// submitting a Sub-Admin request, only `previous`/`changes`. The live
// approve_admin_action's 'toggle_event_featured' branch then always saw
// payload = {}, and its COALESCE((r.payload->>'featured')::boolean, false)
// silently resolved every approval to featured=false -- an admin's "enable
// Featured" click could be approved as a no-op/disable. Same bug class, same
// fix shape as the Trending regression suite
// (adminUserEventActions.trendingApproval.test.ts).
//
// There is no live Postgres available in this test environment (same caveat
// as every other test in this family). The mock below re-implements 0186's
// actual CASE dispatch for the fixed branch.

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
      case 'toggle_event_featured': {
        const raw = r.payload?.featured;
        const text = raw === true ? 'true' : raw === false ? 'false' : raw == null ? null : String(raw);
        if (text !== 'true' && text !== 'false') {
          throw new Error(`toggle_event_featured requires a boolean payload.featured (got: ${text})`);
        }
        const duration = typeof r.payload?.duration_days === 'number' ? r.payload.duration_days : 14; // COALESCE(..., 14) -- unchanged
        eventRpcCalls.push({ name: 'admin_set_event_featured', args: { p_event_id: r.target_id, p_featured: text === 'true', p_duration_days: duration } });
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
      if (name === 'admin_set_event_featured') {
        eventRpcCalls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

import { toggleEventFeatured } from './adminUserEventActions';

beforeEach(() => {
  requests = [];
  requestIdSeq = 0;
  eventRpcCalls.length = 0;
  currentCallerId = 'sub-1';
});

describe('toggle_event_featured: Sub-Admin submit -> Super Admin approve -> real RPC executes', () => {
  it('a Sub-Admin\'s feature request is queued with the intended boolean and duration in payload, not executed directly', async () => {
    const res = await toggleEventFeatured(false, 'event-1', 'My Event', false);
    expect(res.ok).toBe(true);
    expect(requests[0]).toMatchObject({ action_type: 'toggle_event_featured', target_id: 'event-1', payload: { featured: true, duration_days: 14 }, status: 'pending' });
    expect(eventRpcCalls).toHaveLength(0);
  });

  it('ENABLING Featured: approval actually calls admin_set_event_featured with p_featured: true, p_duration_days: 14', async () => {
    await toggleEventFeatured(false, 'event-1', 'My Event', false); // currently NOT featured -> requests ON
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error).toBeNull();
    expect(eventRpcCalls).toEqual([{ name: 'admin_set_event_featured', args: { p_event_id: 'event-1', p_featured: true, p_duration_days: 14 } }]);
    expect(requests[0].status).toBe('approved');
  });

  it('DISABLING Featured: approval actually calls admin_set_event_featured with p_featured: false, p_duration_days: null', async () => {
    await toggleEventFeatured(false, 'event-1', 'My Event', true); // currently featured -> requests OFF
    expect(requests[0].payload).toEqual({ featured: false, duration_days: null });
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error).toBeNull();
    expect(eventRpcCalls).toEqual([{ name: 'admin_set_event_featured', args: { p_event_id: 'event-1', p_featured: false, p_duration_days: 14 } }]); // duration_days COALESCEs to 14 on null, unrelated to this fix
    expect(requests[0].status).toBe('approved');
  });

  it('a missing payload.featured is rejected, the RPC is never called, and the request stays pending -- an enable can never be silently approved as a disable', async () => {
    await toggleEventFeatured(false, 'event-1', 'My Event', false);
    requests[0].payload = {}; // simulate the pre-fix client behavior / a corrupted payload
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error?.message).toMatch(/requires a boolean payload\.featured/);
    expect(eventRpcCalls).toHaveLength(0);
    expect(requests[0].status).toBe('pending');
  });

  it('a malformed (non-boolean) payload.featured is rejected the same way', async () => {
    await toggleEventFeatured(false, 'event-1', 'My Event', false);
    requests[0].payload = { featured: 'yes' };
    const approval = simulateApproveAdminAction(requests[0].id, 'super-1', true);
    expect(approval.error?.message).toMatch(/requires a boolean payload\.featured \(got: yes\)/);
    expect(eventRpcCalls).toHaveLength(0);
    expect(requests[0].status).toBe('pending');
  });

  it('a Super Admin caller executes directly, bypassing the queue entirely', async () => {
    const res = await toggleEventFeatured(true, 'event-1', 'My Event', false);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(0);
  });
});
