import fs from 'fs'
import path from 'path'

function readUniApiVersion() {
  if (process.env.NEXT_PUBLIC_UNI_API_VERSION) return process.env.NEXT_PUBLIC_UNI_API_VERSION
  // 产品版本单一来源：仓库根 VERSION（1.7.x，与上游 tag 对齐）。
  // 兼容几种相对位置：本地仓库布局、Docker 构建阶段布局、上两级。
  const candidates = [
    path.join(process.cwd(), '..', 'VERSION'),
    path.join(process.cwd(), 'VERSION'),
    path.join(process.cwd(), '..', '..', 'VERSION'),
  ]
  for (const candidate of candidates) {
    try {
      const value = fs.readFileSync(candidate, 'utf-8').trim()
      if (value) return value
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return 'unknown'
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
