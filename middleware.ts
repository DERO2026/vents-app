import { NextRequest, NextResponse } from 'next/server';

// In-memory store for edge runtime (per-isolate, resets on cold start)
// For production at scale, replace with KV (Vercel KV / Upstash Redis)
const attempts = new Map<string, { count: number; windowStart: number }>();

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;

// Paths that count toward the rate limit
const RATE_LIMITED_PATHS = [
  '/api/auth/login',
  '/api/auth/signin',
  '/api/auth/token',
  '/api/auth/password-reset',
  '/api/auth/forgot',
];

function getIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isRateLimited = RATE_LIMITED_PATHS.some((p) => pathname.startsWith(p));
  if (!isRateLimited) return NextResponse.next();

  const ip = getIp(req);
  const key = `${ip}:${pathname}`;
  const now = Date.now();

  const entry = attempts.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return NextResponse.next();
  }

  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    return new NextResponse(
      JSON.stringify({ error: 'Too many requests. Please try again later.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(MAX_ATTEMPTS),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil((entry.windowStart + WINDOW_MS) / 1000)),
        },
      }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/auth/:path*'],
};
