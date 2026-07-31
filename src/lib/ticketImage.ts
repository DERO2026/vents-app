import QRCode from 'qrcode';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
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
}

// Renders a real, self-contained ticket image (title, date/venue, ticket
// type, and the actual scannable QR) as a PNG blob — shared by every
// "Save Ticket" entry point so the download is always a usable image, never
// a bare text/receipt file.
export async function renderTicketImage(params: TicketImageParams): Promise<Blob | null> {
  const width = 600;
  const height = 900;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#07030F');
  bg.addColorStop(1, '#0C0616');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#F0F0FF';
  ctx.font = 'bold 28px Inter, sans-serif';
  wrapText(ctx, params.title, 40, 70, width - 80, 34);

  ctx.fillStyle = '#8B8FA8';
  ctx.font = '16px Inter, sans-serif';
  ctx.fillText(params.dateTimeLabel, 40, 150);
  ctx.fillText(params.venue, 40, 178);

  ctx.fillStyle = '#FFB830';
  ctx.font = 'bold 14px Inter, sans-serif';
  ctx.fillText(params.ticketTypeLabel.toUpperCase(), 40, 216);

  ctx.fillStyle = '#8B8FA8';
  ctx.font = '13px Inter, sans-serif';
  ctx.fillText(`Holder: ${params.holderName}`, 40, 250);
  ctx.fillText(`Ticket Reference No.: ${params.referenceNumber}`, 40, 272);

  if (params.signedToken) {
    const qrDataUrl = await QRCode.toDataURL(params.signedToken, {
      width: 440,
      margin: 3,
      errorCorrectionLevel: 'L',
      color: { dark: '#0A0B14', light: '#ffffff' },
    });
    const qrImg = await loadImage(qrDataUrl);
    const qrX = (width - 440) / 2;
    const qrY = 300;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, qrX - 16, qrY - 16, 440 + 32, 440 + 32, 16);
    ctx.fill();
    ctx.drawImage(qrImg, qrX, qrY, 440, 440);

    ctx.fillStyle = '#22D3EE';
    ctx.font = '13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Show this QR code at the entrance', width / 2, qrY + 440 + 40);
    ctx.textAlign = 'left';
  } else {
    ctx.fillStyle = '#8B8FA8';
    ctx.font = '14px Inter, sans-serif';
    ctx.fillText('Connect to the internet once to activate this ticket.', 40, 320);
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
