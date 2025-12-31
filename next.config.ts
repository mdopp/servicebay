import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
