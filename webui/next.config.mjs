/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev mode: API routes are handled by Next.js route handlers.
  // Production: static export served by the Rust `status` module inside the
  // uni-api process (see rust/uni-api-native/src/bin/uni-api-front/status.rs).
  ...(process.env.NODE_ENV === 'production' ? { output: 'export' } : {}),
  trailingSlash: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
}

export default nextConfig
