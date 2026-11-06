# Family Brain Gateway runtime image. Every base is pinned by digest; the
# runtime stage holds only the compiled gateway, production dependencies, the
# governed policy files and the SQL migrations, owned by root and run as an
# unprivileged user so the filesystem can be mounted read-only.

FROM node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de AS toolchain
ENV CI=true
RUN npm install --global --no-fund --no-audit pnpm@11.19.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM toolchain AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM toolchain AS production-dependencies
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de AS runtime
# Take Debian security fixes newer than the base digest (the image is built
# once and promoted by digest), then remove the bundled package managers:
# the gateway needs only node.
RUN apt-get update \
  && apt-get upgrade --yes --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config/policy ./config/policy
COPY migrations ./migrations
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/cli.js"]
