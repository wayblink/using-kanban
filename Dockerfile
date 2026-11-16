# -- build -------------------------------------------------------------------
# The full Debian image is the builder on purpose: better-sqlite3 is a native
# addon and node:22-slim has no python/make/g++.
ARG NODE_IMAGE=node:22-bookworm
ARG NODE_RUNTIME_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Registries differ by network: defaults are the public ones; a mirror can be
# passed with --build-arg without editing this file.
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry "$NPM_REGISTRY" \
 && npm install -g pnpm@10.32.1 \
 && pnpm config set registry "$NPM_REGISTRY"
# Compile native addons in the builder instead of asking prebuild-install for a
# GitHub release: the builder image already has python/make/g++, and restricted
# networks often cannot reach github.com at build time.
ENV npm_config_build_from_source=true \
    npm_config_nodedir=/usr/local
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
 && pnpm -r build \
 && pnpm --filter @wayblink/using-kanban-cli deploy --prod --legacy /runtime \
 && cp -r packages/web/dist /runtime/web

# -- runtime -----------------------------------------------------------------
FROM ${NODE_RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production

WORKDIR /app
COPY --from=build /runtime /app
COPY docker/entrypoint.sh /usr/local/bin/ukb-entrypoint
COPY docker/backup.mjs /app/backup.mjs
# `pnpm deploy` of the CLI target does not link the package's own bin, so make
# the wrapper explicit: `docker compose run ukb user add …` must work.
RUN chmod 0755 /usr/local/bin/ukb-entrypoint /app/backup.mjs \
 && printf '#!/bin/sh\nexec node /app/dist/bin.js "$@"\n' > /usr/local/bin/ukb \
 && chmod 0755 /usr/local/bin/ukb \
 && mkdir -p /data \
 && chown -R node:node /data

ENV PATH=/app/node_modules/.bin:$PATH \
    UKB_HOST=0.0.0.0 \
    UKB_PORT=8787 \
    UKB_DIR=/data \
    UKB_UI=/app/web

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.UKB_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["ukb-entrypoint"]
