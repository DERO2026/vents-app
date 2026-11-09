import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Both sides of a VENTS Representative referral render ONLY what the server
// returns for the signed-in user (0209/0210) -- no mock counts, no locally
// simulated connection, no commission wording.
let responses: Record<string, { data: any; error: any }> = {};
const rpc = vi.fn(async (fn: string, _args?: unknown) => responses[fn] ?? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
vi.mock('../../../lib/supabase', () => ({ supabase: { rpc: (fn: string, a: any) => rpc(fn, a) } }));
import { RepresentativeConnectionCard } from './representativeConnection';
import { RepresentativeInviteBanner } from './RepresentativeInviteBanner';
import { REP_REFERRAL_STORAGE_KEY } from '../../../lib/representativeReferral';

let container: HTMLDivElement; let root: Root;
async function render(el: React.ReactElement) {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(el); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
afterEach(() => { act(() => root.unmount()); container.remove(); rpc.mockClear(); responses = {}; localStorage.clear(); });

const established = {
  status: 'established', is_representative: false,
  attribution: { attributed_at: '2026-11-01T10:00:00Z', source: 'referral_link', representative: { display_name: 'Rep One', username: 'rep_one', active: true } },
  pending_invitations: [], reward_confirmations: [],
  events: [{ event_id: 'e1', title: 'Free meetup', event_date: null, created_at: '2026-11-02T00:00:00Z', eligible: false, reasons: ['free_event'], is_free_event: true }],
  reward_amount_kobo: 5000000, organizer_pays_for_referral: false,
};

describe('organizer side: Your VENTS Representative', () => {
  it('established: names the representative and username from the server, says it is permanent and free for the organizer', async () => {
    responses.get_my_representative_connection = { data: established, error: null };
    await render(<RepresentativeConnectionCard enabled />);
    expect(q('rep-connection-name')?.textContent).toBe('Rep One · @rep_one');
    expect(q('rep-connection-established')?.textContent).toMatch(/joined VENTS through their referral link/);
    expect(q('rep-connection-established')?.textContent).toMatch(/permanent/);
    expect(q('rep-connection-cost-note')?.textContent).toMatch(/costs you nothing/);
    expect(q('rep-connection-event-e1')?.textContent).toMatch(/Free events do not qualify/);
    expect(container.textContent).not.toMatch(/commission %|\d+% commission|deducted for/i);
  });
  it('the reward steps say a fixed N50,000 paid by VENTS only after the event took place', async () => {
    responses.get_my_representative_connection = { data: established, error: null };
    await render(<RepresentativeConnectionCard enabled />);
    await act(async () => { (q('rep-connection-how') as HTMLElement).click(); });
    const steps = q('referral-steps-organizer')?.textContent ?? '';
    expect(steps).toMatch(/₦50,000/);
    expect(steps).toMatch(/fixed reward paid by VENTS, not a commission/);
    expect(steps).toMatch(/Event took place/);
    expect(steps).toMatch(/two VENTS admins/);
  });
  it('pending: names the inviting representative and marks it pending', async () => {
    responses.get_my_representative_connection = { data: { ...established, status: 'pending', attribution: null, events: [],
      pending_invitations: [{ partnership_id: 'p1', invited_at: '2026-11-03T00:00:00Z', representative: { display_name: 'Rep Two', username: 'rep_two' } }] }, error: null };
    await render(<RepresentativeConnectionCard enabled />);
    expect(q('rep-connection-pending-p1')?.textContent).toMatch(/Rep Two · @rep_two/);
    expect(q('rep-connection-pending-p1')?.textContent).toMatch(/Pending/);
  });
  it('none, with a referral link still being claimed: says it is connecting (no fake connection)', async () => {
    localStorage.setItem(REP_REFERRAL_STORAGE_KEY, JSON.stringify({ code: 'ABCDEFGH', at: Date.now() }));
    responses.get_my_representative_connection = { data: { ...established, status: 'none', attribution: null, events: [] }, error: null };
    await render(<RepresentativeConnectionCard enabled />);
    expect(q('rep-connection-connecting')).not.toBeNull();
    expect(q('rep-connection-established')).toBeNull();
  });
  it('none and no link: shows nothing; a representative: shows nothing; backend not live yet: shows nothing', async () => {
    responses.get_my_representative_connection = { data: { ...established, status: 'none', attribution: null }, error: null };
    await render(<RepresentativeConnectionCard enabled />);
    expect(q('rep-connection')).toBeNull();
    act(() => root.unmount()); container.remove();
    responses.get_my_representative_connection = { data: { ...established, is_representative: true }, error: null };
    await render(<RepresentativeConnectionCard enabled />);
    expect(q('rep-connection')).toBeNull();
    act(() => root.unmount()); container.remove();
    responses = {};
    await render(<RepresentativeConnectionCard enabled />);
    expect(q('rep-connection')).toBeNull();
  });
});

describe('organizer side, before registering: who invited me', () => {
  it('shows the representative from the server preview for a stored link code', async () => {
    localStorage.setItem(REP_REFERRAL_STORAGE_KEY, JSON.stringify({ code: 'ABCDEFGH', at: Date.now() }));
    responses.get_representative_referral_preview = { data: { valid: true, code: 'ABCDEFGH', representative: { display_name: 'Rep One', username: 'rep_one' } }, error: null };
    await render(<RepresentativeInviteBanner />);
    expect(q('rep-invite-banner')?.textContent).toMatch(/Rep One · @rep_one invited you to VENTS/);
    expect(q('rep-invite-banner')?.textContent).toMatch(/costs you nothing/);
    expect(rpc).toHaveBeenCalledWith('get_representative_referral_preview', { p_code: 'ABCDEFGH' });
  });
  it('an invalid or suspended code shows nothing (never trusts the URL)', async () => {
    localStorage.setItem(REP_REFERRAL_STORAGE_KEY, JSON.stringify({ code: 'ZZZZZZZZ', at: Date.now() }));
    responses.get_representative_referral_preview = { data: { valid: false }, error: null };
    await render(<RepresentativeInviteBanner />);
    expect(q('rep-invite-banner')).toBeNull();
  });
  it('no link opened: no call, nothing shown', async () => {
    await render(<RepresentativeInviteBanner />);
    expect(rpc).not.toHaveBeenCalled();
    expect(q('rep-invite-banner')).toBeNull();
  });
});
