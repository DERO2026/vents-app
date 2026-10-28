import { describe, it, expect } from 'vitest';
import { avatarFill } from './avatarFill';

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function contrastWithWhite(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

function hue(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// Every per-user colour the app generates today: ExploreScreen's
// mapDbUserToUserProfile palette and AttendeeListScreen's AVATAR_COLORS.
const USER_COLORS = [
  '#EC4899', '#60A5FA', '#34D399', '#FBBF24', '#8E5CF7', '#F87171',
  '#3B82F6', '#F59E0B', '#22C55E', '#8B5CF6', '#06B6D4', '#F97316', '#EF4444',
];

describe('avatarFill', () => {
  it('brings every generated user colour to WCAG AA (4.5:1) with white initials', () => {
    for (const c of USER_COLORS) expect(contrastWithWhite(avatarFill(c)), c).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps each colour\'s hue -- a darker version of the same colour, not a different one', () => {
    for (const c of USER_COLORS) expect(Math.abs(hue(avatarFill(c)) - hue(c)), c).toBeLessThan(3);
  });

  it('only darkens as far as needed', () => {
    for (const c of USER_COLORS) expect(contrastWithWhite(avatarFill(c)), c).toBeLessThan(4.7);
  });

  it('keeps distinct users distinct', () => {
    expect(new Set(USER_COLORS.map(avatarFill)).size).toBe(USER_COLORS.length);
  });

  it('returns colours that already pass, and non-hex values, unchanged', () => {
    expect(avatarFill('#7B2FBE')).toBe('#7B2FBE');
    expect(avatarFill('#065F46')).toBe('#065F46');
    expect(avatarFill('transparent')).toBe('transparent');
    expect(avatarFill('rgba(0,0,0,0.5)')).toBe('rgba(0,0,0,0.5)');
  });

  it('is deterministic, so a user gets the same fill on every screen', () => {
    expect(avatarFill('#ec4899')).toBe(avatarFill('#EC4899'));
    expect(avatarFill('#EC4899')).toBe('#CD3F85');
  });
});
