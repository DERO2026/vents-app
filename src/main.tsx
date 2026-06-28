import * as Sentry from '@sentry/react';
import { createRoot } from 'react-dom/client';
import App from './app/App.tsx';
import './styles/index.css';
import { initSentry } from './lib/sentry';
import { initAnalytics } from './lib/analytics';

initSentry();
initAnalytics(import.meta.env.VITE_POSTHOG_KEY || '');

createRoot(document.getElementById('root')!).render(
  <Sentry.ErrorBoundary fallback={
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: '#0D0D0D', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24
    }}>
      <div style={{ color: 'white', fontSize: 18, fontWeight: 700 }}>Something went wrong</div>
      <div style={{ color: '#888', fontSize: 14, textAlign: 'center' }}>We have been notified and are fixing it. Please refresh.</div>
      <button onClick={() => window.location.reload()} style={{
        background: '#7B2FF7', color: 'white', border: 'none',
        padding: '12px 24px', borderRadius: 12, fontSize: 14,
        fontWeight: 700, cursor: 'pointer', marginTop: 8
      }}>Refresh App</button>
    </div>
  }>
    <App />
  </Sentry.ErrorBoundary>
);
