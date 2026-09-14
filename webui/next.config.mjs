import fs from 'fs'
import path from 'path'

function readCargoVersion() {
  // 上游 1.7.276 起仓库转为纯 Rust，后端版本号来源是 rust crate 的 Cargo.toml。
  // 依次尝试几种相对位置：本地仓库布局、Docker 构建阶段布局，均失败则回落 unknown。
  const candidates = [
    path.join(process.cwd(), '..', 'rust', 'uni-api-native', 'Cargo.toml'),
    path.join(process.cwd(), 'rust', 'uni-api-native', 'Cargo.toml'),
    path.join(process.cwd(), '..', '..', 'rust', 'uni-api-native', 'Cargo.toml'),
  ]
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, 'utf-8')
      const match = content.match(/^version\s*=\s*"([^"]+)"/m)
      if (match) return match[1]
    } catch {
      // 继续尝试下一个候选路径
    }
  }
  return 'unknown'
}

function readUniApiVersion() {
  return process.env.NEXT_PUBLIC_UNI_API_VERSION || readCargoVersion()
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
