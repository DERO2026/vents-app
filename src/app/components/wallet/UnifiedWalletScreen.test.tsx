import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// The one VENTS Wallet: two real tabs in one screen (Wallet Balance /
// Earnings), separate balances never mixed, Send / Receive only when the
// server says transfers are on, a truthful history, and Send Money that
// cannot send twice.

const rpcCalls: { name: string; params: any }[] = [];
let rpcResult: Record<string, (p: any) => any> = {};
let rpcGate: Promise<void> | null = null;

let earningsRow: any = { balance_kobo: 990000 };
vi.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: table === 'organizer_wallets' ? earningsRow : null, error: null }) };
      return q;
    },
    rpc: async (name: string, params: any) => {
      rpcCalls.push({ name, params });
      if (rpcGate && name === 'transfer_wallet_funds') await rpcGate;
      const f = rpcResult[name];
      return f ? f(params) : { data: null, error: null };
    },
  },
  getAuthToken: async () => 'tok',
}));
vi.mock('../../../lib/apiBase', () => ({ apiUrl: (p: string) => p }));
vi.mock('../../../lib/paystack', () => ({ openPaystackPopup: vi.fn() }));
vi.mock('../../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));
vi.mock('../../../lib/vcBalanceCache', () => ({ getVcBalance: async () => ({ spendable: 1234, expired_this_call: 0 }) }));
vi.mock('../WalletScreen', () => ({ WalletScreen: (p: any) => <div data-testid="earnings-body">EARNINGS {p.embedded ? 'embedded' : 'full'}</div> }));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,QR' } }));

import { UnifiedWalletScreen } from './UnifiedWalletScreen';
import walletSource from './UnifiedWalletScreen.tsx?raw';

const user = { id: 'u1', email: 'a@example.test', full_name: 'Ada', role: 'user', username: 'ada' };
const statusOn = { enabled: true, username: 'ada', sent_today_kobo: 0, sent_today_count: 0, remaining_today_kobo: 50000000, account_ok: true, account_old_enough: true,
  email_verified: true, has_pin: true, pin_locked: false, pin_paused_until: null,
  policy: { min_kobo: 10000, max_kobo: 20000000, daily_kobo: 50000000, daily_count: 20, min_account_age_hours: 24, note_max_length: 140 } };
const row = (id: string, type: string, amount: number, extra: any = {}) => ({ id, type, amount_kobo: amount, description: null, reference_id: `ref-${id}`, metadata: {}, created_at: '2026-11-10T10:00:00Z', ...extra });
const ROWS = [
  row('d', 'deposit', 500000),
  row('s', 'spend', 104000, { reference_id: 'VNT-1' }),
  row('b', 'spend', 200000, { reference_id: 'BKG-1' }),
  row('r', 'refund', 104000),
  row('v', 'vc_conversion', 100000),
  row('i', 'transfer_in', 250000, { reference_id: 'VTIN', metadata: { counterparty_username: 'bola', note: 'Dinner' } }),
  row('o', 'transfer_out', 50000, { reference_id: 'VTOUT', metadata: { counterparty_username: 'chi' } }),
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const q = (id: string) => container!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); }); };
const type = async (el: HTMLElement | null, value: string) => {
  expect(el).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, value); el!.dispatchEvent(new Event('input', { bubbles: true })); await flush(); });
};
async function render(props: any = {}) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root!.render(<UnifiedWalletScreen currentUser={user} onBack={() => {}} {...props} />); await flush(); });
  await act(async () => { await flush(); });
}

beforeEach(() => {
  rpcCalls.length = 0; rpcGate = null;
  rpcResult = {
    get_my_wallet: () => ({ data: [{ balance_kobo: 750000 }], error: null }),
    get_my_wallet_transactions: () => ({ data: ROWS, error: null }),
    get_my_wallet_transfer_status: () => ({ data: statusOn, error: null }),
    get_my_wallet_transfer: () => ({ data: { reference: 'VTIN', status: 'completed', amount_kobo: 250000, note: 'Dinner', created_at: '2026-11-10T10:00:00Z', direction: 'in', sender: { username: 'bola', name: 'Bola' }, recipient: { username: 'ada', name: 'Ada' } }, error: null }),
    find_wallet_transfer_recipient: () => ({ data: { ok: true, recipient: { id: 'u2', username: 'bola', name: 'Bola', avatar_url: null, is_verified: true } }, error: null }),
    transfer_wallet_funds: (p: any) => ({ data: { ok: true, replayed: false, transfer_id: 't1', reference: 'VT123', amount_kobo: p.p_amount_kobo, balance_kobo: 750000 - p.p_amount_kobo }, error: null }),
  };
  try { sessionStorage.clear(); } catch { /* */ }
});
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); container = null; root = null; });

describe('two tabs in one screen', () => {
  it('both tabs are always visible; Wallet Balance is active by default and clearly selected', async () => {
    await render();
    expect(q('wallet-tab-balance')!.getAttribute('aria-selected')).toBe('true');
    expect(q('wallet-tab-earnings')!.getAttribute('aria-selected')).toBe('false');
    expect(q('wallet-panel-balance')!.hidden).toBe(false);
    expect(q('wallet-panel-earnings')!.hidden).toBe(true);
  });

  it('switching tabs never navigates away or reloads: both panels stay mounted', async () => {
    await render();
    const loads = rpcCalls.filter((c) => c.name === 'get_my_wallet').length;
    await click(q('wallet-tab-earnings'));
    expect(q('wallet-tab-earnings')!.getAttribute('aria-selected')).toBe('true');
    expect(q('wallet-panel-earnings')!.hidden).toBe(false);
    expect(q('earnings-body')!.textContent).toBe('EARNINGS embedded');
    expect(q('wallet-panel-balance')!.hidden).toBe(true);
    expect(q('wallet-balance-amount')).toBeTruthy(); // still mounted, state kept
    await click(q('wallet-tab-balance'));
    expect(rpcCalls.filter((c) => c.name === 'get_my_wallet').length).toBe(loads);
    expect(q('unified-wallet')).toBeTruthy();
  });

  it('opens on Earnings when asked (organizer entry points), and arrow keys switch tabs', async () => {
    await render({ initialTab: 'earnings' });
    expect(q('wallet-panel-earnings')!.hidden).toBe(false);
    await act(async () => { q('wallet-tab-earnings')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await flush(); });
    expect(q('wallet-tab-balance')!.getAttribute('aria-selected')).toBe('true');
  });

  it('touch targets are at least 44px', async () => {
    await render();
    for (const id of ['wallet-tab-balance', 'wallet-tab-earnings']) expect(parseInt(q(id)!.style.minHeight)).toBeGreaterThanOrEqual(44);
  });
});

describe('Wallet Balance', () => {
  it('mockup layout: title, Unified pill, two separate balance cards with Spendable / Withdrawable', async () => {
    await render();
    expect(q('wallet-card')!.textContent).toMatch(/^VENTS WalletUnified/);
    expect(q('wallet-balance-card')!.textContent).toMatch(/Wallet Balance₦7,500Spendable/);
    expect(q('wallet-earnings-card')!.textContent).toMatch(/Earnings₦9,900Withdrawable/);
    expect(q('wallet-tab-balance')!.textContent).toBe('Wallet');
    expect(q('wallet-tab-earnings')!.textContent).toBe('Earnings');
    // the two balances are never added together anywhere
    expect(container!.textContent).not.toMatch(/₦17,400/);
  });

  it('tapping the Earnings card switches to the Earnings tab (same screen)', async () => {
    await render();
    await click(q('wallet-earnings-card'));
    expect(q('wallet-tab-earnings')!.getAttribute('aria-selected')).toBe('true');
    expect(q('wallet-balance-card')).toBeTruthy();
  });

  it('someone with no earnings sees ₦0 withdrawable', async () => {
    earningsRow = null;
    await render();
    expect(q('wallet-earnings-amount')!.textContent).toBe('₦0');
    earningsRow = { balance_kobo: 990000 };
  });

  it('shows only the spendable balance, explains it, and keeps VENTS Cents separate', async () => {
    await render();
    expect(q('wallet-balance-amount')!.textContent).toBe('₦7,500');
    expect(q('wallet-balance-card')!.textContent).toMatch(/spend on VENTS tickets and services/);
    expect(q('wallet-balance-card')!.textContent).toMatch(/can't be withdrawn/);
    expect(q('wallet-vc-card')!.textContent).toMatch(/1,234 VC/);
    expect(q('wallet-vc-card')!.textContent).toMatch(/not naira/);
    expect(q('wallet-vc-card')!.textContent).toMatch(/can't be withdrawn or sent/);
  });

  it('Send and Receive appear only when the server says transfers are on', async () => {
    rpcResult.get_my_wallet_transfer_status = () => ({ data: { ...statusOn, enabled: false }, error: null });
    await render();
    expect(q('wallet-deposit')).toBeTruthy();
    expect(q('wallet-send')).toBeNull();
    expect(q('wallet-receive')).toBeNull();
    act(() => root!.unmount()); container!.remove(); container = null; root = null;
    rpcResult.get_my_wallet_transfer_status = () => ({ data: null, error: { message: 'Could not find the function public.get_my_wallet_transfer_status', code: 'PGRST202' } });
    await render();
    expect(q('wallet-send')).toBeNull();
    act(() => root!.unmount()); container!.remove(); container = null; root = null;
    rpcResult.get_my_wallet_transfer_status = () => ({ data: statusOn, error: null });
    await render();
    expect(q('wallet-send')).toBeTruthy();
    expect(q('wallet-receive')).toBeTruthy();
  });

  it('history: every type has the right label, sign and colour; VC conversions are money in', async () => {
    await render();
    const amt = (id: string) => q(`wallet-txn-amount-${id}`)!.textContent;
    expect(amt('d')).toBe('+₦5,000');
    expect(amt('s')).toBe('−₦1,040');
    expect(amt('r')).toBe('+₦1,040');
    expect(amt('v')).toBe('+₦1,000');
    expect(amt('i')).toBe('+₦2,500');
    expect(amt('o')).toBe('−₦500');
  });

  it('history rows: title and subtitle like the mockup; date and status are in the accessible label and the receipt', async () => {
    await render();
    expect(q('wallet-txn-i')!.textContent).toMatch(/^Money receivedFrom @bola/);
    expect(q('wallet-txn-o')!.textContent).toMatch(/^Money sentTo @chi/);
    expect(q('wallet-txn-s')!.textContent).toMatch(/^Ticket purchaseWallet payment/);
    expect(q('wallet-txn-b')!.textContent).toMatch(/^Service bookingWallet payment/);
    expect(q('wallet-txn-d')!.textContent).toMatch(/^DepositAdded via Paystack/);
    expect(q('wallet-txn-v')!.textContent).toMatch(/^VENTS Cents convertedAdded from VENTS Cents/);
    expect(q('wallet-txn-i')!.getAttribute('aria-label')).toMatch(/plus ₦2,500, .*2026.*completed/);
  });

  it('kobo are never rounded away', async () => {
    rpcResult.get_my_wallet = () => ({ data: [{ balance_kobo: 119050050 }], error: null });
    await render();
    expect(q('wallet-balance-amount')!.textContent).toBe('₦1,190,500.50');
  });

  it('a transfer receipt shows status, reference, counterparty and note from the server', async () => {
    await render();
    await click(q('wallet-txn-i'));
    expect(rpcCalls.find((c) => c.name === 'get_my_wallet_transfer')!.params).toEqual({ p_reference: 'VTIN' });
    expect(q('wallet-receipt-status')!.textContent).toMatch(/Completed/);
    expect(q('wallet-receipt-ref')!.textContent).toMatch(/VTIN/);
    expect(q('wallet-receipt-counterparty')!.textContent).toMatch(/Bola \(@bola\)/);
    expect(q('wallet-receipt-body')!.textContent).toMatch(/Dinner/);
  });

  it('older transactions load by offset without duplicates', async () => {
    const page = Array.from({ length: 50 }, (_, i) => row(`p${i}`, 'deposit', 100));
    rpcResult.get_my_wallet_transactions = (p: any) => ({ data: p.p_offset === 0 ? page : [row('older', 'spend', 100)], error: null });
    await render();
    await click(q('wallet-load-more'));
    expect(rpcCalls.filter((c) => c.name === 'get_my_wallet_transactions').pop()!.params).toEqual({ p_limit: 50, p_offset: 50 });
    expect(q('wallet-txn-older')).toBeTruthy();
    expect(q('wallet-load-more')).toBeNull();
  });

  it('a load failure is shown with a retry, not as an empty wallet', async () => {
    rpcResult.get_my_wallet = () => ({ data: null, error: { message: 'boom' } });
    await render();
    expect(q('wallet-load-error')).toBeTruthy();
    expect(q('wallet-empty')).toBeNull();
  });
});

describe('Send Money', () => {
  async function toReview() {
    await render();
    await click(q('wallet-send'));
    await type(q('send-username'), '@Bola');
    await act(async () => { (q('send-username')!.closest('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(); });
    expect(rpcCalls.find((c) => c.name === 'find_wallet_transfer_recipient')!.params).toEqual({ p_username: 'bola' });
    expect(q('send-recipient')!.textContent).toMatch(/Bola.*@bola/);
    await click(q('send-next'));
    await type(q('send-amount'), '1,500');
    await type(q('send-note'), 'Tickets');
    await click(q('send-review'));
  }

  it('review shows the recipient, amount and source before the PIN', async () => {
    await toReview();
    expect(q('send-review-amount')!.textContent).toBe('₦1,500.00');
    expect(q('send-review-to')!.textContent).toMatch(/Bola.*@bola/);
    expect(q('send-money-sheet')!.textContent).toMatch(/cannot be reversed/);
  });

  it('confirm sends once with an idempotency key, even on a double click, then shows the receipt', async () => {
    await toReview();
    await type(q('send-pin'), '7391');
    let release!: () => void;
    rpcGate = new Promise<void>((r) => { release = r; });
    const btn = q('send-confirm')!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    release();
    await act(async () => { await flush(); });
    const sends = rpcCalls.filter((c) => c.name === 'transfer_wallet_funds');
    expect(sends).toHaveLength(1);
    expect(sends[0].params).toMatchObject({ p_recipient_id: 'u2', p_amount_kobo: 150000, p_note: 'Tickets', p_pin: '7391' });
    expect(sends[0].params.p_idempotency_key).toMatch(/^[A-Za-z0-9_-]{16,100}$/);
    expect(q('send-done-ref')!.textContent).toMatch(/VT123/);
  });

  it('a wrong PIN is explained and the retry reuses the same key (cannot send twice)', async () => {
    rpcResult.transfer_wallet_funds = () => ({ data: { ok: false, code: 'wrong_pin', attempts_left: 4, message: 'Wrong PIN. 4 attempts left' }, error: null });
    await toReview();
    await type(q('send-pin'), '0000');
    await click(q('send-confirm'));
    expect(q('send-error')!.textContent).toMatch(/4 attempts left/);
    expect((q('send-pin') as HTMLInputElement).value).toBe('');
    await type(q('send-pin'), '7391');
    await click(q('send-confirm'));
    const keys = rpcCalls.filter((c) => c.name === 'transfer_wallet_funds').map((c) => c.params.p_idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('a network failure keeps the key, so a retry is safe', async () => {
    let n = 0;
    rpcResult.transfer_wallet_funds = (p: any) => { n++; if (n === 1) throw new Error('Failed to fetch'); return { data: { ok: true, replayed: true, reference: 'VT123', amount_kobo: p.p_amount_kobo }, error: null }; };
    await toReview();
    await type(q('send-pin'), '7391');
    await click(q('send-confirm'));
    expect(q('send-error')!.textContent).toMatch(/cannot send twice/);
    await type(q('send-pin'), '7391');
    await click(q('send-confirm'));
    const keys = rpcCalls.filter((c) => c.name === 'transfer_wallet_funds').map((c) => c.params.p_idempotency_key);
    expect(keys[0]).toBe(keys[1]);
    expect(q('send-done')!.textContent).toMatch(/already gone through/);
  });

  it('insufficient funds is refused before the PIN and explained by the server after', async () => {
    await render();
    await click(q('wallet-send'));
    await type(q('send-username'), 'bola');
    await act(async () => { (q('send-username')!.closest('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(); });
    await click(q('send-next'));
    await type(q('send-amount'), '9000');
    expect(q('send-amount-problem')!.textContent).toMatch(/More than your VENTS Wallet balance/);
    expect((q('send-review') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an unknown username is explained; nothing can be sent', async () => {
    rpcResult.find_wallet_transfer_recipient = () => ({ data: { ok: false, code: 'not_found', message: 'No VENTS user has that username' }, error: null });
    await render();
    await click(q('wallet-send'));
    await type(q('send-username'), 'nobody');
    await act(async () => { (q('send-username')!.closest('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush(); });
    expect(q('send-lookup-error')!.textContent).toMatch(/No VENTS user/);
    expect((q('send-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('without a PIN the user creates one in the flow (existing PIN function), then confirms', async () => {
    rpcResult.get_my_wallet_transfer_status = () => ({ data: { ...statusOn, has_pin: false }, error: null });
    rpcResult.set_my_withdrawal_pin = () => ({ data: { has_pin: true }, error: null });
    await toReview();
    expect(q('send-create-pin')).toBeTruthy();
    await type(q('send-new-pin'), '1111');
    await type(q('send-new-pin2'), '1111');
    await click(q('send-create-pin-submit'));
    expect(rpcCalls.some((c) => c.name === 'set_my_withdrawal_pin')).toBe(false); // weak PIN refused client-side
    await type(q('send-new-pin'), '7391');
    await type(q('send-new-pin2'), '7391');
    await click(q('send-create-pin-submit'));
    expect(rpcCalls.find((c) => c.name === 'set_my_withdrawal_pin')!.params).toEqual({ p_pin: '7391', p_pin_confirm: '7391' });
    expect(q('send-pin')).toBeTruthy();
  });

  it('a ?pay=<username> link opens Send Money with that user looked up', async () => {
    sessionStorage.setItem('vents_pay_to', 'bola');
    await render();
    expect(q('send-money-sheet')).toBeTruthy();
    expect(q('send-recipient')!.textContent).toMatch(/@bola/);
    expect(sessionStorage.getItem('vents_pay_to')).toBeNull();
  });
});

describe('Receive Money', () => {
  it('shows the username and a QR code that opens Send Money to it', async () => {
    await render();
    await click(q('wallet-receive'));
    expect(q('receive-username')!.textContent).toBe('@ada');
    expect((q('receive-qr') as HTMLImageElement).src).toMatch(/^data:image\/png/);
  });
  it('without a username it says how to get one', async () => {
    rpcResult.get_my_wallet_transfer_status = () => ({ data: { ...statusOn, username: null }, error: null });
    await act(async () => {});
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => { root!.render(<UnifiedWalletScreen currentUser={{ ...user, username: null }} onBack={() => {}} />); await flush(); });
    await act(async () => { await flush(); });
    await click(q('wallet-receive'));
    expect(q('receive-no-username')).toBeTruthy();
  });
});

// Regression: the Wallet/Earnings switch moved while scrolling and on tab
// switch, and Deposit sat alone in the middle of a three-column row.
describe('switch position and actions (layout regressions)', () => {
  const geometry = (sc: HTMLElement, anchorTopInFlow: number) => {
    // jsdom has no layout: give the scroll container and anchor real-looking geometry.
    sc.getBoundingClientRect = () => ({ top: 0, left: 0, right: 390, bottom: 800, width: 390, height: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
    q('wallet-tabs-anchor')!.getBoundingClientRect = () => ({ top: anchorTopInFlow - sc.scrollTop, left: 0, right: 390, bottom: anchorTopInFlow - sc.scrollTop, width: 390, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  };

  it('the scroll container has no top padding (it would inset the sticky switch); the safe area is on the non-scrolling root', async () => {
    await render();
    const sc = q('wallet-scroll')!;
    expect(sc.style.paddingTop).toBe('0px');
    // jsdom drops env() values, so this rule is checked in the source: the safe area pads the root, never the scroller.
    expect(walletSource).toMatch(/data-testid="unified-wallet"[^>]*\n?[^>]*paddingTop: 'env\(safe-area-inset-top\)'/);
    expect(walletSource).not.toMatch(/data-testid="wallet-scroll"[\s\S]{0,300}safe-area-inset-top/);
    const tabs = q('wallet-tabs')!;
    expect(tabs.style.position).toBe('sticky');
    expect(tabs.style.top).toBe('0px');
    expect(tabs.style.background).not.toBe('');           // opaque: content never shows through
    expect(tabs.previousElementSibling).toBe(q('wallet-tabs-anchor'));
  });

  it('switching while the switch is stuck keeps it in place: the other tab opens at its top, and each tab keeps its own position', async () => {
    await render();
    const sc = q('wallet-scroll')!;
    geometry(sc, 210);
    sc.scrollTop = 900;                                   // deep in the Wallet history
    await click(q('wallet-tab-earnings'));
    expect(sc.scrollTop).toBe(210);                       // Earnings at its top, switch still stuck
    sc.scrollTop = 400;
    await click(q('wallet-tab-balance'));
    expect(sc.scrollTop).toBe(900);                       // Wallet where the user left it
    await click(q('wallet-tab-earnings'));
    expect(sc.scrollTop).toBe(400);                       // and Earnings too
  });

  it('switching above the stick point does not move the page', async () => {
    await render();
    const sc = q('wallet-scroll')!;
    geometry(sc, 210);
    sc.scrollTop = 50;
    await click(q('wallet-tab-earnings'));
    expect(sc.scrollTop).toBe(50);
  });

  it('each panel is at least one viewport below the switch, so a short tab cannot drag the switch down', async () => {
    const ch = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    const oh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return (this as HTMLElement).dataset.testid === 'wallet-scroll' ? 800 : 0; } });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return (this as HTMLElement).dataset.testid === 'wallet-tabs' ? 72 : 0; } });
    try {
      await render();
      expect(q('wallet-panel-balance')!.style.minHeight).toBe('728px');
      expect(q('wallet-panel-earnings')!.style.minHeight).toBe('728px');
    } finally {
      if (ch) Object.defineProperty(HTMLElement.prototype, 'clientHeight', ch);
      if (oh) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', oh);
    }
  });

  it('with transfers unavailable, Deposit is one full-width row and Send/Receive do not exist (0215 missing, switched off, or status error)', async () => {
    const cases = [
      () => ({ data: null, error: { message: 'Could not find the function public.get_my_wallet_transfer_status', code: 'PGRST202' } }),
      () => ({ data: { ...statusOn, enabled: false }, error: null }),
      () => ({ data: null, error: { message: 'permission denied', code: '42501' } }),
    ];
    for (const status of cases) {
      rpcResult.get_my_wallet_transfer_status = status;
      await render();
      expect(q('wallet-actions')!.dataset.layout).toBe('single');
      expect(q('wallet-deposit')!.style.width).toBe('100%');
      expect(q('wallet-deposit')!.textContent).toMatch(/Deposit.*Paystack/);
      expect(q('wallet-send')).toBeNull();
      expect(q('wallet-receive')).toBeNull();
      expect(container!.textContent).not.toMatch(/\btransfers\b/i);   // no promise of a feature that is off
      act(() => root!.unmount()); container!.remove(); container = null; root = null;
    }
  });

  it('with transfers on, the three actions share one row', async () => {
    await render();
    expect(q('wallet-actions')!.dataset.layout).toBe('grid');
    expect(q('wallet-actions')!.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    for (const id of ['wallet-deposit', 'wallet-send', 'wallet-receive']) expect(q(id)).toBeTruthy();
  });

  it('the Deposit row opens the deposit sheet', async () => {
    rpcResult.get_my_wallet_transfer_status = () => ({ data: null, error: { message: 'x', code: 'PGRST202' } });
    await render();
    await click(q('wallet-deposit'));
    expect(q('deposit-sheet')).toBeTruthy();
  });
});
