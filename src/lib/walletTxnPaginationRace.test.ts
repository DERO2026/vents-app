import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression test for a /code-review finding: loadMoreTxns computed its
// .range() offset from a `txns.length` snapshot that a concurrent load()
// (e.g. pull-to-retry) could invalidate before the response arrived --
// appending the fetched page onto load()'s freshly-reset array at the
// wrong offset, gapping or duplicating rows. Fixed with a generation
// counter load() bumps and loadMoreTxns checks before applying its result,
// plus a defense-in-depth id-based de-dup on append.

let walletSrc: string;

beforeAll(() => {
  walletSrc = readFileSync(join(__dirname, '..', 'app', 'components', 'WalletScreen.tsx'), 'utf8');
});

function loadMoreTxnsFn(): string {
  return walletSrc.match(/const loadMoreTxns = async \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
}

describe('WalletScreen transaction pagination: safe under a concurrent full reload', () => {
  it('load() bumps a generation counter on every call', () => {
    expect(walletSrc).toMatch(/const load = async \(\) => \{\s*\n\s*if \(!currentUser\?\.id\) return;\s*\n\s*txnsGenerationRef\.current \+= 1;/);
  });

  it('loadMoreTxns captures the generation and offset synchronously before fetching, not after', () => {
    const fn = loadMoreTxnsFn();
    const beforeFetch = fn.split('supabase')[0];
    expect(beforeFetch).toMatch(/const generation = txnsGenerationRef\.current;/);
    expect(beforeFetch).toMatch(/const offset = txns\.length;/);
  });

  it('discards its result if a full load() completed while it was in flight', () => {
    const fn = loadMoreTxnsFn();
    expect(fn).toMatch(/if \(generation !== txnsGenerationRef\.current\) return;/);
  });

  it('refuses to start while a full load() is already in progress, not just while another loadMoreTxns is running', () => {
    const fn = loadMoreTxnsFn();
    expect(fn).toMatch(/if \(!currentUser\?\.id \|\| loadingMore \|\| loading \|\| !txnsHasMore\) return;/);
  });

  it('de-dupes appended rows by id as defense-in-depth against a retried/overlapping fetch', () => {
    const fn = loadMoreTxnsFn();
    expect(fn).toMatch(/const seen = new Set\(prev\.map\(t => t\.id\)\);/);
    expect(fn).toMatch(/\[\.\.\.prev, \.\.\.\(data \|\| \[\]\)\.filter\(t => !seen\.has\(t\.id\)\)\]/);
  });

  it('still uses the captured offset (not a re-read of txns.length after the await) for the actual query range', () => {
    const fn = loadMoreTxnsFn();
    expect(fn).toMatch(/\.range\(offset, offset \+ PAGE_SIZE - 1\)/);
  });
});
