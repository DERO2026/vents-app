import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import {
  BALANCE_PRIVACY_STORAGE_KEY, MASK_NAIRA, MASK_VC, isBalanceHidden, privateAmount, setBalanceHidden, toggleBalanceHidden,
} from './balancePrivacy';
import { PrivateAmount, BalanceVisibilityToggle } from '../app/components/BalancePrivacy';

// The hide-balances preference is device-level: one fixed localStorage key,
// read synchronously, never tied to the signed-in account.

let container: HTMLDivElement | null = null;
let root: Root | null = null;
beforeEach(() => { localStorage.clear(); setBalanceHidden(false); localStorage.clear(); });
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); container = null; root = null; localStorage.clear(); vi.restoreAllMocks(); });

function mount(ui: ReactElement) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => { root!.render(ui); });
}

describe('preference storage', () => {
  it('defaults to shown when nothing is saved', () => {
    expect(isBalanceHidden()).toBe(false);
  });

  it('persists under one fixed, account-independent key', () => {
    setBalanceHidden(true);
    expect(localStorage.getItem(BALANCE_PRIVACY_STORAGE_KEY)).toBe('1');
    expect(BALANCE_PRIVACY_STORAGE_KEY).not.toMatch(/user|uid|account/i);
    setBalanceHidden(false);
    expect(localStorage.getItem(BALANCE_PRIVACY_STORAGE_KEY)).toBe('0');
  });

  it('survives an app restart (a fresh read of storage)', () => {
    localStorage.setItem(BALANCE_PRIVACY_STORAGE_KEY, '1');
    expect(isBalanceHidden()).toBe(true);
  });

  it('survives logout/login and account switching: auth storage changes do not touch it', () => {
    setBalanceHidden(true);
    // What a sign-out / sign-in as someone else does to storage in this app:
    // the Supabase session key is removed and replaced; nothing else is cleared.
    localStorage.setItem('sb-slrtjxtzhowhwhebjprv-auth-token', JSON.stringify({ user: { id: 'user-A' } }));
    localStorage.removeItem('sb-slrtjxtzhowhwhebjprv-auth-token');
    localStorage.setItem('sb-slrtjxtzhowhwhebjprv-auth-token', JSON.stringify({ user: { id: 'user-B' } }));
    expect(isBalanceHidden()).toBe(true);
  });

  it('toggle flips and notifies', () => {
    toggleBalanceHidden();
    expect(isBalanceHidden()).toBe(true);
    toggleBalanceHidden();
    expect(isBalanceHidden()).toBe(false);
  });

  it('when storage throws, the app keeps working for the session (falls back to memory)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(() => setBalanceHidden(true)).not.toThrow();
    expect(isBalanceHidden()).toBe(true);
  });

  it('privateAmount masks only when hidden, with the requested mask', () => {
    expect(privateAmount('₦7,500', false)).toBe('₦7,500');
    expect(privateAmount('₦7,500', true)).toBe(MASK_NAIRA);
    expect(privateAmount('1,234 VC', true, MASK_VC)).toBe(MASK_VC);
    expect(MASK_NAIRA).toBe('₦••••••');
  });
});

describe('PrivateAmount and the eye toggle', () => {
  it('no flash: when hidden is saved, the very first render already shows the mask', () => {
    localStorage.setItem(BALANCE_PRIVACY_STORAGE_KEY, '1');
    const html = renderToString(<PrivateAmount>₦1,190,500</PrivateAmount>);
    expect(html).toContain('₦••••••');
    expect(html).not.toContain('1,190,500');
  });

  it('no flash on the client: the real amount is never rendered, not even for one frame', () => {
    localStorage.setItem(BALANCE_PRIVACY_STORAGE_KEY, '1');
    let rendersOfRealAmount = 0;
    const Real = () => { rendersOfRealAmount++; return <>₦1,190,500</>; };
    mount(<PrivateAmount><Real /></PrivateAmount>);
    expect(rendersOfRealAmount).toBe(0);
    expect(container!.textContent).toBe('₦••••••');
  });

  it('one toggle updates every amount on screen at once', () => {
    mount(<div>
      <PrivateAmount>₦7,500</PrivateAmount>
      <PrivateAmount>₦18,450</PrivateAmount>
      <PrivateAmount mask={MASK_VC}>1,234 VC</PrivateAmount>
      <BalanceVisibilityToggle />
    </div>);
    const btn = container!.querySelector('[data-testid="balance-visibility-toggle"]') as HTMLButtonElement;
    expect(container!.textContent).toContain('₦7,500');
    expect(btn.getAttribute('aria-label')).toBe('Hide balances');
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    act(() => { btn.click(); });
    expect(container!.textContent).not.toMatch(/7,500|18,450|1,234/);
    expect(container!.querySelectorAll('[data-balance-masked="true"]')).toHaveLength(3);
    expect(container!.textContent).toContain('•••••• VC');
    expect(btn.getAttribute('aria-label')).toBe('Show balances');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(BALANCE_PRIVACY_STORAGE_KEY)).toBe('1');

    act(() => { btn.click(); });
    expect(container!.textContent).toContain('₦18,450');
  });

  it('the toggle never triggers a parent click (e.g. a tappable balance card)', () => {
    const parent = vi.fn();
    mount(<div onClick={parent}><BalanceVisibilityToggle /></div>);
    act(() => { (container!.querySelector('button') as HTMLButtonElement).click(); });
    expect(parent).not.toHaveBeenCalled();
  });

  it('another tab changing the preference updates this one (storage event)', () => {
    mount(<PrivateAmount>₦7,500</PrivateAmount>);
    act(() => {
      localStorage.setItem(BALANCE_PRIVACY_STORAGE_KEY, '1');
      window.dispatchEvent(new StorageEvent('storage', { key: BALANCE_PRIVACY_STORAGE_KEY, newValue: '1' }));
    });
    expect(container!.textContent).toBe('₦••••••');
  });
});
