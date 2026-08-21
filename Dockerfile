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
# Same compile-time URL as the desktop release (`option_env!`). Empty, which is
# a local `docker compose build` without the arg, compiles against
# https://telemetry.invalid and the host sends nothing. image.yml injects the
# repository secret.
ARG BOITE_TELEMETRY_URL=
ENV BOITE_TELEMETRY_URL=$BOITE_TELEMETRY_URL
# Cache the cargo registry/git and the target dir across builds: a source-only
# change then recompiles just the changed crates instead of every dependency
# (the slow part on arm64). target/ is an ephemeral cache mount and is NOT kept
# in the layer, so copy the binary out within the same RUN.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    cargo build -p boite-server -p boite-mcp --release \
    && cp target/release/boite-server /boite-server \
    && cp target/release/boite-mcp /boite-mcp

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
FROM node:26-bookworm-slim

# This stage runs as root, and the image ships that way. It is worth saying why
# rather than leaving it to look like nobody thought about it: everything in
# here — the npm globals, the agent CLIs, the chromium profile, the mounted
# credentials — lives under /root, and every deployment that already pulled this
# image has host directories owned by root behind /data and /workspace. A `USER`
# line added now breaks each of them on the next `docker compose pull`, silently,
# at the first write.
#
# It is still the right change: the process in here runs whatever an agent
# decides to run, and root in the container is one fewer boundary between that
# and the host. Doing it properly means a non-root user, an entrypoint that
# chowns the volumes while it still can and drops privileges before exec, and a
# note in the release that says so. That is its own change, not a line in this
# one.

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
COPY --from=server /boite-mcp /usr/local/bin/boite-mcp
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

# `restart: unless-stopped` in the compose file restarts a container that exits.
# A server that is up and answering nothing exits never, and that is the failure
# an agent host actually has: the process lives, the port listens, and every
# request hangs. Without this the restart policy covers the one case that
# already fixes itself and none of the case it was written for.
#
# /api/health is the one route that answers before pairing, which is what makes
# it usable from here: a check that needed a credential would report a healthy
# server unhealthy the moment the token rotated.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7337/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["boite-entry"]
