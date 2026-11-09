// @vitest-environment jsdom
// Regression tests: selecting Creator Studio must open Creator Studio for
// organizers (it used to land on the attendee Home feed) and the organizer
// application for everyone else (it used to do nothing).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { decideCreatorStudioDestination } from '../../../lib/creatorStudioRouting';
import { organizerRole } from '../../../lib/workRoles';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fromMock = vi.fn();
const rpcMock = vi.fn();
vi.mock('../../../lib/supabase', () => ({
  supabase: { from: (...a: any[]) => fromMock(...a), rpc: (...a: any[]) => rpcMock(...a) },
}));
vi.mock('../../../lib/vcBalanceCache', () => ({ getVcBalance: () => Promise.resolve({ spendable: 0 }) }));
vi.mock('../SettingsScreen', () => ({ CACVerificationScreen: () => <div data-testid="cac-screen" /> }));

import { VentsWorkScreen } from './VentsWorkScreen';

function chain(result: any) {
  const obj: any = {
    select: () => obj, eq: () => obj, order: () => obj, limit: () => obj, in: () => obj, is: () => obj,
    maybeSingle: () => Promise.resolve({ data: Array.isArray(result) ? result[0] ?? null : result, error: null }),
    then: (res: any, rej: any) => Promise.resolve({ data: result, error: null }).then(res, rej),
  };
  return obj;
}
let tables: Record<string, any>;

beforeEach(() => {
  tables = {
    organizer_requests: null, service_provider_requests: null, service_providers: null,
    recruiters: null, organizer_wallets: null, recruiter_partnerships: [],
  };
  fromMock.mockImplementation((t: string) => chain(tables[t] ?? null));
  rpcMock.mockImplementation(() => Promise.resolve({ data: [], error: null }));
});

let container: HTMLDivElement;
let root: Root;
async function render(el: ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container); root.render(el); });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}
afterEach(() => { act(() => root?.unmount()); container?.remove(); });
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
};

describe('decideCreatorStudioDestination', () => {
  const never = () => Promise.reject(new Error('should not be called'));

  it('an organizer goes to Creator Studio without a lookup', async () => {
    expect(await decideCreatorStudioDestination({ id: 'u1', role: 'user', isOrganizer: true }, never))
      .toEqual({ destination: 'creator-studio', confirmedOrganizer: false });
  });

  it('admin and sub-admin staff go to Creator Studio (same rule as Home\'s "+" button)', async () => {
    expect((await decideCreatorStudioDestination({ id: 'a', role: 'admin', isOrganizer: false }, never)).destination).toBe('creator-studio');
    expect((await decideCreatorStudioDestination({ id: 's', role: 'sub-admin', isOrganizer: false }, never)).destination).toBe('creator-studio');
  });

  it('a just-approved organizer the 15s role sync has not caught yet goes to Creator Studio', async () => {
    const d = await decideCreatorStudioDestination({ id: 'u1', role: 'user', isOrganizer: false }, async () => ({ is_organizer: true, role: 'user' }));
    expect(d).toEqual({ destination: 'creator-studio', confirmedOrganizer: true });
  });

  it('a non-organizer goes to the organizer application', async () => {
    const d = await decideCreatorStudioDestination({ id: 'u1', role: 'user', isOrganizer: false }, async () => ({ is_organizer: false, role: 'user' }));
    expect(d.destination).toBe('organizer-application');
  });

  it('a failed lookup never grants Creator Studio', async () => {
    const d = await decideCreatorStudioDestination({ id: 'u1', role: 'user', isOrganizer: false }, () => Promise.reject(new Error('offline')));
    expect(d.destination).toBe('organizer-application');
  });

  it('no signed-in user never reaches Creator Studio', async () => {
    expect((await decideCreatorStudioDestination(null, never)).destination).toBe('organizer-application');
  });
});

describe('App.openCreatorStudio wiring', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');
  const fn = app.slice(app.indexOf('const openCreatorStudio = useCallback'), app.indexOf('const handleOrgNavigate'));

  it('navigates organizers to org-dashboard, never to Home', () => {
    expect(fn).toMatch(/navigateTo\('org-dashboard'\)/);
    expect(fn).not.toMatch(/setScreen\('home'\)/);
    expect(fn).not.toMatch(/setActiveTab\('home'\)/);
  });

  it('sends non-organizers to the organizer application in VENTS Work', () => {
    expect(fn).toMatch(/setOrganizerApplicationSignal/);
    expect(fn).toMatch(/navigateTo\('vents-work'\)/);
  });

  it('Home\'s "+" and Profile both use the same Creator Studio route', () => {
    expect(app).toMatch(/onCreatePress=\{\(\) => void openCreatorStudio\(\)\}/);
    expect(app).toMatch(/if \(view === 'organizer'\) \{\s*\n\s*void openCreatorStudio\(\);/);
    expect(app).toMatch(/openOrganizerApplicationSignal=\{organizerApplicationSignal\}/);
  });
});

describe('Organizer role row', () => {
  it('an unverified organizer opens Creator Studio, not CAC verification', () => {
    expect(organizerRole({ isOrganizer: true, isStaff: false, isVerified: false, request: 'approved' }).action).toBe('organizer-studio');
    expect(organizerRole({ isOrganizer: true, isStaff: false, isVerified: true, request: 'approved' }).action).toBe('organizer-studio');
  });

  it('a non-organizer is sent to the application', () => {
    expect(organizerRole({ isOrganizer: false, isStaff: false, isVerified: false, request: 'none' }).action).toBe('organizer-apply');
  });
});

describe('VENTS Work hub', () => {
  const plain = { id: 'u1', role: 'user', isOrganizer: false, is_service_provider: false, is_verified: false };

  it('opens the organizer application when App signals a non-organizer chose Creator Studio', async () => {
    await render(<VentsWorkScreen currentUser={plain} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={() => {}} openOrganizerApplicationSignal={1} />);
    expect(byTestId('organizer-request-sheet')).toBeTruthy();
  });

  it('does not open the application on a normal visit', async () => {
    await render(<VentsWorkScreen currentUser={plain} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={() => {}} />);
    expect(byTestId('organizer-request-sheet')).toBeNull();
  });

  it('an unverified organizer\'s role row opens Creator Studio; CAC is a separate shortcut', async () => {
    const onOpen = vi.fn();
    await render(<VentsWorkScreen currentUser={{ ...plain, isOrganizer: true }} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={onOpen} />);
    await click(byTestId('work-role-organizer')!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(byTestId('cac-screen')).toBeNull();
    await click(byTestId('shortcut-cac')!);
    expect(byTestId('cac-screen')).toBeTruthy();
  });

  it('an approved application shows "Open Creator Studio" instead of the form again', async () => {
    tables.organizer_requests = { status: 'approved', admin_note: null, reason: 'x' };
    const onOpen = vi.fn();
    await render(<VentsWorkScreen currentUser={plain} onBack={() => {}} onNavigate={() => {}} onOpenCreatorStudio={onOpen} openOrganizerApplicationSignal={1} />);
    const btn = byTestId('org-sheet-open-studio');
    expect(btn).toBeTruthy();
    expect(container.textContent).not.toContain('Submit Request');
    await click(btn!);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
