import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Admin → VENTS Earn reward claims. Approved rule: free events NEVER qualify
// for the N50,000 representative reward. The admin screen therefore offers no
// approval for a free-event claim (only rejection), and an approval request
// never carries the retired 0201 "free_event_verified" override. The server
// refuses both anyway (0209 eligibility, 0216 executor and credit check;
// scripts/local-pg-test/run-representative-reward-integrity-verification.sh).

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../../lib/supabase', () => ({ supabase: { rpc } }));

import { AdminEarnScreen } from './AdminEarnScreen';

const claim = (over: Record<string, unknown>) => ({
  id: 'c', status: 'pending_review', amount_kobo: 5000000, reward_month: '2026-10-01', is_free_event: false,
  organizer_verified_now: true, representative_id: 'rep-1', representative_name: 'Rep One',
  organizer_name: 'Org', event_title: 'Event', decision_reason: null, ...over,
});
const overview = {
  settings: { payouts_enabled: false, legacy_commission_reconciled: true, settlement_hold_days: 7, base_reward_kobo: 5000000 },
  pool: { available_kobo: 0, reserved_kobo: 0, credited_kobo: 0 },
  claims: [
    claim({ id: 'paid', organizer_name: 'Paid Org', event_title: 'Paid concert' }),
    claim({ id: 'free', organizer_name: 'Free Org', event_title: 'Free meetup', is_free_event: true }),
  ],
  attributions: [], expenses: [], monthly_counts: [], audit: [],
};

let container: HTMLDivElement;
let root: Root;
const flush = () => new Promise((r) => setTimeout(r, 0));
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const requests = () => rpc.mock.calls.filter(([name]) => name === 'request_admin_action').map(([, args]) => args);

beforeEach(async () => {
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => (name === 'admin_get_vents_earn_overview'
    ? { data: overview, error: null } : { data: { id: 'req-1' }, error: null }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<AdminEarnScreen />); await flush(); });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe('AdminEarnScreen: free events never qualify', () => {
  it('a free-event claim has no approve action, says it never qualifies, and can still be rejected', () => {
    expect(q('earn-claim-approve-free')).toBeNull();
    expect(q('earn-claim-free-free')?.textContent).toMatch(/Free event: never qualifies/);
    expect(container.textContent).toContain('FREE EVENT (never qualifies)');
    const rejectButtons = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Request rejection');
    expect(rejectButtons).toHaveLength(2);   // both pending claims can be rejected
  });

  it('a paid claim can be put forward; the request never carries free_event_verified', async () => {
    expect(q('earn-claim-free-paid')).toBeNull();
    await act(async () => { q('earn-claim-approve-paid')!.click(); await flush(); });
    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({ p_action_type: 'earn_approve_reward', p_target_id: 'paid',
      p_payload: { claim_id: 'paid', event_verified: true } });
    expect(requests()[0].p_payload).not.toHaveProperty('free_event_verified');
    // The admin is never asked to vouch for a free event.
    expect((window.confirm as any).mock.calls.some(([m]: [string]) => /free event/i.test(m))).toBe(false);
  });

  it('the reward is fixed at ₦50,000: no higher-rate request anywhere, and the screen says so', async () => {
    expect(container.textContent).not.toMatch(/Request higher rate|higher rate|9 or more/i);
    expect(container.querySelector('[aria-label="New rate (₦)"]')).toBeNull();
    expect(q('earn-fixed-reward-note')?.textContent).toMatch(/fixed at ₦50,000 per qualifying organizer\. There is no monthly rate, uplift or bonus/);
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(readFileSync(join(__dirname, 'AdminEarnScreen.tsx'), 'utf8')).not.toContain('earn_set_monthly_rate');
  });

  it('nothing in the screen can send the retired override', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'AdminEarnScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/free_event_verified/);
    expect(src).not.toMatch(/Confirm you verified it was a genuine event/);
  });
});
