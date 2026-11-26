import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// H5 (docs/repair-tracker.md): every pull request into main must run the
// TypeScript check and the full test suite. This keeps the workflow from
// being weakened or silently disabled.
const wf = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'pr-checks.yml'), 'utf8');
const code = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

describe('PR checks workflow', () => {
  it('runs on pull requests into main and pushes to main', () => {
    expect(code).toMatch(/on:\s*\n\s+pull_request:\s*\n\s+branches: \[main\]/);
    expect(code).toMatch(/\n\s+push:\s*\n\s+branches: \[main\]/);
  });

  it('runs the typecheck and the full suite (both vitest configs), with no skips', () => {
    expect(code).toContain('run: npm ci');
    expect(code).toContain('run: npm run typecheck');
    expect(code).toContain('run: npm test');
    expect(code).not.toMatch(/continue-on-error|\|\| true|--passWithNoTests|\.skip|--bail/);
  });

  it('npm test still means both configs', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.scripts.test).toBe('vitest run && vitest run --config vitest.preview.config.ts');
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit');
  });

  it('uses no secrets, read-only permissions and pinned actions', () => {
    expect(code).not.toMatch(/secrets\./);
    expect(code).toMatch(/permissions:\s*\n\s+contents: read/);
    for (const uses of code.match(/uses: \S+/g) ?? []) expect(uses).toMatch(/@[0-9a-f]{40}$/);
  });
});
