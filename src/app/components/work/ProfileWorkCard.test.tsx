// @vitest-environment jsdom
// Profile VENTS Work card: prominent heading, all four indicators always
// visible with their live state, and the whole card opens VENTS Work.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProfileWorkCard, workIndicators } from './ProfileWorkCard';
import { organizerRole, providerRole, representativeRole } from '../../../lib/workRoles';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
afterEach(() => { act(() => root.unmount()); container.remove(); });

function render(indicators: ReturnType<typeof workIndicators>, onOpen = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(<ProfileWorkCard indicators={indicators} onOpen={onOpen} />); });
  return onOpen;
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;

const newcomer = () => workIndicators({
  loading: false,
  organizer: organizerRole({ isOrganizer: false, isStaff: false, isVerified: false, request: 'none' }),
  provider: providerRole({ isProvider: false, isStaff: false, request: 'none', profileStatus: null }),
  representative: representativeRole('none'),
  vcSpendable: 0,
});

describe('ProfileWorkCard', () => {
  it('has a prominent VENTS Work heading', () => {
    render(newcomer());
    const h = container.querySelector('h2')!;
    expect(h.textContent).toBe('VENTS Work');
    expect(parseInt(h.style.fontSize, 10)).toBeGreaterThanOrEqual(22);
    expect(h.style.fontWeight).toBe('800');
  });

  it('always shows Organizer, Provider, Representative and VENTS Cents -- even before any role is taken up', () => {
    render(newcomer());
    for (const key of ['organizer', 'provider', 'representative', 'vc']) {
      expect(q(`vents-work-indicator-${key}`)).toBeTruthy();
    }
    expect(q('vents-work-indicator-organizer').textContent).toContain('Start');
    expect(q('vents-work-indicator-representative').textContent).toContain('Join');
    expect(q('vents-work-indicator-vc').textContent).toContain('0 VC');
  });

  it('shows live states for an active organizer, a provider in review and an active representative', () => {
    render(workIndicators({
      loading: false,
      organizer: organizerRole({ isOrganizer: true, isStaff: false, isVerified: true, request: 'approved' }),
      provider: providerRole({ isProvider: false, isStaff: false, request: 'pending', profileStatus: null }),
      representative: representativeRole('active'),
      vcSpendable: 1250,
    }));
    expect(q('vents-work-indicator-organizer').textContent).toContain('Verified');
    expect(q('vents-work-indicator-organizer').dataset.tone).toBe('on');
    expect(q('vents-work-indicator-provider').textContent).toContain('In review');
    expect(q('vents-work-indicator-provider').dataset.tone).toBe('wait');
    expect(q('vents-work-indicator-representative').dataset.tone).toBe('on');
    expect(q('vents-work-indicator-vc').textContent).toContain('1,250 VC');
  });

  it('shows placeholders while statuses load, never a wrong state', () => {
    render(workIndicators({
      loading: true,
      organizer: organizerRole({ isOrganizer: false, isStaff: false, isVerified: false, request: 'none' }),
      provider: providerRole({ isProvider: false, isStaff: false, request: 'none', profileStatus: null }),
      representative: representativeRole('none'),
      vcSpendable: null,
    }));
    expect(q('vents-work-indicator-organizer').textContent).toContain('…');
    expect(q('vents-work-indicator-organizer').textContent).not.toContain('Start');
  });

  it('the entire card is one click target: tapping an indicator or the heading opens VENTS Work', () => {
    const onOpen = render(newcomer());
    act(() => { q('vents-work-indicator-provider').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { container.querySelector('h2')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('is keyboard accessible and contains no nested interactive elements', () => {
    const onOpen = render(newcomer());
    const card = q('profile-vents-work-card');
    expect(card.getAttribute('role')).toBe('button');
    expect(card.tabIndex).toBe(0);
    expect(card.getAttribute('aria-label')).toMatch(/Open VENTS Work.*Organizer: Start/);
    act(() => { card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    act(() => { card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(card.querySelectorAll('button, a, [role="button"]')).toHaveLength(0);
  });

  it('uses a dark background with purple gradient accents and a glow', () => {
    render(newcomer());
    const card = q('profile-vents-work-card');
    expect(card.style.background).toMatch(/radial-gradient/);
    expect(card.style.background).toMatch(/linear-gradient/);
    expect(card.style.boxShadow).toMatch(/rgba\(123, ?47, ?190/);
  });

  it('indicator grid wraps for phone widths (no fixed 4-column row)', () => {
    render(newcomer());
    expect(q('vents-work-indicators').style.gridTemplateColumns).toMatch(/auto-fit, minmax\(132px, 1fr\)/);
  });
});

describe('ProfileScreen uses the card and routes it to VENTS Work', () => {
  it('wires ProfileWorkCard to onNavigate("vents-work")', () => {
    const src = readFileSync(join(__dirname, '..', 'ProfileScreen.tsx'), 'utf8');
    expect(src).toMatch(/<ProfileWorkCard indicators=\{workCardIndicators\} onOpen=\{\(\) => onNavigate\('vents-work'\)\} \/>/);
    expect(src).not.toMatch(/filter\(\(r\) => r\.pill\.tone !== 'off'\)/);
  });
});
