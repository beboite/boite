# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY apps/shell/package.json apps/shell/package.json
RUN bun install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/core packages/core
COPY packages/ui packages/ui
ARG BOITE_VERSION
RUN if [ -n "$BOITE_VERSION" ]; then bun -e 'const v=process.env.BOITE_VERSION; if (!/^\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/.test(v)) throw Error("invalid nightly version"); const p="packages/core/package.json"; const j=await Bun.file(p).json(); j.version=v; await Bun.write(p,JSON.stringify(j));'; fi
RUN bun run build:ui && bun run build:core

FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS agents
COPY docker/agents/package.json docker/agents/package-lock.json /opt/agents/
RUN cd /opt/agents && npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime
ARG BOITE_CHANNEL=stable
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git ripgrep tini bash \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /workspace /home/node/.local/bin \
    && chown -R node:node /data /workspace /home/node
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
COPY --from=agents /opt/agents /opt/agents
COPY --from=build /app/packages/core/dist /app/packages/core/dist
COPY --from=build /app/packages/ui/dist /app/packages/ui/dist
COPY packages/core/src/providers/shipped/echo-login.ts /app/packages/core/dist/shipped/echo-login.ts
COPY docker/boite-server /usr/local/bin/boite-server
COPY docker/healthcheck.ts /app/healthcheck.ts
COPY LICENSE /app/LICENSE
RUN chmod +x /usr/local/bin/boite-server
ENV NODE_ENV=production \
    BOITE_CHANNEL=${BOITE_CHANNEL} \
    BOITE_DATA_DIR=/data \
    HOME=/home/node \
    PATH=/opt/agents/node_modules/.bin:/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin
LABEL org.opencontainers.image.title="boite-server" \
      org.opencontainers.image.description="Self-hosted coding agent manager with a web UI" \
      org.opencontainers.image.source="https://github.com/beboite/boite" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /workspace
USER node
EXPOSE 7337
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["bun", "/app/healthcheck.ts"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "boite-server"]
CMD ["--host", "0.0.0.0", "--port", "7337"]
