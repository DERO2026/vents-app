import { describe, it, expect, vi, afterEach } from 'vitest';

// isIosNative()/isAndroidNative()/isMobileNativeForAiGate() are the shared
// platform checks every VENTS AI iOS/Android purchase restriction reads
// off (AiAccessScreen.tsx, AiPlansScreen.tsx, VentsAiUnlockedScreen.tsx,
// VentsAiScreen.tsx, App.tsx) and that mapEmbed.ts's shouldUseMapEmbed()
// established the two-part convention for. Direct unit coverage here
// guards the one place the "which platforms restrict AI purchases"
// decision lives, independent of any one screen's own test.

const getPlatformMock = vi.fn<() => string>(() => 'web');
const isNativePlatformMock = vi.fn<() => boolean>(() => false);
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => getPlatformMock(),
    isNativePlatform: () => isNativePlatformMock(),
  },
}));

afterEach(() => {
  getPlatformMock.mockReset();
  isNativePlatformMock.mockReset();
});

describe('isIosNative', () => {
  it('true only when native AND platform is ios', async () => {
    const { isIosNative } = await import('./platform');
    getPlatformMock.mockReturnValue('ios');
    isNativePlatformMock.mockReturnValue(true);
    expect(isIosNative()).toBe(true);
  });

  it('false on android even if native', async () => {
    const { isIosNative } = await import('./platform');
    getPlatformMock.mockReturnValue('android');
    isNativePlatformMock.mockReturnValue(true);
    expect(isIosNative()).toBe(false);
  });

  it('false when getPlatform says ios but isNativePlatform is false (not a genuine native shell)', async () => {
    const { isIosNative } = await import('./platform');
    getPlatformMock.mockReturnValue('ios');
    isNativePlatformMock.mockReturnValue(false);
    expect(isIosNative()).toBe(false);
  });
});

describe('isAndroidNative', () => {
  it('true only when native AND platform is android', async () => {
    const { isAndroidNative } = await import('./platform');
    getPlatformMock.mockReturnValue('android');
    isNativePlatformMock.mockReturnValue(true);
    expect(isAndroidNative()).toBe(true);
  });

  it('false on ios even if native', async () => {
    const { isAndroidNative } = await import('./platform');
    getPlatformMock.mockReturnValue('ios');
    isNativePlatformMock.mockReturnValue(true);
    expect(isAndroidNative()).toBe(false);
  });

  it('false when getPlatform says android but isNativePlatform is false', async () => {
    const { isAndroidNative } = await import('./platform');
    getPlatformMock.mockReturnValue('android');
    isNativePlatformMock.mockReturnValue(false);
    expect(isAndroidNative()).toBe(false);
  });

  it('false on web', async () => {
    const { isAndroidNative } = await import('./platform');
    getPlatformMock.mockReturnValue('web');
    isNativePlatformMock.mockReturnValue(false);
    expect(isAndroidNative()).toBe(false);
  });
});

describe('isMobileNativeForAiGate', () => {
  it('true on native iOS', async () => {
    const { isMobileNativeForAiGate } = await import('./platform');
    getPlatformMock.mockReturnValue('ios');
    isNativePlatformMock.mockReturnValue(true);
    expect(isMobileNativeForAiGate()).toBe(true);
  });

  it('true on native Android', async () => {
    const { isMobileNativeForAiGate } = await import('./platform');
    getPlatformMock.mockReturnValue('android');
    isNativePlatformMock.mockReturnValue(true);
    expect(isMobileNativeForAiGate()).toBe(true);
  });

  it('false on web -- website AI/AI+ purchasing must stay unrestricted', async () => {
    const { isMobileNativeForAiGate } = await import('./platform');
    getPlatformMock.mockReturnValue('web');
    isNativePlatformMock.mockReturnValue(false);
    expect(isMobileNativeForAiGate()).toBe(false);
  });
});
