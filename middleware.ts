// NOTE: Vercel Edge Middleware only runs for Next.js projects.
// This file is a placeholder documenting the rate-limiting intent — it is
// NOT executed at runtime for this Vite SPA. Real rate limiting is enforced
// server-side via Supabase RPCs (check_auth_rate_limit(), called from
// AuthScreen.tsx's checkAuthRateLimit(); check_rate_limit(), called from
// api/_lib/verifyAuth.ts's enforceRateLimit()), not by this file.
// When migrating to Next.js, implement this middleware:
//
// import { NextRequest, NextResponse } from 'next/server';
// const attempts = new Map<string, { count: number; windowStart: number }>();
// const WINDOW_MS = 15 * 60 * 1000;
// const MAX_ATTEMPTS = 10;
// export function middleware(req: NextRequest) {
//   const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
//   const key = `${ip}:${req.nextUrl.pathname}`;
//   const now = Date.now();
//   const entry = attempts.get(key);
//   if (!entry || now - entry.windowStart > WINDOW_MS) {
//     attempts.set(key, { count: 1, windowStart: now });
//     return NextResponse.next();
//   }
//   entry.count++;
//   if (entry.count > MAX_ATTEMPTS) {
//     return new NextResponse(JSON.stringify({ error: 'Too many requests.' }), {
//       status: 429,
//       headers: { 'Content-Type': 'application/json', 'Retry-After': '900' },
//     });
//   }
//   return NextResponse.next();
// }
// export const config = { matcher: ['/api/auth/:path*'] };
export {};
