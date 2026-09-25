import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression test for the visible scrollbar on Wallet -> Transaction
// Details. scrollbarWidth: 'none' (used pervasively in this codebase) only
// hides the scrollbar in Firefox -- WebKit (desktop Safari/Chrome, which is
// what this screen was reviewed in via the web Preview build) ignores that
// property and needs its own ::-webkit-scrollbar rule, which can't be set
// inline and requires the existing .no-scrollbar utility class (src/styles/
// index.css) that already defines both.

let walletSrc: string;
let globalCss: string;

beforeAll(() => {
  walletSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'WalletScreen.tsx'), 'utf8');
  globalCss = readFileSync(join(__dirname, '..', 'styles', 'index.css'), 'utf8');
});

describe('Wallet Transaction Details: scrollbar hidden without disabling scroll', () => {
  it('the Transaction Details scroll container uses the .no-scrollbar class', () => {
    const block = walletSrc.match(/<span style=\{\{ fontSize: '18px', fontWeight: 700 \}\}>Transaction Details<\/span>[\s\S]{0,700}/)?.[0] ?? '';
    expect(block).toMatch(/className="no-scrollbar"/);
    expect(block).toMatch(/overflowY: 'auto'/);
  });

  it('.no-scrollbar hides the scrollbar in both Firefox and WebKit while leaving scrolling itself enabled', () => {
    expect(globalCss).toMatch(/\.no-scrollbar \{\s*scrollbar-width: none;\s*\}/);
    expect(globalCss).toMatch(/\.no-scrollbar::-webkit-scrollbar \{\s*display: none;\s*\}/);
  });
});
