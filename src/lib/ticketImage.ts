import QRCode from 'qrcode';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

function loadImage(src: string, crossOrigin?: 'anonymous'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Draws the VENTS wordmark (V + three purple bars for "E" + NTS) using pure
// canvas primitives — matches VentsLogo.tsx's proportions/colors. Canvas
// text, not an image asset, so it never depends on a network fetch.
function drawVentsWordmark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 ${size}px Space Grotesk, Inter, sans-serif`;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText('V', x, y);
  const vWidth = ctx.measureText('V').width;

  const barX = x + vWidth + size * 0.08;
  const barW = size * 0.5;
  const midBarW = size * 0.37;
  const barH = Math.max(3, size * 0.13);
  const gap = Math.max(2, size * 0.09);
  const barsTop = y - size * 0.72;
  ctx.fillStyle = '#A855F7';
  roundRect(ctx, barX, barsTop, barW, barH, barH / 2);
  ctx.fill();
  roundRect(ctx, barX, barsTop + barH + gap, midBarW, barH, barH / 2);
  ctx.fill();
  roundRect(ctx, barX, barsTop + (barH + gap) * 2, barW, barH, barH / 2);
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.fillText('NTS', barX + barW + size * 0.08, y);
  ctx.restore();
}

// Dashed perforation line with two circular cutout notches at the edges —
// the classic "tear here" ticket-stub divider between the event details and
// the QR code section.
function drawPerforation(ctx: CanvasRenderingContext2D, y: number, width: number, cardBg: string) {
  ctx.save();
  ctx.fillStyle = cardBg === 'transparent' ? '#07030F' : cardBg;
  ctx.beginPath(); ctx.arc(0, y, 14, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(width, y, 14, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(30, y);
  ctx.lineTo(width - 30, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  const words = text.split(' ');
  let line = '';
  let curY = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, curY);
      line = word;
      curY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, curY);
}

export interface TicketImageParams {
  title: string;
  dateTimeLabel: string;
  venue: string;
  ticketTypeLabel: string;
  holderName: string;
  referenceNumber: string;
  /** Signed v2 pass token — only ever rendered as the QR image, never as text. */
  signedToken: string | null;
  /** Event flyer/cover image URL, if available — purely decorative (a banner
   *  strip at the top). Best-effort: a failed load never blocks the rest of
   *  the ticket from rendering. */
  eventImage?: string | null;
  /** Organizer display name — shown as "Hosted by {organizer}" if present. */
  organizer?: string | null;
}

// Renders a real, self-contained VENTS-branded ticket image (wordmark, event
// flyer banner, organizer, date/venue, ticket type, holder, and the actual
// scannable QR behind a ticket-stub perforation) as a PNG blob — shared by
// every "Save Ticket" entry point so the download is always a proper ticket,
// never a bare QR/text receipt.
//
// Security boundary, unchanged: the QR is the ONLY thing derived from
// params.signedToken. Every other field here (title, holder name, reference
// number, organizer, etc.) is display-only, sourced from the same data
// already shown on-screen -- none of it is read back by verify_entry_pass()
// server-side, which only ever trusts the signed token it decodes from the
// scanned QR. Nothing added here changes that: the visible fields still
// can't become a credential, and the signed token is still never rendered
// as text anywhere on the image.
export async function renderTicketImage(params: TicketImageParams): Promise<Blob | null> {
  const width = 600;
  const BANNER_H = 170;
  const height = 1050;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const cardGradientTop = '#07030F';
  const bg = ctx.createLinearGradient(0, BANNER_H, width, height);
  bg.addColorStop(0, cardGradientTop);
  bg.addColorStop(1, '#0C0616');
  ctx.fillStyle = bg;
  ctx.fillRect(0, BANNER_H, width, height - BANNER_H);

  // Event flyer banner, purely decorative -- a failed/slow load (CORS,
  // network) must never block the rest of the ticket, which is why this is
  // wrapped separately and falls back to a plain brand-gradient strip.
  let bannerDrawn = false;
  if (params.eventImage) {
    try {
      const bannerImg = await loadImage(params.eventImage, 'anonymous');
      const scale = Math.max(width / bannerImg.width, BANNER_H / bannerImg.height);
      const sw = width / scale, sh = BANNER_H / scale;
      const sx = (bannerImg.width - sw) / 2, sy = (bannerImg.height - sh) / 2;
      ctx.drawImage(bannerImg, sx, sy, sw, sh, 0, 0, width, BANNER_H);
      const shade = ctx.createLinearGradient(0, 0, 0, BANNER_H);
      shade.addColorStop(0, 'rgba(0,0,0,0.15)');
      shade.addColorStop(1, 'rgba(7,3,15,0.95)');
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, width, BANNER_H);
      bannerDrawn = true;
    } catch (err) {
      console.warn('[VENTS] renderTicketImage: event banner failed to load — using fallback', err);
    }
  }
  if (!bannerDrawn) {
    const bannerBg = ctx.createLinearGradient(0, 0, width, BANNER_H);
    bannerBg.addColorStop(0, '#3B1466');
    bannerBg.addColorStop(1, '#0C0616');
    ctx.fillStyle = bannerBg;
    ctx.fillRect(0, 0, width, BANNER_H);
  }

  // VENTS wordmark, top-left, over the banner -- small dark badge behind it
  // so it stays legible over any flyer image.
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  roundRect(ctx, 20, 18, 108, 40, 10);
  ctx.fill();
  drawVentsWordmark(ctx, 32, 44, 24);

  let y = BANNER_H + 55;
  ctx.fillStyle = '#F0F0FF';
  ctx.font = 'bold 28px Inter, sans-serif';
  wrapText(ctx, params.title, 40, y, width - 80, 34);
  y += params.title.length > 34 ? 68 : 34; // room for a second wrapped line on long titles

  if (params.organizer) {
    y += 34;
    ctx.fillStyle = '#A855F7';
    ctx.font = '600 13px Inter, sans-serif';
    ctx.fillText(`Hosted by ${params.organizer}`, 40, y);
  }

  y += 34;
  ctx.fillStyle = '#8B8FA8';
  ctx.font = '16px Inter, sans-serif';
  ctx.fillText(params.dateTimeLabel, 40, y);
  y += 28;
  ctx.fillText(params.venue, 40, y);

  y += 38;
  ctx.fillStyle = '#FFB830';
  ctx.font = 'bold 14px Inter, sans-serif';
  ctx.fillText(params.ticketTypeLabel.toUpperCase(), 40, y);

  y += 34;
  ctx.fillStyle = '#8B8FA8';
  ctx.font = '13px Inter, sans-serif';
  ctx.fillText(`Holder: ${params.holderName}`, 40, y);
  y += 22;
  ctx.fillText(`Ticket Reference No.: ${params.referenceNumber}`, 40, y);

  y += 38;
  drawPerforation(ctx, y, width, cardGradientTop);

  if (params.signedToken) {
    const qrDataUrl = await QRCode.toDataURL(params.signedToken, {
      width: 440,
      margin: 3,
      errorCorrectionLevel: 'L',
      color: { dark: '#0A0B14', light: '#ffffff' },
    });
    const qrImg = await loadImage(qrDataUrl);
    const qrX = (width - 440) / 2;
    const qrY = y + 40;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, qrX - 16, qrY - 16, 440 + 32, 440 + 32, 16);
    ctx.fill();
    ctx.drawImage(qrImg, qrX, qrY, 440, 440);

    ctx.fillStyle = '#22D3EE';
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Show this QR code at the entrance', width / 2, qrY + 440 + 40);
    ctx.font = '11px Inter, sans-serif';
    ctx.fillStyle = '#555C7A';
    ctx.fillText('VENTS · getvents.com', width / 2, qrY + 440 + 66);
    ctx.textAlign = 'left';
  } else {
    ctx.fillStyle = '#8B8FA8';
    ctx.font = '14px Inter, sans-serif';
    ctx.fillText('Connect to the internet once to activate this ticket.', 40, y + 60);
  }

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // FileReader gives a data: URL — Filesystem.writeFile wants the raw
      // base64 payload only.
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // @capacitor-community/media's savePhoto wants the full data: URL
    // (unlike Filesystem.writeFile above, which wants the base64 payload
    // with the prefix stripped) — kept as a separate helper rather than
    // re-deriving one from the other.
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Android's savePhoto requires an albumIdentifier (iOS doesn't) — resolved
// once per app session and cached, rather than a getAlbums()+createAlbum()
// round trip on every save.
let ventsAlbumId: string | null | undefined;
async function getVentsAlbumId(): Promise<string | null> {
  if (ventsAlbumId !== undefined) return ventsAlbumId;
  if (Capacitor.getPlatform() !== 'android') {
    ventsAlbumId = null;
    return ventsAlbumId;
  }
  const { Media } = await import('@capacitor-community/media');
  const { albums } = await Media.getAlbums();
  const existing = albums.find((a) => a.name === 'VENTS');
  if (existing) {
    ventsAlbumId = existing.identifier;
  } else {
    await Media.createAlbum({ name: 'VENTS' });
    const { albums: after } = await Media.getAlbums();
    ventsAlbumId = after.find((a) => a.name === 'VENTS')?.identifier ?? null;
  }
  return ventsAlbumId;
}

export type SaveTicketResult = 'saved' | 'permission_denied' | 'failed';

// Silently saves the ticket image straight to the device's Photos/Gallery —
// no share sheet, no browser download bar. This is the "Save Ticket"
// button's action; downloadBlob() below (cache write + native share sheet)
// remains the "Share Ticket" action for when the user actually wants to
// send the image somewhere. @capacitor-community/media's savePhoto handles
// the platform permission prompt itself (throws error.code='accessDenied'
// on refusal) — no separate requestPermissions() call needed. Falls back to
// the browser save-as flow on web, same as downloadBlob().
export async function saveTicketToGallery(blob: Blob, filename: string): Promise<SaveTicketResult> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Media } = await import('@capacitor-community/media');
      const dataUrl = await blobToDataUrl(blob);
      const albumIdentifier = await getVentsAlbumId();
      await Media.savePhoto({
        path: dataUrl,
        albumIdentifier: albumIdentifier ?? undefined,
        fileName: filename.replace(/\.png$/i, ''),
      });
      return 'saved';
    } catch (err: any) {
      if (err?.code === 'accessDenied') return 'permission_denied';
      console.error('Native gallery save failed:', err);
      return 'failed';
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return 'saved';
  } catch (err) {
    console.error('Ticket download failed:', err);
    return 'failed';
  }
}

// `<a download>` is a browser-only mechanism — inside a Capacitor WebView
// (iOS/Android) it silently does nothing, so a native user would see a
// "Saved!" confirmation for a file that never actually saved anywhere.
// On native, write the image to cache and hand it to the OS share sheet
// (the standard way an installed app lets a user save-to-Photos or share
// a generated file, since neither platform allows a WebView to write
// straight into the system Photos/Downloads location on its own).
// Returns whether the save/share genuinely happened — callers should only
// show a success message when this resolves true.
export async function downloadBlob(blob: Blob, filename: string): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      const base64Data = await blobToBase64(blob);
      const written = await Filesystem.writeFile({
        path: filename,
        data: base64Data,
        directory: Directory.Cache,
      });
      await Share.share({
        title: 'Save Ticket',
        url: written.uri,
        dialogTitle: 'Save or share your ticket',
      });
      return true;
    } catch (err) {
      console.error('Native ticket save/share failed:', err);
      return false;
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch (err) {
    console.error('Ticket download failed:', err);
    return false;
  }
}
