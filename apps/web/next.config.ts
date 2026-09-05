import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Inline the two public values into every bundle at build time. Server code otherwise reads
  // process.env at request time, and hosted functions do not load .env.production at runtime.
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    NEXT_PUBLIC_PIPELINE_VERSION: process.env.NEXT_PUBLIC_PIPELINE_VERSION ?? '1',
  },
  transpilePackages: ['@viladomat/core'],
  typedRoutes: true,
  poweredByHeader: false,
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ],
    },
  ],
};

export default nextConfig;
