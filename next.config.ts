import type { NextConfig } from 'next';

const apiUrl = (process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

/**
 * The browser talks to this site only. Every /v1/* request is forwarded to the API, so the
 * API's auth cookies are first-party here and no CORS is involved.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/v1/:path*', destination: `${apiUrl}/v1/:path*` },
      // Live updates (Socket.IO). Long-polling and WebSocket upgrades both go through here.
      // The API serves it at /socket.io without a trailing slash, so Next's slash redirect
      // never applies.
      { source: '/socket.io', destination: `${apiUrl}/socket.io` },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      // Nothing may frame the app, except the chat widget, whose allowed sites src/proxy.ts
      // sets per channel with frame-ancestors.
      {
        source: '/:path((?!widget/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
