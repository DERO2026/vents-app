import * as Sentry from '@sentry/react';

// ROOT CAUSE of "Replays are being dropped -- 100% of replay budget consumed":
// replaysSessionSampleRate: 0.1 recorded a FULL session replay for 10% of
// EVERY session across EVERY environment (dev, Preview, production alike) --
// not just sessions that errored. Full-session replays are by far the most
// storage/quota-expensive thing Sentry captures, and this pass's own
// extensive manual Preview QA testing (this branch's whole history) was
// itself contributing to that same shared quota. Fixed two ways:
//   1. replaysSessionSampleRate -> 0. Baseline "record 1 in 10 sessions
//      whether or not anything went wrong" has poor diagnostic value per
//      replay-minute spent -- replaysOnErrorSampleRate below already
//      guarantees a replay for every session that actually errors, which is
//      both the useful case and, since only a small fraction of sessions
//      ever error, far cheaper against the quota.
//   2. Replay (and, more conservatively, tracing) only runs in production.
//      environment was already being set to import.meta.env.MODE, but
//      nothing actually gated behavior on it -- dev/Preview traffic was
//      silently spending the same shared budget as real users. Error
//      reporting itself (Sentry.init, captureException) stays active in
//      every environment -- only Replay/tracing sampling is gated, so a
//      Preview bug is still fully visible in Sentry, just without also
//      recording a full-session video for it.
const IS_PRODUCTION = (import.meta.env.MODE || 'production') === 'production';

export function initSentry() {
  Sentry.init({
    dsn: 'https://e3a6f5547429870f18a56c99ca40c942@o4511632583753728.ingest.us.sentry.io/4511632636575744',
    environment: import.meta.env.MODE || 'production',
    // Reduced from 0.2 -- performance-transaction volume isn't what's
    // exhausting the account's budget (Replay is), but there is no reason
    // to spend even that quota on non-production traffic either.
    tracesSampleRate: IS_PRODUCTION ? 0.1 : 0,
    // Kept at 1.0 for production: recording a replay for every session that
    // actually threw an error is the entire point of error-triggered replay
    // (real diagnostic value, low relative cost since most sessions never
    // error). Zero outside production so Preview/dev QA never touches the
    // shared quota.
    replaysOnErrorSampleRate: IS_PRODUCTION ? 1.0 : 0,
    // This was the actual quota drain -- see header comment. Off everywhere.
    replaysSessionSampleRate: 0,
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
