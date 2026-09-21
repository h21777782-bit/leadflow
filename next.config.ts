import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Forms (server actions) check the Origin header. Behind a proxy such as
      // GitHub Codespaces the browser origin differs from localhost, so allow it.
      allowedOrigins: ["localhost:3000", "*.app.github.dev"],
    },
  },
};

export default nextConfig;
