-- MVP launch kill switches for chat voice notes and image sharing.
--
-- A pre-launch stability audit found voice notes have real bugs: no
-- unmount cleanup for the MediaRecorder/timer/mic stream (the mic can
-- stay hot for up to 60s if the screen is left mid-recording) and cached
-- playback <audio> elements that are never released, plus the Android
-- wrapper's AndroidManifest.xml doesn't declare RECORD_AUDIO, so
-- getUserMedia will likely fail outright on-device regardless of the JS
-- fixes. The JS-level leaks are fixed in this same change, but the
-- Android permission gap needs an on-device verification pass this
-- migration can't cover — so voice notes default OFF for launch.
--
-- Image sharing was audited as already stable (client-side compression
-- to <=1200px/JPEG q0.82 before upload, no retained blobs/base64 in
-- message state) — it stays on by default. Both get a kill switch for
-- symmetry and operational flexibility, following the same singleton
-- app_config pattern already used for maintenance_mode.

ALTER TABLE public.app_config
  ADD COLUMN IF NOT EXISTS voice_notes_enabled   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS image_sharing_enabled  boolean NOT NULL DEFAULT true;
