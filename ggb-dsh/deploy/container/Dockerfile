# syntax=docker/dockerfile:1
#
# One image, two entry points (§7.5): `apps/api` and `apps/worker` run as separate
# processes in the same container and hand plugin-core runs over a tmpfs Unix socket.
#
# Build from the repository root. All workspace packages, the vendored plugin TGZ
# and its provisioning tool are under ggb-dsh/:
#
#   docker build -f ggb-dsh/deploy/container/Dockerfile -t ggb-dsh-server .
#
# The plugin-core runtime needs Chromium and its OS libraries, so its build and
# runtime stages use the pinned Playwright image instead of node:22-slim.

FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY ggb-dsh ./ggb-dsh
WORKDIR /src/ggb-dsh
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm run build

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS plugin
RUN npm install --global pnpm@11.7.0
COPY ggb-dsh/vendor /opt/vendor
COPY ggb-dsh/tools /opt/tools
RUN node /opt/tools/provision-plugin-core.mjs \
  --target /opt/ggb-plugin \
  --tgz /opt/vendor/ggb-plugins-dsh-0.8.3.tgz \
  --browsers /ms-playwright

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    GGB_AGENT_ENGINE=plugin_core \
    GGB_PLUGIN_ROOT=/opt/ggb-plugin \
    GGB_PLUGIN_CORE_OUTPUT_ROOT=/var/lib/ggb-dsh/plugin-core-runs \
    HOME=/tmp/ggb-home \
    TMPDIR=/tmp
# §12: non-root, no host home, isolated DSH homes, no core dumps.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin ggb \
  && mkdir -p /app /run/ggb /dsh-home /tmp/ggb-home /var/lib/ggb-dsh/plugin-core-runs \
  && chown -R ggb:ggb /app /run/ggb /dsh-home /tmp/ggb-home /var/lib/ggb-dsh
WORKDIR /app
COPY --from=build --chown=ggb:ggb /src/ggb-dsh/apps /app/apps
COPY --from=build --chown=ggb:ggb /src/ggb-dsh/packages /app/packages
COPY --from=build --chown=ggb:ggb /src/ggb-dsh/vendor /app/vendor
COPY --from=build --chown=ggb:ggb /src/ggb-dsh/config /app/config
COPY --from=build --chown=ggb:ggb /src/ggb-dsh/knowledge /app/knowledge
COPY --from=build --chown=ggb:ggb /src/ggb-dsh/tools /app/tools
COPY --from=build --chown=ggb:ggb /src/ggb-dsh/node_modules /app/node_modules
COPY --from=build --chown=ggb:ggb /src/ggb-dsh/deploy/container/entrypoint.sh /app/entrypoint.sh
COPY --from=plugin --chown=ggb:ggb /opt/ggb-plugin /opt/ggb-plugin
# The fixed GeoGebra runtime and the Client PWA build are published by the edge tier
# (§10: `geogebra-runtime.ts` splits into Client resource resolution + API/edge static
# serving); they are not read from the container filesystem. The plugin runtime is
# separate and self-contained under /opt/ggb-plugin.
USER ggb
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["both"]
