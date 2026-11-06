// Banner for read-only Vercel Preview builds (loaded only when
// __VENTS_PREVIEW_READ_ONLY__ is true; see main.tsx). Plain DOM, outside the
// React tree, so no screen has to know about it. It ignores pointer events
// so it never blocks the controls underneath it.

export const PREVIEW_BANNER_TEXT = 'PREVIEW · READ ONLY · PRODUCTION DATA';

export function mountPreviewReadOnlyBanner(doc: Document = document): HTMLElement {
  const existing = doc.getElementById('vents-preview-banner');
  if (existing) return existing;
  const el = doc.createElement('div');
  el.id = 'vents-preview-banner';
  el.setAttribute('role', 'status');
  el.textContent = PREVIEW_BANNER_TEXT;
  Object.assign(el.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
    padding: 'calc(env(safe-area-inset-top, 0px) + 4px) 8px 4px',
    background: '#B91C1C',
    color: '#FFFFFF',
    font: '800 11px/1.3 system-ui, -apple-system, sans-serif',
    letterSpacing: '0.12em',
    textAlign: 'center',
    boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
  } as Partial<CSSStyleDeclaration>);
  doc.body.appendChild(el);
  return el;
}
