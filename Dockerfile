FROM lukemathwalker/cargo-chef:0.1.71-rust-1.84-bullseye@sha256:e372d5aae4166598a5e4ce08c0eb75af0e7ec909d7e19188ebf669d79fa62355 AS chef
WORKDIR /workspace
COPY rust/uni-api-native/Cargo.toml rust/uni-api-native/Cargo.lock ./rust/uni-api-native/
COPY rust/uni-api-native/.cargo ./rust/uni-api-native/.cargo
# build.rs 读取 webui/package.json 注入 UNI_API_WEB_VERSION，cook 阶段即需要
COPY webui/package.json ./webui/package.json
RUN mkdir -p rust/uni-api-native/src/bin/uni-api-front && printf 'fn main() {}\n' > rust/uni-api-native/src/bin/uni-api-front/main.rs && cd rust/uni-api-native && cargo chef prepare --recipe-path recipe.json
FROM chef AS planner
RUN cd rust/uni-api-native && cargo chef cook --release --locked --recipe-path recipe.json
FROM planner AS builder
COPY README.md ./README.md
COPY static ./static
COPY uni_api/api/codex_models_pro_0_153_2.json ./uni_api/api/codex_models_pro_0_153_2.json
COPY webui/package.json ./webui/package.json
COPY rust/uni-api-native ./rust/uni-api-native
WORKDIR /workspace/rust/uni-api-native
RUN cargo build --release --locked && cp target/release/uni-api-front /tmp/uni-api-front

# 前端面板（Next.js 静态导出），产物由 Rust 侧 status 模块托管
FROM node:22-bookworm-slim AS status-builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /build
COPY webui/package.json webui/pnpm-lock.yaml ./
RUN pnpm fetch
COPY webui ./
# 面板页头要显示后端版本号：next.config.mjs 会按仓库布局读 ../rust/uni-api-native/Cargo.toml，
# 故此阶段把该文件放到同一相对位置（否则会显示 unknown）
COPY rust/uni-api-native/Cargo.toml /rust/uni-api-native/Cargo.toml
# next/font 会去 fonts.googleapis.com 取 Inter：pnpm 需要代理，但代理到不了 Google Fonts
# （实测经 10.0.0.10:9132 取 fonts.googleapis.com 直接 ECONNRESET），故构建时临时摘掉代理走直连。
RUN pnpm install --offline --frozen-lockfile && \
    env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
        pnpm exec next build && \
    cp -r out /tmp/status-out

FROM debian:bookworm-slim
ARG SOURCE_COMMIT=unknown
ENV SOURCE_COMMIT=${SOURCE_COMMIT} \
    UNI_API_RUNTIME=rust \
    MALLOC_ARENA_MAX=2 \
    MALLOC_MMAP_THRESHOLD_=131072 \
    MALLOC_TRIM_THRESHOLD_=131072
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*
EXPOSE 8000
WORKDIR /home
COPY --from=builder /tmp/uni-api-front /usr/local/bin/uni-api-front
COPY --from=status-builder /tmp/status-out /home/status
ENTRYPOINT ["/usr/local/bin/uni-api-front"]
