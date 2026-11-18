import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Organizer side of event cancellation (0218): an event with ticket holders
// is steered to a cancellation request instead of deletion (the server also
// refuses the delete); the request explains what happens to ticket holders,
// needs a reason, and its status and refund progress show on the card.
const sold = { id: 'e1', title: 'Lagos Jazz Night', status: 'live', displayStatus: 'live', soldCount: 6, soldQuantity: 6, ticketGoal: 100, revenue: 0, checkedIn: 0, date: '2026-12-08', time: '19:00', location: 'Lagos' };
const empty = { ...sold, id: 'e2', title: 'Empty draft', soldCount: 0, soldQuantity: 0 };
let eventsList: any[] = [sold, empty];
vi.mock('../../lib/useOrganizerEvents', () => ({
  useOrganizerEvents: () => ({ events: eventsList, loading: false, error: null, sort: 'newest', setSort: () => {}, live: true, refresh: () => {} }),
}));
vi.mock('../../lib/useDesktopWideShell', () => ({ useDesktopWideShell: () => {} }));
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../lib/supabase', () => ({ supabase: { rpc }, getAuthToken: async () => 't' }));

import { ManageEventsScreen } from './ManageEventsScreen';

let container: HTMLDivElement; let root: Root;
const flush = () => new Promise((r) => setTimeout(r, 0));
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const byText = (t: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); await flush(); }); };
async function render() {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => {
    root.render(<ManageEventsScreen onBack={() => {}} currentUser={{ id: 'org-1' } as any} onOpenEdit={() => {}} onCreateEvent={() => {}} onViewAttendees={() => {}} onViewAnalytics={() => {}} onOpenDoorManager={() => {}} onOpenScanner={() => {}} />);
    await flush();
  });
}
const openOptions = async (title: string) => {
  const card = [...container.querySelectorAll('.vents-manage-card')].find((c) => c.textContent?.includes(title))!;
  await click(card.querySelector('button[aria-label="Event options"]'));
};

beforeEach(() => { rpc.mockReset(); eventsList = [sold, empty]; });
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('ManageEventsScreen: event cancellation', () => {
  it('an event with ticket holders is steered to a cancellation, not deleted', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await render();
    await openOptions('Lagos Jazz Night');
    await click(byText('Delete Event'));
    expect(q('delete-event-explainer')?.textContent).toContain("has 6 ticket(s) sold, so it can't be deleted");
    expect(byText('Delete')).toBeUndefined();
    await click(q('delete-to-cancel'));
    expect(q('cancel-event-dialog')).not.toBeNull();
    expect(rpc.mock.calls.map(([n]) => n)).not.toContain('soft_delete_event');
  });

  it('an event with no ticket holders keeps the normal delete', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await render();
    await openOptions('Empty draft');
    await click(byText('Delete Event'));
    expect(q('delete-event-explainer')?.textContent).toContain('will be removed from your dashboard');
    expect(byText('Delete')).toBeDefined();
  });

  it('the request explains what happens to ticket holders, needs a reason, and is sent to the server', async () => {
    rpc.mockImplementation(async (name: string) => name === 'get_my_event_cancellations' ? { data: [], error: null } : { data: { id: 'rq1', status: 'requested' }, error: null });
    await render();
    await openOptions('Lagos Jazz Night');
    await click(byText('Cancel Event'));
    const explainer = q('cancel-event-explainer')!.textContent!;
    expect(explainer).toContain('Ticket sales stay open until it is approved');
    expect(explainer).toContain('each of the 6 ticket(s) sold is refunded the way it was paid');
    expect(explainer).toContain("can't be undone");
    await click(q('cancel-event-submit'));
    expect(q('cancel-event-error')?.textContent).toContain('at least 10 characters');
    expect(rpc.mock.calls.map(([n]) => n)).not.toContain('request_event_cancellation');
    const ta = container.querySelector('textarea[aria-label="Cancellation reason"]') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'The venue flooded and is closed');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(q('cancel-event-submit'));
    expect(rpc).toHaveBeenCalledWith('request_event_cancellation', { p_event_id: 'e1', p_reason: 'The venue flooded and is closed' });
  });

  it('a server refusal is shown, not swallowed', async () => {
    rpc.mockImplementation(async (name: string) => name === 'get_my_event_cancellations' ? { data: [], error: null } : { data: null, error: { message: 'A cancellation request for this event is already open' } });
    await render();
    await openOptions('Lagos Jazz Night');
    await click(byText('Cancel Event'));
    const ta = container.querySelector('textarea[aria-label="Cancellation reason"]') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, 'The venue flooded and is closed');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(q('cancel-event-submit'));
    expect(q('cancel-event-error')?.textContent).toBe('A cancellation request for this event is already open');
  });

  it('the card shows the request status and refund progress; delete and make-live are not offered', async () => {
    rpc.mockResolvedValue({ data: [{ id: 'rq1', event_id: 'e1', status: 'attention', reason: 'x', requested_at: '', decided_at: '', decision_note: null, completed_at: null,
      refunds: { total: 6, refunded: 5, processing: 0, needs_attention: 1 } }], error: null });
    await render();
    expect(q('cancellation-status-e1')?.textContent).toBe('Cancelled · some refunds need attention · 5/6 refunded');
    await openOptions('Lagos Jazz Night');
    expect(byText('Delete Event')).toBeUndefined();
    expect(byText('Cancel Event')).toBeUndefined();
    expect(byText('Make Live')).toBeUndefined();
    expect(byText('Hide as Draft')).toBeUndefined();
  });

  it('before 0218 is applied (function missing) nothing about cancellations is shown and the screen still works', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    await render();
    expect(q('cancellation-status-e1')).toBeNull();
    expect(container.textContent).toContain('Lagos Jazz Night');
  });
});
