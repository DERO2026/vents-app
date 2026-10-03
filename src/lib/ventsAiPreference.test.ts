import { describe, it, expect, beforeEach } from 'vitest';
import { isVentsAiEnabled, setVentsAiEnabled } from './ventsAiPreference';

describe('ventsAiPreference: device-local VENTS AI orb show/hide switch', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to enabled when nothing has been stored yet (no behavior change for existing users)', () => {
    expect(isVentsAiEnabled()).toBe(true);
  });

  it('setVentsAiEnabled(false) persists and is read back as disabled', () => {
    setVentsAiEnabled(false);
    expect(isVentsAiEnabled()).toBe(false);
  });

  it('setVentsAiEnabled(true) after a prior false persists and is read back as enabled', () => {
    setVentsAiEnabled(false);
    setVentsAiEnabled(true);
    expect(isVentsAiEnabled()).toBe(true);
  });

  it('never throws even if localStorage access fails (private browsing / storage disabled)', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: storage disabled'); },
    });
    try {
      expect(() => isVentsAiEnabled()).not.toThrow();
      expect(isVentsAiEnabled()).toBe(true); // fails open to enabled, matching the default
      expect(() => setVentsAiEnabled(false)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
