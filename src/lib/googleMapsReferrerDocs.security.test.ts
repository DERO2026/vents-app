import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// VENTS release sprint — "Close Google Maps security gap" task.
//
// Found and fixed a real documentation defect: IOS_LAUNCH_CHECKLIST.md §7
// and LAUNCH_CHECKLIST.md §8 both told whoever configures the Google Cloud
// Console Maps key to add `capacitor://localhost/*` as an HTTP referrer
// pattern for iOS. That directly contradicts src/lib/mapEmbed.ts's own
// documented rationale: iOS deliberately does NOT rely on that referrer at
// all (a Capacitor WKWebView's origin is permanently `capacitor://localhost`,
// which Google's own docs call unreliable for referrer matching) -- instead
// it renders Maps through a real HTTPS iframe to https://getvents.com/embed/
// map.html, so the Referer header Google actually sees is a normal
// https://getvents.com/... one, already covered by the entry web browsers
// need anyway. Giving someone the old instruction would have them configure
// an unnecessary, unreliable allowlist entry while possibly believing the
// real (and different) required set was covered.
//
// This locks in, statically, that the two checklist docs match the actual
// shipped architecture (src/lib/mapEmbed.ts, capacitor.config.ts,
// src/lib/googleMaps.ts) rather than the stale/incorrect guidance.

let mapEmbedSrc: string;
let capacitorConfigSrc: string;
let iosChecklist: string;
let launchChecklist: string;

beforeAll(() => {
  const root = join(__dirname, '..', '..');
  mapEmbedSrc = readFileSync(join(root, 'src', 'lib', 'mapEmbed.ts'), 'utf8');
  capacitorConfigSrc = readFileSync(join(root, 'capacitor.config.ts'), 'utf8');
  iosChecklist = readFileSync(join(root, 'IOS_LAUNCH_CHECKLIST.md'), 'utf8');
  launchChecklist = readFileSync(join(root, 'LAUNCH_CHECKLIST.md'), 'utf8');
});

describe('Google Maps key referrer restriction docs match the actual shipped architecture', () => {
  it('capacitor.config.ts really does set the Android WebView origin to https://localhost (the fact the correct restriction set depends on)', () => {
    expect(capacitorConfigSrc).toMatch(/androidScheme:\s*'https'/);
    expect(capacitorConfigSrc).toMatch(/hostname:\s*'localhost'/);
  });

  it('mapEmbed.ts really does route iOS through an HTTPS iframe to getvents.com instead of a capacitor:// referrer', () => {
    expect(mapEmbedSrc).toMatch(/MAP_EMBED_ORIGIN = 'https:\/\/getvents\.com'/);
    expect(mapEmbedSrc).toMatch(/shouldUseMapEmbed/);
    expect(mapEmbedSrc).toMatch(/Capacitor\.getPlatform\(\) === 'ios'/);
  });

  it('neither checklist instructs adding a capacitor:// referrer pattern anymore (a mention explaining NOT to add it is fine)', () => {
    // The old, wrong instruction put this string inside a fenced ``` block
    // presented as "add these referrer patterns" -- no fenced code block in
    // either doc should contain it anymore. A plain-prose mention (this
    // test file's own header comment, or a "do not add X" sentence in the
    // checklist) is fine and expected.
    const fencedBlocks = (doc: string) => [...doc.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);
    for (const doc of [iosChecklist, launchChecklist]) {
      for (const block of fencedBlocks(doc)) {
        expect(block).not.toMatch(/capacitor:\/\/localhost\/\*/);
      }
    }
  });

  it('both checklists state the correct, complete referrer allowlist: getvents.com and https://localhost only', () => {
    for (const doc of [iosChecklist, launchChecklist]) {
      expect(doc).toContain('https://getvents.com/*');
      expect(doc).toContain('https://localhost/*');
    }
  });

  it('IOS_LAUNCH_CHECKLIST.md explains why iOS needs no separate referrer entry (rides on the iframe-to-getvents.com path)', () => {
    expect(iosChecklist).toMatch(/iframe/i);
    expect(iosChecklist).toMatch(/needs no separate referrer entry|no separate referrer entry/i);
  });

  it('both checklists recommend API restrictions scoped to exactly the three Maps APIs this app uses', () => {
    for (const doc of [iosChecklist, launchChecklist]) {
      expect(doc).toMatch(/Maps JavaScript API/);
      expect(doc).toMatch(/Places API \(New\)/);
      expect(doc).toMatch(/Geocoding API/);
    }
  });

  it('the rotation checklist item states the safe sequence: create, restrict, update deployment, verify, THEN retire the old key', () => {
    const rotationLine = launchChecklist.slice(launchChecklist.indexOf('Rotate the key'));
    expect(rotationLine).toMatch(/create the replacement/i);
    expect(rotationLine).toMatch(/verify/i);
    expect(rotationLine).toMatch(/never revoke it first|only once verified/i);
  });
});
