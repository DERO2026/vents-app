import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { AdminAuditLogScreen } from './AdminAuditLogScreen';

// Regression coverage for a confirmed bug: a failed admin_logs fetch (RLS
// denial, network error) fell through to the exact same "No audit entries
// yet." empty state as a genuinely clean log -- on the one screen whose
// entire job is to be a trustworthy compliance trail, a failed query and
// "nothing has happened" must not look identical.

let shouldError = false;

vi.mock('../../../lib/supabase', () => {
  function makeQuery() {
    const q: any = {
      select: () => q,
      order: () => q,
      limit: () => q,
      then: (resolve: any, reject: any) => {
        if (shouldError) return resolve({ data: null, error: { message: 'permission denied for table admin_logs' } });
        return resolve({ data: [], error: null });
      },
    };
    return q;
  }
  return { supabase: { from: () => makeQuery() } };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  shouldError = false;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('AdminAuditLogScreen: error state', () => {
  it('shows an explicit error, not the empty-log message, when the fetch fails', async () => {
    shouldError = true;
    root = createRoot(container);
    act(() => { root.render(<AdminAuditLogScreen />); });
    await flush();

    expect(container.textContent).toContain('Could not load the audit log');
    expect(container.textContent).not.toContain('No audit entries yet.');
  });

  it('shows the empty-log message when the fetch genuinely succeeds with zero rows', async () => {
    shouldError = false;
    root = createRoot(container);
    act(() => { root.render(<AdminAuditLogScreen />); });
    await flush();

    expect(container.textContent).toContain('No audit entries yet.');
    expect(container.textContent).not.toContain('Could not load the audit log');
  });
});
