import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const res = NextResponse.next();

  // Security headers
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-XSS-Protection', '1; mode=block');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'camera=(), geolocation=()');
  res.headers.set('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: stun.l.google.com:19302 stun1.l.google.com:19302; frame-ancestors *;");

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
