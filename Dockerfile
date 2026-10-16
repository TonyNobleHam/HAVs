# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Optional trusted CA for development environments with an HTTPS proxy.
# The certificate is mounted only during installation and never enters the image.
RUN --mount=type=secret,id=npm_ca \
    if [ -s /run/secrets/npm_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm ci --no-audit --no-fund; \
    else \
      npm ci --no-audit --no-fund; \
    fi
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    HAVS_DATA_DIR=/app/data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node scripts/restore.mjs ./scripts/restore.mjs
COPY --chown=node:node src/domain.ts ./src/domain.ts
COPY --chown=node:node package.json ./package.json
RUN mkdir -p /app/data && chown node:node /app/data
USER node:node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node --input-type=module -e "const r = await fetch('http://127.0.0.1:3001/api/health', { signal: AbortSignal.timeout(4000) }); if (!r.ok) process.exit(1)"
CMD ["node", "--experimental-strip-types", "server/index.mjs"]
