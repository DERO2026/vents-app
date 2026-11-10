import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_VERSION, isVersionOlder, updateTarget, APP_STORE_URL, PLAY_STORE_URL } from './appVersion';

// Native release 1.3.0: the first store build with the withdrawal PIN (0211).
// The web app, the Android build and the iOS build must report the same
// version, because app_config.min_client_version is compared with it and is
// the only way to stop builds older than the PIN flow.

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('native release version', () => {
  const gradle = read('android/app/build.gradle');
  const pbx = read('ios/App/App.xcodeproj/project.pbxproj');

  it('one version everywhere: web, Android versionName, iOS MARKETING_VERSION', () => {
    expect(gradle.match(/versionName "([0-9.]+)"/)![1]).toBe(APP_VERSION);
    const ios = Array.from(new Set(Array.from(pbx.matchAll(/MARKETING_VERSION = ([0-9.]+);/g)).map((m) => m[1])));
    expect(ios).toEqual([APP_VERSION]);
  });

  it('is newer than every build without the withdrawal PIN (1.2.0 predates b5efac7)', () => {
    expect(isVersionOlder('1.2.0', APP_VERSION)).toBe(true);
    expect(Number(gradle.match(/versionCode (\d+)/)![1])).toBeGreaterThan(4);
  });

  it('App.tsx uses the shared version, not a second copy', () => {
    const app = read('src/app/App.tsx');
    expect(app).not.toMatch(/const APP_VERSION\s*=/);
    expect(app).toMatch(/import \{ APP_VERSION, isVersionOlder, updateTarget \} from '\.\.\/lib\/appVersion'/);
  });

  it('isVersionOlder compares numerically, part by part', () => {
    expect(isVersionOlder('1.2.0', '1.3.0')).toBe(true);
    expect(isVersionOlder('1.3.0', '1.3.0')).toBe(false);
    expect(isVersionOlder('1.10.0', '1.9.9')).toBe(false);
    expect(isVersionOlder('1.3', '1.3.1')).toBe(true);
    expect(isVersionOlder('2.0.0', '1.99.99')).toBe(false);
  });

  it('the update screen sends app users to their store and web users to a reload', () => {
    expect(updateTarget('ios')).toMatchObject({ url: APP_STORE_URL });
    expect(updateTarget('android')).toMatchObject({ url: PLAY_STORE_URL });
    expect(updateTarget('web')).toMatchObject({ url: null, label: 'Reload VENTS' });
  });
});

describe('0212: old store builds are told to update', () => {
  const sql = read('supabase/migrations/0212_old_app_withdrawal_update_required.sql');
  const stub = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.request_organizer_payout('), sql.indexOf('$function$;', sql.indexOf('CREATE OR REPLACE FUNCTION public.request_organizer_payout(')));

  it('the old entry point is a plain message: not SECURITY DEFINER, no reads or writes', () => {
    expect(stub).not.toMatch(/SECURITY DEFINER/i);
    expect(stub).not.toMatch(/\b(insert|delete|perform|select)\b/i);
    expect(stub).toMatch(/RAISE EXCEPTION/);
  });

  it('old builds show error.message verbatim, so the message must be readable and not a kill-switch code', () => {
    const msg = stub.match(/MESSAGE = '([^']+)'/)![1];
    expect(msg).toMatch(/^Please update VENTS to withdraw\./);
    expect(msg).toMatch(/getvents\.com/);
    expect(msg).not.toMatch(/payouts_disabled|purchases_disabled|deposits_disabled|bookings_disabled/);
  });

  it('only the stub is granted to clients; the real function stays closed', () => {
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.request_organizer_payout\(bigint, uuid, text\) TO authenticated;/);
    expect(sql).not.toMatch(/GRANT[^;]*request_organizer_payout_core/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.request_organizer_payout_core\(bigint, uuid, text\) FROM PUBLIC, anon, authenticated;/);
  });

  it('undo_0211 refuses while 0212 is applied', () => {
    expect(read('supabase/rollback/undo_0211.sql')).toMatch(/0212 is applied; run supabase\/rollback\/undo_0212\.sql first/);
  });
});
