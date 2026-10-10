import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Release-blocker fix: ?event=/?user=/?provider= deep links used to be
// stripped from the browser URL via history.replaceState(pathname + hash)
// the instant the query string was parsed -- BEFORE the fetch even
// resolved. That was not Safari's collapsed address-bar display; the query
// string was genuinely erased from browser history, so refreshing the
// page, tapping the address bar, or copying the URL manually afterward all
// lost the shared destination. No React-render test harness exists for
// App.tsx (3700+ lines, huge dependency graph) in this codebase, so this
// locks in the fix statically, same convention as every other
// *.security.test.ts here that has no live integration harness to run
// against.

let src: string;

beforeAll(() => {
  src = readFileSync(join(__dirname, 'App.tsx'), 'utf8');
});

function extractBlock(startMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `expected to find marker: ${startMarker}`).toBeGreaterThan(-1);
  // Each deep-link block is self-contained and followed by a blank line
  // before the next comment block starts -- slice a generous window and
  // let the next assertions narrow in on the relevant lines.
  return src.slice(start, start + 2200);
}

describe('deep-link URL preservation: ?event=/?user=/?provider= stay in the address bar on success', () => {
  it('guards each deep-link type with a processedDeepLinkIdsRef check, not an unconditional strip', () => {
    for (const key of ['event', 'user', 'provider']) {
      const block = extractBlock(`const ${key}DeepLink = params.get('${key}');`);
      expect(block).toMatch(new RegExp(`processedDeepLinkIdsRef\\.current\\.has\\(\`${key}:\\$\\{${key}DeepLink\\}\`\\)`));
      expect(block).toMatch(new RegExp(`processedDeepLinkIdsRef\\.current\\.add\\(\`${key}:\\$\\{${key}DeepLink\\}\`\\)`));
    }
  });

  it('does NOT call history.replaceState before the fetch resolves for any of the three deep-link types', () => {
    for (const key of ['event', 'user', 'provider']) {
      const block = extractBlock(`const ${key}DeepLink = params.get('${key}');`);
      // The guard line and the immediately following setDeepLinkPending(true)
      // must come before any Promise.resolve(...) fetch call, with zero
      // history.replaceState calls in between.
      const guardIdx = block.indexOf('processedDeepLinkIdsRef.current.add');
      const fetchIdx = block.indexOf('Promise.resolve(');
      expect(guardIdx).toBeGreaterThan(-1);
      expect(fetchIdx).toBeGreaterThan(guardIdx);
      const beforeFetch = block.slice(guardIdx, fetchIdx);
      expect(beforeFetch).not.toContain('history.replaceState');
    }
  });

  it('the event success path sets the screen without stripping the URL', () => {
    const block = extractBlock(`const eventDeepLink = params.get('event');`);
    const successIdx = block.indexOf("setScreen('event-details')");
    expect(successIdx).toBeGreaterThan(-1);
    // No replaceState call between the fetch success check and setScreen.
    const deletedCheckIdx = block.indexOf('!evtData.deleted_at');
    const between = block.slice(deletedCheckIdx, successIdx);
    expect(between).not.toContain('history.replaceState');
  });

  it('the user success path sets the screen without stripping the URL', () => {
    const block = extractBlock(`const userDeepLink = params.get('user');`);
    const errorCheckIdx = block.indexOf('userError || !userData');
    const successIdx = block.indexOf("setScreen('user-profile')");
    expect(successIdx).toBeGreaterThan(errorCheckIdx);
    const between = block.slice(errorCheckIdx, successIdx);
    // The error branch's own replaceState call is before this slice starts
    // being checked for the success path -- only assert no NEW strip call
    // sits directly before setScreen on the success branch by checking the
    // segment right after the error branch's own return.
    const returnIdx = between.indexOf('return;');
    expect(returnIdx).toBeGreaterThan(-1);
    const successOnlySegment = between.slice(returnIdx);
    expect(successOnlySegment).not.toContain('history.replaceState');
  });

  it('the provider success path sets the screen without stripping the URL', () => {
    const block = extractBlock(`const providerDeepLink = params.get('provider');`);
    const notFoundIdx = block.indexOf('!providerData');
    const successIdx = block.indexOf("setScreen('service-provider-profile')");
    expect(successIdx).toBeGreaterThan(notFoundIdx);
    const between = block.slice(notFoundIdx, successIdx);
    const returnIdx = between.indexOf('return;');
    expect(returnIdx).toBeGreaterThan(-1);
    const successOnlySegment = between.slice(returnIdx);
    expect(successOnlySegment).not.toContain('history.replaceState');
  });

  it('each failure/not-found/error branch still cleans the URL (nothing valid to keep)', () => {
    for (const { key, marker } of [
      { key: 'event', marker: `const eventDeepLink = params.get('event');` },
      { key: 'user', marker: `const userDeepLink = params.get('user');` },
      { key: 'provider', marker: `const providerDeepLink = params.get('provider');` },
    ]) {
      const block = extractBlock(marker);
      // At least one replaceState(pathname + hash) call still exists in
      // each block, covering the invalid/deleted/error outcomes.
      expect(block).toContain('window.history.replaceState({}, document.title, window.location.pathname + window.location.hash)');
    }
  });
});
