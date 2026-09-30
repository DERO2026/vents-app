import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the global VENTS selector migration: every audited
// custom country/state/category/currency dropdown now routes through the
// ONE shared compact bottom-sheet component (src/app/components/shared/
// PickerSheet.tsx: PickerField trigger + PickerSheet), instead of each
// screen rolling its own <select> (a full native OS picker, not the
// compact/premium/iOS-style sheet requested) or its own bespoke modal.
//
// PickerSheet itself predates this pass and already implemented nearly
// every requirement (translucent/dark rounded sheet, drag handle, dimmed
// backdrop, internal scroll, search, selected-state check, clean dismiss) --
// this pass is about ADOPTION (closing the gap between screens that already
// used it and screens that still had a raw <select>), plus a small zIndex
// prop addition so the sheet can render above a host screen's own modal.

const componentsDir = join(__dirname, '..', 'app', 'components');

let settingsSrc: string;
let spVerifySrc: string;
let manageProviderServicesSrc: string;
let adminProvidersListSrc: string;
let adminProviderDetailSrc: string;
let adminUserDetailSrc: string;
let pickerSheetSrc: string;
let phoneInputSrc: string;

beforeAll(() => {
  settingsSrc = readFileSync(join(componentsDir, 'SettingsScreen.tsx'), 'utf8');
  spVerifySrc = readFileSync(join(componentsDir, 'ServiceProviderVerificationScreen.tsx'), 'utf8');
  manageProviderServicesSrc = readFileSync(join(componentsDir, 'ManageProviderServicesScreen.tsx'), 'utf8');
  // The Admin Dashboard's services filters/service-form/role/ban selectors
  // now live in the Admin Console (legacy AdminDashboardScreen.tsx retired):
  // list+filters in AdminProvidersList.tsx, the service form in
  // AdminProviderDetail.tsx, and the ban-duration picker in AdminUserDetail.tsx.
  const adminDir = join(componentsDir, 'admin');
  adminProvidersListSrc = readFileSync(join(adminDir, 'AdminProvidersList.tsx'), 'utf8');
  adminProviderDetailSrc = readFileSync(join(adminDir, 'AdminProviderDetail.tsx'), 'utf8');
  adminUserDetailSrc = readFileSync(join(adminDir, 'AdminUserDetail.tsx'), 'utf8');
  pickerSheetSrc = readFileSync(join(componentsDir, 'shared', 'PickerSheet.tsx'), 'utf8');
  phoneInputSrc = readFileSync(join(componentsDir, 'PhoneInput.tsx'), 'utf8');
});

// NOTE: PickerSheet's exact visual shape (bottom sheet vs. centered card,
// dimensions, corner radii, presence of a drag handle) is now asserted in
// src/lib/selectorAuditComplete.test.ts, which reflects the current
// screenshot-3 direction (a centered floating card) -- this file only
// covers behavior that hasn't changed across that redesign.
describe('PickerSheet: the single reusable VENTS selector component', () => {
  it('supports internal scrolling, search, and clear selected-state indication', () => {
    expect(pickerSheetSrc).toMatch(/overflowY: 'auto',/);
    expect(pickerSheetSrc).toMatch(/searchable = true,/);
    expect(pickerSheetSrc).toMatch(/isSelected && <Check/);
  });

  it('accepts an overridable zIndex so it can render above a host screen that already has its own modal', () => {
    expect(pickerSheetSrc).toMatch(/zIndex = 1000,/);
    expect(pickerSheetSrc).toMatch(/zIndex,\s*$/m);
  });

  it('supports a custom renderOption for rows that need more than icon+label+sublabel (e.g. PhoneInput\'s flag + format + dial code)', () => {
    expect(pickerSheetSrc).toMatch(/renderOption\?: \(option: PickerOption, isSelected: boolean\) => ReactNode;/);
    expect(pickerSheetSrc).toMatch(/renderOption \? \(\s*renderOption\(o, isSelected\)/);
  });
});

describe('Get Verified (organizer CAC verification, SettingsScreen.tsx): selector migration + layout fix', () => {
  it('the Country field now uses PickerField/PickerSheet instead of a native <select>', () => {
    expect(settingsSrc).toMatch(/import \{ PickerField, PickerSheet \} from '\.\/shared\/PickerSheet';/);
    const ctaBlock = settingsSrc.match(/const \[showCountryPicker, setShowCountryPicker\][\s\S]*?PickerSheet[\s\S]*?\/>\s*\)\}/)?.[0] ?? '';
    expect(ctaBlock.length).toBeGreaterThan(0);
    expect(settingsSrc).not.toMatch(/<select\s*\n\s*value=\{country\}/);
  });

  it('the Individual/Registered Business toggle buttons can shrink below their content width (minWidth: 0) instead of forcing horizontal overflow', () => {
    const block = settingsSrc.match(/Verifying as<\/label>[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? '';
    expect(block).toMatch(/minWidth: 0/);
  });
});

describe('Service Provider verification (ServiceProviderVerificationScreen.tsx): Country selector migrated', () => {
  it('uses PickerField/PickerSheet instead of a native <select>', () => {
    expect(spVerifySrc).toMatch(/import \{ PickerField, PickerSheet \} from '\.\/shared\/PickerSheet';/);
    expect(spVerifySrc).not.toMatch(/<select value=\{country\}/);
  });
});

describe('Manage Provider Services: Category and Currency selectors migrated', () => {
  it('uses PickerField/PickerSheet instead of native <select> elements', () => {
    expect(manageProviderServicesSrc).toMatch(/import \{ PickerField, PickerSheet \} from '\.\/shared\/PickerSheet';/);
    expect(manageProviderServicesSrc).not.toMatch(/<select style=\{inputStyle\} value=\{form\.category/);
    expect(manageProviderServicesSrc).not.toMatch(/<select style=\{\{ \.\.\.inputStyle, width: '110px'/);
  });
});

describe('Admin Console: Providers filters and service-form selectors have no native <select> (post-retirement of AdminDashboardScreen.tsx)', () => {
  it('AdminProvidersList status filter is chip-based, not a native <select>', () => {
    expect(adminProvidersListSrc).not.toMatch(/<select/);
    expect(adminProvidersListSrc).toMatch(/setStatusFilter/);
  });

  it('the admin service-form Currency selector uses the shared PickerSheet, not a native <select>', () => {
    expect(adminProviderDetailSrc).toMatch(/import \{ PickerSheet \} from '\.\.\/shared\/PickerSheet';/);
    expect(adminProviderDetailSrc).not.toMatch(/<select/);
    expect(adminProviderDetailSrc).toMatch(/<PickerSheet/);
  });

  it('AdminUserDetail\'s ban-duration picker uses the shared PickerSheet, not a native <select>', () => {
    expect(adminUserDetailSrc).toMatch(/import \{ PickerSheet \} from '\.\.\/shared\/PickerSheet';/);
    expect(adminUserDetailSrc).not.toMatch(/<select/);
    expect(adminUserDetailSrc).toMatch(/banPickerOpen/);
  });
});

describe('PhoneInput: dial-code picker is its own inline dropdown, distinct from the shared PickerSheet (handoff PK2)', () => {
  // Supersedes an earlier round's decision to route this through the shared
  // PickerSheet -- the actual Claude Design mockup (PK2) is explicit that
  // the phone country-code selector is "PhoneInput's inline flag+dial-code
  // dropdown, distinct from the full-screen PickerSheet" used for account
  // country/state/category pickers. Rebuilt as a small panel anchored to
  // and opening below the dial-code chip, not a screen-covering sheet.
  it('does not use the shared PickerSheet component', () => {
    expect(phoneInputSrc).not.toMatch(/import \{ PickerSheet \}/);
    expect(phoneInputSrc).not.toMatch(/<PickerSheet/);
  });

  it('renders an anchored dropdown panel positioned below the dial-code chip, not a full-screen backdrop', () => {
    expect(phoneInputSrc).toMatch(/position: 'absolute',\s*\n\s*top: `calc\(\$\{height\}px \+ 8px\)`,/);
  });

  it('still supports search (the real list is ~195 countries, not the mockup\'s illustrative 3 rows) and closes on an outside click', () => {
    expect(phoneInputSrc).toMatch(/Search country or code\.\.\./);
    expect(phoneInputSrc).toMatch(/document\.addEventListener\('mousedown', handleClick\);/);
  });

  it('preserves the flag + name + dial-code row anatomy', () => {
    expect(phoneInputSrc).toMatch(/<CountryMark country=\{c\} size=\{15\} \/>/);
  });
});
