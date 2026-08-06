import { Capacitor } from '@capacitor/core';

// Native "Take Photo / Choose from Library" action sheet instead of the
// web file-picker every image upload in the app used before, even inside
// the native build — a hidden <input type="file"> in a Capacitor WebView
// still opens the OS's generic document picker, not the camera-aware sheet
// a real app gets. Returns null on web (the caller falls back to its
// existing <input type="file">) or if the user cancels/denies permission —
// never throws, since "user backed out of the picker" isn't an error.
export async function pickImage(): Promise<File | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
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
    // for these cases too, but on native there's nothing further to offer.
    return null;
  }
}
