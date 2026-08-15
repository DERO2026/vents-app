import * as Sentry from '@sentry/react';
import { createRoot } from 'react-dom/client';
import App from './app/App.tsx';
import { PrivacyScreen } from './app/components/PrivacyScreen';
import { TermsScreen } from './app/components/TermsScreen';
import { RefundPolicyScreen } from './app/components/RefundPolicyScreen';
import { HelpPage } from './app/components/HelpPage';
import { DeleteAccountScreen } from './app/components/DeleteAccountScreen';
import './styles/index.css';
import { initSentry } from './lib/sentry';
import { initAnalytics } from './lib/analytics';

initSentry();
initAnalytics(import.meta.env.VITE_POSTHOG_KEY || '');

// Public legal pages are served without the app shell (and without ever
// mounting App at all) -- this used to be a conditional early-return inside
// App() itself, before any of its hooks ran, which is a Rules-of-Hooks
// violation (fragile even though `pathname` never changes mid-mount today).
// Deciding which component to render here, before React even sees `<App/>`,
// removes the conditional-hooks pattern entirely instead of just reordering it.
const pathname = window.location.pathname;
const legalPaths = new Set(['/privacy', '/terms', '/refunds', '/help', '/delete-account']);
if (legalPaths.has(pathname)) {
  // Unwind the app shell's scroll lock (see index.css) before first paint so
  // these pages scroll like a normal web page instead of fighting it.
  document.documentElement.classList.add('legal-scroll');
}
const RootScreen =
  pathname === '/privacy' ? <PrivacyScreen /> :
  pathname === '/terms' ? <TermsScreen /> :
  pathname === '/refunds' ? <RefundPolicyScreen /> :
  pathname === '/help' ? <HelpPage /> :
  pathname === '/delete-account' ? <DeleteAccountScreen /> :
  <App />;

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
    {RootScreen}
  </Sentry.ErrorBoundary>
);
