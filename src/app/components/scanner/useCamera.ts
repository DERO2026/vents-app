// ── Camera module ────────────────────────────────────────────────────────────
// Owns the MediaStream and binds it to a <video> element that the CALLER renders
// and fully controls (no injected DOM, no library-owned element — this is the
// deliberate fix for the old html5-qrcode preview that rendered at 0px height on
// iOS WKWebView). Responsibilities: request permission once, open the requested
// camera, expose torch + front/back switching when the hardware supports them,
// and pause/resume cleanly with app background/foreground. Zero UI, zero
// decoding — just a stable, live preview surface.

import { useCallback, useEffect, useRef, useState } from 'react';
import { askPermission } from '../../../lib/permissionPrimer';

export type CameraStatus = 'idle' | 'starting' | 'ready' | 'error';
export type Facing = 'environment' | 'user';

export interface CameraController {
  /** Attach to a <video autoPlay muted playsInline> that the caller renders. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: CameraStatus;
  error: string | null;
  torchSupported: boolean;
  torchOn: boolean;
  toggleTorch: () => void;
  canSwitchCamera: boolean;
  facing: Facing;
  switchCamera: () => void;
  /** Retry after a permission/hardware failure. */
  retry: () => void;
}

function friendlyError(err: any): string {
  const raw = String(err?.name || err?.message || err || '');
  if (/NotAllowedError|Permission denied|permission/i.test(raw)) {
    return 'Camera access is blocked. Allow camera access for Vents in your device settings, then tap Try Again.';
  }
  if (/NotFoundError|DevicesNotFound|no camera/i.test(raw)) {
    return 'No camera was found on this device.';
  }
  if (/NotReadableError|TrackStartError|in use/i.test(raw)) {
    return 'The camera is already in use by another app. Close it, then tap Try Again.';
  }
  if (/OverconstrainedError/i.test(raw)) {
    return 'This device could not provide a compatible camera stream.';
  }
  return 'Could not start the camera. Please try again.';
}

export function useCamera(active: boolean): CameraController {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const mountedRef = useRef(true);

  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<Facing>('environment');
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [canSwitchCamera, setCanSwitchCamera] = useState(false);
  const [nonce, setNonce] = useState(0); // bump to force a clean restart

  const stopStream = useCallback(() => {
    try {
      if (trackRef.current && torchOn) {
        trackRef.current.applyConstraints({ advanced: [{ torch: false } as any] }).catch(() => {});
      }
    } catch { /* ignore */ }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    trackRef.current = null;
  }, [torchOn]);

  // Single source of truth for opening the camera. Runs whenever the screen is
  // active, the facing direction changes, or an explicit retry bumps `nonce`.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setStatus('starting');
    setError(null);
    setTorchOn(false);

    (async () => {
      try {
        // Apple's Oct 2026 rejection of VENTS 1.0.2 (Guideline 5.1.1(iv))
        // was about the OTHER camera entry point (pickImage.ts's photo
        // picker) having a dismissible pre-permission screen; auditing
        // "every relevant caller" for this same fix turned up this one too
        // -- until now, opening the check-in scanner called getUserMedia
        // directly with zero explanation, firing the real OS prompt the
        // instant an organizer navigated here. Same primer, same
        // non-dismissible contract as pickImage.ts (dismissible: false --
        // no skip path, "Continue" is the only way out, and it leads
        // straight into the real getUserMedia call below). Shares the one
        // "shown once per device" key with pickImage.ts's own 'camera'
        // primer (lib/permissionPrimer.ts) -- whichever camera-using
        // feature a user reaches first explains it once; a later feature
        // never needs to repeat an explanation the OS has already acted on.
        await askPermission('camera', {
          icon: 'camera',
          title: 'Allow Camera Access',
          message: 'VENTS uses your camera to scan attendee QR codes for ticket check-in.',
          dismissible: false,
        });
        if (cancelled || !mountedRef.current) return;

        // Minimal constraints only. Demanding an explicit resolution/frame rate
        // caused getUserMedia to reject on some devices/WebViews; quality is the
        // sensor's default, which is more than enough for QR decoding.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing } },
          audio: false,
        });
        if (cancelled || !mountedRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0] || null;
        trackRef.current = track;

        // Torch capability probe (best-effort; unsupported on many iOS devices).
        let torchOk = false;
        try {
          const caps: any = track?.getCapabilities?.() || {};
          torchOk = !!caps.torch;
        } catch { /* capabilities unavailable */ }
        if (!cancelled) setTorchSupported(torchOk);

        // Can we offer a front/back switch?
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cams = devices.filter((d) => d.kind === 'videoinput');
          if (!cancelled) setCanSwitchCamera(cams.length > 1);
        } catch { /* ignore */ }

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        video.muted = true;
        try {
          await video.play();
        } catch {
          // Autoplay can reject until a gesture; a muted+playsinline video
          // normally still starts. Retry once shortly after.
          setTimeout(() => { video.play().catch(() => {}); }, 150);
        }
        if (!cancelled && mountedRef.current) setStatus('ready');
      } catch (err) {
        if (!cancelled && mountedRef.current) {
          setStatus('error');
          setError(friendlyError(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      stopStream();
    };
    // stopStream intentionally omitted: it closes over torchOn and would restart
    // the camera on every torch toggle. Restart triggers are explicit only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, facing, nonce]);

  // Background/foreground: pause the <video> to save power when hidden; the
  // stream itself is kept alive so returning is instant (no re-permission).
  useEffect(() => {
    const onVisibility = () => {
      const v = videoRef.current;
      if (!v) return;
      if (document.hidden) {
        try { v.pause(); } catch { /* ignore */ }
      } else {
        v.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = useCallback(() => {
    const track = trackRef.current;
    if (!track || !torchSupported) return;
    const next = !torchOn;
    track
      .applyConstraints({ advanced: [{ torch: next } as any] })
      .then(() => { if (mountedRef.current) setTorchOn(next); })
      .catch(() => {});
  }, [torchOn, torchSupported]);

  const switchCamera = useCallback(() => {
    setFacing((f) => (f === 'environment' ? 'user' : 'environment'));
  }, []);

  const retry = useCallback(() => {
    stopStream();
    setNonce((n) => n + 1);
  }, [stopStream]);

  return {
    videoRef,
    status,
    error,
    torchSupported,
    torchOn,
    toggleTorch,
    canSwitchCamera,
    facing,
    switchCamera,
    retry,
  };
}
