import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Private Chats Realtime (migration 0199): the screen must join only MY
// private personal topic and this conversation's private dm topic, send
// typing on the dm topic, and never join or send to the other user's
// personal topic (which used to let any client watch anyone's activity).

type MockChannel = {
  topic: string;
  opts: any;
  handlers: { event: string; cb: (msg: any) => void }[];
  on: (type: string, filter: { event: string }, cb: (msg: any) => void) => MockChannel;
  subscribe: () => MockChannel;
  send: ReturnType<typeof vi.fn>;
};

const { channels, removeChannel, fromCalls } = vi.hoisted(() => ({
  channels: [] as any[],
  removeChannel: vi.fn(),
  fromCalls: [] as string[],
}));

vi.mock('../../lib/supabase', () => {
  // Any query chain resolves to an empty, successful result.
  const chain = (): any =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve({ data: [], error: null }) : chain()),
      apply: () => chain(),
    });
  return {
    supabase: {
      from: (table: string) => { fromCalls.push(table); return chain(); },
      rpc: () => Promise.resolve({ data: null, error: null }),
      storage: { from: () => chain() },
      channel: (topic: string, opts?: any) => {
        const ch: MockChannel = {
          topic, opts, handlers: [],
          on(_type, filter, cb) { ch.handlers.push({ event: filter.event, cb }); return ch; },
          subscribe() { return ch; },
          send: vi.fn(async () => 'ok'),
        };
        channels.push(ch);
        return ch;
      },
      removeChannel,
    },
  };
});
vi.mock('../../lib/haptics', () => ({ haptics: { light: vi.fn(), medium: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));

import { ConversationScreen } from './ConversationScreen';

const ME = '0000000b-0000-0000-0000-00000000000b';
const OTHER = '0000000a-0000-0000-0000-00000000000a';
const DM = `dm:${OTHER}:${ME}`; // sorted order

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  channels.length = 0;
  fromCalls.length = 0;
  removeChannel.mockClear();
  if (!(Element.prototype as any).scrollIntoView) (Element.prototype as any).scrollIntoView = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ConversationScreen currentUser={{ id: ME }} otherUser={{ id: OTHER, name: 'Ada' }} onBack={() => {}} />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTopic = (t: string) => channels.find((c) => c.topic === t) as MockChannel | undefined;
const fire = (ch: MockChannel, event: string, payload: any) =>
  act(() => { ch.handlers.filter((h) => h.event === event).forEach((h) => h.cb({ payload })); });

describe('ConversationScreen private Realtime', () => {
  it('joins only my private personal topic and the private conversation topic', () => {
    expect(channels.map((c) => c.topic).sort()).toEqual([DM, `user:${ME}`].sort());
    for (const c of channels) expect(c.opts?.config?.private).toBe(true);
    expect(byTopic(`user:${OTHER}`)).toBeUndefined();
  });

  it('listens for new_message on my topic and typing on the conversation topic only', () => {
    expect(byTopic(`user:${ME}`)!.handlers.map((h) => h.event)).toEqual(['new_message']);
    expect(byTopic(DM)!.handlers.map((h) => h.event)).toEqual(['typing']);
  });

  it('sends typing on the conversation topic, never on a personal topic', () => {
    const input = container.querySelector('textarea, input[placeholder="Type a message…"]') as HTMLTextAreaElement;
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
    act(() => { setter.call(input, 'hi'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(byTopic(DM)!.send).toHaveBeenCalledWith({ type: 'broadcast', event: 'typing', payload: { from: ME } });
    expect(byTopic(`user:${ME}`)!.send).not.toHaveBeenCalled();
  });

  it('shows the indicator for the other participant typing, and ignores any other sender', () => {
    const dm = byTopic(DM)!;
    fire(dm, 'typing', { from: '0000000c-0000-0000-0000-00000000000c' });
    expect(container.textContent).not.toContain('typing…');
    fire(dm, 'typing', { from: OTHER });
    expect(container.textContent).toContain('typing…');
  });

  it('reloads the thread on a body-less new_message signal from this conversation', async () => {
    const before = fromCalls.filter((t) => t === 'direct_messages').length;
    const ch = byTopic(`user:${ME}`)!;
    await act(async () => {
      ch.handlers.filter((h) => h.event === 'new_message')
        .forEach((h) => h.cb({ payload: { id: 'm1', sender_id: OTHER, recipient_id: ME, created_at: '2026-10-28T10:00:00Z' } }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fromCalls.filter((t) => t === 'direct_messages').length).toBeGreaterThan(before);
  });

  it('removes both channels when the conversation closes', () => {
    const opened = [...channels];
    act(() => root.unmount());
    for (const c of opened) expect(removeChannel).toHaveBeenCalledWith(c);
    root = createRoot(container); // afterEach unmounts again harmlessly
  });
});
