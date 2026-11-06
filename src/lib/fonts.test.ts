import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// VENTS typography is Manrope (src/styles/index.css). No page may download
// another display font, and no component may ask for one that is no longer
// loaded (it would silently fall back to a system font).
const root = join(__dirname, '..', '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css|html)$/.test(f) ? [p] : [];
});

describe('fonts', () => {
  it('index.html downloads no Google font family itself (Manrope comes from index.css)', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).not.toMatch(/fonts\.googleapis\.com\/css2\?family=/);
    expect(html).not.toMatch(/Outfit/);
  });

  it('index.css loads Manrope and makes it the base font', () => {
    const css = readFileSync(join(root, 'src/styles/index.css'), 'utf8');
    expect(css).toMatch(/fonts\.googleapis\.com\/css2\?family=Manrope/);
    expect(css).toMatch(/html, body \{[^}]*font-family: 'Manrope', sans-serif;/);
  });

  it('no source file asks for the removed Outfit font', () => {
    const offenders = walk(join(root, 'src')).filter((p) => !p.endsWith('fonts.test.ts') && /Outfit/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
