import fs from 'fs'
import path from 'path'

function readUniApiVersion() {
  try {
    const content = fs.readFileSync(path.join(process.cwd(), '..', 'pyproject.toml'), 'utf-8')
    const match = content.match(/^version\s*=\s*"([^"]+)"/m)
    return match ? match[1] : 'unknown'
  } catch {
    return 'unknown'
  }
}

function readUniApiWebVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'))
    return pkg.version || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_UNI_API_VERSION: readUniApiVersion(),
    NEXT_PUBLIC_UNI_API_WEB_VERSION: readUniApiWebVersion(),
  },
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
