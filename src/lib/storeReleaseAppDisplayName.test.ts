import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Final release requirement: the app's store/device display name must be
// exactly "VENTS APP" (previously "VENTS" everywhere, a deliberate prior
// decision documented in IOS_LAUNCH_CHECKLIST.md -- explicitly overridden
// for this store release). Capacitor derives both platforms' native
// display name from capacitor.config.ts's `appName` at `cap add`/`cap
// sync` time; Android's checked-in strings.xml is kept in sync with it
// directly since the native project itself isn't committed for iOS.

const repoRoot = join(__dirname, '..', '..');

describe('Store release: app display name is exactly "VENTS APP"', () => {
  it('capacitor.config.ts appName is exactly "VENTS APP"', () => {
    const src = readFileSync(join(repoRoot, 'capacitor.config.ts'), 'utf8');
    expect(src).toMatch(/appName: 'VENTS APP',/);
    expect(src).not.toMatch(/appName: 'VENTS',/);
  });

  it('Android strings.xml app_name and title_activity_main are exactly "VENTS APP"', () => {
    const src = readFileSync(join(repoRoot, 'android/app/src/main/res/values/strings.xml'), 'utf8');
    expect(src).toMatch(/<string name="app_name">VENTS APP<\/string>/);
    expect(src).toMatch(/<string name="title_activity_main">VENTS APP<\/string>/);
  });

  it('bundle/package identifier is unchanged by the display-name update', () => {
    const configSrc = readFileSync(join(repoRoot, 'capacitor.config.ts'), 'utf8');
    expect(configSrc).toMatch(/appId: 'com\.getvents\.app',/);
    const gradleSrc = readFileSync(join(repoRoot, 'android/app/build.gradle'), 'utf8');
    expect(gradleSrc).toMatch(/applicationId\s+"com\.getvents\.app"/);
  });
});
