// @vitest-environment jsdom
// Regression tests for service-provider onboarding: photo upload errors
// (every upload-check failure used to say "Too many uploads"), retry,
// rate-limit recovery, duplicate requests, and the Review step matching
// what Save & Publish submits (photos were only counted, errors from the
// Details step carried over, the country was missing).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const fetchOwnServiceProvider = vi.fn();
const saveAndPublishServiceProvider = vi.fn();
const setServiceProviderCategories = vi.fn(async () => {});
vi.mock('../../lib/serviceProviders', () => ({
  fetchOwnServiceProvider: (...a: any[]) => fetchOwnServiceProvider(...a),
  saveAndPublishServiceProvider: (...a: any[]) => saveAndPublishServiceProvider(...a),
}));
vi.mock('../../lib/serviceProviderCategories', () => ({
  fetchServiceProviderCategories: vi.fn(async () => []),
  setServiceProviderCategories: (...a: any[]) => (setServiceProviderCategories as any)(...a),
}));
vi.mock('../../lib/compressImage', () => ({
  compressImage: async (b: Blob) => ({ blob: b, mimeType: 'image/jpeg', extension: 'jpg' }),
}));
vi.mock('../../lib/pickImage', () => ({ pickImage: async () => null }));

let lastRegionCode: string | undefined;
vi.mock('./LocationPicker', () => ({
  LocationPicker: ({ onChange, regionCode }: any) => {
    lastRegionCode = regionCode;
    return (
      <button data-testid="mock-pick-location" onClick={() => onChange({ address: 'Lekki Phase 1, Lagos', lat: 6.44, lng: 3.47 })}>
        pick
      </button>
    );
  },
}));
vi.mock('./ImageCropperModal', () => ({
  ImageCropperModal: ({ onCropComplete }: any) => (
    <button data-testid="mock-crop-done" onClick={() => onCropComplete(new Blob(['img'], { type: 'image/jpeg' }))}>done</button>
  ),
}));

let rateLimitResponse: () => Promise<{ data: null; error: any }>;
let uploadResponse: () => Promise<{ data: any; error: any }>;
const rpcCalls: string[] = [];
const uploads: string[] = [];
vi.mock('../../lib/supabase', () => ({
  getAuthToken: vi.fn(async () => 'token'),
  supabase: {
    rpc: (name: string) => { rpcCalls.push(name); return rateLimitResponse(); },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { is_service_provider: true }, error: null }) }) }) }),
    storage: {
      from: () => ({
        upload: (key: string) => { uploads.push(key); return uploadResponse(); },
        getPublicUrl: (key: string) => ({ data: { publicUrl: `https://cdn.example/${key}` } }),
      }),
    },
  },
}));

import { ServiceProviderSetupScreen } from './ServiceProviderSetupScreen';

let container: HTMLDivElement;
let root: Root;
const onSaved = vi.fn();

beforeEach(() => {
  rpcCalls.length = 0;
  uploads.length = 0;
  lastRegionCode = undefined;
  rateLimitResponse = async () => ({ data: null, error: null });
  uploadResponse = async () => ({ data: { path: 'x' }, error: null });
  fetchOwnServiceProvider.mockResolvedValue(null);
  saveAndPublishServiceProvider.mockImplementation(async (_uid: string, input: any) => ({ id: 'sp-1', ...input }));
  onSaved.mockReset();
  (URL as any).createObjectURL = () => 'blob:mock';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function flush(n = 4) {
  for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function click(el: Element | null) {
  expect(el).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await flush();
}
const buttonWith = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null;
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

async function mountAtDetails() {
  root = createRoot(container);
  await act(async () => {
    root.render(<ServiceProviderSetupScreen currentUser={{ id: 'user-1', country: 'NG' }} onBack={() => {}} onSaved={onSaved} />);
  });
  await flush();
  await click(buttonWith('Beauty & Styling'));
  await click(q('wizard-continue'));
  // Specialties: tap the first suggestion chip.
  const chip = Array.from(container.querySelectorAll('button')).find((b) => b.querySelector('svg') && b.textContent && b.textContent.trim().length > 2 && b.style.borderStyle !== 'none' && b.style.border.includes('dashed'));
  await click(chip ?? null);
  await click(q('wizard-continue'));
  expect(container.textContent).toContain('PROVIDER DETAILS');
}

async function addPhoto() {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
  await click(q('mock-crop-done'));
}

describe('provider photo upload errors', () => {
  it('a real rate limit says so, names when uploads resume, and clears itself when the window resets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-31T10:20:00Z'));
    rateLimitResponse = async () => ({ data: null, error: { code: 'P0429', message: 'rate_limited' } });
    await mountAtDetails();
    await addPhoto();
    expect(q('photo-error')?.textContent).toMatch(/limit of 30 uploads per hour/);
    expect(uploads).toHaveLength(0);
    expect((q('add-photo') as HTMLButtonElement).disabled).toBe(true);
    expect((q('photo-retry') as HTMLButtonElement).disabled).toBe(true);

    // The limit is a fixed clock hour: it resets at 11:00 UTC.
    await act(async () => { vi.advanceTimersByTime(40 * 60 * 1000); });
    await flush();
    expect(q('photo-error')).toBeNull();
    expect((q('add-photo') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a Preview read-only block is not reported as "Too many uploads", and offers no useless Retry', async () => {
    rateLimitResponse = async () => ({ data: null, error: { code: 'PREVIEW_READ_ONLY', message: 'Disabled in Preview' } });
    await mountAtDetails();
    await addPhoto();
    expect(q('photo-error')?.textContent).toMatch(/Preview/);
    expect(container.textContent).not.toMatch(/Too many uploads/);
    expect(q('photo-retry')).toBeNull();
  });

  it('an expired session is reported as such, not as a rate limit', async () => {
    rateLimitResponse = async () => ({ data: null, error: { code: 'P0001', message: 'Not authenticated' } });
    await mountAtDetails();
    await addPhoto();
    expect(q('photo-error')?.textContent).toMatch(/session has expired/);
    expect(container.textContent).not.toMatch(/Too many uploads|limit of 30/);
  });

  it('Retry re-sends the same cropped photo after a failed upload, and it then appears', async () => {
    let fail = true;
    uploadResponse = async () => (fail ? { data: null, error: { message: 'network down' } } : { data: { path: 'x' }, error: null });
    await mountAtDetails();
    await addPhoto();
    expect(q('photo-error')?.textContent).toMatch(/Upload failed: network down/);
    expect(container.querySelectorAll('img')).toHaveLength(0);

    fail = false;
    await click(q('photo-retry'));
    expect(q('photo-error')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(rpcCalls).toEqual(['check_media_upload_rate_limit', 'check_media_upload_rate_limit']);
    expect(uploads).toHaveLength(2);
  });

  it('a second Retry while one upload is in flight does not send a duplicate request', async () => {
    let release!: (v: any) => void;
    let first = true;
    uploadResponse = () => {
      if (first) { first = false; return Promise.resolve({ data: null, error: { message: 'boom' } }); }
      return new Promise((res) => { release = res; });
    };
    await mountAtDetails();
    await addPhoto();
    const retry = q('photo-retry')!;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(uploads).toHaveLength(2); // the failed one + exactly one retry
    await act(async () => { release({ data: { path: 'x' }, error: null }); });
    await flush();
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });
});

describe('provider Review step and Save & Publish', () => {
  async function fillDetails() {
    await addPhoto();
    await addPhoto();
    await typeInto(container.querySelector('input[placeholder="e.g. Glow Beauty Studio"]') as HTMLInputElement, 'Glow Studio');
    await typeInto(container.querySelector('input[placeholder="Amount"]') as HTMLInputElement, '5000');
    await click(q('mock-pick-location'));
    await click(q('toggle-Home Service'));
  }

  it('location search is scoped to the selected country', async () => {
    await mountAtDetails();
    expect(lastRegionCode).toBe('NG');
  });

  it('Review shows the uploaded photos, formatted price, location and country, with no stale Details error', async () => {
    await mountAtDetails();
    // Leave an upload error on the Details step first.
    uploadResponse = async () => ({ data: null, error: { message: 'blip' } });
    await addPhoto();
    expect(q('photo-error')).toBeTruthy();
    uploadResponse = async () => ({ data: { path: 'x' }, error: null });
    await fillDetails();
    await click(q('wizard-continue'));

    expect(container.textContent).toContain('REVIEW');
    expect(q('review-photos')?.querySelectorAll('img')).toHaveLength(2);
    expect(q('review-price')?.textContent).toBe('From ₦5,000');
    expect(q('review-location')?.textContent).toContain('Lekki Phase 1, Lagos · Nigeria');
    expect(q('review-location')?.textContent).toContain('pinned on map');
    expect(q('review-services')?.textContent?.length).toBeGreaterThan(0);
    expect(q('photo-error')).toBeNull();
    expect(q('setup-error')).toBeNull();
    expect(container.textContent).not.toMatch(/Upload failed|blip/);
  });

  it('Save & Publish submits exactly what Review showed', async () => {
    await mountAtDetails();
    await fillDetails();
    await click(q('wizard-continue'));
    const shownServices = q('review-services')!.textContent!;
    await click(buttonWith('Save & Publish'));

    expect(saveAndPublishServiceProvider).toHaveBeenCalledTimes(1);
    const input = saveAndPublishServiceProvider.mock.calls[0][1];
    expect(input.businessName).toBe('Glow Studio');
    expect(input.category).toBe('Beauty & Styling');
    expect(input.country).toBe('NG');
    expect(input.location).toBe('Lekki Phase 1, Lagos');
    expect([input.latitude, input.longitude]).toEqual([6.44, 3.47]);
    expect(input.startingPrice).toBe(5000);
    expect(input.startingPriceCurrency).toBe('NGN');
    expect(input.photoUrls).toHaveLength(2);
    expect(input.servicesOffered.join(', ')).toBe(shownServices);
    expect(input.offersHomeService).toBe(true);
    expect(setServiceProviderCategories).toHaveBeenCalledWith('sp-1', ['Beauty & Styling']);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('a save failure is shown on Review, and cleared when the person goes back', async () => {
    saveAndPublishServiceProvider.mockRejectedValueOnce(new Error('Disabled in Preview: this deployment uses production data and is read-only.'));
    await mountAtDetails();
    await fillDetails();
    await click(q('wizard-continue'));
    await click(buttonWith('Save & Publish'));
    expect(q('setup-error')?.textContent).toMatch(/read-only/);
    await click(buttonWith('Back'));
    expect(q('setup-error')).toBeNull();
  });

  it('changing country keeps the currency the provider chose for their price', async () => {
    await mountAtDetails();
    const exact = (t: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === t) ?? null;
    await click(exact('NGN'));
    const usd = Array.from(container.querySelectorAll('span')).find((sp) => sp.textContent === 'USD — US Dollar')?.parentElement ?? null;
    await click(usd);
    expect(exact('USD')).toBeTruthy();
    await click(buttonWith('Nigeria'));
    const ghana = Array.from(container.querySelectorAll('span')).find((sp) => sp.textContent === 'Ghana')?.parentElement ?? null;
    await click(ghana);
    expect(buttonWith('Ghana')).toBeTruthy();
    expect(exact('USD')).toBeTruthy();
    expect(lastRegionCode).toBe('GH');
  });

  it('cannot continue to Review while a photo is still uploading', async () => {
    let release!: (v: any) => void;
    uploadResponse = () => new Promise((res) => { release = res; });
    await mountAtDetails();
    await typeInto(container.querySelector('input[placeholder="e.g. Glow Beauty Studio"]') as HTMLInputElement, 'Glow Studio');
    await addPhoto();
    expect((q('wizard-continue') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release({ data: { path: 'x' }, error: null }); });
    await flush();
    expect((q('wizard-continue') as HTMLButtonElement).disabled).toBe(false);
  });
});
