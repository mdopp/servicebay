import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['socket.io', 'node-pty'],
  async redirects() {
    return [
      {
        source: '/',
        destination: '/services',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
