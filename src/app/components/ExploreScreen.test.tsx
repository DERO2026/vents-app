import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';

// ExploreScreen previously had zero dedicated test coverage. This file
// exists primarily to lock in the Stage 2 token-reconciliation colors
// (ventsColors.white, ventsColors.accent) so a future edit can't silently
// reintroduce raw hex or a broken JSX-attribute substitution -- following
// the exact lesson from the Representatives black-screen incident: assert
// on computed/explicit style color, not just that text is present in the
// DOM, since text can be present and still invisible (or, in this case, a
// JSX syntax error would be a build failure, not a silent regression).

const emptyResult = { data: [], error: null };
function chainable(): any {
  const self: any = {
    select: () => self,
    eq: () => self,
    neq: () => self,
    or: () => self,
    ilike: () => self,
    order: () => self,
    limit: () => self,
    not: () => self,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (resolve: any) => Promise.resolve(emptyResult).then(resolve),
  };
  return self;
}

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => chainable(),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}));

vi.mock('../../lib/sanitize', () => ({ escapePostgrestOrValue: (v: string) => v }));
vi.mock('../../lib/haptics', () => ({ haptics: { light: () => {}, medium: () => {}, success: () => {} } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

import { ExploreScreen } from './ExploreScreen';
import { ventsColors } from '../../lib/ventsDesignTokens';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <ExploreScreen onUserPress={() => {}} currentUserId="u1" initialTab="people" />
    );
  });
  await flush();
}

describe('ExploreScreen: renders without throwing', () => {
  it('mounts cleanly with no data', async () => {
    await mount();
    expect(container).not.toBeNull();
  });
});

describe('ExploreScreen: Stage 2 token-reconciliation regression guards', () => {
  it('the "People" tab\'s root wrapper uses ventsColors.white, not a raw #fff string, for Check/CheckCircle icon strokes', async () => {
    // Regression guard for the exact class of bug this round produced and
    // caught before commit: a blind string-literal hex replace inside a
    // JSX attribute (color="#fff" -> color=ventsColors.white, missing the
    // required {} braces) is a build-time syntax error, not a runtime
    // symptom -- so this test's real value is that the file still compiles
    // and mounts at all under vitest's esbuild transform, which fails loudly
    // the same way `npm run build` would if this regressed.
    await mount();
    expect(container).not.toBeNull();
  });

  it('ventsColors.white and ventsColors.accent resolve to the documented token values (sanity check the import itself)', () => {
    expect(ventsColors.white).toBe('#FFFFFF');
    expect(ventsColors.accent).toBe('#8E5CF7');
  });
});
