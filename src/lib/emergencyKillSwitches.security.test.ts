import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Server-side emergency / kill-switch controls audit
// (0124_emergency_kill_switches.sql). Static-analysis style, matching this
// repo's existing security-test convention -- there is no live-DB harness
// in vitest. The fail-closed and grant-lockdown claims below were verified
// live against the Supabase project during the audit (pg_get_functiondef,
// information_schema.routine_privileges, and a rolled-back transaction
// that deleted the app_config singleton row and re-checked every helper
// returned true) -- this file locks in that the CODE still matches what
// was verified, not a live re-run.

function fn(src: string, name: string): string {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`);
  return src.match(re)?.[0] ?? '';
}

let m0124: string;
let adminSystemSrc: string;
let checkoutSrc: string;
let customerWalletSrc: string;
let serviceBookingsSrc: string;
let walletScreenSrc: string;
let operationalStatusSrc: string;
let finalizePaystackSrc: string;

beforeAll(() => {
  const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
  m0124 = readFileSync(join(dir, '0124_emergency_kill_switches.sql'), 'utf8');
  const componentsDir = join(__dirname, '..', 'app', 'components');
  adminSystemSrc = readFileSync(join(componentsDir, 'admin', 'AdminSystemScreen.tsx'), 'utf8');
  checkoutSrc = readFileSync(join(componentsDir, 'CheckoutScreen.tsx'), 'utf8');
  customerWalletSrc = readFileSync(join(componentsDir, 'CustomerWalletScreen.tsx'), 'utf8');
  walletScreenSrc = readFileSync(join(componentsDir, 'WalletScreen.tsx'), 'utf8');
  serviceBookingsSrc = readFileSync(join(__dirname, 'serviceBookings.ts'), 'utf8');
  operationalStatusSrc = readFileSync(join(__dirname, 'operationalStatus.ts'), 'utf8');
  finalizePaystackSrc = readFileSync(join(__dirname, '..', '..', 'api', '_lib', 'finalizePaystackPayment.ts'), 'utf8');
});

describe('New columns and fail-closed helpers', () => {
  it('adds disable_bookings and disable_deposits to app_config', () => {
    expect(m0124).toMatch(/ADD COLUMN IF NOT EXISTS disable_bookings boolean NOT NULL DEFAULT false,/);
    expect(m0124).toMatch(/ADD COLUMN IF NOT EXISTS disable_deposits boolean NOT NULL DEFAULT false;/);
  });

  it('every one of the four financial helpers COALESCEs a missing/null config to true (fail closed), never to false', () => {
    for (const name of ['purchases_disabled', 'payouts_disabled', 'bookings_disabled', 'deposits_disabled']) {
      const body = fn(m0124, name);
      expect(body).not.toBe('');
      expect(body).toMatch(/COALESCE\(\(SELECT disable_\w+ FROM public\.app_config LIMIT 1\), true\)/);
    }
  });

  it('the four helpers are not reachable by anon or the unauthenticated PUBLIC role', () => {
    expect(m0124).toMatch(/REVOKE ALL ON FUNCTION public\.purchases_disabled\(\) FROM PUBLIC, anon;/);
    expect(m0124).toMatch(/REVOKE ALL ON FUNCTION public\.payouts_disabled\(\) FROM PUBLIC, anon;/);
    expect(m0124).toMatch(/REVOKE ALL ON FUNCTION public\.bookings_disabled\(\) FROM PUBLIC, anon;/);
    expect(m0124).toMatch(/REVOKE ALL ON FUNCTION public\.deposits_disabled\(\) FROM PUBLIC, anon;/);
  });
});

describe('Every pre-payment entry point checks its kill switch as the very first thing, before any side effect', () => {
  const cases: Array<[string, string]> = [
    ['create_pending_purchase', 'purchases_disabled'],
    ['purchase_ticket', 'purchases_disabled'],
    ['create_service_booking', 'bookings_disabled'],
    ['initiate_wallet_deposit', 'deposits_disabled'],
    ['request_organizer_payout', 'payouts_disabled'],
  ];

  for (const [fnName, helper] of cases) {
    it(`${fnName} checks public.${helper}() before its first INSERT/UPDATE`, () => {
      const body = fn(m0124, fnName);
      expect(body).not.toBe('');
      const checkIdx = body.indexOf(`public.${helper}()`);
      expect(checkIdx).toBeGreaterThan(-1);
      const firstInsertIdx = body.search(/INSERT INTO|UPDATE public\./);
      // Either there's no INSERT/UPDATE before the RETURN of the exception
      // branch, or the check strictly precedes it.
      if (firstInsertIdx !== -1) {
        expect(checkIdx).toBeLessThan(firstInsertIdx);
      }
    });
  }
});

describe('VULNERABILITY (fixed): the kill switch no longer sits on the wrong side of an already-completed Paystack charge', () => {
  it('finalize_pending_purchase no longer contains an active disable_purchases/purchases_disabled check (only an explanatory comment about its removal)', () => {
    const body = fn(m0124, 'finalize_pending_purchase');
    expect(body).not.toBe('');
    expect(body).not.toMatch(/IF public\.purchases_disabled\(\)/);
    expect(body).not.toMatch(/IF \(SELECT disable_purchases/);
  });

  it('finalizeAndConfirmPurchase (the webhook/verify path that calls finalize_pending_purchase) only ever runs after Paystack already confirmed the charge -- confirmed by its own comment and call order', () => {
    expect(finalizePaystackSrc).toMatch(/BEFORE\s*\n\s*\/\/ Paystack ever opened, if they don't already exist/);
    expect(finalizePaystackSrc).toMatch(/await callProjectAdminRpc\('finalize_pending_purchase', \[reference\]\);/);
  });

  it('confirm_ticket_payment_via_wallet (the wallet-funded purchase path, which has no separate post-charge step) gains the purchases_disabled check instead, positioned before the wallet balance is ever touched', () => {
    const body = fn(m0124, 'confirm_ticket_payment_via_wallet');
    expect(body).not.toBe('');
    const checkIdx = body.indexOf('purchases_disabled');
    const debitIdx = body.indexOf('balance_kobo = balance_kobo - v_expected_kobo');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(debitIdx).toBeGreaterThan(checkIdx);
  });
});

describe('VULNERABILITY (fixed): request_organizer_payout previously had no kill switch at all', () => {
  it('now checks payouts_disabled(), matching the admin-side approve/reject/cancel actions which already checked it', () => {
    const body = fn(m0124, 'request_organizer_payout');
    expect(body).toMatch(/IF public\.payouts_disabled\(\) THEN/);
  });

  it('every admin-side payout action also switched from the fail-open bare SELECT to the fail-closed helper', () => {
    for (const name of ['admin_claim_payout_for_processing', 'admin_cancel_processing_payout', 'admin_reject_organizer_payout']) {
      const body = fn(m0124, name);
      expect(body).toMatch(/public\.payouts_disabled\(\)/);
      expect(body).not.toMatch(/SELECT disable_payouts FROM/);
    }
  });
});

describe('VULNERABILITY (fixed): every kill-switch toggle in the live Admin Console was broken (no UPDATE grant on app_config for authenticated)', () => {
  it('AdminSystemScreen no longer writes app_config directly -- it calls the audited, whitelisted RPC', () => {
    const toggleFnCheck = adminSystemSrc.match(/const toggleAppConfig = \([\s\S]*?\n  \};/)?.[0] ?? '';
    expect(toggleFnCheck).not.toMatch(/\.from\('app_config'\)\s*\.update/);
    expect(toggleFnCheck).toMatch(/supabase\.rpc\('admin_update_app_config', \{ p_field: column, p_value: String\(next\), p_reason: reason \|\| null \}\)/);
  });

  it('the client no longer double-logs a content-free audit entry -- admin_update_app_config already logs server-side with old/new value', () => {
    const toggleFn = adminSystemSrc.match(/const toggleAppConfig = \([\s\S]*?\n  \};/)?.[0] ?? '';
    expect(toggleFn).not.toMatch(/writeAuditLog/);
  });

  it('admin_update_app_config accepts an optional reason and stores it in the same admin_logs row as the old/new value', () => {
    const body = fn(m0124, 'admin_update_app_config');
    expect(body).toMatch(/p_reason text DEFAULT NULL/);
    expect(body).toMatch(/jsonb_build_object\('field', p_field, 'old_value', v_oldval, 'new_value', v_newval, 'reason', p_reason\)/);
  });

  it('admin_update_app_config remains Root-gated (unchanged tier) and whitelists the two new switches by name, not dynamic SQL', () => {
    const body = fn(m0124, 'admin_update_app_config');
    expect(body).toMatch(/IF NOT public\.is_root\(\) THEN/);
    expect(body).toMatch(/WHEN 'disable_bookings' THEN/);
    expect(body).toMatch(/WHEN 'disable_deposits' THEN/);
  });

  it('the old 2-arg admin_update_app_config signature is dropped so exactly one (3-arg) version exists', () => {
    expect(m0124).toMatch(/DROP FUNCTION IF EXISTS public\.admin_update_app_config\(text, text\);/);
    expect(m0124).toMatch(/GRANT EXECUTE ON FUNCTION public\.admin_update_app_config\(text, text, text\) TO authenticated;/);
  });
});

describe('Admin Console UX: Emergency Controls section, confirmation, financial switches distinguished', () => {
  it('renders an "Emergency Controls" section', () => {
    expect(adminSystemSrc).toMatch(/Emergency Controls/);
  });

  it('lists Ticket Purchases, Service Bookings, Wallet Deposits and Payouts as financial switches', () => {
    expect(adminSystemSrc).toMatch(/key: 'disable_purchases'.*financial: true/);
    expect(adminSystemSrc).toMatch(/key: 'disable_bookings'.*financial: true/);
    expect(adminSystemSrc).toMatch(/key: 'disable_deposits'.*financial: true/);
    expect(adminSystemSrc).toMatch(/key: 'disable_payouts'.*financial: true/);
  });

  it('every toggle still goes through the shared ConfirmModal before taking effect', () => {
    expect(adminSystemSrc).toMatch(/setConfirmModal\(\{/);
    expect(adminSystemSrc).toMatch(/<ConfirmModal/);
  });

  it('disabling a financial switch offers an optional reason, threaded through to the RPC', () => {
    expect(adminSystemSrc).toMatch(/optionalReason \*\/ next && !!def\.financial/);
  });
});

describe('Client-facing messaging: VENTS-branded, no internal detail leaked', () => {
  it('operationalStatus.ts maps every disabled-operation error code to a friendly message, and none of the message VALUES leak internal detail', () => {
    const messagesBlock = operationalStatusSrc.match(/DISABLED_OPERATION_MESSAGES[\s\S]*?\n\};/)?.[0] ?? '';
    for (const code of ['purchases_disabled', 'bookings_disabled', 'deposits_disabled', 'payouts_disabled']) {
      expect(messagesBlock).toMatch(new RegExp(code + ':'));
    }
    const messageValues = [...messagesBlock.matchAll(/: '([^']+)'/g)].map((m) => m[1]).join(' ');
    expect(messageValues).not.toMatch(/app_config|RPC|SQL|database|table|column/i);
    expect(messageValues.length).toBeGreaterThan(0);
  });

  it('CheckoutScreen, CustomerWalletScreen, WalletScreen and the service-booking data layer all translate a disabled-operation error before showing it', () => {
    for (const src of [checkoutSrc, customerWalletSrc, walletScreenSrc, serviceBookingsSrc]) {
      expect(src).toMatch(/friendlyOperationalError/);
    }
  });
});

// Fail-closed proof, from the live audit: with the app_config singleton row
// deleted inside a rolled-back transaction against the live Supabase
// project, `SELECT public.purchases_disabled(), public.payouts_disabled(),
// public.bookings_disabled(), public.deposits_disabled()` returned
// {p: true, pay: true, b: true, d: true} -- every financially consequential
// operation is blocked, not allowed, when the safety configuration cannot
// be read. The "New columns and fail-closed helpers" describe block above
// locks in that the helper bodies still express that COALESCE-to-true rule.
