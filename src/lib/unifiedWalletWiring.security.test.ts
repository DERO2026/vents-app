import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// One wallet: every entry point lands on the same unified screen; the old
// separate customer wallet screen is gone; ?pay= only pre-fills Send Money.
const root = join(__dirname, '..', '..');
const app = readFileSync(join(root, 'src', 'app', 'App.tsx'), 'utf8');
const m15 = readFileSync(join(root, 'supabase', 'migrations', '0215_wallet_transfers.sql'), 'utf8');

describe('wallet entry points', () => {
  it("both 'wallet' and 'customer-wallet' render UnifiedWalletScreen; the old screens are not rendered", () => {
    expect(app).toMatch(/\(screen === 'wallet' \|\| screen === 'customer-wallet'\) && \(\s*<UnifiedWalletScreen/);
    expect(app).not.toMatch(/<CustomerWalletScreen/);
    expect(app).not.toMatch(/<WalletScreen /);
    expect(existsSync(join(root, 'src', 'app', 'components', 'CustomerWalletScreen.tsx'))).toBe(false);
  });
  it("'wallet' opens Earnings only for people who earn; everyone else gets Wallet Balance", () => {
    expect(app).toMatch(/initialTab=\{screen === 'wallet' && \(\s*!!currentUser\?\.isOrganizer \|\| currentUser\?\.is_service_provider === true \|\|\s*currentUser\?\.role === 'admin' \|\| currentUser\?\.role === 'sub-admin'\s*\) \? 'earnings' : 'balance'\}/);
  });
  it('wallet notifications open the wallet', () => {
    expect(app).toMatch(/data\.screen === 'customer-wallet'\) \{ setScreenStack\(\[\]\); setScreen\('customer-wallet'\)/);
  });
  it('?pay= is validated, stripped from the URL and only stored for the Send Money sheet', () => {
    expect(app).toMatch(/const payTo = usernameFromPayParam\(params\.get\(PAY_PARAM\)\)/);
    expect(app).toMatch(/sessionStorage\.setItem\(PAY_TO_STORAGE_KEY, payTo\)/);
    expect(app).not.toMatch(/transfer_wallet_funds/);
  });
});

describe('0215 boundaries (static)', () => {
  it('transfers start disabled and only the VENTS Admin can enable them', () => {
    expect(m15).toMatch(/ADD COLUMN IF NOT EXISTS disable_wallet_transfers boolean NOT NULL DEFAULT true/);
    expect(m15).toMatch(/admin_set_wallet_transfers_enabled[\s\S]*?IF NOT public\.is_root\(\) THEN RAISE EXCEPTION/);
  });
  it('touches only the spendable wallet: never earnings, VENTS Cents or withdrawals', () => {
    const code = m15.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/organizer_wallets|organizer_transactions|organizer_withdrawal_requests|vents_wallets|vc_transactions|earnings_holds/);
  });
  it('the PIN is checked with the existing counted check, and never by a raise that would roll the count back', () => {
    expect(m15).toMatch(/v_check := public\.withdrawal_pin_check\(v_uid, p_pin\);\s*IF NOT COALESCE\(\(v_check->>'ok'\)::boolean, false\) THEN\s*RETURN/);
  });
  it('both wallets are locked in a fixed order before any balance moves', () => {
    const lock = m15.indexOf('ORDER BY user_id FOR UPDATE');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(m15.indexOf('UPDATE public.user_wallets SET balance_kobo = balance_kobo - p_amount_kobo'));
  });
});
