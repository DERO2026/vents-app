import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The definitive repo-wide selector audit requested after two prior rounds
// of partial migration. Rather than re-listing files by name (which is how
// two real gaps -- ServicesHomeScreen's DiscoveryCountryPicker and
// WalletScreen's bank picker, both bespoke full-screen implementations
// that were never <select> elements so earlier greps for "<select" missed
// them -- survived two "complete" migration passes), this scans every
// .tsx file under src/app/components for an actual <select ...> JSX
// element (not a comment mentioning one) and fails if any remain outside
// the one deliberate, documented exception.

const componentsDir = join(__dirname, '..', 'app', 'components');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

// Matches an actual JSX element open tag: "<select" followed by whitespace
// or ">", not "<select>" inside a code comment sentence like "a native
// <select> would...". A real element is always followed by a prop
// (whitespace) or an immediate ">" with no surrounding prose.
const SELECT_ELEMENT_RE = /<select(\s|>)/;

describe('Repo-wide selector audit: no native <select> survives outside the one documented exception', () => {
  let offenders: { file: string; line: number; text: string }[];

  beforeAll(() => {
    offenders = [];
    for (const file of walk(componentsDir)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        // Skip comment lines (// ... or inside /* */ prose) -- a mention of
        // "<select>" in a code comment is documentation, not a live control.
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (SELECT_ELEMENT_RE.test(line)) {
          offenders.push({ file: file.replace(componentsDir + '/', ''), line: i + 1, text: trimmed });
        }
      });
    }
  });

  it('zero native <select> elements remain in the entire src/app/components tree', () => {
    expect(offenders).toEqual([]);
  });
});

describe('ServicesHomeScreen: discovery country picker migrated off its bespoke full-screen implementation', () => {
  it('DiscoveryCountryPicker now renders PickerSheet instead of its own position:fixed full-screen list', () => {
    const src = readFileSync(join(componentsDir, 'ServicesHomeScreen.tsx'), 'utf8');
    const fn = src.match(/function DiscoveryCountryPicker[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/<PickerSheet/);
    expect(fn).not.toMatch(/position: 'fixed', inset: 0/);
  });
});

describe('WalletScreen: bank picker migrated off its bespoke full-screen implementation', () => {
  it('the bank picker now renders PickerSheet instead of its own position:fixed full-screen list', () => {
    const src = readFileSync(join(componentsDir, 'WalletScreen.tsx'), 'utf8');
    expect(src).toMatch(/import \{ PickerSheet \} from '\.\/shared\/PickerSheet';/);
    const block = src.match(/\{showBankPicker && \([\s\S]*?\)\}/)?.[0] ?? '';
    expect(block).toMatch(/<PickerSheet/);
    expect(block).not.toMatch(/position: 'fixed', inset: 0, background: '#020005'/);
  });
});

describe('Admin Dashboard: the last two per-row native <select> controls (role change, ban duration) migrated', () => {
  it('role-change and ban-duration now open PickerSheet, keyed per user row', () => {
    const src = readFileSync(join(componentsDir, 'AdminDashboardScreen.tsx'), 'utf8');
    expect(src).toMatch(/const \[rolePickerUserId, setRolePickerUserId\] = useState<string \| null>\(null\);/);
    expect(src).toMatch(/const \[banPickerUserId, setBanPickerUserId\] = useState<string \| null>\(null\);/);
    expect(src).toMatch(/\{rolePickerUserId && \(\(\) => \{/);
    expect(src).toMatch(/\{banPickerUserId && \(\(\) => \{/);
  });
});

describe('PickerSheet: matches the screenshot-3 direction -- a centered floating card, not a bottom sheet', () => {
  let pickerSheetSrc: string;
  beforeAll(() => {
    pickerSheetSrc = readFileSync(join(componentsDir, 'shared', 'PickerSheet.tsx'), 'utf8');
  });

  it('centers the card both horizontally and vertically, not anchored to the bottom edge', () => {
    expect(pickerSheetSrc).toMatch(/alignItems: 'center',\s*\n\s*justifyContent: 'center',/);
    expect(pickerSheetSrc).not.toMatch(/alignItems: 'flex-end',/);
  });

  it('is capped to a compact width and height, never edge-to-edge or a large sheet', () => {
    expect(pickerSheetSrc).toMatch(/maxWidth: '360px',/);
    expect(pickerSheetSrc).toMatch(/maxHeight: 'min\(50vh, 420px\)',/);
    expect(pickerSheetSrc).not.toMatch(/width: 'calc\(100% - 24px\)'/);
  });

  it('is rounded on every corner (not top-only, since it is no longer bottom-anchored)', () => {
    expect(pickerSheetSrc).toMatch(/borderRadius: '20px',/);
    expect(pickerSheetSrc).not.toMatch(/borderTopLeftRadius/);
  });

  it('has no drag-to-dismiss handle (that gesture belongs to a bottom sheet, not a centered card)', () => {
    expect(pickerSheetSrc).not.toMatch(/handleDragStart/);
    expect(pickerSheetSrc).not.toMatch(/width: '36px', height: '4px', borderRadius: '2px'/);
  });

  it('presents with a scale+fade animation appropriate to a centered card, not a slide-up', () => {
    expect(pickerSheetSrc).toMatch(/@keyframes pickerCardIn \{ from \{ transform: scale\(0\.94\); opacity: 0; \} to \{ transform: scale\(1\); opacity: 1; \} \}/);
  });

  it('remains translucent/frosted, keeps search+selected-check+renderOption, and stays keyboard-safe via viewport-relative sizing', () => {
    expect(pickerSheetSrc).toMatch(/background: 'rgba\(13,10,26,0\.78\)',/);
    expect(pickerSheetSrc).toMatch(/backdropFilter: 'blur\(24px\) saturate\(1\.4\)',/);
    expect(pickerSheetSrc).toMatch(/searchable = true,/);
    expect(pickerSheetSrc).toMatch(/isSelected && <Check/);
    expect(pickerSheetSrc).toMatch(/renderOption\?: \(option: PickerOption, isSelected: boolean\) => ReactNode;/);
  });
});
