import { Capacitor } from '@capacitor/core';
import { askPermission, notifyPermissionDenied } from './permissionPrimer';

// Native "Take Photo / Choose from Library" action sheet instead of the
// web file-picker every image upload in the app used before, even inside
// the native build — a hidden <input type="file"> in a Capacitor WebView
// still opens the OS's generic document picker, not the camera-aware sheet
// a real app gets. Returns null on web (the caller falls back to its
// existing <input type="file">) or if the user cancels/denies permission —
// never throws, since "user backed out of the picker" isn't an error.
export async function pickImage(): Promise<File | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');

  // Explanatory sheet, shown once per device before the very first camera
  // prompt — skipped on every call after that (including this one, if the
  // user already saw it). dismissible:false per Apple's Oct 2026 rejection
  // of VENTS 1.0.2 (Guideline 5.1.1(iv)): this screen must not offer a
  // close/"Not now" action that avoids the real OS permission dialog --
  // "Continue" is the only button, and it leads straight into
  // Camera.getPhoto() below, which is what actually fires the system
  // prompt. The user's real "no" is the OS's own Don't Allow, handled in
  // the catch block below, not a custom screen standing in front of it.
  await askPermission('camera', {
    icon: 'camera',
    title: 'Allow Photo Access',
    message: 'VENTS uses your camera and photo library to let you add a profile picture, event cover, and share photos in chat.',
    dismissible: false,
  });

  try {
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Uri,
      source: CameraSource.Prompt,
      quality: 90,
      // Uploads here always go through their own crop/compress pipeline
      // afterward — no point asking the OS to also edit before handing back.
      allowEditing: false,
    });
    if (!photo.webPath) return null;
    const res = await fetch(photo.webPath);
    const blob = await res.blob();
    const ext = (photo.format || 'jpeg').replace('jpg', 'jpeg');
    return new File([blob], `photo.${ext === 'jpeg' ? 'jpg' : ext}`, { type: blob.type || `image/${ext}` });
  } catch {
    // Prompt dismissed, permission denied, or no camera/gallery available —
    // the caller's existing <input type="file"> web fallback still exists
    // for these cases too. Only nudge toward Settings if it's a real,
    // persistent denial (not just "user tapped Cancel" on the picker sheet).
    try {
      const perm = await Camera.checkPermissions();
      if (perm.camera === 'denied' || perm.photos === 'denied') {
        notifyPermissionDenied({
          icon: 'camera',
          title: 'Camera Access Denied',
          message: 'You previously denied camera/photo access. Open Settings to allow it, or continue using the file picker.',
        });
      }
    } catch { /* best-effort */ }
    return null;
  }
}
