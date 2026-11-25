import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// Regression (release audit C1): ProfileScreen returns early when there is no
// user. A hook placed after that return made React throw "Rendered fewer hooks
// than expected" when the user became null while the screen stayed mounted
// (e.g. the native app-resume session check signing the user out on Profile).

vi.mock('../../lib/supabase', () => {
  const q: any = new Proxy({}, {
    get: (_t, k) => k === 'then' ? (r: any) => r({ data: [], error: null, count: 0 })
      : (k === 'maybeSingle' || k === 'single') ? () => Promise.resolve({ data: null, error: null }) : () => q,
  });
  return { supabase: {
    from: () => q, rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
  } };
});

import { ProfileScreen } from './ProfileScreen';

const KEY = 'vents:balance-privacy:hidden';
let root: Root | null = null; let c: HTMLDivElement | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); c?.remove(); root = null; c = null; localStorage.removeItem(KEY); });

const props: any = { onNavigate: () => {}, onSignOut: () => {}, tickets: [], savedCount: 0, onViewTicket: () => {}, setActiveView: () => {}, userRole: 'user' };
const user: any = { id: 'u1', email: 'a@example.test', full_name: 'Ada' };

async function render(currentUser: any) {
  await act(async () => { root!.render(<ProfileScreen {...props} currentUser={currentUser} />); });
}

describe('ProfileScreen: signed-in -> signed-out while mounted', () => {
  for (const hidden of [false, true]) {
    it(`shows the signed-out state instead of crashing (balances ${hidden ? 'hidden' : 'shown'})`, async () => {
      if (hidden) localStorage.setItem(KEY, '1');
      c = document.createElement('div'); document.body.appendChild(c); root = createRoot(c);
      await render(user);
      expect(c.textContent).not.toContain('Sign in to view your profile');
      await render(null);
      expect(c.textContent).toContain('Sign in to view your profile');
      // and back again (sign in on the same mounted screen)
      await render(user);
      expect(c.textContent).not.toContain('Sign in to view your profile');
    });
  }
});
