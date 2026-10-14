import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: process.cwd(),
  },
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        {
          key: "Content-Security-Policy",
          value: "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
  // Lưu ý: `next build` bản thường đang dính bug upstream của Next.js 16.3 + React 19.2
  // khi prerender trang /_global-error ("Cannot read properties of null (reading
  // 'useContext')") — đã tái hiện trên scaffold hoàn toàn mới. Workaround hiện tại
  // nằm ở script "build" (--debug-prerender). Khi Next fix bug có thể bỏ cờ này.
};

export default nextConfig;
