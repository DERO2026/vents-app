import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Featured card must keep the event flyer vibrant: only a bottom-only
// gradient scrim behind the text, never a flat dark band over half the card
// (the old `height: '55%', background: 'rgba(0,0,0,0.75)'` greyed out every flyer).
const src = readFileSync(join(__dirname, 'HomeScreen.tsx'), 'utf8');
const carousel = src.slice(src.indexOf('export function FeaturedCarousel('), src.indexOf('function FilterChip('));

describe('Featured card scrim', () => {
  it('has no flat dark band over the flyer', () => {
    expect(carousel).not.toMatch(/background:\s*'rgba\(0,\s*0,\s*0,\s*0\.[5-9]\d*\)'/);
    expect(carousel).not.toMatch(/height:\s*'55%'/);
  });
  it('uses one bottom-only gradient, transparent at its top, covering at most 45% of the card', () => {
    const scrim = carousel.match(/data-testid="featured-scrim"[\s\S]*?\}\} \/>/)?.[0] ?? '';
    expect(scrim).toMatch(/bottom: 0/);
    const h = Number(scrim.match(/height: '(\d+)%'/)?.[1]);
    expect(h).toBeGreaterThan(0);
    expect(h).toBeLessThanOrEqual(45);
    expect(scrim).toMatch(/linear-gradient\(to bottom, rgba\(6,10,20,0\) 0%/);
    expect(scrim).toMatch(/pointerEvents: 'none'/);
  });
  it('keeps the title, date and place readable over bright flyers', () => {
    expect(carousel).toMatch(/textShadow: '0 1px 8px rgba\(0,0,0,0\.6\)' \}\}>\{event\.title\}/);
    expect(carousel.match(/textShadow: '0 1px 6px rgba\(0,0,0,0\.7\)' \}\}>\{event\.(date|city)\}/g)?.length).toBe(2);
  });
});
