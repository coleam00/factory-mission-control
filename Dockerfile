# Local mode (LOCAL-MODE.md): serves against a self-hosted Postgres, no Neon.
FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
RUN bunx vite build

FROM oven/bun:1.4.3-slim
ARG BUILD_ID=local
ENV NODE_ENV=production \
    MC_LIVE_MODE=local \
    MC_LISTEN_HOST=0.0.0.0 \
    PORT=8850 \
    FACTORY_RUNTIME_CANDIDATE=${BUILD_ID}
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app
USER bun
EXPOSE 8850
# The ingest loop runs from the same image: `bun scripts/local/ingest.ts`.
CMD ["bun", "scripts/local/serve.ts"]
