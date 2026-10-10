import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { ServiceProviderSetupScreen } from './ServiceProviderSetupScreen';

// Batch 2.1 / Batch "Finish the remaining prototype gaps": verifies the
// category-scoped specialty-suggestion chips (tap-to-add shortcuts into
// the EXISTING servicesOffered array) actually work end to end through
// the now-5-step registration wizard (Category -> Specialties ->
// Provider details -> Review), and that selecting a category still
// satisfies the real validation gate before Continue is enabled --
// nothing about the existing save-gating logic was touched, just which
// step surfaces each check.

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

function clickButtonContaining(text: string) {
  const button = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent?.includes(text))!;
  expect(button).toBeTruthy();
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('ServiceProviderSetupScreen: 5-step wizard (Category -> Specialties -> Details -> Review)', () => {
  it('step 0 shows the category grid; Continue is disabled until one is selected', async () => {
    await mountForNewRegistration();
    expect(container!.textContent).toContain('STEP 1 OF 4 · CATEGORY');

    const continueBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Continue') as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);

    clickButtonContaining('Beauty & Styling');
    expect(continueBtn.disabled).toBe(false);
  });

  it('step 1 (Specialties) shows real category-scoped suggestion chips, and tapping one adds it', async () => {
    await mountForNewRegistration();
    clickButtonContaining('Beauty & Styling');
    clickButtonContaining('Continue');

    expect(container!.textContent).toContain('STEP 2 OF 4 · SPECIALTIES');
    // Beauty & Styling's real suggestion list (servicesDesignTokens.ts),
    // not a fabricated one.
    expect(container!.textContent).toContain('Makeup artist');
    expect(container!.textContent).toContain('Hairstylist');

    const suggestionChip = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Makeup artist')!;
    act(() => { suggestionChip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const addedChips = Array.from(container!.querySelectorAll('span')).filter((s) => s.textContent?.includes('Makeup artist'));
    expect(addedChips.length).toBeGreaterThan(0);
    const remainingSuggestions = Array.from(container!.querySelectorAll('button')).filter((b) => b.textContent === 'Makeup artist');
    expect(remainingSuggestions.length).toBe(0);
  });

  it('step 2 (Provider details) gates Continue on business name + country, same as the original single-page form', async () => {
    await mountForNewRegistration();
    clickButtonContaining('Beauty & Styling');
    clickButtonContaining('Continue');
    clickButtonContaining('Continue'); // -> step 2

    expect(container!.textContent).toContain('STEP 3 OF 4 · PROVIDER DETAILS');
    const continueBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Continue') as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);

    const nameInput = container!.querySelector('input[placeholder="e.g. Glow Beauty Studio"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(nameInput, 'Glow Studio');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Country defaults from currentUser.country ('NG'), so business name
    // alone should now satisfy the gate.
    expect(continueBtn.disabled).toBe(false);
  });

  it('step 3 (Review) shows a real summary built from entered data and the actual Save & Publish action, not fabricated content', async () => {
    await mountForNewRegistration();
    clickButtonContaining('Beauty & Styling');
    clickButtonContaining('Continue');
    clickButtonContaining('Continue'); // -> step 2

    const nameInput = container!.querySelector('input[placeholder="e.g. Glow Beauty Studio"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(nameInput, 'Glow Studio');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    clickButtonContaining('Continue'); // -> step 3 (Review)

    expect(container!.textContent).toContain('STEP 4 OF 4 · REVIEW');
    expect(container!.textContent).toContain('Glow Studio');
    expect(container!.textContent).toContain('Beauty & Styling');
    expect(container!.textContent).toContain('No description added');

    const saveBtn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Save & Publish') as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();
    expect(saveBtn.disabled).toBe(false);
  });

  it('selecting a second category on step 0 merges in its suggestions on step 1 without duplicating the first category\'s', async () => {
    await mountForNewRegistration();
    clickButtonContaining('Beauty & Styling');
    clickButtonContaining('Photography & Videography');
    clickButtonContaining('Continue');

    expect(container!.textContent).toContain('Makeup artist');
    expect(container!.textContent).toContain('Photographer');
    const hairstylistChips = Array.from(container!.querySelectorAll('button')).filter((b) => b.textContent === 'Hairstylist');
    expect(hairstylistChips.length).toBe(1);
  });

  it('Back from step 1 returns to step 0 with the category selection preserved', async () => {
    await mountForNewRegistration();
    clickButtonContaining('Beauty & Styling');
    clickButtonContaining('Continue');
    expect(container!.textContent).toContain('STEP 2 OF 4 · SPECIALTIES');

    clickButtonContaining('Back');
    expect(container!.textContent).toContain('STEP 1 OF 4 · CATEGORY');
    // Still selected -- real state preserved across wizard navigation.
    expect(container!.textContent).toContain('Primary');
  });
});
