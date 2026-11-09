import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { flyerScrim } from './flyerScrim';

// No event flyer / cover image anywhere in the app may be covered by a flat
// dark band again (commit 407ae10 put one on Featured, event details, tickets,
// payment success, profile/provider covers and the welcome cards). Only the
// shared bottom-only gradient is allowed.
const SRC = join(__dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(n) && !/\.test\.tsx$/.test(n) ? [p] : [];
  });
}

describe('flyer scrim', () => {
  it('is a bottom-only gradient, transparent at its top, ending in the VENTS background', () => {
    const s = flyerScrim(35);
    expect(s.bottom).toBe(0);
    expect(s.top).toBeUndefined();
    expect(s.height).toBe('35%');
    expect(s.pointerEvents).toBe('none');
    expect(String(s.background)).toMatch(/^linear-gradient\(to bottom, rgba\(6,10,20,0\) 0%/);
    expect(String(s.background)).toMatch(/rgba\(6,10,20,0\.88\) 100%\)$/);
  });
  it('never covers more than 60% of an image', () => {
    expect(flyerScrim(90).height).toBe('60%');
  });

  it('no component lays a flat dark band over the bottom of an image', () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const s = readFileSync(f, 'utf8');
      // An absolutely-positioned layer anchored at the bottom with a % height
      // and a solid dark rgba background of 0.5+ opacity, right after an <img>
      // or ImageCarousel -- the shape of the old flyer bands.
      const re = /(<img[^>]*>|<ImageCarousel[\s\S]{0,400}?\/>)\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<div[^>]*style=\{\{[^}]*?(bottom: 0|bottom-0)[^}]*?height: '\d+%'[^}]*?background: 'rgba\(\d+,\s*\d+,\s*\d+,\s*0?\.[5-9]\d*\)'/g;
      const re2 = /(<img[^>]*>|<ImageCarousel[\s\S]{0,400}?\/>)\s*(\{\/\*[\s\S]*?\*\/\}\s*)?<div\s+(className="[^"]*bottom-0[^"]*"\s+)?style=\{\{\s*height: '\d+%', background: 'rgba\(\d+,\s*\d+,\s*\d+,\s*0?\.[5-9]\d*\)'/g;
      if (re.test(s) || re2.test(s)) offenders.push(f.slice(SRC.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it('every screen that showed a band now uses the shared scrim', () => {
    for (const n of ['EventDetailsScreen', 'HomeScreen', 'QRTicket', 'MyTicketsScreen', 'PaymentSuccessScreen', 'ProfileScreen', 'ServiceProviderProfileScreen', 'WelcomeScreen', 'TicketSelectScreen']) {
      expect(readFileSync(join(SRC, 'app', 'components', `${n}.tsx`), 'utf8'), n).toMatch(/style=\{flyerScrim\(\d+\)\}/);
    }
  });
});
