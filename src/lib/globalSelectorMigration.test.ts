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
let adminDashboardSrc: string;
let pickerSheetSrc: string;
let phoneInputSrc: string;

beforeAll(() => {
  settingsSrc = readFileSync(join(componentsDir, 'SettingsScreen.tsx'), 'utf8');
  spVerifySrc = readFileSync(join(componentsDir, 'ServiceProviderVerificationScreen.tsx'), 'utf8');
  manageProviderServicesSrc = readFileSync(join(componentsDir, 'ManageProviderServicesScreen.tsx'), 'utf8');
  adminDashboardSrc = readFileSync(join(componentsDir, 'AdminDashboardScreen.tsx'), 'utf8');
  pickerSheetSrc = readFileSync(join(componentsDir, 'shared', 'PickerSheet.tsx'), 'utf8');
  phoneInputSrc = readFileSync(join(componentsDir, 'PhoneInput.tsx'), 'utf8');
});

describe('PickerSheet: the single reusable VENTS selector component', () => {
  it('renders as a compact floating card, not a full-screen page or an edge-to-edge sheet (fixed inset backdrop, bottom-anchored, side margins, capped height well below full-screen)', () => {
    expect(pickerSheetSrc).toMatch(/position: 'fixed',\s*inset: 0,/);
    expect(pickerSheetSrc).toMatch(/alignItems: 'flex-end',/);
    expect(pickerSheetSrc).toMatch(/width: 'calc\(100% - 24px\)',/);
    expect(pickerSheetSrc).toMatch(/maxHeight: 'min\(56vh, 460px\)',/);
  });

  it('has a translucent/dark, blurred backdrop AND a translucent frosted-glass card surface (not a solid opaque sheet) so the dimmed app stays visible through it', () => {
    expect(pickerSheetSrc).toMatch(/background: 'rgba\(2,0,5,0\.55\)',/);
    expect(pickerSheetSrc).toMatch(/backdropFilter: 'blur\(6px\)',/);
    expect(pickerSheetSrc).toMatch(/background: 'rgba\(13,10,26,0\.78\)',/);
    expect(pickerSheetSrc).toMatch(/backdropFilter: 'blur\(24px\) saturate\(1\.4\)',/);
  });

  it('has rounded corners on every side (a floating card, not a sheet flush with the screen edges) and a drag handle', () => {
    expect(pickerSheetSrc).toMatch(/borderRadius: '22px',/);
    expect(pickerSheetSrc).toMatch(/width: '36px', height: '4px', borderRadius: '2px'/);
  });

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

describe('Admin Dashboard: Services filters and service-form selectors migrated', () => {
  it('the country/category/status/service-status filter chips no longer use native <select>', () => {
    expect(adminDashboardSrc).toMatch(/import \{ PickerField, PickerSheet \} from '\.\/shared\/PickerSheet';/);
    expect(adminDashboardSrc).not.toMatch(/<select value=\{svcCountryFilter\}/);
    expect(adminDashboardSrc).not.toMatch(/<select value=\{svcCategoryFilter\}/);
    expect(adminDashboardSrc).not.toMatch(/<select value=\{svcStatusFilter\}/);
    expect(adminDashboardSrc).not.toMatch(/<select value=\{svcServiceStatusFilter\}/);
  });

  it('the admin service-form Category/Currency selectors no longer use native <select>, and nest above the form modal via zIndex', () => {
    expect(adminDashboardSrc).not.toMatch(/<select\s*\n\s*value=\{svcServiceForm\.input\.category/);
    expect(adminDashboardSrc).not.toMatch(/<select\s*\n\s*value=\{svcServiceForm\.input\.currency/);
    expect(adminDashboardSrc).toMatch(/zIndex=\{9999\}/);
  });

  it('dense per-row admin actions (role change, ban duration) deliberately keep native <select> -- a bottom sheet per row in a scrollable data table is a regression, not an improvement, for that quick power-user action', () => {
    expect(adminDashboardSrc).toMatch(/<select\s*\n\s*value=\{roleOptions\.includes/);
    expect(adminDashboardSrc).toMatch(/<select\s*\n\s*disabled=\{isBusy \|\| isRootUser\}\s*\n\s*defaultValue=""/);
  });
});

describe('PhoneInput: dial-code picker migrated onto the same shared PickerSheet', () => {
  it('uses PickerSheet instead of its own bespoke modal', () => {
    expect(phoneInputSrc).toMatch(/import \{ PickerSheet \} from '\.\/shared\/PickerSheet';/);
    expect(phoneInputSrc).toMatch(/<PickerSheet/);
    expect(phoneInputSrc).not.toMatch(/position: 'fixed', inset: 0, background: 'rgba\(0,0,0,0\.65\)'/);
  });

  it('preserves multi-field search (name, dial code, ISO) via the label, and preserves the flag/format/dial-code row via renderOption', () => {
    expect(phoneInputSrc).toMatch(/label: `\$\{c\.name\} \$\{c\.code\} \$\{c\.iso\}`/);
    expect(phoneInputSrc).toMatch(/renderOption=\{\(o\) => \{/);
  });
});
