import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { VentsAiScreen } from './VentsAiScreen';

// sendVentsAiMessage is the one seam between this screen and the real
// backend (api/ai-assistant.ts) -- mocked here the same way
// UserAutocomplete.render.test.tsx mocks its own network seam, so these
// tests exercise real rendering/state logic, not network plumbing.
const sendVentsAiMessage = vi.fn();
vi.mock('../../lib/ventsAi', () => ({
  sendVentsAiMessage: (...args: any[]) => sendVentsAiMessage(...args),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  sendVentsAiMessage.mockReset();
});

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<VentsAiScreen onClose={() => {}} />);
  });
}

async function typeAndSend(text: string) {
  const input = container!.querySelector('input') as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Both the input's wrapper div and the actual send-arrow div have
  // textContent '↑' (the wrapper's only text-bearing descendant is the
  // arrow span) -- the clickable one is the absolutely-positioned circle.
  const sendBtn = Array.from(container!.querySelectorAll('div')).find(
    (d) => d.textContent === '↑' && d.style.position === 'absolute'
  ) as HTMLDivElement;
  await act(async () => {
    sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('VentsAiScreen: confirmation card', () => {
  it('renders Cancel/Confirm and Confirm re-posts confirmedAction with the real token', async () => {
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'confirmation_required',
      action: 'request_ticket_refund',
      params: { ticket_id: 't1', reason: 'test' },
      proposal: { action: 'request_ticket_refund', ticket_id: 't1', reason: 'test' },
      token: 'signed-token-abc',
      text: "You're eligible for a refund.",
    });
    mount();
    await typeAndSend('Can I get a refund?');

    const confirmBtn = container!.querySelector('[data-testid="ai-confirmation-confirm"]') as HTMLElement;
    const cancelBtn = container!.querySelector('[data-testid="ai-confirmation-cancel"]') as HTMLElement;
    expect(confirmBtn).toBeTruthy();
    expect(cancelBtn).toBeTruthy();
    expect(confirmBtn.textContent).toContain('Confirm Refund');

    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: 'Done -- request ticket refund completed.',
      cards: [{ type: 'request_ticket_refund', data: { id: 'r1' }, source: 'vents' }],
    });

    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(sendVentsAiMessage).toHaveBeenCalledTimes(2);
    const secondCallArgs = sendVentsAiMessage.mock.calls[1];
    expect(secondCallArgs[1]).toEqual({
      action: 'request_ticket_refund',
      params: { ticket_id: 't1', reason: 'test' },
      token: 'signed-token-abc',
    });
    expect(container!.querySelector('[data-testid="ai-success-card"]')).toBeTruthy();
  });

  it('Cancel discards the proposal client-side without any extra request', async () => {
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'confirmation_required',
      action: 'start_ticket_transfer',
      params: { ticket_id: 't2', recipient_identifier: '@someone' },
      proposal: { action: 'start_ticket_transfer', ticket_id: 't2', recipient_identifier: '@someone' },
      token: 'tok-2',
    });
    mount();
    await typeAndSend('Transfer my ticket to @someone');

    expect(sendVentsAiMessage).toHaveBeenCalledTimes(1);
    const cancelBtn = container!.querySelector('[data-testid="ai-confirmation-cancel"]') as HTMLElement;
    act(() => {
      cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // No second network call, and the Cancel/Confirm buttons are gone.
    expect(sendVentsAiMessage).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[data-testid="ai-confirmation-confirm"]')).toBeFalsy();
    expect(container!.textContent).toContain('nothing was changed');
  });
});

describe('VentsAiScreen: external vs VENTS-source cards', () => {
  it('renders a source:"external" card as a plain labeled result, never the VENTS event-card template', async () => {
    sendVentsAiMessage.mockResolvedValueOnce({
      type: 'message',
      text: "Here's what I found.",
      cards: [
        {
          type: 'search_events',
          source: 'vents',
          data: [{ id: 'e1', title: 'Naija Live Sessions', location: 'Abuja', price: 8000, event_date: '2026-09-20T19:00:00Z' }],
        },
        {
          type: 'web_search',
          source: 'external',
          data: [{ title: 'Some Concert Elsewhere', url: 'https://example.com/concert' }],
        },
      ],
    });
    mount();
    await typeAndSend('Find concerts nearby');

    const ventsCard = container!.querySelector('[data-testid="ai-external-card"]');
    expect(ventsCard).toBeTruthy();
    expect(container!.textContent).toContain('Found elsewhere — not on VENTS');

    // The VENTS event card renders its own "View Event" bookable action --
    // the external card must never carry that, keeping the two visually
    // and structurally distinct per the backend's source:'external' rule.
    expect(container!.textContent).toContain('View Event');
    expect(container!.textContent).toContain('Naija Live Sessions');
    const externalCardText = ventsCard!.textContent || '';
    expect(externalCardText).not.toContain('View Event');
    expect(externalCardText).toContain('Some Concert Elsewhere');
  });
});
