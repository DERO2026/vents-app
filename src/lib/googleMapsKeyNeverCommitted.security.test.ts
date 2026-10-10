import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Task 4 (VENTS release sprint): completes the previously-reported Google
// Maps security finding (commit b70696e cleared a real, plaintext-committed
// Google Maps Platform API key + PostHog key out of .env.production; this
// repo's own MASTER_AUDIT.md F5/F13 already documented that the repo-side
// fix was done, and that key rotation + Google Cloud Console HTTP-referrer
// restriction verification remain outstanding and require Cloud Console
// access this session/repo does not have -- not re-litigated here).
//
// This locks in the repo-side state so it can never silently regress:
// - no "AIza"-prefixed Google API key string exists anywhere in tracked
//   source (confirmed via `git grep`, not just a glob -- catches anything
//   staged/tracked regardless of .gitignore).
// - .env.production's Maps/PostHog/Supabase/Paystack values stay empty.
// - vite.config.ts's production-build guard (added this session, closing a
//   real gap: no guard previously existed for a missing/placeholder Maps
//   key, unlike the existing Paystack/Supabase guards) checks presence and
//   the "AIza" prefix before allowing a production build to proceed.

describe('Google Maps key: never committed, build guard exists', () => {
  it('no AIza-prefixed Google API key string exists in any git-tracked file', () => {
    // git grep only searches tracked content -- exactly the right scope
    // for "was a secret committed", independent of the working tree's
    // current .gitignore state. Exit code 1 means no match (git grep's own
    // convention); this test's own file must not itself match since it
    // never contains a real key, only the literal string "AIza" in prose.
    let output = '';
    let matched = false;
    try {
      output = execSync('git grep -n "AIza[0-9A-Za-z_-]\\{10,\\}" -- . ":(exclude)src/lib/googleMapsKeyNeverCommitted.security.test.ts"', {
        cwd: join(__dirname, '..', '..'),
        encoding: 'utf8',
      });
      matched = output.trim().length > 0;
    } catch (err: any) {
      // git grep exits 1 (not an error here) when there are no matches.
      if (err.status !== 1) throw err;
      matched = false;
    }
    expect(matched, `found a committed Google API key-shaped string:\n${output}`).toBe(false);
  });

  it('.env.production keeps every sensitive value empty', () => {
    const envProd = readFileSync(join(__dirname, '..', '..', '.env.production'), 'utf8');
    expect(envProd).toMatch(/^VITE_GOOGLE_PLACES_API_KEY=\s*$/m);
    expect(envProd).toMatch(/^VITE_SUPABASE_URL=\s*$/m);
    expect(envProd).toMatch(/^VITE_SUPABASE_ANON_KEY=\s*$/m);
    expect(envProd).toMatch(/^VITE_PAYSTACK_PUBLIC_KEY=\s*$/m);
    expect(envProd).toMatch(/^VITE_POSTHOG_KEY=\s*$/m);
  });

  describe('vite.config.ts production-build guard', () => {
    let src: string;
    beforeAll(() => {
      src = readFileSync(join(__dirname, '..', '..', 'vite.config.ts'), 'utf8');
    });

    it('checks VITE_GOOGLE_PLACES_API_KEY presence and the AIza prefix', () => {
      expect(src).toMatch(/const mapsKey = env\.VITE_GOOGLE_PLACES_API_KEY \|\| '';/);
      expect(src).toMatch(/mapsKey\.startsWith\('AIza'\)/);
    });

    it('throws a build-time error (never silently continues) when the key is missing or malformed', () => {
      const guardStart = src.indexOf("const mapsKey = env.VITE_GOOGLE_PLACES_API_KEY");
      const guardBlock = src.slice(guardStart, guardStart + 700);
      expect(guardBlock).toMatch(/throw new Error\(/);
      expect(guardBlock).toMatch(/\[build guard\] VITE_GOOGLE_PLACES_API_KEY/);
    });

    it('only runs in production mode, never blocking a development build', () => {
      const prodModeIdx = src.indexOf("if (mode === 'production')");
      const guardIdx = src.indexOf('const mapsKey = env.VITE_GOOGLE_PLACES_API_KEY');
      expect(prodModeIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeGreaterThan(prodModeIdx);
    });
  });
});
