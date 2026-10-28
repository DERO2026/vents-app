import { describe, it, expect } from 'vitest';
import { ventsColors } from './ventsDesignTokens';
import { servicesFills } from './servicesDesignTokens';
import { accentFill, accentStrongFill } from '../app/components/admin/adminConsoleTheme';

// WCAG 2.x contrast ratio between two #rrggbb colours.
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Solid fills under white text must meet WCAG AA for normal-size text
// (4.5:1). The brighter accents stay for icons and decorative fills, where
// the non-text requirement is 3:1.
describe('solid fills under white text', () => {
  it('ventsColors.accentStrong meets AA (4.5:1) with white', () => {
    expect(contrast(ventsColors.accentStrong, ventsColors.white)).toBeGreaterThanOrEqual(4.5);
  });

  it('the strong status fills meet AA (4.5:1) with white', () => {
    for (const c of [ventsColors.successStrong, ventsColors.infoStrong, ventsColors.errorStrong, servicesFills.serviceProviderCapability]) {
      expect(contrast(c, ventsColors.white), c).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the admin accentStrongFill meets AA (4.5:1) with white', () => {
    expect(contrast(accentStrongFill, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });

  it('the bright accents still meet 3:1 for white icons and other non-text accents', () => {
    for (const c of [ventsColors.accent, accentFill]) {
      expect(contrast(c, ventsColors.white)).toBeGreaterThanOrEqual(3);
    }
  });
});
