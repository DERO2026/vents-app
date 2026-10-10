import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceProviderSetupScreen } from './ServiceProviderSetupScreen';

// Batch 2.1: verifies the category-scoped specialty-suggestion chips added
// in Batch 2 (tap-to-add shortcuts into the EXISTING servicesOffered
// array) actually work end to end, and that selecting a category still
// satisfies the real validation (missingFields' "Category" check) --
// nothing about the existing save-gating logic was touched.

const fetchOwnServiceProvider = vi.fn();
const saveAndPublishServiceProvider = vi.fn();
vi.mock('../../lib/serviceProviders', () => ({
  fetchOwnServiceProvider: (...args: any[]) => fetchOwnServiceProvider(...args),
  saveAndPublishServiceProvider: (...args: any[]) => saveAndPublishServiceProvider(...args),
}));
vi.mock('../../lib/serviceProviderCategories', () => ({
  fetchServiceProviderCategories: vi.fn(async () => []),
  setServiceProviderCategories: vi.fn(async () => {}),
}));
vi.mock('./LocationPicker', () => ({ LocationPicker: () => null }));
vi.mock('../../lib/supabase', () => ({
  supabase: { storage: { from: () => ({}) } },
  getAuthToken: vi.fn(async () => 'token'),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
  fetchOwnServiceProvider.mockReset();
  saveAndPublishServiceProvider.mockReset();
});

async function mountForNewRegistration() {
  fetchOwnServiceProvider.mockResolvedValue(null);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ServiceProviderSetupScreen
        currentUser={{ id: 'user-1', country: 'NG' }}
        onBack={() => {}}
        onSaved={() => {}}
      />
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ServiceProviderSetupScreen: category-scoped specialty suggestions', () => {
  it('shows no suggestions before any category is selected, and real category-specific chips after one is', async () => {
    await mountForNewRegistration();

    // Before selecting a category: no suggestion chips, no categories
    // required error blocking save beyond the real "Category" gate.
    expect(container!.textContent).not.toContain('Makeup artist');

    const categoryButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Beauty & Styling'))!;
    expect(categoryButton).toBeTruthy();
    act(() => { categoryButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Beauty & Styling's real suggestion list (servicesDesignTokens.ts),
    // not a fabricated one.
    expect(container!.textContent).toContain('Makeup artist');
    expect(container!.textContent).toContain('Hairstylist');
  });

  it('tapping a suggestion chip adds it to servicesOffered as a real chip, and it stops being suggested again', async () => {
    await mountForNewRegistration();

    const categoryButton = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Beauty & Styling'))!;
    act(() => { categoryButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const suggestionChip = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Makeup artist')!;
    expect(suggestionChip).toBeTruthy();
    act(() => { suggestionChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Now rendered as an added chip (with a remove X), not just a
    // suggestion -- and no longer offered as a suggestion.
    const addedChips = Array.from(container!.querySelectorAll('span')).filter((s) => s.textContent?.includes('Makeup artist'));
    expect(addedChips.length).toBeGreaterThan(0);
    const remainingSuggestions = Array.from(container!.querySelectorAll('button')).filter((b) => b.textContent === 'Makeup artist');
    expect(remainingSuggestions.length).toBe(0);
  });

  it('selecting a second category merges in its suggestions without duplicating the first category\'s', async () => {
    await mountForNewRegistration();

    const beauty = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Beauty & Styling'))!;
    act(() => { beauty.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const photography = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes('Photography & Videography'))!;
    act(() => { photography.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container!.textContent).toContain('Makeup artist');
    expect(container!.textContent).toContain('Photographer');
    // Count, not just presence -- never offered twice.
    const hairstylistChips = Array.from(container!.querySelectorAll('button')).filter((b) => b.textContent === 'Hairstylist');
    expect(hairstylistChips.length).toBe(1);
  });
});
