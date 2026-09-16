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

describe('PickerSheet: matches the Claude Design handoff (PK1/PK3) -- a bottom sheet anchored to the screen edge, not a centered card', () => {
  // Supersedes an earlier round's "screenshot-3" direction (a centered
  // floating card), which was itself a deliberate design choice at the
  // time -- now replaced because the actual Claude Design mockup export
  // (PK1 "Select Country", PK3 "Select Category") shows a bottom sheet:
  // anchored to the bottom edge, rounded only on top, a drag handle, and
  // a plain divided row list instead of per-row cards.
  let pickerSheetSrc: string;
  beforeAll(() => {
    pickerSheetSrc = readFileSync(join(componentsDir, 'shared', 'PickerSheet.tsx'), 'utf8');
  });

  it('anchors to the bottom edge, not centered', () => {
    expect(pickerSheetSrc).toMatch(/left: 0,\s*\n\s*right: 0,\s*\n\s*bottom: 0,/);
    expect(pickerSheetSrc).not.toMatch(/alignItems: 'center',\s*\n\s*justifyContent: 'center',/);
  });

  it('opens tall (~86% of viewport) when searchable per PK1, and caps at 60% when not per PK3', () => {
    expect(pickerSheetSrc).toMatch(/searchable \? \{ top: '14%' \} : \{ maxHeight: '60%' \}/);
  });

  it('is rounded only on the top corners, not every corner', () => {
    expect(pickerSheetSrc).toMatch(/borderRadius: '28px 28px 0 0',/);
  });

  it('has a drag-handle bar at the top, matching every other bottom sheet in the app', () => {
    expect(pickerSheetSrc).toMatch(/width: '38px', height: '4px', borderRadius: '99px', background: 'rgba\(255,255,255,0\.22\)'/);
  });

  it('presents with a slide-up animation appropriate to a bottom sheet, not a scale+fade', () => {
    expect(pickerSheetSrc).toMatch(/@keyframes pickerSheetIn \{ from \{ transform: translateY\(24px\); opacity: 0; \} to \{ transform: translateY\(0\); opacity: 1; \} \}/);
  });

  it('rows are a plain divided list (underline dividers), not individually-bordered cards', () => {
    expect(pickerSheetSrc).toMatch(/borderBottom: i < filtered\.length - 1 \? '1px solid rgba\(255,255,255,0\.05\)' : 'none',/);
    expect(pickerSheetSrc).not.toMatch(/background: isSelected \? 'rgba\(168,85,247,0\.12\)' : '#131629',/);
  });

  it('remains translucent/frosted, keeps search+selected-check+renderOption, and respects a safe-area bottom inset', () => {
    expect(pickerSheetSrc).toMatch(/background: 'rgba\(18,16,25,0\.96\)',/);
    expect(pickerSheetSrc).toMatch(/backdropFilter: 'blur\(34px\)',/);
    expect(pickerSheetSrc).toMatch(/searchable = true,/);
    expect(pickerSheetSrc).toMatch(/isSelected && <Check/);
    expect(pickerSheetSrc).toMatch(/renderOption\?: \(option: PickerOption, isSelected: boolean\) => ReactNode;/);
    expect(pickerSheetSrc).toMatch(/env\(safe-area-inset-bottom\)/);
  });
});
