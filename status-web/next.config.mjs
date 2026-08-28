/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the site is served by the Rust `status` module inside the
  // uni-api process (see rust/uni-api-native/src/bin/uni-api-front/status.rs).
  output: 'export',
  // API requests are relative to the same origin, no rewrites needed.
  trailingSlash: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
}

export default nextConfig
