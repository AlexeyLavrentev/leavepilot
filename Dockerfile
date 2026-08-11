FROM node:22-bookworm-slim AS base

WORKDIR /app

FROM base AS deps

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

ENV CHROMEDRIVER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    # sqlite3 6 prebuilt-бинари собраны под glibc 2.38 (Ubuntu 24.04), а Debian
    # bookworm — glibc 2.36. Собираем нативные модули из исходников под локальный glibc.
    npm_config_build_from_source=true

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY scss ./scss
COPY public ./public
RUN npm run compile-sass

FROM deps AS development

ENV NODE_ENV=development

FROM base AS runtime

ENV NODE_ENV=production

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --create-home appuser

LABEL org.opencontainers.image.source="https://github.com/AlexeyLavrentev/timeoff" \
      org.opencontainers.image.description="LeavePilot Community — open-source leave management system" \
      org.opencontainers.image.licenses="Elastic-2.0"

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev \
  && npm cache clean --force

COPY --chown=appuser:nodejs app.js ./
COPY --chown=appuser:nodejs bin ./bin
COPY --chown=appuser:nodejs config ./config
COPY --chown=appuser:nodejs docker ./docker
COPY --chown=appuser:nodejs lib ./lib
COPY --chown=appuser:nodejs locales ./locales
COPY --chown=appuser:nodejs migrations ./migrations
COPY --chown=appuser:nodejs views ./views
COPY --from=build --chown=appuser:nodejs /app/public ./public
COPY --chown=appuser:nodejs LICENSE.md NOTICE ./
RUN chmod +x /app/docker/*.sh \
  && chown appuser:nodejs /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/', (res) => { process.exit(res.statusCode >= 200 && res.statusCode < 500 ? 0 : 1); }).on('error', () => process.exit(1))"]

CMD ["/bin/sh", "./docker/entrypoint.sh"]

FROM runtime AS commercial

USER root

ENV TIMEOFF_EDITION=commercial

RUN touch /app/.timeoff-commercial \
  && chown appuser:nodejs /app/.timeoff-commercial

ARG PREMIUM_MODULE_TARGET=/opt/timeoff-premium
COPY --from=timeoff_premium --chown=appuser:nodejs . ${PREMIUM_MODULE_TARGET}

# Premium owns its runtime dependencies. Keep them inside the module so normal
# Node resolution works without leaking private dependencies into Community.
RUN cd "${PREMIUM_MODULE_TARGET}" && \
    npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund

# Install SSO packages into a temp dir (no package.json = no devDeps bleed),
# then merge into the app's node_modules.
RUN mkdir -p /tmp/sso-deps && \
    cd /tmp/sso-deps && \
    npm install --no-package-lock --no-audit --no-fund \
      @node-saml/node-saml@5.1.0 \
      openid-client@5.7.1 \
      pdfkit@0.16.0 && \
    cp -a node_modules/. /app/node_modules/ && \
    rm -rf /tmp/sso-deps

ENV TIMEOFF_PREMIUM_MODULE=${PREMIUM_MODULE_TARGET} \
    TIMEOFF_PREMIUM_MODULE_REQUIRED=true

USER appuser
