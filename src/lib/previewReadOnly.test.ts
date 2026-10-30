import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
  installPreviewReadOnlyGuard,
  PREVIEW_ALLOWED_RPCS,
  PREVIEW_READ_ONLY_MESSAGE,
  BLOCKED_AUTH_METHODS,
} from './previewReadOnly';
import { computePreviewFlags, PRODUCTION_SUPABASE_REF } from './previewMode';
import { mountPreviewReadOnlyBanner, PREVIEW_BANNER_TEXT } from './previewBanner';

const root = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

// Every RPC the browser app calls today.
const APP_RPCS = [...new Set(sourceFiles(join(root, 'src')).flatMap((p) =>
  [...readFileSync(p, 'utf8').matchAll(/\.rpc(?:<[^>]*>)?\(\s*['"]([a-z_0-9]+)['"]/g)].map((m) => m[1])))].sort();

const fetchSpy = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));

function guardedClient() {
  const client = createClient(`https://${'a'.repeat(20)}.supabase.co`, 'anon-key', {
    global: { fetch: fetchSpy as unknown as typeof fetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  installPreviewReadOnlyGuard(client);
  return client as any;
}

function expectBlocked(result: any) {
  expect(result.data).toBeNull();
  expect(result.error?.code).toBe('PREVIEW_READ_ONLY');
  expect(result.error?.message).toBe(PREVIEW_READ_ONLY_MESSAGE);
}

beforeEach(() => fetchSpy.mockClear());

describe('direct database writes', () => {
  it('insert, update, upsert and delete never reach the network, however they are chained', async () => {
    const c = guardedClient();
    expectBlocked(await c.from('events').insert([{ title: 'x' }]).select().single());
    expectBlocked(await c.from('users').update({ full_name: 'x' }).eq('id', 'u').select('id').maybeSingle());
    expectBlocked(await c.from('saved_events').upsert({ id: 1 }, { onConflict: 'id' }));
    expectBlocked(await c.from('direct_messages').delete().eq('id', 1));
    await expect(c.from('direct_messages').delete().eq('id', 1).throwOnError()).rejects.toMatchObject({ code: 'PREVIEW_READ_ONLY' });
    await expect(c.rpc('send_direct_message', {}).throwOnError()).rejects.toMatchObject({ code: 'PREVIEW_READ_ONLY' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads still work', async () => {
    const c = guardedClient();
    await c.from('events').select('id').limit(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('other schemas are refused outright', async () => {
    expectBlocked(await guardedClient().schema('private').from('x').select('*'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('RPCs: only verified read-only functions are allowed', () => {
  it('every RPC the app calls that is not on the allowlist is blocked with no request', async () => {
    const c = guardedClient();
    const blocked = APP_RPCS.filter((n) => !PREVIEW_ALLOWED_RPCS.has(n));
    expect(blocked.length).toBeGreaterThan(80);
    for (const name of blocked) expectBlocked(await c.rpc(name, {}));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('money, account, admin and messaging RPCs are never allowlisted', () => {
    const dangerous = [
      'confirm_ticket_payment_via_wallet', 'confirm_service_booking_payment_via_wallet', 'create_pending_purchase',
      'initiate_ticket_payment_attempt', 'initiate_wallet_deposit', 'initiate_transfer_fee_payment',
      'initiate_ai_subscription_payment', 'purchase_ticket_with_tokens', 'convert_vc_to_wallet', 'request_organizer_payout',
      'initiate_ticket_transfer', 'admin_credit_vents_cents', 'admin_debit_vents_cents', 'request_admin_action',
      'approve_admin_action', 'reject_admin_action', 'claim_representative_reward', 'claim_profile_bonus',
      'complete_referral', 'delete_own_account', 'admin_set_user_role', 'admin_update_app_config', 'send_direct_message',
      'send_event_announcement', 'admin_send_announcement', 'manual_check_in', 'verify_entry_pass', 'register_push_token',
      // Look like reads but write (see previewReadOnly.ts).
      'get_my_wallet', 'get_my_vc_balance', 'heartbeat_presence', 'check_auth_rate_limit',
      'get_nearby_service_providers', 'search_users_for_request', 'validate_promo_code',
    ];
    for (const name of dangerous) expect(PREVIEW_ALLOWED_RPCS.has(name), name).toBe(false);
  });

  it('the allowlist is exactly the 47 reviewed functions, each used by the app', () => {
    expect(PREVIEW_ALLOWED_RPCS.size).toBe(47);
    for (const name of PREVIEW_ALLOWED_RPCS) expect(APP_RPCS, name).toContain(name);
  });

  it('allowlisted functions still run', async () => {
    const c = guardedClient();
    await c.rpc('search_events_fuzzy', { p_query: 'x' });
    await c.rpc('get_my_representative_rewards');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('storage', () => {
  it('uploads, replacements, moves, copies, removals and bucket changes never reach the network', async () => {
    const c = guardedClient();
    const bucket = c.storage.from('avatars');
    const file = new Blob(['x']);
    expectBlocked(await bucket.upload('a.png', file));
    expectBlocked(await bucket.update('a.png', file));
    expectBlocked(await bucket.move('a.png', 'b.png'));
    expectBlocked(await bucket.copy('a.png', 'b.png'));
    expectBlocked(await bucket.remove(['a.png']));
    expectBlocked(await bucket.createSignedUploadUrl('a.png'));
    expectBlocked(await bucket.uploadToSignedUrl('a.png', 't', file));
    expectBlocked(await c.storage.createBucket('x'));
    expectBlocked(await c.storage.deleteBucket('x'));
    expectBlocked(await c.storage.emptyBucket('x'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('public URLs and downloads still work', async () => {
    const c = guardedClient();
    expect(c.storage.from('avatars').getPublicUrl('a.png').data.publicUrl).toContain('/avatars/a.png');
    await c.storage.from('avatars').download('a.png');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('edge functions are refused', async () => {
    expectBlocked(await guardedClient().functions.invoke('anything'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('accounts', () => {
  it('nothing that creates, confirms, recovers or changes an account reaches the network', async () => {
    const c = guardedClient();
    for (const m of BLOCKED_AUTH_METHODS) {
      const r = await c.auth[m]({ email: 'a@b.c', password: 'x', token: '1', type: 'signup', provider: 'google' });
      expect(r.error?.code, m).toBe('PREVIEW_READ_ONLY');
      expect(r.data).toEqual({ user: null, session: null });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('signing in to an existing account and signing out stay available', async () => {
    const c = guardedClient();
    await c.auth.signInWithPassword({ email: 'a@b.c', password: 'x' });
    expect(fetchSpy).toHaveBeenCalled();
    await expect(c.auth.signOut()).resolves.toBeDefined();
  });
});

describe('build-time switch', () => {
  it('only a Vercel Preview build that is not positively on another project is read-only', () => {
    const prod = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
    expect(computePreviewFlags({ VERCEL_ENV: 'production', VITE_SUPABASE_URL: prod })).toEqual({ vercelPreview: false, readOnly: false });
    expect(computePreviewFlags({ VERCEL_ENV: undefined, VITE_SUPABASE_URL: prod })).toEqual({ vercelPreview: false, readOnly: false });
    expect(computePreviewFlags({ VERCEL_ENV: 'development', VITE_SUPABASE_URL: prod })).toEqual({ vercelPreview: false, readOnly: false });
    expect(computePreviewFlags({ VERCEL_ENV: 'preview', VITE_SUPABASE_URL: prod })).toEqual({ vercelPreview: true, readOnly: true });
    expect(computePreviewFlags({ VERCEL_ENV: 'preview', VITE_SUPABASE_URL: '' })).toEqual({ vercelPreview: true, readOnly: true });
    expect(computePreviewFlags({ VERCEL_ENV: 'preview', VITE_SUPABASE_URL: `https://${'b'.repeat(20)}.supabase.co` })).toEqual({ vercelPreview: true, readOnly: false });
  });

  it('vite.config.ts compiles the flags in; tests run as a non-preview build', () => {
    const vite = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    expect(vite).toMatch(/__VENTS_PREVIEW_READ_ONLY__: JSON\.stringify\(previewFlags\.readOnly\)/);
    expect(vite).toMatch(/__VENTS_VERCEL_PREVIEW__: JSON\.stringify\(previewFlags\.vercelPreview\)/);
    expect(__VENTS_PREVIEW_READ_ONLY__).toBe(false);
    expect(__VENTS_VERCEL_PREVIEW__).toBe(false);
  });
});

describe('wiring', () => {
  const read = (p: string) => readFileSync(join(root, p), 'utf8');

  it('the shared client installs the guard only on a read-only Preview', () => {
    expect(read('src/lib/supabase.ts')).toMatch(/if \(__VENTS_PREVIEW_READ_ONLY__\) installPreviewReadOnlyGuard\(supabase\);/);
  });

  it('Paystack checkout refuses before loading anything on a read-only Preview', () => {
    const src = read('src/lib/paystack.ts');
    const fn = src.slice(src.indexOf('export function openPaystackPopup'));
    expect(fn).toMatch(/^export function openPaystackPopup\(opts: OpenPaystackOptions\): void \{\s*\/\/[^\n]*\n\s*if \(__VENTS_PREVIEW_READ_ONLY__\) \{\s*\(opts\.onError \|\| opts\.onClose\)\(PREVIEW_READ_ONLY_MESSAGE\);\s*return;/);
  });

  it('the two direct verification uploads refuse before opening a request', () => {
    for (const [file, fn] of [['src/app/components/SettingsScreen.tsx', 'uploadVerificationCertificate'], ['src/app/components/ServiceProviderVerificationScreen.tsx', 'uploadVerificationDoc']]) {
      const src = read(file);
      const body = src.slice(src.indexOf(`function ${fn}(`));
      const guard = body.indexOf('if (__VENTS_PREVIEW_READ_ONLY__) return Promise.reject(new Error(PREVIEW_READ_ONLY_MESSAGE));');
      expect(guard, fn).toBeGreaterThan(0);
      expect(guard, fn).toBeLessThan(body.indexOf('new XMLHttpRequest()'));
    }
  });

  it('no other browser code talks to Supabase or Paystack around the guarded client', () => {
    const offenders = sourceFiles(join(root, 'src')).filter((p) => {
      const s = readFileSync(p, 'utf8');
      return /\/(rest|storage|auth|functions)\/v1\//.test(s.replace(/\/\/[^\n]*/g, '')) && !/(SettingsScreen|ServiceProviderVerificationScreen)\.tsx$/.test(p);
    });
    expect(offenders).toEqual([]);
    const paystackImporters = sourceFiles(join(root, 'src')).filter((p) => /from '@paystack\/inline-js'/.test(readFileSync(p, 'utf8')));
    expect(paystackImporters.map((p) => p.slice(root.length + 1))).toEqual(['src/lib/paystack.ts']);
  });

  it('PostHog is not started on Preview builds, and the banner only loads on a read-only Preview', () => {
    const main = read('src/main.tsx');
    expect(main).toMatch(/if \(!__VENTS_VERCEL_PREVIEW__\) initAnalytics\(/);
    expect(main).toMatch(/if \(__VENTS_PREVIEW_READ_ONLY__\) \{\s*void import\('\.\/lib\/previewBanner'\)/);
    expect(main.match(/initAnalytics\(/g)).toHaveLength(1);
  });
});

describe('banner', () => {
  it('shows the read-only notice once, above everything, without blocking taps', () => {
    const el = mountPreviewReadOnlyBanner();
    expect(el.textContent).toBe(PREVIEW_BANNER_TEXT);
    expect(PREVIEW_BANNER_TEXT).toBe('PREVIEW · READ ONLY · PRODUCTION DATA');
    expect(el.style.position).toBe('fixed');
    expect(el.style.pointerEvents).toBe('none');
    expect(mountPreviewReadOnlyBanner()).toBe(el);
    expect(document.querySelectorAll('#vents-preview-banner')).toHaveLength(1);
  });
});
