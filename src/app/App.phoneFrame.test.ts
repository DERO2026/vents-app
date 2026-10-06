import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression guard for Apple's Oct 2026 rejection of VENTS 1.0.2
// (Guideline 4 -- not optimized for all screen sizes, reproduced on an 11"
// iPad Air M3). The root .phone-frame rule used to hard-lock the entire
// app to 390px wide, stranding every screen in a small box in the middle
// of a much larger iPad viewport. Real rendered verification (Playwright,
// at 820x1180pt portrait and 1180x820pt landscape -- the actual iPad Air
// 11" M3 CSS point resolution -- against both the real WelcomeScreen via
// App.tsx and VentsAiScreen) was done manually this session and is not
// re-run here; a full App.tsx render test needs a real/mocked Supabase
// session this file doesn't set up. This is a cheap, static guard against
// silently reverting to a fixed 390px (or similar) width, not a
// substitute for that rendered check.
describe('App.tsx: phone-frame is not hard-locked to a phone-only width', () => {
  it('the .phone-frame width rule scales past a bare 390px on larger viewports', () => {
    const source = readFileSync(join(__dirname, 'App.tsx'), 'utf-8');
    const ruleMatch = source.match(/\.phone-frame\s*\{[^}]*\}/);
    expect(ruleMatch).toBeTruthy();
    const rule = ruleMatch![0];

    // The old, rejected rule: a bare `width: 390px;` with no formula.
    expect(rule).not.toMatch(/width:\s*390px\s*;/);
    // The fix: a width that can grow with the viewport, capped well short
    // of a literal edge-to-edge tablet stretch (which the task explicitly
    // ruled out as "simply making the phone UI larger").
    expect(rule).toMatch(/width:\s*min\(\s*100vw\s*,\s*\d+px\s*\)/);
  });
});
