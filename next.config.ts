import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['212.87.221.55:3000', '212.87.221.55', 'localhost:3000', '127.0.0.1:3000'],
  // Increase body size limit for file uploads (default is 1MB, we need 50MB for encrypted payloads)
  serverExternalPackages: [],
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
      allowedOrigins: ['212.87.221.55:3000', '212.87.221.55', 'localhost:3000', '127.0.0.1:3000'],
    },
  },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
