import * as Sentry from '@sentry/react';

export function initSentry() {
  Sentry.init({
    dsn: 'https://e3a6f5547429870f18a56c99ca40c942@o4511632583753728.ingest.us.sentry.io/4511632636575744',
    environment: import.meta.env.MODE || 'production',
    tracesSampleRate: 0.2,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0.1,
    integrations: [
      // Sentry's recommended defaults for Session Replay: mask all on-screen
      // text and block all media (images/video) by default. The app renders
      // chat messages, auth forms, and payment/checkout UI as plain text and
      // images, so leaving these off (as before) let Replay capture that
      // content verbatim. Crash/performance monitoring (tracesSampleRate,
      // replaysOnErrorSampleRate/replaysSessionSampleRate above) is
      // untouched — this only changes what a captured replay shows.
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
    dataCollection: {},
  });
}

export { Sentry };
