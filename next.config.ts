import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Increase body size limit for file uploads (default is 1MB, we need 50MB for encrypted payloads)
  serverExternalPackages: [],
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
