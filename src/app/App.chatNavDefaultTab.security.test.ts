import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Bug: the bottom-nav item labeled "Chat" is TabId 'explore', which also
// hosts a People sub-tab (ExploreScreen's exploreTab state, default
// 'people' -- intentionally, since Home's search icon reaches the same
// screen via handleTabChange('explore') directly and must keep defaulting
// to People). Tapping "Chat" for the first time in a session landed on
// People, not the chat inbox, because nothing set exploreTab to 'chats' on
// a fresh switch-in -- only reactively, when a conversation was opened via
// onOpenConversation.
//
// Fix: BottomNav's own onTabChange is wrapped (not handleTabChange itself,
// so Home's search icon and any other handleTabChange('explore') caller is
// unaffected) to force exploreTab to 'chats' whenever the TAB BAR's
// 'explore' entry is tapped, first switch-in or re-tap alike.
//
// No React-render test harness exists for App.tsx, so this locks in the
// fix statically, same convention as App.ventsAiMobileGate.security.test.ts.

let src: string;

beforeAll(() => {
  src = readFileSync(join(__dirname, 'App.tsx'), 'utf8');
});

describe('Chat nav tab: tapping the bottom-nav "Chat" item opens the chats inbox, not People', () => {
  it('BottomNav\'s onTabChange is wrapped to force the chats sub-tab on the explore tab, not passed handleTabChange directly', () => {
    const navIdx = src.indexOf('<BottomNav');
    expect(navIdx).toBeGreaterThan(-1);
    const block = src.slice(navIdx, navIdx + 900);

    // Must NOT be the old bare pass-through.
    expect(block).not.toMatch(/onTabChange=\{handleTabChange\}/);

    // Must set exploreTab to 'chats' for the 'explore' tab before/while
    // delegating to handleTabChange.
    expect(block).toMatch(/onTabChange=\{\(tab\)\s*=>\s*\{/);
    expect(block).toMatch(/if\s*\(tab === 'explore'\)\s*setExploreTab\('chats'\)/);
    expect(block).toMatch(/handleTabChange\(tab\)/);
  });

  it('exploreTab still defaults to \'people\' (Home search icon / any other explore entry must be unaffected)', () => {
    expect(src).toMatch(/const \[exploreTab, setExploreTab\] = useState<'people' \| 'chats'>\('people'\)/);
  });

  it('Home\'s search-icon entry point still calls handleTabChange(\'explore\') directly, not the BottomNav wrapper, so it keeps defaulting to People', () => {
    expect(src).toMatch(/onSearchPress=\{\(\) => handleTabChange\('explore'\)\}/);
  });

  it('onOpenConversation still sets exploreTab to \'chats\' itself (unchanged, not duplicated/broken by this fix)', () => {
    const idx = src.indexOf("onOpenConversation={(userId, userName, avatarUrl, vcBadge) => {");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 300);
    expect(block).toMatch(/setExploreTab\('chats'\)/);
  });

  it('the existing re-tap refresh behavior (chatRefreshKey bump on re-tapping explore) is untouched', () => {
    expect(src).toMatch(/if \(tab === 'explore'\) \{\s*setChatRefreshKey\(k => k \+ 1\);/);
  });

  it('other bottom-nav tabs (home, my-tickets, services, profile) are not touched by this fix', () => {
    const navIdx = src.indexOf('<BottomNav');
    const block = src.slice(navIdx, navIdx + 900);
    expect(block).not.toMatch(/tab === 'home'/);
    expect(block).not.toMatch(/tab === 'my-tickets'/);
    expect(block).not.toMatch(/tab === 'services'/);
    expect(block).not.toMatch(/tab === 'profile'/);
  });

  it('the "Chat" label still maps to TabId \'explore\' in BottomNav (this fix does not rename/restructure tabs)', () => {
    const bottomNavSrc = readFileSync(join(__dirname, 'components/BottomNav.tsx'), 'utf8');
    expect(bottomNavSrc).toMatch(/\{\s*id:\s*'explore',\s*label:\s*'Chat',/);
  });
});
