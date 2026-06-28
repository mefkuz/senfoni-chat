import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    'senfoni.mefkuz.com',
    '*.mefkuz.com',
    '*.ngrok-free.dev',
    '*.ngrok-free.app',
    '*.trycloudflare.com',
    'localhost:3000',
    '127.0.0.1:3000',
    'localhost',
    '127.0.0.1'
  ],
  // Increase body size limit for file uploads (default is 1MB, we need 50MB for encrypted payloads)
  serverExternalPackages: [],
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
      allowedOrigins: [
        'senfoni.mefkuz.com',
        '*.mefkuz.com',
        '*.ngrok-free.dev',
        '*.ngrok-free.app',
        '*.trycloudflare.com',
        'localhost:3000',
        '127.0.0.1:3000',
        'localhost',
        '127.0.0.1'
      ],
    },
  },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;

