import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Settings > SI toggle: a device-local on/off switch for the SI bottom-nav
// destination, backed by src/lib/ventsAiPreference.ts (see its own tests
// for the storage logic). This verifies the wiring between App.tsx (which
// owns the live ventsAiEnabled state and passes it to BottomNav as
// siEnabled) and SettingsScreen.tsx (which renders the actual toggle row).
// A full SettingsScreen render test isn't attempted here -- that component
// has a large supabase/RPC dependency surface unrelated to this one row, so
// this mirrors this session's established pattern of source-level
// verification for wiring that a component-level render test would be
// disproportionate to add just for this.

let appSrc: string;
let settingsScreenSrc: string;

beforeAll(() => {
  const appDir = join(__dirname, '..', 'app');
  appSrc = readFileSync(join(appDir, 'App.tsx'), 'utf8');
  settingsScreenSrc = readFileSync(join(appDir, 'components', 'SettingsScreen.tsx'), 'utf8');
});

describe('App.tsx: owns the live ventsAiEnabled state and gates the orb on it', () => {
  it('initializes ventsAiEnabled from the persisted preference on mount, not hardcoded true', () => {
    expect(appSrc).toMatch(/const \[ventsAiEnabled, setVentsAiEnabledState\] = useState\(\(\) => isVentsAiEnabled\(\)\);/);
  });

  it('handleToggleVentsAi updates both the live state and the persisted preference', () => {
    const fn = appSrc.match(/const handleToggleVentsAi = useCallback\(\(enabled: boolean\) => \{[\s\S]*?\n  \}, \[\]\);/)?.[0] ?? '';
    expect(fn).toMatch(/setVentsAiEnabledState\(enabled\);/);
    expect(fn).toMatch(/setVentsAiEnabled\(enabled\);/);
  });

  it('passes the live ventsAiEnabled state to BottomNav as siEnabled, so the SI tab is never a broken destination when off', () => {
    const bottomNavJsx = appSrc.match(/<BottomNav[\s\S]*?\/>/)?.[0] ?? '';
    expect(bottomNavJsx).toMatch(/siEnabled=\{ventsAiEnabled\}/);
    expect(bottomNavJsx).toMatch(/onOpenSi=\{\(\) => navigateTo\('vents-ai'\)\}/);
  });

  it('passes the live state and handler down to SettingsScreen', () => {
    const settingsJsx = appSrc.match(/<SettingsScreen[\s\S]*?\/>/)?.[0] ?? '';
    expect(settingsJsx).toMatch(/ventsAiEnabled=\{ventsAiEnabled\}/);
    expect(settingsJsx).toMatch(/onToggleVentsAi=\{handleToggleVentsAi\}/);
  });
});

describe('SettingsScreen.tsx: renders a real, working VENTS AI toggle row', () => {
  it('accepts ventsAiEnabled/onToggleVentsAi as props, defaulting enabled when unset (e.g. the QA harness)', () => {
    expect(settingsScreenSrc).toMatch(/ventsAiEnabled\?: boolean;/);
    expect(settingsScreenSrc).toMatch(/onToggleVentsAi\?: \(enabled: boolean\) => void;/);
    expect(settingsScreenSrc).toMatch(/ventsAiEnabled = true,/);
  });

  it('renders a SettingRow with the toggle wired to the real handler, not a no-op stub (unlike Dark Mode)', () => {
    expect(settingsScreenSrc).toMatch(/icon=\{Sparkles\}\s*\n\s*label="VENTS AI"\s*\n\s*toggle=\{ventsAiEnabled\}\s*\n\s*onToggle=\{\(v\) => onToggleVentsAi\?\.\(v\)\}/);
  });

  it('is placed in the PREFERENCES section alongside Push Notifications and Dark Mode, not a new ad-hoc section', () => {
    const prefsSection = settingsScreenSrc.match(/<Section title="PREFERENCES">[\s\S]*?<\/Section>/)?.[0] ?? '';
    expect(prefsSection).toContain('Push Notifications');
    expect(prefsSection).toContain('Dark Mode');
    expect(prefsSection).toContain('VENTS AI');
  });
});
