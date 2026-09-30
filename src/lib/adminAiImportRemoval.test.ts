import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Regression test confirming AI Import is fully removed from the Admin
// Console: the tab entry, its render path, its dedicated state, and the
// now-fully-unused client helper library (src/lib/eventImporter.ts).
// api/extract-events.ts is DELIBERATELY kept -- it's a shared serverless
// endpoint also used by src/lib/visionCrop.ts's flyer smart-crop feature
// (an unrelated, still-active feature that reuses the same endpoint's
// imageBase64 branch to work around Vercel Hobby's serverless-function
// cap), so removing it would break something still in use.
//
// The legacy AdminDashboardScreen.tsx (where this was originally checked)
// has been fully retired and replaced by the Admin Console
// (src/app/components/admin/) -- this now scans that entire directory
// (every file the full migration moved/created), which is a stronger check
// than reading one file by name.

const adminDir = join(__dirname, '..', 'app', 'components', 'admin');
let adminConsoleSrc: string;

beforeAll(() => {
  adminConsoleSrc = readdirSync(adminDir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .map((f) => readFileSync(join(adminDir, f), 'utf8'))
    .join('\n');
});

describe('AI Import removed from Admin Console', () => {
  it('the Import tab entry is gone', () => {
    expect(adminConsoleSrc).not.toMatch(/'import-events'/);
    expect(adminConsoleSrc).not.toMatch(/label: 'Import'/);
  });

  it('the Import Events render block and its dedicated state/handlers are gone', () => {
    expect(adminConsoleSrc).not.toMatch(/IMPORT EVENTS TAB/);
    expect(adminConsoleSrc).not.toMatch(/importText|importResults|importFlyers|extractEventsFromText|isEventExtractionConfigured|publishEvents\(/);
  });

  it('the now-fully-unused eventImporter client helper is deleted', () => {
    expect(existsSync(join(__dirname, 'eventImporter.ts'))).toBe(false);
  });

  it('api/extract-events.ts is kept -- still used by the unrelated vision smart-crop feature', () => {
    const apiDir = join(__dirname, '..', '..', 'api');
    expect(existsSync(join(apiDir, 'extract-events.ts'))).toBe(true);
    const visionCrop = readFileSync(join(__dirname, 'visionCrop.ts'), 'utf8');
    expect(visionCrop).toMatch(/\/api\/extract-events/);
  });

  it('the legacy AdminDashboardScreen.tsx (the original home of this tab) no longer exists', () => {
    expect(existsSync(join(__dirname, '..', 'app', 'components', 'AdminDashboardScreen.tsx'))).toBe(false);
  });
});
