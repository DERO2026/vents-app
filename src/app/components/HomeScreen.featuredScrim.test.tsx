import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Featured card keeps the flyer vibrant: the shared bottom-only scrim
// (src/lib/flyerScrim.ts), never a flat dark band over half the card.
const src = readFileSync(join(__dirname, 'HomeScreen.tsx'), 'utf8');
const carousel = src.slice(src.indexOf('export function FeaturedCarousel('), src.indexOf('function FilterChip('));

describe('Featured card scrim', () => {
  it('has no flat dark band over the flyer', () => {
    expect(carousel).not.toMatch(/background:\s*'rgba\(0,\s*0,\s*0,\s*0\.[5-9]\d*\)'/);
    expect(carousel).not.toMatch(/height:\s*'55%'/);
  });
  it('uses the shared bottom-only scrim', () => {
    expect(carousel).toMatch(/data-testid="featured-scrim" aria-hidden style=\{flyerScrim\(40\)\}/);
  });
  it('keeps the title, date and place readable over bright flyers', () => {
    expect(carousel).toMatch(/textShadow: '0 1px 8px rgba\(0,0,0,0\.6\)' \}\}>\{event\.title\}/);
    expect(carousel.match(/textShadow: '0 1px 6px rgba\(0,0,0,0\.7\)' \}\}>\{event\.(date|city)\}/g)?.length).toBe(2);
  });
});
