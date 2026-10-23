import { describe, it, expect, vi, beforeEach } from 'vitest';

// @paystack/inline-js v2 ships no .d.ts and makes a real HTTP call to
// Paystack's own checkout servers when constructed/invoked for real -- this
// suite never does that (per the task's "do not make real charges during
// testing" instruction). newTransaction is mocked to synchronously invoke
// whichever of onSuccess/onCancel/onError the test wants, exactly mirroring
// how the real SDK invokes those same callbacks asynchronously -- openPaystackPopup
// itself is fire-and-forget (no returned promise), so sync invocation here
// exercises the same code paths a real async callback would.
const mockNewTransaction = vi.fn();
const mockIsNativePlatform = vi.fn(() => false);

// Arrow functions can't be used as constructors ("new (() => {})()" throws),
// so the mocked default export must be a real function/class -- it's
// invoked with `new PaystackPop()` by the module under test.
vi.mock('@paystack/inline-js', () => ({
  default: vi.fn().mockImplementation(function MockPaystackPop() {
    return { newTransaction: mockNewTransaction };
  }),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mockIsNativePlatform() },
}));

import { openPaystackPopup } from './paystack';

const ORIGINAL_ENV = { ...import.meta.env };

beforeEach(() => {
  mockNewTransaction.mockReset();
  mockIsNativePlatform.mockReset();
  mockIsNativePlatform.mockReturnValue(false);
  (import.meta.env as any).VITE_PAYSTACK_PUBLIC_KEY = 'pk_test_abc123';
});

function baseOpts(overrides: Partial<Parameters<typeof openPaystackPopup>[0]> = {}) {
  return {
    email: 'buyer@example.com',
    amountKobo: 500000,
    onSuccess: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('openPaystackPopup: initialization', () => {
  it('starts a transaction with the key, amount, NGN currency, and a reference', () => {
    const opts = baseOpts();
    openPaystackPopup(opts);
    expect(mockNewTransaction).toHaveBeenCalledTimes(1);
    const call = mockNewTransaction.mock.calls[0][0];
    expect(call.key).toBe('pk_test_abc123');
    expect(call.amount).toBe(500000);
    expect(call.currency).toBe('NGN');
    expect(typeof call.reference).toBe('string');
    expect(call.reference.length).toBeGreaterThan(0);
  });

  it('uses the caller-supplied reference when given, instead of generating one', () => {
    openPaystackPopup(baseOpts({ ref: 'vents_fixed_ref_1' }));
    expect(mockNewTransaction.mock.calls[0][0].reference).toBe('vents_fixed_ref_1');
  });

  it('fails fast with onError, never calling newTransaction, when no public key is configured', () => {
    (import.meta.env as any).VITE_PAYSTACK_PUBLIC_KEY = '';
    const onError = vi.fn();
    openPaystackPopup(baseOpts({ onError }));
    expect(mockNewTransaction).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Payment system not configured. Please try again later.');
  });

  it('falls back to onClose when onError is not supplied and the key is missing', () => {
    (import.meta.env as any).VITE_PAYSTACK_PUBLIC_KEY = '';
    const onClose = vi.fn();
    openPaystackPopup(baseOpts({ onError: undefined, onClose }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rejects a zero/negative amount before ever calling newTransaction', () => {
    const onError = vi.fn();
    openPaystackPopup(baseOpts({ amountKobo: 0, onError }));
    expect(mockNewTransaction).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Invalid payment amount.');
  });

  it('converts amountNaira to kobo when amountKobo is not supplied', () => {
    openPaystackPopup(baseOpts({ amountKobo: undefined, amountNaira: 1500 }));
    expect(mockNewTransaction.mock.calls[0][0].amount).toBe(150000);
  });

  it('prefers amountKobo over amountNaira when both are supplied', () => {
    openPaystackPopup(baseOpts({ amountKobo: 777, amountNaira: 999999 }));
    expect(mockNewTransaction.mock.calls[0][0].amount).toBe(777);
  });
});

describe('openPaystackPopup: channel selection (web vs. native, and the wallets)', () => {
  it('includes apple_pay and google_pay on a web build', () => {
    mockIsNativePlatform.mockReturnValue(false);
    openPaystackPopup(baseOpts());
    const channels = mockNewTransaction.mock.calls[0][0].channels;
    expect(channels).toContain('apple_pay');
    expect(channels).toContain('google_pay');
    // google_pay must never be offered without card alongside it, per
    // @paystack/inline-js's own documented requirement.
    expect(channels).toContain('card');
  });

  it('never includes apple_pay or google_pay inside the native Capacitor app', () => {
    mockIsNativePlatform.mockReturnValue(true);
    openPaystackPopup(baseOpts());
    const channels = mockNewTransaction.mock.calls[0][0].channels;
    expect(channels).not.toContain('apple_pay');
    expect(channels).not.toContain('google_pay');
    // The native channel list must be byte-for-byte what it was before
    // wallets existed, so the native app's behavior is provably unchanged.
    expect(channels).toEqual(['card', 'bank_transfer', 'ussd', 'mobile_money', 'bank']);
  });

  it('lets a caller override the channel list explicitly (e.g. event promotion)', () => {
    openPaystackPopup(baseOpts({ channels: ['card'] }));
    expect(mockNewTransaction.mock.calls[0][0].channels).toEqual(['card']);
  });
});

describe('openPaystackPopup: success, cancellation, failure, and duplicate callbacks', () => {
  it('calls onSuccess with the reference when the SDK reports success', () => {
    const onSuccess = vi.fn();
    mockNewTransaction.mockImplementation((params: any) => {
      params.onSuccess({ reference: 'real_paystack_ref_1' });
    });
    openPaystackPopup(baseOpts({ onSuccess }));
    expect(onSuccess).toHaveBeenCalledWith({ reference: 'real_paystack_ref_1' });
  });

  it('calls onClose (not onError) when the SDK reports the customer cancelled', () => {
    const onClose = vi.fn();
    const onError = vi.fn();
    mockNewTransaction.mockImplementation((params: any) => {
      params.onCancel();
    });
    openPaystackPopup(baseOpts({ onClose, onError }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('calls onError with the SDK-provided message on a load/charge failure', () => {
    const onError = vi.fn();
    mockNewTransaction.mockImplementation((params: any) => {
      params.onError({ message: 'Could not load transaction' });
    });
    openPaystackPopup(baseOpts({ onError }));
    expect(onError).toHaveBeenCalledWith('Could not load transaction');
  });

  it('falls back to onClose on error when onError is not supplied', () => {
    const onClose = vi.fn();
    mockNewTransaction.mockImplementation((params: any) => {
      params.onError({ message: 'boom' });
    });
    openPaystackPopup(baseOpts({ onError: undefined, onClose }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces onError (not a thrown exception) if newTransaction itself throws synchronously', () => {
    const onError = vi.fn();
    mockNewTransaction.mockImplementation(() => {
      throw new Error('SDK not loaded');
    });
    expect(() => openPaystackPopup(baseOpts({ onError }))).not.toThrow();
    expect(onError).toHaveBeenCalledWith('SDK not loaded');
  });

  it('a duplicate/late success callback after an already-handled attempt still only reports what it is told (no de-dupe needed at this layer -- caller owns single-flight)', () => {
    // openPaystackPopup itself does not de-duplicate repeated SDK callbacks --
    // that's deliberately the caller's job (CheckoutScreen.tsx's payingRef
    // single-flight guard). This test documents that this module simply
    // forwards whatever the SDK reports, as many times as it's reported.
    const onSuccess = vi.fn();
    let capturedOnSuccess: ((r: any) => void) | undefined;
    mockNewTransaction.mockImplementation((params: any) => {
      capturedOnSuccess = params.onSuccess;
      params.onSuccess({ reference: 'ref_1' });
    });
    openPaystackPopup(baseOpts({ onSuccess }));
    // Simulate the SDK firing a second, duplicate callback for the same
    // attempt (e.g. a retried network event inside the SDK itself).
    capturedOnSuccess?.({ reference: 'ref_1' });
    expect(onSuccess).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenNthCalledWith(1, { reference: 'ref_1' });
    expect(onSuccess).toHaveBeenNthCalledWith(2, { reference: 'ref_1' });
  });
});
