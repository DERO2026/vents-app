import * as Sentry from '@sentry/react';

export function initSentry() {
  Sentry.init({
    dsn: 'https://e3a6f5547429870f18a56c99ca40c942@o4511632583753728.ingest.us.sentry.io/4511632636575744',
    environment: import.meta.env.MODE || 'production',
    tracesSampleRate: 0.2,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.1,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: false,
      }),
    ],
    dataCollection: {},
  });
}

export { Sentry };
