import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// VENTS AI is web-only for this release. SettingsScreen's "VENTS AI"
// preference row is itself a promotional entry point (it links the
// feature by name and lets the user turn it back on) -- this proves it
// doesn't render on iOS or Android, while web keeps it exactly as before
// (same mocking convention as AiAccessScreen.iosSelfGuard.security.test.tsx).

const getPlatformMock = vi.fn<() => string>(() => 'web');
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => getPlatformMock(),
    isNativePlatform: () => getPlatformMock() !== 'web',
  },
}));

const maybeSingleMock = vi.fn(() => Promise.resolve({ data: null, error: null }));
vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }),
    }),
  },
  getAuthToken: () => Promise.resolve(null),
}));

import { SettingsScreen } from './SettingsScreen';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const currentUser = { id: 'u1', email: 'a@b.com', full_name: 'A B', role: 'attendee' };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  getPlatformMock.mockReturnValue('web');
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SettingsScreen: VENTS AI preference row removed entirely on mobile', () => {
  it('iOS: no "VENTS AI" row at all', async () => {
    getPlatformMock.mockReturnValue('ios');
    act(() => {
      root!.render(
        <SettingsScreen
          currentUser={currentUser}
          onBack={() => {}}
          onSignOut={() => {}}
          isDark
          onToggleDark={() => {}}
          ventsAiEnabled
          onToggleVentsAi={() => {}}
        />
      );
    });
    await flush();
    expect(container!.textContent).not.toContain('VENTS AI');
  });

  it('Android: no "VENTS AI" row either, same as iOS', async () => {
    getPlatformMock.mockReturnValue('android');
    act(() => {
      root!.render(
        <SettingsScreen
          currentUser={currentUser}
          onBack={() => {}}
          onSignOut={() => {}}
          isDark
          onToggleDark={() => {}}
          ventsAiEnabled
          onToggleVentsAi={() => {}}
        />
      );
    });
    await flush();
    expect(container!.textContent).not.toContain('VENTS AI');
  });

  it('Web: "VENTS AI" row still renders, unchanged from before this fix', async () => {
    getPlatformMock.mockReturnValue('web');
    act(() => {
      root!.render(
        <SettingsScreen
          currentUser={currentUser}
          onBack={() => {}}
          onSignOut={() => {}}
          isDark
          onToggleDark={() => {}}
          ventsAiEnabled
          onToggleVentsAi={() => {}}
        />
      );
    });
    await flush();
    expect(container!.textContent).toContain('VENTS AI');
  });
});
