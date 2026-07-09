// RFC 6238 TOTP implementation using the Web Crypto API.
// No external dependencies — only crypto.subtle (available in all modern browsers).

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32decode(s: string): Uint8Array {
  const upper = s.toUpperCase().replace(/=+$/, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of upper) {
    const v = BASE32.indexOf(c);
    if (v === -1) continue;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

function b32encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

async function hotp(secret: string, counter: number): Promise<string> {
  const key = b32decode(secret);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, counter >>> 0, false);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buf));
  const offset = sig[19] & 0xf;
  const code =
    ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

export function generateTOTPSecret(): string {
  return b32encode(crypto.getRandomValues(new Uint8Array(20)));
}

export async function verifyTOTP(secret: string, code: string): Promise<boolean> {
  const t = Math.floor(Date.now() / 1000 / 30);
  for (const w of [-1, 0, 1]) {
    if ((await hotp(secret, t + w)) === code) return true;
  }
  return false;
}

export function makeTOTPUri(secret: string, email: string): string {
  return `otpauth://totp/VENTS:${encodeURIComponent(email)}?secret=${secret}&issuer=VENTS&algorithm=SHA1&digits=6&period=30`;
}
