# syntax=docker/dockerfile:1
# Multi-stage build for boite-server. Builds natively for the host arch
# (tested on linux/arm64, Orange Pi). Stages: SvelteKit SPA, Rust server,
# rtk (token killer) build, slim runtime with the full agent + opti toolchain
# (git, ripgrep, node, claude/codex/opencode, rtk, semble, ccusage, axi, gh,
# headful stealth chromium).

# ---- Frontend: SvelteKit SPA (adapter-static) -> /app/build ----
FROM oven/bun:1 AS web
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install && bun run build

# ---- Server: cargo build -p boite-server (boite-core only, not src-tauri) ----
FROM rust:1-bookworm AS server
WORKDIR /app
COPY . .
# Cache the cargo registry/git and the target dir across builds: a source-only
# change then recompiles just the changed crates instead of every dependency
# (the slow part on arm64). target/ is an ephemeral cache mount and is NOT kept
# in the layer, so copy the binary out within the same RUN.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo build -p boite-server --release \
    && cp target/release/boite-server /boite-server

# ---- rtk (Rust Token Killer): pinned to the same commit as the author's host ----
# No prebuilt arm64 release exists; build from the exact git rev (rtk-ai/rtk).
FROM rust:1-bookworm AS rtk
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo install --git https://github.com/rtk-ai/rtk \
      --rev d8c550eefba41e112bd174d58844a803db6e432f rtk --root /usr/local

# ---- Runtime ----
# node base gives node + npm for the npm-distributed agents; tini reaps PTY
# zombies (every spawned shell/agent is a child); git + ripgrep are what the
# PTY and explorer shell out to; chromium + xvfb give axi a headful browser.
FROM node:22-bookworm-slim

# Base tools + gh (GitHub CLI, arm64 from official apt repo) + headful browser.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git ripgrep tini ca-certificates bash curl gnupg procps \
       chromium xvfb fonts-liberation fonts-noto-color-emoji \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Agent CLIs + analytics + browser-automation CLI (all npm global).
RUN npm install -g \
       @anthropic-ai/claude-code \
       @openai/codex \
       opencode-ai \
       ccusage \
       chrome-devtools-axi \
       chrome-devtools-mcp \
  && npm cache clean --force

# uv + semble (semantic code search). uv tools land in /root/.local/bin; symlink
# the entrypoints into /usr/local/bin so every PTY shell sees them on PATH.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
  && /root/.local/bin/uv tool install semble \
  && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
  && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx \
  && ln -sf /root/.local/bin/semble /usr/local/bin/semble

# rtk (token killer) from the build stage.
COPY --from=rtk /usr/local/bin/rtk /usr/local/bin/rtk

# Headful stealth chromium launcher + entrypoint that boots Xvfb + chromium
# (CDP on 127.0.0.1:9222 for axi) before handing off to the server.
COPY docker/stealth-chromium /usr/local/bin/stealth-chromium
COPY docker/boite-entry /usr/local/bin/boite-entry
RUN chmod +x /usr/local/bin/stealth-chromium /usr/local/bin/boite-entry

WORKDIR /app
COPY --from=server /boite-server /usr/local/bin/boite-server
COPY --from=web /app/build /app/web

ENV BOITE_BIND=0.0.0.0:7337 \
    BOITE_DATA_DIR=/data \
    BOITE_STATIC_DIR=/app/web \
    BOITE_WORKSPACE_DIR=/workspace \
    PATH=/root/.local/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin \
    DISPLAY=:99 \
    CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9222 \
    CHROME_DEVTOOLS_AXI_MCP_PATH=/usr/local/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js

# /data: SQLite DB + generated token. /workspace: the repos boite operates on.
# /root/.claude: claude credentials + sessions (mount to persist OAuth login).
# Codex/opencode configs are mounted from the host compose dir (see compose).
VOLUME ["/data", "/workspace", "/root/.claude"]
EXPOSE 7337

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["boite-entry"]
