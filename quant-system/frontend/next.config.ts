import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000",
  },
  outputFileTracingIncludes: {
    "/*": ["./deploy-data/**/*"],
    "/api/*": ["./deploy-data/**/*"],
  },
};

export default nextConfig;
