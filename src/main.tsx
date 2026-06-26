import * as Sentry from '@sentry/react';
import { createRoot } from 'react-dom/client';
import App from './app/App.tsx';
import './styles/index.css';
import { initSentry } from './lib/sentry';

initSentry();

createRoot(document.getElementById('root')!).render(
  <Sentry.ErrorBoundary fallback={<p style={{ color: 'white', padding: '20px' }}>Something went wrong. Please refresh.</p>}>
    <App />
  </Sentry.ErrorBoundary>
);
