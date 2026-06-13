# syntax=docker/dockerfile:1
# Multi-stage build for boite-server. Builds natively for the host arch
# (tested on linux/arm64, Orange Pi). Three stages: SvelteKit SPA, Rust server,
# slim runtime with the agent toolchain (git, ripgrep, node, claude-code).

# ---- Frontend: SvelteKit SPA (adapter-static) -> /app/build ----
FROM oven/bun:1 AS web
WORKDIR /app
COPY . .
RUN bun install && bun run build

# ---- Server: cargo build -p boite-server (boite-core only, not src-tauri) ----
FROM rust:1-bookworm AS server
WORKDIR /app
COPY . .
RUN cargo build -p boite-server --release

# ---- Runtime ----
# node base gives node + npm for claude-code; tini reaps PTY zombies (critical:
# every spawned shell/agent is a child process), git + ripgrep are what the
# PTY and explorer shell out to.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git ripgrep tini ca-certificates bash \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code \
  && npm cache clean --force

WORKDIR /app
COPY --from=server /app/target/release/boite-server /usr/local/bin/boite-server
COPY --from=web /app/build /app/web

ENV BOITE_BIND=0.0.0.0:7337 \
    BOITE_DATA_DIR=/data \
    BOITE_STATIC_DIR=/app/web \
    BOITE_WORKSPACE_DIR=/workspace

# /data: SQLite DB + generated token. /workspace: the repos boite operates on.
# /root/.claude: claude credentials + sessions (mount to persist OAuth login).
VOLUME ["/data", "/workspace", "/root/.claude"]
EXPOSE 7337

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["boite-server"]
