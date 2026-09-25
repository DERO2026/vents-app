import { useEffect } from 'react';

// Toggles a class on the shared #root SPA container so ONLY the screen
// that mounts this hook gets the wider desktop shell (see the
// `#root.vents-desktop-wide` rule in src/styles/index.css) -- #root is a
// single shared ancestor for every screen, so this must be scoped per
// screen rather than left as a blanket width rule, or every other screen
// stretches too (see index.css's own note on the bug this replaced).
export function useDesktopWideShell(): void {
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    root.classList.add('vents-desktop-wide');
    return () => { root.classList.remove('vents-desktop-wide'); };
  }, []);
}
