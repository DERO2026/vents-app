import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rpc = vi.fn();
vi.mock('../../lib/supabase', () => ({ supabase: { rpc: (...a: any[]) => rpc(...a) } }));
import { RepresentativeBadge } from './RepresentativeBadge';

let container: HTMLDivElement; let root: Root;
async function render(userId: string) {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<RepresentativeBadge userId={userId} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
afterEach(() => { act(() => root.unmount()); container.remove(); rpc.mockReset(); });
const badge = () => container.querySelector('[data-testid="representative-badge"]');

describe('VENTS Representative badge', () => {
  it('shows only when the server lists the user as an active representative', async () => {
    rpc.mockResolvedValue({ data: [{ user_id: 'rep-1' }], error: null });
    await render('rep-1');
    expect(badge()?.textContent).toBe('VENTS Representative');
    expect(rpc).toHaveBeenCalledWith('get_representative_badges', { p_user_ids: ['rep-1'] });
  });
  it('is hidden for anyone the server does not list (suspended, unregistered, deleted)', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await render('user-2');
    expect(badge()).toBeNull();
  });
  it('is hidden on any error, including before 0209 is deployed', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    await render('rep-3');
    expect(badge()).toBeNull();
  });
  it('appears on both profile screens, from the server status only', () => {
    const own = readFileSync(join(__dirname, 'ProfileScreen.tsx'), 'utf8');
    const pub = readFileSync(join(__dirname, 'UserProfileScreen.tsx'), 'utf8');
    expect(own).toMatch(/<RepresentativeBadge userId=\{currentUser\?\.id\} \/>/);
    expect(pub).toMatch(/<RepresentativeBadge userId=\{user\.id\} \/>/);
    const src = readFileSync(join(__dirname, 'RepresentativeBadge.tsx'), 'utf8');
    expect(src).not.toMatch(/gradient/);
  });
});
