// QA-only: mounts the REAL, unmodified App.tsx on its own, against the
// fixture-backed fakeSupabase.ts (aliased in vite.harness.config.ts), for
// end-to-end navigation checks such as earnings-navigation.e2e.mjs. Kept
// separate from ../main.tsx so a broken single-screen route there can never
// stop the full app from mounting. Open /full-app/?screen=full-app[&as=rep-1].
import { createRoot } from 'react-dom/client';
import App from '../../src/app/App';
import '../../src/styles/index.css';

createRoot(document.getElementById('root')!).render(<App />);
