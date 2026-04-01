/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  transpilePackages: ['@agenthifive/contracts', '@agenthifive/security'],
  images: {
    unoptimized: true,
    remotePatterns: [
      { hostname: 'lh3.googleusercontent.com' },
      { hostname: 'avatars.githubusercontent.com' },
      { hostname: 'graph.microsoft.com' },
    ],
  },
  env: {
    // In dev: derive from auth OAuth env vars (fall back to connection vars for self-hosters).
    // In CD: set NEXT_PUBLIC_SOCIAL_* directly.
    NEXT_PUBLIC_SOCIAL_GOOGLE: process.env.NEXT_PUBLIC_SOCIAL_GOOGLE || ((process.env.AUTH_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID) ? '1' : ''),
    NEXT_PUBLIC_SOCIAL_MICROSOFT: process.env.NEXT_PUBLIC_SOCIAL_MICROSOFT || ((process.env.AUTH_MICROSOFT_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID) ? '1' : ''),
    NEXT_PUBLIC_SOCIAL_APPLE: process.env.NEXT_PUBLIC_SOCIAL_APPLE || (process.env.APPLE_CLIENT_ID ? '1' : ''),
    NEXT_PUBLIC_SOCIAL_FACEBOOK: process.env.NEXT_PUBLIC_SOCIAL_FACEBOOK || (process.env.FACEBOOK_CLIENT_ID ? '1' : ''),
  },
  // headers() removed — not supported with output:'export'.
  // Security headers now served by Nginx (infra/nginx/prod.conf.template).
  experimental: {
    // Default is 30s which kills long-poll requests (e.g. Telegram getUpdates).
    // Only applies to `next dev` rewrite proxy — production uses Nginx directly.
    proxyTimeout: 120_000,
  },

  // rewrites() is ignored by `next build` with output:'export' but still works
  // with `next dev` — keeps the dev experience intact (HMR + API proxying).
  async rewrites() {
    const apiUrl = process.env.API_INTERNAL_URL || 'http://localhost:4000';
    const docsUrl = process.env.DOCS_INTERNAL_URL;

    const rules = [
      { source: '/v1/:path*', destination: `${apiUrl}/v1/:path*` },
      { source: '/api/auth/:path*', destination: `${apiUrl}/api/auth/:path*` },
      { source: '/.well-known/:path*', destination: `${apiUrl}/.well-known/:path*` },
      { source: '/api/connections/callback', destination: `${apiUrl}/api/connections/callback` },
      { source: '/api/quick-action/:path*', destination: `${apiUrl}/api/quick-action/:path*` },
    ];

    if (docsUrl) {
      rules.push(
        { source: '/docs', destination: `${docsUrl}/docs/` },
        { source: '/docs/:path*', destination: `${docsUrl}/docs/:path*` },
      );
    }

    return rules;
  },
};

export default nextConfig;
